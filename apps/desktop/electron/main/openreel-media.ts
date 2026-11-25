import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, type BigIntStats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeniedFsPath } from "@pi-desktop/plugin-sdk";
import {
  OPENREEL_MEDIA_UNAVAILABLE,
  openReelMediaKind,
  openReelProjectMediaKind,
  type AgentPromptAttachment,
  type OpenReelMediaKind,
} from "@pi-desktop/shared";
import { composerFileSourceIdentity, resolveComposerFileReference } from "./composer-file-references.ts";
import { assertPluginFileDestination } from "./plugin-fs-operation.ts";
import { normalizeOpenReelVideo } from "./openreel-video-normalization.ts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PASTED_FILE = /^pasted-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-(.+)$/i;
const MEDIA_ALIAS = /^video-edits\/[A-Za-z0-9_-]{1,128}\/media\/\.attachments\/[a-f0-9-]{36}\.[a-z0-9]+$/i;
const OTHER_MEDIA_EXTENSIONS = new Set([
  ".aac", ".aif", ".aiff", ".avi", ".avif", ".bmp", ".flac", ".gif", ".heic",
  ".m4a", ".m4v", ".mkv", ".mov", ".mpeg", ".mpg", ".oga", ".ogg", ".opus",
  ".tif", ".tiff", ".webm", ".webp", ".wma", ".wmv",
]);
const FILE_LIMIT = 64 * 1024 * 1024;
const TURN_LIMIT = 128 * 1024 * 1024;
const MEDIA_STALL_MS = 60_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const STOP_CODES = new Set(["TOOL_ABORTED", "TOOL_TURN_CANCELLED", "WORKSPACE_CHANGED", "PERMISSION_DENIED", "PLUGIN_UNLOADED"]);
const NORMALIZATION_ERRORS = new Set([
  "INVALID_MEDIA", "OPENREEL_CONVERSION_UNAVAILABLE", "OPENREEL_CONVERSION_FAILED",
  "OPENREEL_MEDIA_NO_SPACE", "OPENREEL_MEDIA_STALLED",
]);

export type OpenReelMediaSource = {
  attachmentIndex: number;
  name: string;
  kind: OpenReelMediaKind;
  importPath: string;
  projectPath: string;
  projectRoot: string;
  sessionId: string;
  sourcePath: string;
  sourceIdentity: string;
  projectIdentity: BigIntStats;
  size: number;
  external: boolean;
};

type StageOptions = {
  signal: AbortSignal;
  assertCurrent(): void;
  authorizeDestination?(relativePath: string): Promise<void>;
};

function unavailable(message: string, cause?: unknown): Error & { code: string; errorCode: string } {
  return Object.assign(new Error(message, { cause }), { code: OPENREEL_MEDIA_UNAVAILABLE, errorCode: OPENREEL_MEDIA_UNAVAILABLE });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function isMediaName(value: unknown): value is string {
  return typeof value === "string" &&
    (openReelMediaKind(value) !== undefined || OTHER_MEDIA_EXTENSIONS.has(extname(value).toLowerCase()));
}

export function isOpenReelMediaAttachment(attachment: AgentPromptAttachment): boolean {
  return (attachment?.kind === "file" || attachment?.kind === "image") && (
    isMediaName(attachment.path) || isMediaName(attachment.name)
    || (typeof attachment.mimeType === "string" && /^(video|audio|image)\//i.test(attachment.mimeType))
  );
}

export function isOpenReelMediaAlias(path: string): boolean {
  return MEDIA_ALIAS.test(path);
}

/** Composer serializes copied file chips as explicit @ references instead of
 * emitting attachment metadata. Recover only Main-minted files in this turn's
 * own paste directory. Ownership and open-file identity are checked again by
 * prepareOpenReelMedia, including for replays of older transcripts. */
export function openReelInputAttachments(
  dataDir: string,
  sessionId: string,
  content: string,
  attachments: readonly AgentPromptAttachment[],
): readonly AgentPromptAttachment[] {
  if (!SESSION_ID.test(sessionId) || !content.includes("@")) return attachments;
  let root = resolve(dataDir);
  try {
    root = realpathSync(root);
  } catch {
    return attachments;
  }
  const pastes = new Set([join(root, "scratch", sessionId, "pasted"), resolve(dataDir, "scratch", sessionId, "pasted")]);
  const known = new Set(attachments.map(({ path }) => path));
  const recovered: AgentPromptAttachment[] = [];
  for (const match of content.matchAll(/@(?:"([^"\r\n]+)"|([^\s"]+))/g)) {
    const path = match[1] ?? match[2];
    if (!isAbsolute(path) || path !== resolve(path) || !pastes.has(dirname(path)) || known.has(path)) continue;
    const name = PASTED_FILE.exec(basename(path))?.[1];
    if (!isMediaName(name)) continue;
    recovered.push({ path, name, kind: "file" });
    known.add(path);
  }
  return recovered.length ? [...attachments, ...recovered] : attachments;
}

function inside(root: string, target: string): string | undefined {
  const child = relative(root, target);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? child : undefined;
}

function fromRoot(original: string, canonical: string, requested: string): string | undefined {
  const child = inside(original, requested) ?? inside(canonical, requested);
  return child === undefined ? undefined : join(canonical, child);
}

function sameNode(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function canonicalFile(path: string): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || realpathSync(path) !== path) {
    throw unavailable("The attached media was redirected or is not a regular file. Attach it again.");
  }
  return info;
}

function canonicalDirectory(path: string): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || realpathSync(path) !== path) {
    throw unavailable("The OpenReel media directory was redirected. Reopen the project and try again.");
  }
  return info;
}

// Selections carry a trusted session-bound token. Copied attachments instead
// prove ownership by their exclusive, per-session Composer paste directory.
export async function prepareOpenReelMedia(input: {
  dataDir: string;
  sessionId: string;
  projectPath: string;
  attachments: readonly AgentPromptAttachment[];
}): Promise<OpenReelMediaSource[]> {
  const { dataDir, sessionId, projectPath, attachments } = input;
  if (!attachments.some(isOpenReelMediaAttachment)) return [];
  if (!SESSION_ID.test(sessionId) || !isAbsolute(projectPath)) {
    throw unavailable("Open a local project conversation before importing media.");
  }

  try {
    const projectRoot = await realpath(projectPath);
    const projectIdentity = canonicalDirectory(projectRoot);
    const dataRoot = await realpath(dataDir);
    if (inside(dataRoot, join(projectRoot, "video-edits", sessionId, "media")) !== undefined) {
      throw unavailable("Open a project outside the application's data directory to edit this media.");
    }
    const scratchRoot = join(dataRoot, "scratch", sessionId, "pasted");
    const rawScratchRoot = resolve(dataDir, "scratch", sessionId, "pasted");
    const prepared: OpenReelMediaSource[] = [];
    let totalExternalBytes = 0;
    for (const [attachmentIndex, attachment] of attachments.entries()) {
      if (!isOpenReelMediaAttachment(attachment)) continue;
      if (prepared.length >= 20) throw unavailable("OpenReel supports at most 20 media attachments per message.");

      const requested = resolve(projectPath, attachment.path);
      const scratch = fromRoot(rawScratchRoot, scratchRoot, requested);
      const workspace = fromRoot(resolve(projectPath), projectRoot, requested);
      const reference = attachment.localReference === undefined ? undefined
        : await resolveComposerFileReference(dataDir, projectPath, attachment.path, attachment.localReference, sessionId);
      const ownScratch = scratch !== undefined && dirname(scratch) === scratchRoot && PASTED_FILE.test(basename(scratch));
      const sourcePath = ownScratch ? scratch : reference?.path ?? workspace;
      if (!sourcePath || (inside(dataRoot, sourcePath) !== undefined && !ownScratch) || isDeniedFsPath(sourcePath)) {
        throw unavailable("The media file is unavailable to this conversation. Attach it again here.");
      }
      const kind = openReelMediaKind(sourcePath);
      if (!kind) throw unavailable("OpenReel supports MP4, MOV, WebM, MKV, MP3, WAV, PNG, and JPEG attachments.");
      const info = canonicalFile(sourcePath);
      if (ownScratch && info.nlink !== 1n) {
        throw unavailable("The attached media is linked outside its stored copy. Attach it again.");
      }
      const sourceIdentity = composerFileSourceIdentity(info);
      if (reference && sourceIdentity !== reference.sourceIdentity) {
        throw unavailable("The selected media file changed. Attach it again before editing.");
      }
      const external = ownScratch || inside(projectRoot, sourcePath) === undefined;
      const size = Number(info.size);
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw unavailable("The attached file is empty or exceeds the supported file offset range.");
      }
      if (external && kind !== "video") {
        totalExternalBytes += size;
        if (size > FILE_LIMIT || totalExternalBytes > TURN_LIMIT) {
          throw unavailable("Attached audio and images are limited to 64 MiB each and 128 MiB per message.");
        }
      }
      const importPath = external
        ? `video-edits/${sessionId}/media/.attachments/${randomUUID()}${extname(sourcePath).toLowerCase()}`
        : relative(projectRoot, sourcePath).split(sep).join("/");
      if (openReelProjectMediaKind(importPath) !== kind || (!external && isOpenReelMediaAlias(importPath))) {
        throw unavailable("Attach the media to import it under a supported OpenReel path.");
      }
      const suppliedName = typeof attachment.name === "string" ? attachment.name : basename(sourcePath);
      const name = basename(suppliedName.replaceAll("\\", "/")).slice(0, 255).replace(/[\p{Cc}\p{Cs}]/gu, "").trim()
        || "Media attachment";
      prepared.push({ attachmentIndex, name, kind, importPath, projectPath, projectRoot, sessionId, sourcePath, sourceIdentity, projectIdentity, size, external });
    }
    return prepared;
  } catch (error) {
    if (codeOf(error) === OPENREEL_MEDIA_UNAVAILABLE) throw error;
    throw unavailable("The media file could not be verified. Attach it again in this conversation.", error);
  }
}

function assertFileIdentity(path: string, identity: string): void {
  if (composerFileSourceIdentity(canonicalFile(path)) !== identity) {
    throw unavailable("The media file changed. Attach it again before editing.");
  }
}

/** Hash bounded bytes through the same file descriptor used for the copy. */
async function snapshotMedia(
  path: string, identity: string, size: number, signal: AbortSignal, progress: () => void,
  output?: FileHandle,
): Promise<string> {
  signal.throwIfAborted();
  assertFileIdentity(path, identity);
  const input = await open(path, READ_FLAGS);
  try {
    const opened = await input.stat({ bigint: true });
    if (!opened.isFile() || composerFileSourceIdentity(opened) !== identity) {
      throw unavailable("The media file changed while it was being opened.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(256 * 1024, size));
    for (let offset = 0; offset < size;) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) throw unavailable("The media file changed while it was being read.");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      signal.throwIfAborted();
      if (output) await output.writeFile(chunk, { signal });
      offset += bytesRead;
      progress();
    }
    if (composerFileSourceIdentity(await input.stat({ bigint: true })) !== identity) {
      throw unavailable("The media file changed while it was being read.");
    }
    assertFileIdentity(path, identity);
    return digest.digest("hex");
  } finally {
    await input.close();
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createMediaDirectory(source: OpenReelMediaSource): string {
  let directory = source.projectRoot;
  for (const segment of ["video-edits", source.sessionId, "media"]) {
    directory = join(directory, segment);
    assertPluginFileDestination(directory);
    try {
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(dirname(directory));
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
    canonicalDirectory(directory);
  }
  return directory;
}

function temporaryIdentity(path: string): BigIntStats | undefined {
  try {
    return canonicalFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Called from the admitted import invocation, after normal tool permissions. */
export async function stageOpenReelMedia(
  source: OpenReelMediaSource,
  options: StageOptions,
  normalizeVideo: typeof normalizeOpenReelVideo = normalizeOpenReelVideo,
): Promise<string> {
  const stall = new AbortController();
  const signal = AbortSignal.any([options.signal, stall.signal]);
  const timer = setTimeout(() => stall.abort(), MEDIA_STALL_MS).unref();
  const progress = () => { options.assertCurrent(); timer.refresh(); };
  const assertCurrent = () => {
    options.assertCurrent();
    signal.throwIfAborted();
    if (realpathSync(source.projectPath) !== source.projectRoot
      || !sameNode(canonicalDirectory(source.projectRoot), source.projectIdentity)) {
      throw Object.assign(new Error("The OpenReel project's folder changed."), { code: "WORKSPACE_CHANGED" });
    }
  };
  const temporaries = new Map<string, BigIntStats>();
  try {
    assertCurrent();
    assertFileIdentity(source.sourcePath, source.sourceIdentity);
    if (!source.external && source.kind !== "video") return source.importPath;

    const extension = extname(source.importPath).toLowerCase();
    const folder = `video-edits/${source.sessionId}/media`;
    const reservation = randomUUID();
    const pendingPath = `${folder}/.pi-openreel-${reservation}.tmp${extension}`;
    const pending = join(source.projectRoot, pendingPath);
    assertPluginFileDestination(pending);
    await options.authorizeDestination?.(pendingPath);
    assertCurrent();

    const directory = createMediaDirectory(source);
    const directoryIdentity = canonicalDirectory(directory);
    const assertDestination = (path: string) => {
      assertCurrent();
      assertPluginFileDestination(path);
      if (!sameNode(canonicalDirectory(directory), directoryIdentity)) {
        throw unavailable("The OpenReel media directory changed while copying.");
      }
    };
    assertDestination(pending);
    const output = await open(pending, "wx", 0o600);
    let digest: string;
    let stagedIdentity: string;
    try {
      const opened = await output.stat({ bigint: true });
      temporaries.set(pending, opened);
      assertDestination(pending);
      if (!sameNode(canonicalFile(pending), opened)) {
        throw unavailable("The OpenReel temporary file changed while opening it.");
      }
      digest = await snapshotMedia(source.sourcePath, source.sourceIdentity, source.size, signal, progress, output);
      await output.sync();
      stagedIdentity = composerFileSourceIdentity(await output.stat({ bigint: true }));
    } finally {
      await output.close();
    }
    assertCurrent();
    assertFileIdentity(source.sourcePath, source.sourceIdentity);
    assertFileIdentity(pending, stagedIdentity);
    let staged = pending;
    let stagedSize = source.size;
    let stagedExtension = extension;

    if (source.kind === "video") {
      const normalizedPath = `${folder}/.pi-openreel-${reservation}.normalized.mp4`;
      const normalized = join(source.projectRoot, normalizedPath);
      assertDestination(normalized);
      await options.authorizeDestination?.(normalizedPath);
      assertDestination(pending);
      assertDestination(normalized);
      assertFileIdentity(pending, stagedIdentity);
      const normalization = await normalizeVideo({
        inputPath: pending, outputPath: normalized, signal, onProgress: progress,
      });
      assertFileIdentity(pending, stagedIdentity);
      if (normalization === "normalized") {
        const converted = canonicalFile(normalized);
        temporaries.set(normalized, converted);
        assertDestination(normalized);
        stagedSize = Number(converted.size);
        if (!Number.isSafeInteger(stagedSize) || stagedSize <= 0) throw unavailable("The converted video is empty or too large to address.");
        stagedIdentity = composerFileSourceIdentity(converted);
        digest = await snapshotMedia(normalized, stagedIdentity, stagedSize, signal, progress);
        staged = normalized;
        stagedExtension = ".mp4";
      } else if (extension !== ".mp4") {
        throw unavailable("OpenReel could not convert this video to a readable MP4.");
      } else if (!source.external) {
        assertCurrent();
        assertFileIdentity(source.sourcePath, source.sourceIdentity);
        return source.importPath;
      }
    }

    const relativePath = `${folder}/${digest}${stagedExtension}`;
    const destination = join(source.projectRoot, relativePath);
    await options.authorizeDestination?.(relativePath);
    assertDestination(destination);
    assertFileIdentity(source.sourcePath, source.sourceIdentity);
    assertFileIdentity(staged, stagedIdentity);
    try {
      linkSync(staged, destination);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      const existing = canonicalFile(destination);
      if (existing.size !== BigInt(stagedSize)
        || await snapshotMedia(destination, composerFileSourceIdentity(existing), stagedSize, signal, progress) !== digest) {
        throw unavailable("The saved media copy no longer matches the attached media. Use a new attachment.");
      }
      assertDestination(destination);
      assertFileIdentity(destination, composerFileSourceIdentity(existing));
    }
    syncDirectory(directory);
    assertDestination(destination);
    return relativePath;
  } catch (error) {
    if (options.signal.aborted) {
      throw Object.assign(new Error("OpenReel media import was stopped."), { code: "TOOL_ABORTED" });
    }
    if (stall.signal.aborted) throw unavailable("Preparing the attached media stopped progressing. Try again from a local folder.");
    const code = codeOf(error) ?? "";
    if (STOP_CODES.has(code) || code === OPENREEL_MEDIA_UNAVAILABLE) throw error;
    if (NORMALIZATION_ERRORS.has(code) && error instanceof Error) throw unavailable(error.message, error);
    if (code === "ENOSPC") throw unavailable("There is not enough disk space to import this media.");
    if (codeOf(error) === "ENOTSUP" || codeOf(error) === "EOPNOTSUPP" || codeOf(error) === "EXDEV") {
      throw unavailable("This project folder does not support atomic media saves. Try a local project folder.");
    }
    throw unavailable("The media file could not be prepared. Check the project is writable and attach the media file again.", error);
  } finally {
    clearTimeout(timer);
    for (const [path, opened] of temporaries) {
      try {
        const info = temporaryIdentity(path);
        if (info && sameNode(info, opened)) unlinkSync(path);
      } catch (error) {
        // A redirected staging path must never be removed.
        console.warn("[openreel] Could not verify staging cleanup:", codeOf(error) ?? "UNKNOWN");
      }
    }
  }
}
