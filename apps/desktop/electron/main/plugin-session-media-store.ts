import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginFetchTransport } from "./plugin-net-fetch";
import type { SessionVideoTools } from "./plugin-session-video-tools";

const PAGE_SIZE = 20;
const RECORD_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_LIMIT = 128 * 1024 * 1024;
const VIDEO_TIMEOUT = 120_000;
const STAGED_VIDEO_LIMIT = 512 * 1024 * 1024;
const TAIL_LIMIT = 1024 * 1024;
const MAX_SEGMENTS = 12;
const ID = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const DIGEST = /^[\da-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const legacyRatios = ["1:1", "16:9", "9:16"] as const;
const videoRatios = [...legacyRatios, "21:9", "4:3", "3:4"] as const;
const imageRatios = [...videoRatios, "auto", "2:3", "3:2"] as const;
const imageAreas = ["1K", "2K", "4K"] as const;
const imageModels = ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"] as const;
const frameModes = ["first", "last", "both"] as const;
const workflows = ["omni", "frames", "multiframe", "edit", "long", "remake"] as const;
const remakeStrategies = ["creative", "replace-subject", "imitate-motion"] as const;
const resolutions = ["480P", "768P"] as const;
const videoModels = ["MiniMax-H3-Lite", "MiniMax-H3-Highspeed"] as const;
const statuses = ["submitting", "running", "saving", "saved", "save-failed", "failed", "unknown"] as const;

type Ratio = typeof imageRatios[number];
type Status = typeof statuses[number];
type Kind = "image" | "video";
type Authorize = (sessionId: string) => Promise<void>;
type RecordLocation = { pluginId: string; sessionId: string };
type SegmentedVideo = {
  dir: string;
  record: StoredMediaRecord;
  revalidate: () => Promise<void>;
  remove: (path: string) => Promise<void>;
  tools: SessionVideoTools;
};

export type StoredMediaRecord = {
  id: string;
  sessionId: string;
  kind: Kind;
  prompt: string;
  ratio: Ratio;
  imageArea?: typeof imageAreas[number];
  imageModel?: typeof imageModels[number];
  imageReferenceCount?: number;
  duration?: number;
  frameMode?: typeof frameModes[number];
  workflow?: typeof workflows[number];
  remakeStrategy?: typeof remakeStrategies[number];
  resolution?: typeof resolutions[number];
  model?: typeof videoModels[number];
  plannedRequests?: number;
  keyframeTransitions?: { duration: number; prompt: string }[];
  /** Zero-based segment of the current provider task. */
  segment?: number;
  createdAt: number;
  status: Status;
  taskId?: string;
  error?: string;
};

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function missing() {
  return failure("NOT_FOUND", "Session media record is unavailable");
}

function absent(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function fields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw failure("INVALID_ARGUMENT", "Invalid session media input");
  }
  return input as Record<string, unknown>;
}

function mediaId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw failure("INVALID_ARGUMENT", "Invalid session media identifier");
  }
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw failure("INVALID_ARGUMENT", "Invalid session identifier");
  }
  return value;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function advancedImage(input: Record<string, unknown>) {
  const imageArea = imageAreas.find((entry) => entry === input.imageArea);
  const imageModel = imageModels.find((entry) => entry === input.imageModel);
  const { imageReferenceCount } = input;
  if (input.kind !== "image" || (input.imageArea !== undefined && imageArea === undefined) ||
      (input.imageModel !== undefined && imageModel === undefined) ||
      (imageReferenceCount !== undefined && !integer(imageReferenceCount, 0, 9))) {
    throw failure("INVALID_ARGUMENT", "Invalid image workflow parameters");
  }
  return {
    ...(imageArea === undefined ? {} : { imageArea }),
    ...(imageModel === undefined ? {} : { imageModel }),
    ...(imageReferenceCount === undefined ? {} : { imageReferenceCount }),
  };
}

function readKeyframeTransitions(value: unknown, plannedRequests: number, totalDuration: number) {
  const invalid = () => failure("INVALID_ARGUMENT", "Invalid multi-frame transition parameters");
  if (!Array.isArray(value) || !integer(value.length, 1, 9) || value.length !== plannedRequests) {
    throw invalid();
  }
  const transitions = Array.from(value, (entry: unknown) => {
    const { duration, prompt } = fields(entry);
    if (!integer(duration, 4, 15) || typeof prompt !== "string") throw invalid();
    const trimmed = prompt.trim();
    if (trimmed.length > 300) throw invalid();
    return { duration, prompt: trimmed };
  });
  if (transitions.reduce((sum, transition) => sum + transition.duration, 0) !== totalDuration) {
    throw invalid();
  }
  return transitions;
}

function advancedVideo(input: Record<string, unknown>) {
  const { kind, duration, plannedRequests } = input;
  const workflow = workflows.find((entry) => entry === input.workflow);
  const remakeStrategy = remakeStrategies.find((entry) => entry === input.remakeStrategy);
  const resolution = resolutions.find((entry) => entry === input.resolution);
  const model = videoModels.find((entry) => entry === input.model);
  const sequence = workflow === "long" || workflow === "multiframe";
  if (kind !== "video" || !workflow || !resolution || (input.model !== undefined && !model) ||
      (input.remakeStrategy !== undefined && (workflow !== "remake" || remakeStrategy === undefined)) ||
      (input.keyframeTransitions !== undefined && workflow !== "multiframe") ||
      !integer(duration, workflow === "long" ? 16 : 4, sequence ? 180 : 15) ||
      !integer(plannedRequests, workflow === "long" ? 2 : 1, sequence ? MAX_SEGMENTS : 1)) {
    throw failure("INVALID_ARGUMENT", "Invalid video workflow parameters");
  }
  const keyframeTransitions = input.keyframeTransitions === undefined ? undefined
    : readKeyframeTransitions(input.keyframeTransitions, plannedRequests, duration);
  return {
    workflow, resolution, plannedRequests, duration,
    ...(model === undefined ? {} : { model }),
    ...(remakeStrategy === undefined ? {} : { remakeStrategy }),
    ...(keyframeTransitions === undefined ? {} : { keyframeTransitions }),
  };
}

function parameters(input: Record<string, unknown>) {
  const { kind, prompt, duration } = input;
  const frameMode = frameModes.find((mode) => mode === input.frameMode);
  const hasVideoWorkflow = input.workflow !== undefined || input.resolution !== undefined ||
    input.plannedRequests !== undefined || input.model !== undefined || input.remakeStrategy !== undefined ||
    input.keyframeTransitions !== undefined;
  const hasImageWorkflow = input.imageArea !== undefined || input.imageModel !== undefined ||
    input.imageReferenceCount !== undefined;
  const allowedRatios = hasVideoWorkflow ? videoRatios : hasImageWorkflow ? imageRatios : legacyRatios;
  const ratio = allowedRatios.find((option) => option === input.ratio);
  if ((kind !== "image" && kind !== "video") || typeof prompt !== "string" || !prompt.trim()
    || prompt.length > 8_000 || Array.from(prompt).length > 4_000 || ratio === undefined
    || (input.frameMode !== undefined && (kind !== "video" || frameMode === undefined))
    || (kind === "image" ? duration !== undefined : !hasVideoWorkflow && duration !== 4 && duration !== 6 && duration !== 8)) {
    throw failure("INVALID_ARGUMENT", "Invalid media generation parameters");
  }
  const image = hasImageWorkflow ? advancedImage(input) : undefined;
  const workflow = hasVideoWorkflow ? advancedVideo(input) : undefined;
  if (workflow && frameMode !== undefined && workflow.workflow !== "frames") {
    throw failure("INVALID_ARGUMENT", "Reference frames require the frames workflow");
  }
  return {
    kind,
    prompt: prompt.trim(),
    ratio,
    ...(typeof duration === "number" ? { duration } : {}),
    ...(frameMode === undefined ? {} : { frameMode }),
    ...image,
    ...workflow,
  } satisfies Pick<StoredMediaRecord, "kind" | "prompt" | "ratio"> & Partial<StoredMediaRecord>;
}

function recordStatus(value: unknown): Status {
  const status = statuses.find((entry) => entry === value);
  if (!status) throw failure("INVALID_ARGUMENT", "Invalid session media status");
  return status;
}

function optionalError(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw failure("INVALID_ARGUMENT", "Invalid session media error code");
  }
  return value;
}

function optionalTaskId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw failure("INVALID_ARGUMENT", "Invalid provider task identifier");
  }
  return value;
}

function optionalSegment(value: unknown, plannedRequests: number | undefined) {
  if (value === undefined) return undefined;
  if (!plannedRequests || plannedRequests < 2 || !integer(value, 0, plannedRequests - 1)) {
    throw failure("INVALID_ARGUMENT", "Invalid video segment index");
  }
  return value;
}

function partName(index: number) {
  return "part-" + String(index).padStart(2, "0") + ".mp4";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** UUIDv7 sorts on the creation time, so a page reads only the files it returns. */
function newId(createdAt: number) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(createdAt, 0, 6);
  bytes[6] = 0x70 | (bytes[6] & 0xf);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const value = bytes.toString("hex");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
}

async function directory(path: string, create = false) {
  const stat = () => lstat(path).catch((error: unknown) => {
    if (!absent(error)) throw error;
    return null;
  });
  let info = await stat();
  if (!info && create) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    info = await stat();
  }
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw failure("PERMISSION_DENIED", "Session media directory is redirected");
  }
  return true;
}

async function fileInfo(path: string): Promise<Stats | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info = await lstat(path).catch((error: unknown) => {
      if (!absent(error)) throw error;
      return null;
    });
    if (!info) return null;
    // APFS may return the old regular vnode after an atomic rename unlinks it.
    // Recheck the pathname without accepting a hard link or a redirected file.
    if (info.isFile() && info.nlink === 0) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) {
      throw failure("PERMISSION_DENIED", "Session media file is redirected");
    }
    return info;
  }
  throw failure("BUSY", "Session media file is being replaced");
}

async function atomicJson(path: string, value: StoredMediaRecord) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: 1, ...value }) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fileInfo(path);
    await rename(temp, path);
  } finally {
    await removeStage(temp);
  }
}

async function removeStage(path: string) {
  await unlink(path).catch((error: unknown) => {
    if (!absent(error)) throw error;
  });
}

function assetName(kind: Kind) {
  return kind === "image" ? "media.jpg" : "media.mp4";
}

function jpegBytes(value: unknown) {
  if (typeof value !== "string" || value.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || value.length % 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw failure("INVALID_ARGUMENT", "Invalid or oversized JPEG");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 5 || bytes.length > IMAGE_LIMIT || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw failure("INVALID_ARGUMENT", "Expected a JPEG image");
  }
  return bytes;
}

function downloadUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 8192) throw failure("INVALID_ARGUMENT", "Invalid video URL");
  const url = URL.parse(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
    throw failure("INVALID_ARGUMENT", "Expected an HTTPS media URL without credentials");
  }
  return url.href;
}

async function saveVideo(
  raw: unknown,
  destination: string,
  assertUrl: (url: string) => void,
  transport: PluginFetchTransport,
  lifetime?: AbortSignal,
  limit = VIDEO_LIMIT,
) {
  const signal = lifetime ? AbortSignal.any([lifetime, AbortSignal.timeout(VIDEO_TIMEOUT)]) : AbortSignal.timeout(VIDEO_TIMEOUT);
  let url = downloadUrl(raw);
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    signal.throwIfAborted();
    assertUrl(url);
    // Deliberately no API Key, custom headers, or credentials on the asset request.
    try {
      response = await transport(url, { signal, redirect: "manual", credentials: "omit" });
    } catch {
      throw failure(signal.aborted ? "TIMEOUT" : "UNAVAILABLE", "Media download could not be completed");
    }
    if (response.status < 300 || response.status >= 400) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || hop >= 4) throw failure("UNAVAILABLE", "Media redirect could not be followed");
    const next = URL.parse(location, url);
    url = downloadUrl(next?.href);
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (response.status !== 200 || !response.body || (mime !== "video/mp4" && mime !== "application/octet-stream")
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
    await response.body?.cancel();
    throw failure("UNAVAILABLE", "Provider did not return a supported MP4");
  }

  const reader = response.body.getReader();
  let complete = false;
  try {
    const file = await open(destination, "wx", 0o600);
    try {
      const header = Buffer.alloc(12);
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size < header.length) header.set(chunk.value.subarray(0, header.length - size), size);
        size += chunk.value.byteLength;
        if (size > limit) throw failure("INVALID_ARGUMENT", "Video exceeds the media size limit");
        await file.writeFile(chunk.value);
      }
      if (size < header.length || header.readUInt32BE(0) < 12 || header.toString("ascii", 4, 8) !== "ftyp") {
        throw failure("INVALID_ARGUMENT", "Expected an MP4 video");
      }
      await file.sync();
      complete = true;
    } finally {
      await file.close();
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function terminal(record: StoredMediaRecord) {
  return record.status === "saved" || record.status === "failed" || record.status === "unknown";
}

export class PluginSessionMediaStore {
  private readonly locations = new Map<string, RecordLocation>();
  private readonly busy = new Set<string>();
  private readonly dataDir: string;
  private readonly videoTools?: SessionVideoTools;

  constructor(dataDir: string, videoTools?: SessionVideoTools) {
    this.dataDir = resolve(dataDir);
    this.videoTools = videoTools;
  }

  private async folder(parts: string[], create = false) {
    let current = join(await realpath(this.dataDir), "session-media");
    if (!await directory(current, create)) return null;
    for (const part of parts) {
      current = join(current, part);
      if (!await directory(current, create)) return null;
    }
    return current;
  }

  private async read(pluginId: string, sessionHash: string, id: string) {
    const dir = await this.folder([sessionHash, digest(pluginId), id]);
    if (!dir) return null;
    const filename = join(dir, "record.json");
    let input: Record<string, unknown> | undefined;
    // Updates atomically replace the JSON. Retry a coherent replacement that
    // lands between lstat and open rather than interrupting a history refresh.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info = await fileInfo(filename);
      if (!info) return null;
      const file = await open(filename, constants.O_RDONLY | NOFOLLOW);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.size > RECORD_LIMIT) {
          throw failure("PERMISSION_DENIED", "Session media record changed");
        }
        if (opened.ino !== info.ino || opened.dev !== info.dev) continue;
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length !== opened.size) throw failure("UNAVAILABLE", "Session media record changed");
        input = fields(JSON.parse(buffer.toString("utf8", 0, length)));
        break;
      } finally {
        await file.close();
      }
    }
    if (!input) throw failure("UNAVAILABLE", "Session media record changed");
    const owner = sessionId(input.sessionId);
    const createdAt = input.createdAt;
    if (input.schemaVersion !== 1 || input.id !== id || digest(owner) !== sessionHash
      || typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) {
      throw failure("UNAVAILABLE", "Session media record is invalid");
    }
    const record: StoredMediaRecord = {
      ...parameters(input), id, sessionId: owner, createdAt, status: recordStatus(input.status),
      error: optionalError(input.error), taskId: optionalTaskId(input.taskId),
    };
    const segment = optionalSegment(input.segment, record.plannedRequests);
    if (segment !== undefined) {
      if (!record.taskId) throw failure("UNAVAILABLE", "The video segment has no provider task");
      record.segment = segment;
    }
    // The media is published before its JSON status. A crash between the two
    // renames must not turn an already stored result into a lost output.
    if ((record.status === "saving" || record.status === "save-failed") && await fileInfo(join(dir, assetName(record.kind)))) {
      record.status = "saved";
      delete record.error;
    }
    return { dir, record };
  }

  private async owned(pluginId: string, id: string) {
    const location = this.locations.get(id);
    if (location?.pluginId !== pluginId) throw missing();
    const entry = await this.read(pluginId, digest(location.sessionId), id);
    if (!entry) {
      this.locations.delete(id);
      throw missing();
    }
    return entry;
  }

  async reserve(pluginId: string, input: unknown, authorize: Authorize) {
    const value = fields(input);
    const owner = sessionId(value.sessionId);
    const createdAt = Date.now();
    const record: StoredMediaRecord = {
      ...parameters(value), id: newId(createdAt), sessionId: owner, createdAt, status: "submitting",
    };
    await authorize(owner);
    const parts = [digest(owner), digest(pluginId), record.id];
    const dir = await this.folder(parts, true);
    if (!dir) throw missing();
    try {
      await authorize(owner);
      if (!await this.folder(parts)) throw missing();
      await atomicJson(join(dir, "record.json"), record);
    } catch (error) {
      if (await this.folder(parts)) await rm(dir, { recursive: true });
      throw error;
    }
    this.locations.set(record.id, { pluginId, sessionId: owner });
    return record;
  }

  async update(pluginId: string, input: unknown, authorize: Authorize) {
    const value = fields(input);
    const id = mediaId(value.id);
    const status = recordStatus(value.status);
    if (status === "submitting" || status === "saved") {
      throw failure("INVALID_ARGUMENT", "Use the media reserve or archive operation");
    }
    const { error, taskId } = { error: optionalError(value.error), taskId: optionalTaskId(value.taskId) };
    const operation = JSON.stringify([pluginId, id]);
    if (this.busy.has(operation)) throw failure("BUSY", "Session media record is being saved");
    this.busy.add(operation);
    try {
      const { dir, record } = await this.owned(pluginId, id);
      await authorize(record.sessionId);
      if (terminal(record)) return record;
      const segment = optionalSegment(value.segment, record.plannedRequests);
      if (segment !== undefined || taskId !== undefined) {
        await this.assertProviderTask(dir, record, taskId, segment);
      }
      const next: StoredMediaRecord = {
        ...record, status, error, taskId: taskId ?? record.taskId, segment: segment ?? record.segment,
      };
      if (!await this.folder([digest(record.sessionId), digest(pluginId), id])) throw missing();
      await atomicJson(join(dir, "record.json"), next);
      if (terminal(next)) this.locations.delete(id);
      return next;
    } finally {
      this.busy.delete(operation);
    }
  }

  private async assertProviderTask(dir: string, record: StoredMediaRecord, taskId: string | undefined, segment: number | undefined) {
    if (record.kind !== "video" || !taskId) throw failure("INVALID_ARGUMENT", "Expected a video provider task");
    if (!record.plannedRequests || record.plannedRequests === 1) {
      if (!record.taskId || taskId === record.taskId) return;
    } else if (segment !== undefined) {
      if (record.segment === undefined && !record.taskId && segment === 0) return;
      if (record.segment === segment && record.taskId === taskId) return;
      if (record.segment !== undefined && segment === record.segment + 1 && taskId !== record.taskId &&
          await fileInfo(join(dir, partName(record.segment)))) return;
    }
    throw failure("INVALID_ARGUMENT", "Provider task cannot be replaced before the current segment is staged");
  }

  async archive(
    pluginId: string,
    input: unknown,
    authorize: Authorize,
    assertUrl: (url: string) => void,
    transport: PluginFetchTransport = fetch,
    signal?: AbortSignal,
  ) {
    const value = fields(input);
    const id = mediaId(value.id);
    const operation = JSON.stringify([pluginId, id]);
    if (this.busy.has(operation)) throw failure("BUSY", "Session media record is being saved");
    this.busy.add(operation);
    try {
      const { dir, record } = await this.owned(pluginId, id);
      await authorize(record.sessionId);
      if (terminal(record)) {
        if (record.status === "saved") return record;
        throw failure("INVALID_ARGUMENT", "Session media record has already finished");
      }
      if (record.plannedRequests && record.plannedRequests > 1) {
        throw failure("INVALID_ARGUMENT", "Use segmented archiving for this video");
      }
      const parts = [digest(record.sessionId), digest(pluginId), id];
      if (!await this.folder(parts)) throw missing();
      const filename = join(dir, "record.json");
      const saving: StoredMediaRecord = { ...record, status: "saving", error: undefined };
      await atomicJson(filename, saving);
      const staged = join(dir, `${randomUUID()}.asset.tmp`);
      try {
        if (record.kind === "image") {
          const bytes = jpegBytes(value.jpegBase64);
          const file = await open(staged, "wx", 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
        } else {
          await saveVideo(value.videoUrl, staged, assertUrl, transport, signal);
        }
        signal?.throwIfAborted();
        await authorize(record.sessionId);
        if (!await this.folder(parts)) throw missing();
        const asset = join(dir, assetName(record.kind));
        await fileInfo(asset);
        await rename(staged, asset);
        const saved: StoredMediaRecord = { ...saving, status: "saved" };
        await atomicJson(filename, saved);
        this.locations.delete(id);
        return saved;
      } finally {
        if (await this.folder(parts)) await removeStage(staged);
      }
    } finally {
      this.busy.delete(operation);
    }
  }

  private async segmented<T>(pluginId: string, rawId: unknown, authorize: Authorize,
    perform: (video: SegmentedVideo) => Promise<T>) {
    if (!this.videoTools) throw failure("UNSUPPORTED", "Local video processing is unavailable");
    const id = mediaId(rawId);
    const operation = JSON.stringify([pluginId, id]);
    if (this.busy.has(operation)) throw failure("BUSY", "Session media record is being saved");
    this.busy.add(operation);
    try {
      const { dir, record } = await this.owned(pluginId, id);
      const parts = [digest(record.sessionId), digest(pluginId), id];
      const revalidate = async () => {
        await authorize(record.sessionId);
        if (!await this.folder(parts)) throw missing();
      };
      const remove = async (path: string) => {
        if (await this.folder(parts)) await removeStage(path);
      };
      await revalidate();
      if (record.kind !== "video" || !record.plannedRequests || record.plannedRequests < 2 ||
          record.segment === undefined || !record.taskId || (terminal(record) && record.status !== "saved")) {
        throw failure("INVALID_ARGUMENT", "Expected an active segmented video task");
      }
      return await perform({ dir, record, revalidate, remove, tools: this.videoTools });
    } finally {
      this.busy.delete(operation);
    }
  }

  async stageVideo(pluginId: string, input: unknown, authorize: Authorize,
    assertUrl: (url: string) => void, transport: PluginFetchTransport = fetch, signal?: AbortSignal) {
    const value = fields(input);
    const url = downloadUrl(value.videoUrl);
    if (value.extractLastFrame !== undefined && typeof value.extractLastFrame !== "boolean") {
      throw failure("INVALID_ARGUMENT", "Invalid tail frame option");
    }
    return this.segmented(pluginId, value.id, authorize, async ({ dir, record, revalidate, remove, tools }) => {
      if (record.status === "saved" || !integer(value.index, 0, MAX_SEGMENTS - 1) || value.index !== record.segment) {
        throw failure("INVALID_ARGUMENT", "Only the current video segment can be staged");
      }
      signal?.throwIfAborted();
      assertUrl(url);
      const destination = join(dir, partName(value.index));
      const temp = join(dir, randomUUID() + ".part.tmp");
      const thumbnail = join(dir, randomUUID() + ".tail.jpg");
      try {
        if (!await fileInfo(destination)) {
          let remaining = STAGED_VIDEO_LIMIT;
          for (let i = 0; i < value.index; i += 1) {
            const size = (await fileInfo(join(dir, partName(i))))?.size;
            if (!size) throw failure("INVALID_ARGUMENT", "Earlier video segments are missing");
            remaining -= size;
          }
          if (remaining < 12) throw failure("INVALID_ARGUMENT", "Video exceeds the staged media size limit");
          await saveVideo(url, temp, assertUrl, transport, signal, Math.min(remaining, VIDEO_LIMIT));
          signal?.throwIfAborted();
          await revalidate();
          await fileInfo(destination);
          await rename(temp, destination);
        }
        if (!value.extractLastFrame) return {};
        await tools.tail(destination, thumbnail, signal);
        signal?.throwIfAborted();
        await revalidate();
        const info = await fileInfo(thumbnail);
        if (!info || info.size > TAIL_LIMIT) throw failure("UNAVAILABLE", "The video tail frame is unavailable");
        const file = await open(thumbnail, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat();
          if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw missing();
          const bytes = Buffer.alloc(info.size);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== info.size) throw missing();
          const data = bytes.toString("base64");
          jpegBytes(data);
          await revalidate();
          signal?.throwIfAborted();
          return { lastFrame: "data:image/jpeg;base64," + data };
        } finally {
          await file.close();
        }
      } finally {
        await remove(temp);
        await remove(thumbnail);
      }
    });
  }

  async finishVideo(pluginId: string, input: unknown, authorize: Authorize, signal?: AbortSignal) {
    const value = fields(input);
    return this.segmented(pluginId, value.id, authorize, async ({ dir, record, revalidate, remove, tools }) => {
      if (!integer(value.count, 2, MAX_SEGMENTS) || value.count !== record.plannedRequests || record.segment !== value.count - 1) {
        throw failure("INVALID_ARGUMENT", "This video sequence is incomplete");
      }
      if (record.status === "saved") return record;
      const inputs = Array.from({ length: value.count }, (_, index) => join(dir, partName(index)));
      for (const input of inputs) {
        const info = await fileInfo(input);
        if (!info || info.size > VIDEO_LIMIT) throw failure("INVALID_ARGUMENT", "A video segment is missing or oversized");
      }
      const metadata = join(dir, "record.json");
      const saving: StoredMediaRecord = { ...record, status: "saving", error: undefined };
      await atomicJson(metadata, saving);
      const temp = join(dir, randomUUID() + ".video.tmp.mp4");
      try {
        await tools.stitch(inputs, temp, signal);
        signal?.throwIfAborted();
        await revalidate();
        const info = await fileInfo(temp);
        if (!info || info.size < 12 || info.size > VIDEO_LIMIT) throw failure("UNAVAILABLE", "The combined video is unavailable");
        const file = await open(temp, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
        try {
          const header = Buffer.alloc(12);
          const opened = await file.stat();
          const { bytesRead } = await file.read(header, 0, header.length, 0);
          if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size ||
              bytesRead !== header.length || header.readUInt32BE(0) < 12 || header.toString("ascii", 4, 8) !== "ftyp") {
            throw failure("UNAVAILABLE", "The combined video is not an MP4");
          }
          await file.sync();
        } finally {
          await file.close();
        }
        signal?.throwIfAborted();
        await revalidate();
        const destination = join(dir, assetName(record.kind));
        await fileInfo(destination);
        await rename(temp, destination);
        const saved: StoredMediaRecord = { ...saving, status: "saved" };
        await atomicJson(metadata, saved);
        this.locations.delete(record.id);
        // A cleanup error should not turn a published archive into a failed result.
        for (const input of inputs) {
          await remove(input).catch(() => console.warn("[session-media] Could not remove a staged video segment."));
        }
        return saved;
      } finally {
        await remove(temp);
      }
    });
  }

  async list(pluginId: string, input: unknown) {
    const value = fields(input);
    const owner = sessionId(value.sessionId);
    const before = value.before == null ? null : mediaId(value.before);
    const ownerHash = digest(owner);
    const dir = await this.folder([ownerHash, digest(pluginId)]);
    const items: Array<Omit<StoredMediaRecord, "taskId">> = [];
    if (!dir) return { items, nextCursor: null };
    const ids = (await readdir(dir)).filter((id) => ID.test(id) && (before === null || id < before)).sort().reverse();
    for (const id of ids) {
      const entry = await this.read(pluginId, ownerHash, id);
      if (!entry) continue;
      if (items.length === PAGE_SIZE) return { items, nextCursor: items[PAGE_SIZE - 1].id };
      const { taskId: _taskId, ...record } = entry.record;
      items.push(record);
    }
    return { items, nextCursor: null };
  }

  async recoverable(pluginId: string) {
    const base = await this.folder([]);
    const records: StoredMediaRecord[] = [];
    if (!base) return records;
    for (const sessionHash of await readdir(base)) {
      if (!DIGEST.test(sessionHash)) continue;
      const dir = await this.folder([sessionHash, digest(pluginId)]);
      if (!dir) continue;
      for (const id of await readdir(dir)) {
        if (!ID.test(id)) continue;
        const entry = await this.read(pluginId, sessionHash, id);
        if (entry && !terminal(entry.record)) {
          this.locations.set(id, { pluginId, sessionId: entry.record.sessionId });
          records.push(entry.record);
        }
      }
    }
    return records;
  }

  async resolve(pluginId: string, owner: string, rawId: string) {
    const entry = await this.read(pluginId, digest(sessionId(owner)), mediaId(rawId));
    if (!entry || entry.record.status !== "saved") throw missing();
    const path = join(entry.dir, assetName(entry.record.kind));
    if (!await fileInfo(path)) throw missing();
    return { path, kind: entry.record.kind };
  }
}
