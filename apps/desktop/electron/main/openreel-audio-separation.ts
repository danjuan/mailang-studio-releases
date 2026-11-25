import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPluginFileDestination } from "./plugin-fs-operation";
import { OPENREEL_JOB_MAX_SECONDS } from "./openreel-job-policy";
import { decodeOpenReelSeparatedWav } from "./openreel-separated-wav";

type Guard = () => void;
type PathMode = "read" | "write";
type ResolvedPath = { full: string; rel: string; root: string };
type JobScope = {
  sessionId: string;
  signal: AbortSignal;
  guard: Guard;
  readText(path: string): Promise<string>;
  resolve(mode: PathMode, path: string): Promise<ResolvedPath>;
  progress(fraction: number): void;
  cleanupError(error: unknown): void;
};

type SeparationInput = { workspacePath: string; expectedRevision: number; clipId: string };

type Draft = {
  formatVersion?: number;
  revision?: number;
  mediaPaths?: Record<string, string>;
  project?: { timeline?: { tracks?: Array<{
    type?: string;
    locked?: boolean;
    clips?: Array<{
      id: string; mediaId: string; duration: number; inPoint: number; outPoint: number;
      speed?: number; reversed?: boolean; freezeFrames?: unknown[]; speedKeyframes?: unknown[]; audioTrackIndex?: number;
      audioDetached?: boolean; metadata?: { audioDetached?: boolean };
    }>;
  }> } };
};

const maxDraftBytes = 8 * 1024 * 1024;
const slots = 11;

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function readSeparationInput(value: unknown): SeparationInput {
  const input = value && typeof value === "object" ? value as Partial<SeparationInput> : {};
  const { workspacePath, expectedRevision, clipId } = input;
  if (!workspacePath || typeof workspacePath !== "string" || typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      typeof clipId !== "string" || !clipId || clipId.length > 128) {
    throw failure("INVALID_ARGUMENT", "Select a saved OpenReel video clip to separate its audio.");
  }
  return { workspacePath, expectedRevision, clipId };
}

function findVideo(draft: Draft, clipId: string, root: string) {
  for (const track of draft.project?.timeline?.tracks ?? []) {
    const clip = track.clips?.find(entry => entry.id === clipId);
    if (!clip) continue;
    const path = draft.mediaPaths?.[clip.mediaId];
    if (track.type !== "video" || track.locked || clip.audioDetached || clip.metadata?.audioDetached ||
        (clip.speed ?? 1) !== 1 || clip.reversed || clip.freezeFrames?.length || clip.speedKeyframes?.length || (clip.audioTrackIndex ?? 0) !== 0 ||
        !path || !/\.mp4$/i.test(path) || (path.toLowerCase().startsWith("video-edits/") && !path.startsWith(root + "/")) ||
        !Number.isFinite(clip.duration) || !Number.isFinite(clip.inPoint) || !Number.isFinite(clip.outPoint) ||
        clip.inPoint < 0 || clip.duration <= 0 || clip.duration > OPENREEL_JOB_MAX_SECONDS ||
        Math.abs(clip.duration - (clip.outPoint - clip.inPoint)) > 0.001) break;
    return { path, duration: clip.duration, startTime: clip.inPoint };
  }
  throw failure("INVALID_ARGUMENT", "Choose an unlocked normal-speed video clip with up to 300 seconds of original audio.");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSource(left: Stats, right: Stats): boolean {
  return right.isFile() && sameIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function removeOwnedFile(path: string, own: Stats) {
  assertPluginFileDestination(path);
  try {
    const current = lstatSync(path);
    if (current.isFile() && sameIdentity(own, current)) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Check only this admitted session's draft and bounded history. Preserve the
 * file on an indeterminate read or if any saved version references it. */
async function draftReferences(sessionRoot: string, path: string) {
  const files = [join(sessionRoot, "draft.json"),
    ...Array.from({ length: slots }, (_, slot) => join(sessionRoot, "history", String(slot) + ".json"))];
  for (const file of files) {
    assertPluginFileDestination(file);
    let handle;
    const noLinks = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
    try {
      handle = await open(file, constants.O_RDONLY | noLinks | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxDraftBytes) {
        throw failure("INVALID_DRAFT", "Could not check whether the saved draft references its separated audio.");
      }
      const draft = JSON.parse(await handle.readFile("utf8")) as Draft;
      if (draft.formatVersion !== 2 || !draft.mediaPaths || typeof draft.mediaPaths !== "object") {
        throw failure("INVALID_DRAFT", "Could not verify the saved OpenReel media references.");
      }
      if (Object.values(draft.mediaPaths).includes(path)) return true;
    } finally {
      await handle.close();
    }
  }
  return false;
}

export async function prepareOpenReelSeparatedAudio(input: SeparationInput, scope: JobScope) {
  const root = "video-edits/" + scope.sessionId;
  const verifyRevision = async () => {
    scope.guard();
    const draft = JSON.parse(await scope.readText(root + "/draft.json")) as Draft;
    scope.guard();
    if (draft.formatVersion !== 2 || draft.revision !== input.expectedRevision) {
      throw failure("REVISION_CONFLICT", "The OpenReel draft changed while separating audio.");
    }
    return draft;
  };
  const selected = findVideo(await verifyRevision(), input.clipId, root);
  const source = await scope.resolve("read", selected.path);
  scope.guard();
  if (source.rel.toLowerCase().startsWith("video-edits/") && !source.rel.startsWith(root + "/")) {
    throw failure("PERMISSION_DENIED", "This media belongs to a different OpenReel draft.");
  }
  const original = lstatSync(source.full);
  if (!original.isFile()) throw failure("INVALID_MEDIA", "Choose a readable local video.");
  const key = randomUUID();
  const path = root + "/media/separated/audio-" + key + ".wav";
  const destination = await scope.resolve("write", path);
  scope.guard();
  if (destination.rel !== path) throw failure("WORKSPACE_CHANGED", "The separated media directory was redirected.");
  assertPluginFileDestination(destination.full);
  const directory = dirname(destination.full);
  mkdirSync(directory, { recursive: true });
  assertPluginFileDestination(destination.full);
  const folder = lstatSync(directory);
  const guard = () => {
    scope.guard();
    assertPluginFileDestination(destination.full);
    if (!sameIdentity(folder, lstatSync(directory)) || !sameSource(original, lstatSync(source.full))) {
      throw failure("WORKSPACE_CHANGED", "The source video or destination changed while separating audio.");
    }
  };

  const temporary = join(directory, ".separate-" + key + ".tmp");
  let staged: Stats | undefined;
  let published = false;
  try {
    const decoded = await decodeOpenReelSeparatedWav({
      source: source.full, temporary, startTime: selected.startTime, duration: selected.duration,
      signal: scope.signal, guard, progress: scope.progress,
    });
    staged = decoded.identity;
    await verifyRevision();
    guard();
    if (!sameIdentity(staged, lstatSync(temporary))) {
      throw failure("WORKSPACE_CHANGED", "The staged OpenReel audio changed.");
    }
    linkSync(temporary, destination.full);
    published = true;
    const handle = openSync(directory, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    guard();
    return {
      output: { path, duration: decoded.duration, bytes: decoded.bytes, channels: decoded.channels },
      assertCommitMedia() {
        guard();
        const current = lstatSync(destination.full);
        if (!current.isFile() || !sameIdentity(decoded.identity, current) || current.size !== decoded.identity.size ||
            current.mtimeMs !== decoded.identity.mtimeMs) {
          throw failure("WORKSPACE_CHANGED", "The derived OpenReel audio changed before saving.");
        }
      },
      async discard() {
        if (!(await draftReferences(join(destination.root, root), path))) removeOwnedFile(destination.full, decoded.identity);
      },
    };
  } catch (error) {
    if (published && staged) {
      try { removeOwnedFile(destination.full, staged); } catch (cleanup) { scope.cleanupError(cleanup); }
    }
    throw error;
  } finally {
    if (staged) {
      try { removeOwnedFile(temporary, staged); } catch (cleanup) { scope.cleanupError(cleanup); }
    }
  }
}
