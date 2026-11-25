import type { Project } from "@openreel/core/types/project";
import type { Clip } from "@openreel/core/types/timeline";
import { invalid, numeric, object } from "./mcp-editing-native";
import { failure } from "./drafts.mjs";

type Range = { start: number; end: number };
type SilenceSettings = {
  threshold: number;
  minSilenceDuration: number;
  paddingBefore: number;
  paddingAfter: number;
};
type NativeSilence = (path: string, startTime: number, duration: number, channels: 1 | 2,
  threshold: number, minFrameSeconds: number) => Promise<{ ranges: Range[]; allQuiet: boolean }>;

const settingsSchema = {
  type: "object", additionalProperties: false, properties: {
    threshold: { type: "number", minimum: -80, maximum: -20 },
    minSilenceDuration: { type: "number", minimum: 0.1, maximum: 2 },
    paddingBefore: { type: "number", minimum: 0, maximum: 2 },
    paddingAfter: { type: "number", minimum: 0, maximum: 2 },
  },
};

export const detectSilenceCapability = {
  name: "detect_silence", domain: "audio",
  description: "Find low-volume ranges in one local dialogue clip. Returns only cut candidates in saved timeline seconds and never edits the draft. Use preview_ripple_delete before proposing a cut.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    clipId: { type: "string", minLength: 1, maxLength: 128 }, settings: settingsSchema,
  }, required: ["clipId"] },
  readOnly: true, destructive: false, expensive: true,
};

const defaults: SilenceSettings = { threshold: -40, minSilenceDuration: 0.5, paddingBefore: 0.1, paddingAfter: 0.1 };

function getSettings(value: unknown): SilenceSettings {
  if (value === undefined) return defaults;
  const settings = object(value, "Silence settings");
  if (Object.keys(settings).some(key => !Object.hasOwn(defaults, key))) invalid("Unsupported silence setting.");
  return Object.fromEntries(Object.entries(settingsSchema.properties).map(([key, range]) =>
    [key, numeric(settings[key] ?? defaults[key as keyof SilenceSettings], key, range.minimum, range.maximum)],
  )) as SilenceSettings;
}

function overlappingDialogue(project: Project, selected: Clip) {
  const sources = new Map(project.mediaLibrary.items.map(item => [item.id, item]));
  const dialogue = project.timeline.tracks.filter(track =>
    !track.muted && !["music", "effects", "ambience", "captions"].includes(track.role ?? "general"),
  ).flatMap(track => track.clips).filter(clip => {
    if (clip.id === selected.id) return false;
    const metadata = sources.get(clip.mediaId)?.metadata;
    return !!metadata && (metadata.hasAudio ?? (metadata.channels > 0))
      && (clip.volume !== 0 || clip.automation?.volume?.some(point => point.value > 0));
  });
  return (range: Range) => dialogue.some(clip => clip.startTime < range.end && clip.startTime + clip.duration > range.start);
}

export async function analyzeSilence(
  project: Project, args: Record<string, unknown>, mediaPaths: Record<string, string>,
  detect: NativeSilence, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const matches = project.timeline.tracks.flatMap(track => track.clips.map(clip => ({ clip, track })));
  const active = matches.find(({ clip }) => clip.id === args.clipId);
  if (!active) invalid("Select a dialogue clip in the current saved draft.");
  const { clip, track } = active;
  const source = project.mediaLibrary.items.find(item => item.id === clip.mediaId);
  const path = mediaPaths[clip.mediaId];
  const channels = source?.metadata.channels;
  if (!path || !source || source.metadata.hasAudio === false || !channels) {
    throw failure("NO_AUDIO_TRACK", "This clip has no local audio track to analyze.");
  }
  if (channels !== 1 && channels !== 2) invalid("Silence analysis supports mono or stereo dialogue.");
  if (track.muted || (clip.volume === 0 && !clip.automation?.volume?.some(point => point.value > 0))) {
    invalid("Select an audible dialogue clip.");
  }
  if (track.locked || ["music", "effects", "ambience", "captions"].includes(track.role ?? "general")) {
    invalid("Choose an unlocked dialogue clip.");
  }
  const speed = numeric(clip.speed ?? 1, "Clip speed", 0.1, 8);
  if (clip.reversed || clip.speedKeyframes?.length || clip.freezeFrames?.length || (clip.audioTrackIndex ?? 0) !== 0) {
    invalid("Silence analysis requires forward dialogue at a constant speed using its primary audio.");
  }
  const requested = numeric(clip.outPoint - clip.inPoint, "Source duration", 0.001, 300);
  if (clip.duration <= 0 || clip.duration > 300.001) invalid("Select a dialogue clip of at most five minutes.");
  const settings = getSettings(args.settings);
  const minimumSourceDuration = Math.max(0.1, (settings.minSilenceDuration + settings.paddingBefore + settings.paddingAfter) * speed);
  if (minimumSourceDuration > requested) return { ranges: [], totalSeconds: 0, reason: "NO_SILENCE" };
  const native = await detect(path, clip.inPoint, requested, channels, settings.threshold, minimumSourceDuration);
  signal?.throwIfAborted();
  if (native.allQuiet) return { ranges: [], totalSeconds: 0, reason: "ALL_QUIET" };
  if (!Array.isArray(native.ranges)) invalid("The local silence detector returned invalid ranges.");
  const clipEnd = clip.startTime + clip.duration;
  const all = native.ranges.map(range => {
    const start = clip.startTime + numeric(range.start, "Silence start", 0, requested) / speed + settings.paddingBefore;
    const end = Math.min(clipEnd, clip.startTime + numeric(range.end, "Silence end", 0, requested) / speed) - settings.paddingAfter;
    return { start: Math.ceil(start * 1000 - 1e-6) / 1000, end: Math.floor(end * 1000 + 1e-6) / 1000 };
  }).filter(range => range.end - range.start >= settings.minSilenceDuration - 0.000001);
  const overlaps = overlappingDialogue(project, clip);
  const ranges = all.filter(range => !overlaps(range));
  if (ranges.length > 32) throw failure("TOO_MANY_RANGES", "More than 32 quiet sections were found. Increase the minimum duration and analyze again.");
  return {
    ranges,
    totalSeconds: Math.round(ranges.reduce((total, range) => total + range.end - range.start, 0) * 1000) / 1000,
    ...(ranges.length ? {} : { reason: all.length ? "DIALOGUE_OVERLAP" : "NO_SILENCE" }),
  };
}
