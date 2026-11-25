import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENREEL_JOB_MAX_SECONDS, OPENREEL_NATIVE_JOB_TIMEOUT_MS, type OpenReelVideoPreset } from "./openreel-job-policy";
import { createOpenReelMediaScope, OPENREEL_MEDIA_SCHEME } from "./openreel-media-protocol";
import type { OpenReelJobProgress } from "./openreel-job-progress";
import { getModuleDirectory } from "./module-path";
import { assertPluginFileDestination } from "./plugin-fs-operation";

const maxOutputBytes = 1024 * 1024 * 1024;
const maxReadBytes = 1024 * 1024;
const maxWriteBytes = 512 * 1024;

export type OpenReelExportFormat = "mp4" | "wav";

export type OpenReelExportOptions = {
  format: OpenReelExportFormat;
  preset?: OpenReelVideoPreset;
  duration: number;
  sessionId: string;
  entry: string;
  destination: string;
  path: string;
  revision: number;
  record: Record<string, unknown>;
  mediaPaths: ReadonlySet<string>;
  signal: AbortSignal;
  guard(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  verifyRevision(): Promise<void>;
  stat(path: string): Promise<unknown>;
  source(path: string): Promise<string>;
  read(path: string, offset: number, length: number): Promise<unknown>;
  progress(progress: OpenReelJobProgress): void;
  cleanupFailed(error: unknown): void;
};

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw failure("INVALID_ARGUMENT", "Invalid OpenReel export range.");
  }
  return value;
}

function finite(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw failure("INVALID_ARGUMENT", "Invalid OpenReel export metadata.");
  }
  return value;
}

function allowExportAsset(raw: string, directory: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "blob:" || url.protocol === "data:" || url.protocol === `${OPENREEL_MEDIA_SCHEME}:`) return true;
    if (url.protocol !== "file:") return false;
    const path = relative(directory, fileURLToPath(url));
    return path !== ".." && !/^\.\.[/\\]/.test(path) && !isAbsolute(path);
  } catch {
    return false;
  }
}

export class OpenReelExporter {
  private running = false;

  preflight(): void {
    if (this.running) throw failure("BUSY", "An OpenReel export is already running.");
  }

  async run(options: OpenReelExportOptions) {
    this.preflight();
    this.running = true;
    try {
      return await this.render(options);
    } finally {
      this.running = false;
    }
  }

  private async render(options: OpenReelExportOptions) {
    const { BrowserWindow, session } = await import("electron");
    const jobId = randomUUID();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(OPENREEL_NATIVE_JOB_TIMEOUT_MS)]);
    const guard = () => { signal.throwIfAborted(); options.guard(); };
    const progress = (phase: string, value?: number, done?: true) => options.progress({
      sessionId: options.sessionId, jobId, kind: "export", phase, progress: value, done,
    });
    const temporary = join(dirname(options.destination), `.pi-openreel-${jobId}.tmp`);
    guard();
    assertPluginFileDestination(options.destination);
    mkdirSync(dirname(temporary), { recursive: true });
    assertPluginFileDestination(temporary);
    const file = await open(temporary, "wx+", 0o600);
    let cleanupWindow: (() => void) | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    try {
      guard();
      const ses = session.fromPartition(`openreel-export-${jobId}`, { cache: false });
      const mediaScope = createOpenReelMediaScope(ses.protocol);
      const directory = dirname(options.entry);
      ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        callback({ cancel: !allowExportAsset(details.url, directory) });
      });
      ses.setPermissionCheckHandler(() => false);
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ses,
          preload: join(getModuleDirectory(import.meta.url), "../preload/plugin-panel.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          backgroundThrottling: false,
        },
      });
      const wc = window.webContents;
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", event => event.preventDefault());

      type Result = {
        path: string; bytes: number; format: OpenReelExportFormat; revision: number; duration: number;
        width?: number; height?: number; frameRate?: number;
      };
      let settle: (value: Result) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const finished = new Promise<Result>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
      const abort = () => reject(signal.reason);
      const channel = "pi-plugin-panel-invoke";
      cleanupWindow = () => {
        signal.removeEventListener("abort", abort);
        mediaScope.reset();
        if (!window.isDestroyed()) {
          wc.ipc.removeHandler(channel);
          window.destroy();
        }
        ses.webRequest.onBeforeRequest(null);
        ses.setPermissionCheckHandler(null);
        ses.setPermissionRequestHandler(null);
      };
      signal.addEventListener("abort", abort, { once: true });
      wc.once("render-process-gone", () => reject(failure("RENDER_FAILED", "OpenReel's export renderer stopped.")));
      let claimed = false;
      let terminal = false;
      let position = 0;
      let bytes = 0;
      let reported = 0;
      const handle = async (method: string, input: Record<string, unknown>) => {
        guard();
        if (terminal) throw failure("WORKSPACE_CHANGED", "The OpenReel export is closed.");
        if (method === "openreel.export.claim" && !claimed) {
          claimed = true;
          return { record: options.record, format: options.format, preset: options.preset };
        }
        if (!claimed) throw failure("PERMISSION_DENIED", "The OpenReel export must claim its draft first.");
        if (method === "openreel.export.media.source" ||
            method === "openreel.export.media.stat" || method === "openreel.export.media.read") {
          const path = input.path;
          if (typeof path !== "string" || !options.mediaPaths.has(path)) {
            throw failure("PERMISSION_DENIED", "The media is outside the exported draft.");
          }
          if (method === "openreel.export.media.source") {
            if (!/\.mp4$/i.test(path)) throw failure("INVALID_MEDIA", "Only project video uses streaming media URLs.");
            const file = await options.source(path);
            return mediaScope.source(path, file, () => options.run(async () => { guard(); }));
          }
          if (method === "openreel.export.media.stat") return options.stat(path);
          return options.read(path, integer(input.offset, 0, Number.MAX_SAFE_INTEGER), integer(input.length, 1, maxReadBytes));
        }
        switch (method) {
          case "openreel.export.output.write": {
            const value = input.bytes;
            if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > maxWriteBytes
              || position + value.byteLength > maxOutputBytes) {
              throw failure("INVALID_ARGUMENT", "The OpenReel export chunk exceeds its size limit.");
            }
            let offset = 0;
            while (offset < value.byteLength) {
              guard();
              const result = await file.write(value, offset, value.byteLength - offset, position + offset);
              if (!result.bytesWritten) throw failure("RENDER_FAILED", "Could not write the OpenReel export.");
              offset += result.bytesWritten;
            }
            position += offset;
            bytes = Math.max(bytes, position);
            return null;
          }
          case "openreel.export.output.seek":
            position = integer(input.position, 0, bytes);
            return null;
          case "openreel.export.output.truncate":
            bytes = integer(input.size, 0, bytes);
            await file.truncate(bytes);
            position = Math.min(position, bytes);
            return null;
          case "openreel.export.progress": {
            const value = input.progress;
            if (typeof value === "number" && Number.isFinite(value) && value >= reported && value <= 1) {
              reported = value;
              progress("rendering", value);
            }
            return null;
          }
          case "openreel.export.fail":
            throw failure("RENDER_FAILED", "OpenReel could not render this draft.");
          case "openreel.export.output.finish": {
            if (input.revision !== options.revision || input.format !== options.format || bytes < 44) {
              throw failure("RENDER_FAILED", "The OpenReel export did not match its requested draft.");
            }
            const metadata = {
              duration: finite(input.duration, OPENREEL_JOB_MAX_SECONDS + 1),
              ...(options.format === "mp4" ? {
                width: integer(input.width, 2, 4096),
                height: integer(input.height, 2, 4096),
                frameRate: finite(input.frameRate, 120),
              } : {}),
            };
            const durationTolerance = options.format === "mp4" ? Math.max(0.1, 1 / (metadata.frameRate ?? 30)) : 0.1;
            if (Math.abs(metadata.duration - options.duration) > durationTolerance
              || (options.preset === "landscape1080p" && (metadata.width !== 1920 || metadata.height !== 1080))
              || (options.preset === "portrait1080p" && (metadata.width !== 1080 || metadata.height !== 1920))
              || (options.preset === "square1080p" && (metadata.width !== 1080 || metadata.height !== 1080))) {
              throw failure("RENDER_FAILED", "The OpenReel output did not match its requested duration or dimensions.");
            }
            const header = Buffer.alloc(12);
            await file.read(header, 0, header.length, 0);
            const matchesFormat = options.format === "mp4"
              ? header.toString("ascii", 4, 8) === "ftyp"
              : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
            if (!matchesFormat) throw failure("RENDER_FAILED", "The OpenReel output did not match its requested format.");
            await file.sync();
            const output = await file.stat();
            if (output.size !== bytes) throw failure("RENDER_FAILED", "The OpenReel output size could not be verified.");
            await options.verifyRevision();
            guard();
            assertPluginFileDestination(options.destination);
            assertPluginFileDestination(temporary);
            linkSync(temporary, options.destination);
            terminal = true;
            settle({ path: options.path, bytes, format: options.format, revision: options.revision, ...metadata });
            return null;
          }
          default:
            throw failure("PERMISSION_DENIED", "The OpenReel export does not expose that operation.");
        }
      };
      wc.ipc.handle(channel, (event, method: unknown, payload: unknown) => {
        if (event.sender !== wc || event.senderFrame !== wc.mainFrame || typeof method !== "string") {
          throw failure("PERMISSION_DENIED", "Invalid OpenReel export invoker.");
        }
        const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const operation = tail.then(() => options.run(() => handle(method, input)));
        tail = operation.catch(error => { reject(error); });
        return operation;
      });
      guard();
      progress("preparing");
      void window.loadFile(options.entry, { hash: "pi-export-job" }).catch(reject);
      return await finished;
    } catch (error) {
      if (options.signal.aborted) throw failure("TOOL_ABORTED", "OpenReel export was stopped.");
      if (signal.aborted) throw failure("TIMEOUT", "OpenReel export timed out.");
      throw error;
    } finally {
      cleanupWindow?.();
      await tail;
      await file.close().catch(options.cleanupFailed);
      await unlink(temporary).catch(options.cleanupFailed);
      progress("finished", undefined, true);
    }
  }
}
