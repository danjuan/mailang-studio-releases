import type { HeadlessHost } from "@openreel/agent/headless-host";
import type { Project } from "@openreel/core/types/project";
import type { Clip } from "@openreel/core/types/timeline";
import { apply, invalid, numeric, retimeAutoCaptions, writableClip, writableTrack } from "./mcp-editing-native";

type Arguments = Record<string, unknown>;

function regularClip(project: Project, id: unknown): Clip {
  const clip = writableClip(project, id);
  const track = writableTrack(project, clip.trackId);
  if (track.groupId) invalid("Ungroup the selected track before retiming individual clips.");
  if ((clip.speed ?? 1) !== 1 || clip.reversed || clip.speedKeyframes?.length || clip.freezeFrames?.length) {
    invalid("This edit requires forward clips at normal speed.");
  }
  return clip;
}

function requireSourceRange(project: Project, clip: Clip, inPoint: number, outPoint: number) {
  const source = project.mediaLibrary.items.find(item => item.id === clip.mediaId);
  if (!source || !Number.isFinite(inPoint) || !Number.isFinite(outPoint) ||
    inPoint < 0 || outPoint > source.metadata.duration || outPoint - inPoint < 1 / project.settings.frameRate) {
    invalid("The edit needs a complete frame inside each clip's source range.");
  }
}

function requireAdjacent(project: Project, left: Clip, right: Clip) {
  const track = writableTrack(project, left.trackId);
  const ordered = [...track.clips].sort((a, b) => a.startTime - b.startTime);
  const index = ordered.findIndex(clip => clip.id === left.id);
  if (right.trackId !== track.id || index === -1 || ordered[index + 1]?.id !== right.id ||
    Math.abs(left.startTime + left.duration - right.startTime) > 0.001) {
    invalid("Choose adjacent clips on the same track in timeline order.");
  }
}

async function updateCaptions(host: HeadlessHost, original: Clip[], signal?: AbortSignal) {
  for (const clip of original) {
    signal?.throwIfAborted();
    await retimeAutoCaptions(host, clip, writableClip(host.getProject(), clip.id), signal);
  }
}

export async function slipClip(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const project = host.getProject();
  const clip = regularClip(project, args.clipId);
  const delta = numeric(args.delta, "Source offset", -clip.inPoint);
  requireSourceRange(project, clip, clip.inPoint + delta, clip.outPoint + delta);
  await apply(host, { type: "clip/slip", params: { clipId: clip.id, delta } });
  await updateCaptions(host, [clip], signal);
  return { clipId: clip.id, inPoint: clip.inPoint + delta, outPoint: clip.outPoint + delta };
}

export async function rollEdit(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const project = host.getProject();
  const left = regularClip(project, args.leftClipId);
  const right = regularClip(project, args.rightClipId);
  requireAdjacent(project, left, right);
  const delta = numeric(args.delta, "Edit-point offset", -left.duration, right.duration);
  requireSourceRange(project, left, left.inPoint, left.outPoint + delta);
  requireSourceRange(project, right, right.inPoint + delta, right.outPoint);
  await apply(host, { type: "clip/roll", params: { leftClipId: left.id, rightClipId: right.id, delta } });
  await updateCaptions(host, [left, right], signal);
  return { leftClipId: left.id, rightClipId: right.id, cutTime: right.startTime + delta };
}

export async function slideClip(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const project = host.getProject();
  const left = regularClip(project, args.prevClipId);
  const middle = regularClip(project, args.clipId);
  const right = regularClip(project, args.nextClipId);
  requireAdjacent(project, left, middle);
  requireAdjacent(project, middle, right);
  const delta = numeric(args.delta, "Slide offset", -left.duration, right.duration);
  requireSourceRange(project, left, left.inPoint, left.outPoint + delta);
  requireSourceRange(project, right, right.inPoint + delta, right.outPoint);
  // Move both outer cut points without changing the middle clip's source range.
  // The native slide action does not update both neighboring source ranges.
  await apply(host, { type: "clip/roll", params: { leftClipId: left.id, rightClipId: right.id, delta } });
  await apply(host, { type: "clip/move", params: { clipId: middle.id, startTime: middle.startTime + delta } });
  await updateCaptions(host, [left, middle, right], signal);
  return { clipId: middle.id, startTime: middle.startTime + delta, duration: middle.duration };
}

export async function trimToPlayhead(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const project = host.getProject();
  const clip = regularClip(project, args.clipId);
  const playheadTime = numeric(args.playheadTime, "Playhead time", clip.startTime, clip.startTime + clip.duration);
  const offset = playheadTime - clip.startTime;
  requireSourceRange(project, clip, args.trimStart ? clip.inPoint + offset : clip.inPoint,
    args.trimStart ? clip.outPoint : clip.inPoint + offset);
  await apply(host, { type: "clip/trimToPlayhead", params: { clipId: clip.id, playheadTime, trimStart: args.trimStart === true } });
  await updateCaptions(host, [clip], signal);
  const result = writableClip(host.getProject(), clip.id);
  return { clipId: clip.id, startTime: result.startTime, duration: result.duration };
}
