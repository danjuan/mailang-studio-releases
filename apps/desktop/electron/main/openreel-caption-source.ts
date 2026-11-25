import { OPENREEL_JOB_MAX_SECONDS } from "./openreel-job-policy";
import type { readCaptionInput } from "./openreel-transcription";

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readOpenReelCaptionAnchor(value: unknown) {
  const { clipId, expectedRevision } = record(value);
  if (typeof clipId !== "string" || !clipId || clipId.length > 128 || typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw failure("INVALID_ARGUMENT", "Cloud captions require a clip in a saved OpenReel draft.");
  }
  return { clipId, expectedRevision };
}

export function assertOpenReelCaptionDraftSource(
  value: unknown, input: ReturnType<typeof readCaptionInput>, anchor: ReturnType<typeof readOpenReelCaptionAnchor>,
) {
  const draft = record(value);
  if (draft.formatVersion !== 2 || draft.revision !== anchor.expectedRevision) {
    throw failure("REVISION_CONFLICT", "The saved draft changed. Generate a new caption preview.");
  }
  const { tracks } = record(record(draft.project).timeline);
  const sourceChanged = () => failure("OPENREEL_CAPTION_SOURCE_CHANGED", "The saved clip or its audio range changed.");
  if (!Array.isArray(tracks)) throw sourceChanged();
  for (const entry of tracks as unknown[]) {
    const track = record(entry);
    if (!Array.isArray(track.clips)) continue;
    const item = (track.clips as unknown[]).find(clip => record(clip).id === anchor.clipId);
    if (!item) continue;
    const { inPoint, outPoint, mediaId } = record(item);
    if (track.locked || typeof inPoint !== "number" || typeof outPoint !== "number" ||
      !Number.isFinite(inPoint) || !Number.isFinite(outPoint) || typeof mediaId !== "string" ||
      record(draft.mediaPaths)[mediaId] !== input.path) throw sourceChanged();
    const offset = input.startTime - inPoint;
    const windowStart = Math.round(offset / OPENREEL_JOB_MAX_SECONDS) * OPENREEL_JOB_MAX_SECONDS;
    const length = Math.min(OPENREEL_JOB_MAX_SECONDS, outPoint - inPoint - windowStart);
    if (windowStart < 0 || length <= 0 || Math.abs(offset - windowStart) > 1e-7 ||
      Math.abs(input.duration - length) > 1e-7) throw sourceChanged();
    return;
  }
  throw sourceChanged();
}
