import { randomUUID } from "node:crypto";
import type { HeadlessHost } from "@openreel/agent/headless-host";
import { deriveEffectDescriptor, getStaticDescriptor, parseEffectKeyframeProperty } from "@openreel/core/animation/keyframe-properties";
import { parseSRT } from "@openreel/core/text/subtitle-engine";
import { TitleEngine } from "@openreel/core/text/title-engine";
import type { TextClip, TextStyle } from "@openreel/core/text/types";
import type { Action } from "@openreel/core/types/actions";
import { TRANSITION_TYPES } from "@openreel/core/types/effects";
import type { TransitionType } from "@openreel/core/types/effects";
import type { Project } from "@openreel/core/types/project";
import type { Clip, Track, TransitionEdge } from "@openreel/core/types/timeline";
import { FILTER_PRESETS } from "@openreel/core/video/filter-presets";
import { TransitionEngine } from "@openreel/core/video/transition-engine";
import { failure } from "./drafts.mjs";

type Arguments = Record<string, unknown>;
type ActionInput<T extends Action = Action> = T extends Action ? Omit<T, "id" | "timestamp"> : never;

export function invalid(message: string): never {
  throw failure("INVALID_ARGUMENT", message);
}

export function numeric(value: unknown, label: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

export function boundedText(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    invalid(`${label} must be nonempty text of at most ${max} characters.`);
  }
  return value;
}

export function object(value: unknown, label: string): Arguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Arguments;
}

export function writableTrack(project: Project, id: unknown): Track {
  const track = project.timeline.tracks.find(item => item.id === id);
  if (!track) invalid("Track not found in this draft.");
  if (track.locked) invalid("The target track is locked.");
  return track;
}

export function writableClip(project: Project, id: unknown): Clip {
  const track = project.timeline.tracks.find(item => item.clips.some(clip => clip.id === id));
  if (!track) invalid("Clip not found in this draft.");
  const clip = writableTrack(project, track.id).clips.find(item => item.id === id);
  if (!clip) invalid("Clip not found in this draft.");
  return clip;
}

export async function apply(host: HeadlessHost, action: ActionInput) {
  const result = await host.applyAction({ ...action, id: randomUUID(), timestamp: Date.now() } as Action);
  if (!result.success) throw failure("INVALID_EDIT", result.error?.message ?? "OpenReel could not apply the edit.");
}

export async function trimClip(
  host: HeadlessHost, clip: Clip, requested: { inPoint?: unknown; outPoint?: unknown }, signal?: AbortSignal,
) {
  const project = host.getProject();
  const media = project.mediaLibrary.items.find(item => item.id === clip.mediaId);
  const inPoint = requested.inPoint ?? clip.inPoint;
  const outPoint = requested.outPoint ?? clip.outPoint;
  if (typeof inPoint !== "number" || !Number.isFinite(inPoint) || inPoint < 0 ||
      typeof outPoint !== "number" || !Number.isFinite(outPoint) || outPoint <= inPoint ||
      !media || outPoint > (media.type === "image" ? 300 : media.metadata.duration)) {
    throw failure("INVALID_EDIT", "Trim points must define a nonempty range inside the source media.");
  }
  // Update one endpoint at a time, leaving a valid source range in each action.
  const setIn = () => apply(host, { type: "clip/trim", params: { clipId: clip.id, inPoint } });
  const setOut = () => apply(host, { type: "clip/trim", params: { clipId: clip.id, outPoint } });
  if (inPoint >= clip.outPoint) {
    await setOut();
    await setIn();
  } else {
    if (inPoint !== clip.inPoint) await setIn();
    if (outPoint !== clip.outPoint) await setOut();
  }
  const updated = host.getProject().timeline.tracks.flatMap(track => track.clips).find(item => item.id === clip.id);
  if (!updated) throw failure("INVALID_EDIT", "The trimmed clip is missing from the timeline.");
  await retimeAutoCaptions(host, clip, updated, signal);
}

export async function addKeyframe(host: HeadlessHost, args: Arguments) {
  const clip = writableClip(host.getProject(), args.clipId);
  const property = boundedText(args.property, "Keyframe property");
  const reference = parseEffectKeyframeProperty(property);
  const effect = reference && clip.effects.find(item => item.id === reference.effectId);
  const descriptor = reference && effect
    ? deriveEffectDescriptor(effect.id, effect.type, reference.paramKey)
    : getStaticDescriptor(property);
  if (!descriptor || typeof descriptor.min !== "number" || typeof descriptor.max !== "number") {
    invalid("Choose a supported keyframe property.");
  }
  const time = numeric(args.time, "Keyframe time", 0, clip.duration);
  const value = numeric(args.value, "Keyframe value", descriptor.min, descriptor.max);
  if (clip.keyframes.some(frame => frame.property === property && frame.time === time)) {
    invalid("A keyframe already occupies this property and time.");
  }
  const frame = { id: randomUUID(), property, time, value, easing: "linear" as const };
  const keyframes = [...clip.keyframes, frame].sort((first, second) => first.time - second.time);
  await apply(host, { type: "keyframe/setAll", params: { clipId: clip.id, keyframes } });
  return frame;
}

function captionStyle(value: unknown): Partial<TextStyle> {
  if (value === undefined) return {};
  const input = object(value, "Caption style");
  const style: Partial<TextStyle> = {
    ...(input.fontFamily === undefined ? {} : { fontFamily: boundedText(input.fontFamily, "Font family") }),
    ...(input.fontSize === undefined ? {} : { fontSize: numeric(input.fontSize, "Font size", 8, 300) }),
    ...(input.color === undefined ? {} : { color: boundedText(input.color, "Color", 64) }),
    ...(input.backgroundColor === undefined ? {} : { backgroundColor: boundedText(input.backgroundColor, "Background color", 64) }),
  };
  if (Object.keys(input).some(key => !Object.hasOwn(style, key))) invalid("Unsupported caption style field.");
  return style;
}

function textTiming(project: Project, start: unknown, end: unknown) {
  const startTime = numeric(start, "Start time", 0, project.timeline.duration);
  const endTime = numeric(end, "End time", 0, project.timeline.duration);
  if (endTime <= startTime) invalid("Text must occupy a nonempty range in the existing timeline.");
  return { startTime, duration: endTime - startTime };
}

async function textTrack(host: HeadlessHost, caption: boolean, requested?: unknown): Promise<Track> {
  const project = host.getProject();
  const track = requested === undefined
    ? project.timeline.tracks.find(item => !item.locked && (caption ? item.role === "captions" : item.type === "text"))
    : writableTrack(project, requested);
  if (track) return track;
  const trackId = randomUUID();
  await apply(host, { type: "track/add", params: caption
    ? { trackId, trackType: "video", name: "字幕", mode: "standard", role: "captions" }
    : { trackId, trackType: "text", name: "文字" } });
  return writableTrack(host.getProject(), trackId);
}

async function addText(host: HeadlessHost, input: Arguments, caption: boolean, sourceClipId?: string) {
  const project = host.getProject();
  const text = boundedText(input.text, "Text", 4096);
  const timing = textTiming(project, input.startTime, input.endTime);
  const style = captionStyle(input.style);
  const track = await textTrack(host, caption, input.trackId);
  const title = new TitleEngine().createTextClip({
    id: randomUUID(), trackId: track.id, ...timing, text, style,
    ...(caption ? { transform: { position: { x: 0.5, y: 0.86 } }, metadata: {
      captionSource: "openreel",
      ...(sourceClipId ? { captionSourceClipId: sourceClipId, captionSource: "openreel-transcription" } : {}),
    } } : {}),
  });
  await apply(host, { type: "text/create", params: { clip: title } });
  return { id: title.id, trackId: track.id, text: title.text, ...timing };
}

function editableText(project: Project, id: unknown, captions: boolean): TextClip {
  const title = project.textClips?.find(item => item.id === id);
  if (!title) invalid("Text clip not found in this draft.");
  const track = writableTrack(project, title.trackId);
  if (captions && track.role !== "captions" && track.name !== "Captions") {
    invalid("The target text is not on a captions track.");
  }
  return title;
}

async function changeText(host: HeadlessHost, id: unknown, input: Arguments, captions: boolean) {
  const project = host.getProject();
  const current = editableText(project, id, captions);
  const startTime = input.startTime ?? current.startTime;
  const endTime = input.endTime ?? (input.duration === undefined
    ? current.startTime + current.duration
    : numeric(startTime, "Start time") + numeric(input.duration, "Duration"));
  const timing = textTiming(project, startTime, endTime);
  const text = input.text === undefined ? current.text : boundedText(input.text, "Text", 4096);
  const style = { ...current.style, ...captionStyle(input.style) };
  await apply(host, { type: "text/update", params: { clipId: current.id, updates: { text, style, ...timing } } });
  return { id: current.id, trackId: current.trackId, text, ...timing };
}

export async function addSubtitle(host: HeadlessHost, args: Arguments) {
  return addText(host, args, true);
}

function automaticCaptions(project: Project, clipId: string) {
  return (project.textClips ?? []).filter(item => item.metadata?.captionSource === "openreel-transcription" &&
    item.metadata.captionSourceClipId === clipId);
}

function unknownOverlappingCaptions(project: Project, clip: Clip) {
  const overlaps = (start: number, end: number) => start < clip.startTime + clip.duration && end > clip.startTime;
  const captionTracks = new Set(project.timeline.tracks.filter(track =>
    track.role === "captions" || track.name === "Captions").map(track => track.id));
  const clipIds = new Set(project.timeline.tracks.flatMap(track => track.clips.map(item => item.id)));
  const titles = (project.textClips ?? []).filter(item => {
    if (!captionTracks.has(item.trackId) || !overlaps(item.startTime, item.startTime + item.duration)) return false;
    const source = item.metadata?.captionSource;
    const sourceClipId = item.metadata?.captionSourceClipId;
    return source !== "openreel" && (source !== "openreel-transcription" ||
      typeof sourceClipId !== "string" || !clipIds.has(sourceClipId));
  });
  return titles.length + project.timeline.subtitles.filter(item => overlaps(item.startTime, item.endTime)).length;
}

/** Apply the exact cues of an already completed, host-bound panel preview. */
export async function applyAnalyzedCaptions(
  host: HeadlessHost, clipId: unknown, cues: unknown, replaceCaptionIds: unknown, signal?: AbortSignal,
) {
  const project = host.getProject();
  const clip = writableClip(project, clipId);
  const replace = automaticCaptions(project, clip.id);
  const currentIds = new Set(replace.map(item => item.id));
  if (!Array.isArray(replaceCaptionIds) || replaceCaptionIds.length !== replace.length ||
    new Set(replaceCaptionIds).size !== replaceCaptionIds.length || replaceCaptionIds.some(id => !currentIds.has(id))) {
    throw failure("REVISION_CONFLICT", "The automatic captions no longer match the preview. Generate a new preview before saving.");
  }
  if (!Array.isArray(cues) || !cues.length || cues.length > 500) invalid("The caption preview is empty or invalid.");
  const normalized = cues.map(cue => {
    const value = object(cue, "Analyzed caption");
    const startTime = numeric(value.startTime, "Caption start", clip.startTime, clip.startTime + clip.duration);
    const endTime = numeric(value.endTime, "Caption end", clip.startTime, clip.startTime + clip.duration);
    if (endTime <= startTime) invalid("A caption must have a positive duration.");
    return {
      text: boundedText(value.text, "Caption text", 4096),
      startTime, endTime,
    };
  });
  for (const item of replace) writableTrack(project, item.trackId);
  for (const item of replace) {
    signal?.throwIfAborted();
    await apply(host, { type: "text/remove", params: { clipId: item.id } });
  }
  for (const cue of normalized) {
    signal?.throwIfAborted();
    await addText(host, cue, true, clip.id);
  }
  return { project: host.getProject(), cues: normalized };
}

type CaptionCue = { text: string; startTime: number; endTime: number };
export type Transcribe = (path: string, startTime: number, duration: number, language: string | undefined, anchor: { clipId: string }) =>
  Promise<{ cues: CaptionCue[] }>;

function captionLanguage(value: unknown): string | undefined {
  const language = value === undefined ? undefined : boundedText(value, "Language", 24);
  if (language && !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language)) invalid("Use an ISO language code.");
  return language;
}

function captionSource(project: Project, mediaPaths: Record<string, string>, clip: Clip, maxDuration: number) {
  if (clip.metadata?.audioDetached) invalid("Choose the separated WAV clip for automatic captions.");
  const source = project.mediaLibrary.items.find(item => item.id === clip.mediaId);
  const path = mediaPaths[clip.mediaId];
  writableTrack(project, clip.trackId);
  if (!source || !path || source.metadata.hasAudio === false) invalid("Choose clips with a local dialogue source.");
  if (clip.reversed || clip.speedKeyframes?.length || clip.freezeFrames?.length || (clip.audioTrackIndex ?? 0) !== 0) {
    invalid("Automatic captions need forward clips with a constant speed and primary audio.");
  }
  return { path, duration: numeric(clip.outPoint - clip.inPoint, "Clip source duration", 0.001, maxDuration) };
}

async function captionWindow(
  clip: Clip, path: string, offset: number, duration: number, language: string | undefined,
  transcribe: Transcribe, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const response = await transcribe(path, clip.inPoint + offset, duration, language, { clipId: clip.id });
  signal?.throwIfAborted();
  if (!Array.isArray(response?.cues) || response.cues.length > 500) {
    invalid("The transcription returned an invalid caption list.");
  }
  if (!response.cues.length) throw failure("NO_DIALOGUE", "The service returned no usable captions for the audio.");
  const speed = clip.speed ?? 1;
  const clipEnd = clip.startTime + clip.duration;
  return response.cues.map(cue => {
    const start = numeric(cue?.startTime, "Caption start", 0, duration);
    const end = numeric(cue?.endTime, "Caption end", 0, duration);
    const startTime = clip.startTime + (offset + start) / speed;
    const endTime = clip.startTime + (offset + end) / speed;
    const boundedEnd = Math.min(endTime, clipEnd);
    if (boundedEnd <= startTime || endTime > clipEnd + 1e-6) invalid("A caption must have a positive duration inside the clip.");
    return { text: boundedText(cue?.text, "Caption text", 4096), startTime, endTime: boundedEnd };
  });
}

export async function previewAnalyzedCaptions(
  project: Project, args: Arguments, mediaPaths: Record<string, string>, transcribe: Transcribe, signal?: AbortSignal,
) {
  const clip = writableClip(project, args.clipId);
  const { path, duration } = captionSource(project, mediaPaths, clip, 300);
  const replace = automaticCaptions(project, clip.id);
  for (const item of replace) writableTrack(project, item.trackId);
  const cues = await captionWindow(clip, path, 0, duration, captionLanguage(args.language), transcribe, signal);
  return { cues, replaceCaptionIds: replace.map(item => item.id), unknownOverlapCount: unknownOverlappingCaptions(project, clip) };
}

export async function autoCaption(
  host: HeadlessHost, args: Arguments, mediaPaths: Record<string, string>, transcribe: Transcribe, signal?: AbortSignal,
) {
  const project = host.getProject();
  if (args.clipId !== undefined && args.clipIds !== undefined) invalid("Choose clipId or clipIds.");
  const requested = args.clipIds ?? (args.clipId === undefined ? undefined : [args.clipId]);
  if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.length > 50 ||
    new Set(requested).size !== requested.length)) invalid("Choose one to 50 distinct dialogue clips.");
  const clips = (Array.isArray(requested) ? requested.map(id => writableClip(project, id)) :
    project.timeline.tracks.filter(track => !track.muted && (track.type === "video" || track.role === "dialogue"))
      .flatMap(track => track.clips).filter(clip => !clip.metadata?.audioDetached
        && project.mediaLibrary.items.find(item => item.id === clip.mediaId)?.metadata.hasAudio))
    .sort((a, b) => a.startTime - b.startTime);
  if (!clips.length || clips.length > 50 || project.timeline.duration > 300.001) {
    invalid("Choose dialogue clips in a saved timeline of at most 300 seconds.");
  }
  const language = captionLanguage(args.language);
  const sources = clips.map(clip => {
    const source = captionSource(project, mediaPaths, clip, 600);
    if (automaticCaptions(project, clip.id).length) {
      invalid("A selected clip already has automatic captions. Edit those captions in the draft.");
    }
    return { clip, ...source };
  });
  // The host owns incremental decoding and progress within a source batch.
  const sourceBatchSeconds = 300;
  const snippets: { path: string; clip: Clip; offset: number; duration: number }[] = [];
  for (const { clip, path, duration } of sources) {
    for (let offset = 0; offset < duration - 1e-7; offset += sourceBatchSeconds) {
      snippets.push({ clip, path, offset, duration: Math.min(sourceBatchSeconds, duration - offset) });
    }
  }
  if (snippets.reduce((total, snippet) => total + snippet.duration, 0) > 600.001) {
    invalid("The selected clips require more than 600 seconds of source dialogue decoding.");
  }
  const analyzed: { clipId: string; cue: CaptionCue }[] = [];
  for (const { clip, path, offset, duration } of snippets) {
    const cues = await captionWindow(clip, path, offset, duration, language, transcribe, signal);
    if (analyzed.length + cues.length > 500) invalid("A caption job can create at most 500 subtitles.");
    analyzed.push(...cues.map(cue => ({ clipId: clip.id, cue })));
  }
  const captions: Awaited<ReturnType<typeof addText>>[] = [];
  for (const { clipId, cue } of analyzed) {
    signal?.throwIfAborted();
    captions.push(await addText(host, cue, true, clipId));
  }
  return { clipIds: clips.map(clip => clip.id), captions };
}

export async function retimeAutoCaptions(host: HeadlessHost, before: Clip, after: Clip, signal?: AbortSignal) {
  const project = host.getProject();
  const captions = (project.textClips ?? []).filter(item => item.metadata?.captionSourceClipId === before.id &&
    item.metadata.captionSource === "openreel-transcription");
  if (!captions.length) return;
  const mapTime = (time: number) =>
    after.startTime + (before.inPoint + (time - before.startTime) * (before.speed ?? 1) - after.inPoint) / (after.speed ?? 1);
  const end = after.startTime + after.duration;
  for (const caption of captions) {
    signal?.throwIfAborted();
    writableTrack(project, caption.trackId);
    const startTime = Math.max(after.startTime, mapTime(caption.startTime));
    const duration = Math.min(end, mapTime(caption.startTime + caption.duration)) - startTime;
    if (duration <= 0) await apply(host, { type: "text/remove", params: { clipId: caption.id } });
    else if (startTime !== caption.startTime || duration !== caption.duration) {
      await apply(host, { type: "text/update", params: { clipId: caption.id, updates: { startTime, duration } } });
    }
  }
}

export async function updateSubtitle(host: HeadlessHost, args: Arguments) {
  return changeText(host, args.subtitleId, args, true);
}

export async function importSrt(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const source = boundedText(args.srtContent, "SRT content", 64 * 1024);
  const parsed = parseSRT(source);
  if (parsed.errors.length || !parsed.subtitles.length || parsed.subtitles.length > 500) {
    invalid("Provide a valid SRT with one to 500 cues.");
  }
  const captions: Awaited<ReturnType<typeof addText>>[] = [];
  for (const cue of parsed.subtitles) {
    signal?.throwIfAborted();
    captions.push(await addText(host, { text: cue.text, startTime: cue.startTime, endTime: cue.endTime }, true));
  }
  return { captions };
}

export async function setSubtitleStyle(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const style = captionStyle(args.style);
  const project = host.getProject();
  const tracks = new Set(project.timeline.tracks.filter(track => track.role === "captions" || track.name === "Captions").map(track => track.id));
  const captions = (project.textClips ?? []).filter(clip => tracks.has(clip.trackId));
  if (!captions.length) invalid("Add editable captions before changing their style.");
  for (const clip of captions) {
    signal?.throwIfAborted();
    writableTrack(project, clip.trackId);
    await apply(host, { type: "text/update", params: { clipId: clip.id, updates: { style: { ...clip.style, ...style } } } });
  }
  return { captionIds: captions.map(clip => clip.id) };
}

export async function createText(host: HeadlessHost, args: Arguments) {
  const input = object(args.clip, "Text clip");
  const start = numeric(input.startTime, "Start time");
  return addText(host, { ...input, endTime: start + numeric(input.duration, "Duration") }, false);
}

export async function updateText(host: HeadlessHost, args: Arguments) {
  const input = object(args.updates, "Text update");
  if (Object.keys(input).some(key => !["text", "startTime", "duration", "style"].includes(key))) {
    invalid("Text updates support text, start time, duration, and basic style.");
  }
  return changeText(host, args.clipId, input, false);
}

function transitionType(value: unknown): TransitionType {
  const type = TRANSITION_TYPES.find(item => item === value);
  if (!type) invalid("Choose an OpenReel transition type.");
  return type;
}

async function setTransition(host: HeadlessHost, input: Arguments, existingId?: string) {
  const project = host.getProject();
  const clip = writableClip(project, input.clipAId);
  const track = writableTrack(project, clip.trackId);
  if (track.type !== "video" || track.role === "captions") invalid("Transitions require a video track.");
  const type = transitionType(input.transitionType);
  const duration = numeric(input.duration, "Transition duration", 0.001);
  const engine = new TransitionEngine({ width: project.settings.width, height: project.settings.height });
  let transition;
  if (input.edge === "in" || input.edge === "out") {
    const edge: TransitionEdge = input.edge;
    transition = engine.createClipEdgeTransition(clip, edge, type, duration);
  } else {
    const adjacent = writableClip(project, input.clipBId);
    if (!engine.findAdjacentClipPairs(track).some(pair => pair.clipA.id === clip.id && pair.clipB.id === adjacent.id)) {
      invalid("A between-clip transition needs two adjacent clips on the same video track.");
    }
    transition = engine.createTransition(clip, adjacent, type, duration);
  }
  if (!transition) invalid("The selected clips do not support this transition.");
  const occupied = (track.transitions ?? []).find(current => current.clipAId === transition.clipAId &&
    current.clipBId === transition.clipBId && current.edge === transition.edge);
  if (occupied && occupied.id !== existingId) invalid("Update the existing transition explicitly.");
  const result = existingId ? { ...transition, id: existingId } : transition;
  await apply(host, { type: "transition/set", params: { transition: result } });
  return result;
}

export async function addTransition(host: HeadlessHost, args: Arguments) {
  return setTransition(host, args);
}

export async function addClipEdgeTransition(host: HeadlessHost, args: Arguments) {
  return setTransition(host, { ...args, clipAId: args.clipId });
}

export async function updateTransition(host: HeadlessHost, args: Arguments) {
  const current = host.getProject().timeline.tracks.flatMap(track => track.transitions ?? [])
    .find(item => item.id === args.transitionId);
  if (!current) invalid("Transition not found in this draft.");
  return setTransition(host, {
    clipAId: current.clipAId, clipBId: current.clipBId, edge: current.edge,
    transitionType: args.type ?? current.type, duration: args.duration ?? current.duration,
  }, current.id);
}

export function listFilterPresets() {
  return { presets: FILTER_PRESETS.map(({ id, name, category, description }) => ({ id, name, category, description })) };
}

export async function applyFilterPreset(host: HeadlessHost, args: Arguments, signal?: AbortSignal) {
  const clip = writableClip(host.getProject(), args.clipId);
  const preset = FILTER_PRESETS.find(item => item.id === args.presetId);
  if (!preset) invalid("Filter preset not found. Read the list of available filter presets.");
  const effectIds: string[] = [];
  for (const effect of preset.effects) {
    signal?.throwIfAborted();
    const effectId = randomUUID();
    await apply(host, { type: "effect/add", params: {
      clipId: clip.id, effectId, effectType: effect.type, params: { ...effect.params },
    } });
    effectIds.push(effectId);
  }
  return { presetId: preset.id, clipId: clip.id, effectIds };
}
