import { randomUUID } from "node:crypto";
import type { HeadlessHost } from "@openreel/agent/headless-host";
import { getVolumeAutomationPointsForRange } from "@openreel/core/audio/clip-volume-automation";
import { exportSRT } from "@openreel/core/text/subtitle-engine";
import type { Project } from "@openreel/core/types/project";
import type { AutomationPoint, Clip, Transition } from "@openreel/core/types/timeline";
import { TransitionEngine } from "@openreel/core/video/transition-engine";
import { boundedText, invalid, numeric, object, writableClip } from "./mcp-editing-native";

type Range = { start: number; end: number };
type Arguments = Record<string, unknown>;

const interval = {
  type: "object",
  additionalProperties: false,
  properties: { start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 } },
  required: ["start", "end"],
};

export const shortDramaCapabilities = [
  {
    name: "ripple_delete_ranges", domain: "clip",
    description: "Remove one or more explicit time ranges, in original timeline seconds, and close the resulting gaps across all tracks. Use only when the user specified the ranges or approved the exact suggested ranges.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { ranges: { type: "array", minItems: 1, maxItems: 32, items: interval } }, required: ["ranges"] },
    readOnly: false, destructive: true, expensive: false,
  },
  {
    name: "preview_ripple_delete", domain: "clip",
    description: "Validate exact cut ranges against the saved timeline and preview their impact without changing the draft.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { ranges: { type: "array", minItems: 1, maxItems: 32, items: interval } }, required: ["ranges"] },
    readOnly: true, destructive: false, expensive: false,
  },
  {
    name: "duck_music", domain: "audio",
    description: "Apply reversible music-volume automation under the editable dialogue captions. Specify the BGM clip, not the dialogue source.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      clipId: { type: "string" }, reductionDb: { type: "number", minimum: 1, maximum: 30 },
    }, required: ["clipId"] },
    readOnly: false, destructive: false, expensive: false,
  },
  {
    name: "export_srt", domain: "subtitle",
    description: "Read the current editable caption track as standard SRT text.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    readOnly: true, destructive: false, expensive: false,
  },
] as const;

function union(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function readRanges(value: unknown, duration: number): Range[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) invalid("Provide one to 32 original timeline ranges.");
  return union(value.map(value => {
    const range = object(value, "Cut range");
    if (Object.keys(range).length !== 2) invalid("Each cut range has only a start and end.");
    const start = numeric(range.start, "Cut start", 0, duration);
    const end = numeric(range.end, "Cut end", 0, duration);
    if (start >= end) invalid("Every cut range must have a positive duration.");
    return { start, end };
  }));
}

function timeMapping(ranges: Range[]) {
  const includes = (time: number) => ranges.some(({ start, end }) => start <= time && time < end);
  const map = (time: number) => time - ranges.reduce(
    (removed, { start, end }) => removed + Math.max(0, Math.min(time, end) - start), 0);
  const keep = (start: number, end: number): Range[] => {
    const result: Range[] = [];
    let cursor = start;
    for (const cut of ranges) {
      if (cut.end <= cursor) continue;
      if (cut.start >= end) break;
      if (cut.start > cursor) result.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < end) result.push({ start: cursor, end });
    return result;
  };
  return { includes, map, keep };
}

export function rippleDelete(host: HeadlessHost, args: Arguments) {
  const project = host.getProject();
  const { timeline } = project;
  const ranges = readRanges(args.ranges, timeline.duration);
  const { includes, map, keep } = timeMapping(ranges);
  const pieces = new Map<string, { original: Range; clip: Clip }[]>();
  const unlocked = (trackId: string | undefined, changed: boolean) => {
    if (changed && timeline.tracks.some(track => track.id === trackId && track.locked)) {
      invalid("Unlock the affected tracks before removing these time ranges.");
    }
  };
  const takePieces = (clip: Clip): Clip[] => {
    const end = clip.startTime + clip.duration;
    const remainder = keep(clip.startTime, end);
    const partial = remainder.length > 0 && (remainder.length > 1 ||
      remainder[0].start !== clip.startTime || remainder[0].end !== end);
    unlocked(clip.trackId, partial || !remainder.length || map(clip.startTime) !== clip.startTime);
    if (partial && (clip.speedKeyframes?.length || clip.freezeFrames?.length || clip.keyframes.length ||
        clip.automation?.pan?.length || clip.emphasisAnimation)) {
      invalid("The range crosses a clip with timing or automation that cannot be cut precisely.");
    }
    const speed = clip.speed ?? 1;
    const slices = remainder.map((original, index) => {
      const { start, end: stop } = original;
      const duration = stop - start;
      const from = (start - clip.startTime) * speed;
      const to = (stop - clip.startTime) * speed;
      const slice = {
        ...clip, id: index === 0 ? clip.id : randomUUID(), startTime: map(start), duration,
        inPoint: !partial ? clip.inPoint : clip.reversed ? clip.outPoint - to : clip.inPoint + from,
        outPoint: !partial ? clip.outPoint : clip.reversed ? clip.outPoint - from : clip.inPoint + to,
        ...(partial && clip.automation?.volume?.length ? { automation: { ...clip.automation,
          volume: getVolumeAutomationPointsForRange(clip.automation.volume, start - clip.startTime, duration, clip.volume),
        } } : {}),
        ...(clip.fade && partial ? { fade: {
          fadeIn: start === clip.startTime ? Math.min(duration, clip.fade.fadeIn) : 0,
          fadeOut: stop === end ? Math.min(duration, clip.fade.fadeOut) : 0,
        } } : {}),
      };
      return { original, clip: slice };
    });
    pieces.set(clip.id, slices);
    return slices.map(piece => piece.clip);
  };
  const transitionEngine = new TransitionEngine({ width: project.settings.width, height: project.settings.height });
  const tracks = timeline.tracks.map(track => {
    const clips = track.clips.flatMap(takePieces);
    const adjacent = transitionEngine.findAdjacentClipPairs({ ...track, clips });
    const transitions = track.transitions.flatMap((transition): Transition[] => {
      const left = pieces.get(transition.clipAId);
      if (!left?.length) return [];
      const a = transition.edge === "in" ? left[0].clip : left.at(-1)!.clip;
      const b = transition.clipBId ? pieces.get(transition.clipBId)?.[0]?.clip : undefined;
      if (transition.clipBId && (!b || !adjacent.some(pair => pair.clipA.id === a.id && pair.clipB.id === b.id))) return [];
      const duration = Math.min(transition.duration, a.duration / 2, b ? b.duration / 2 : Infinity);
      return duration > 0 ? [{ ...transition, clipAId: a.id, ...(b ? { clipBId: b.id } : {}), duration }] : [];
    });
    return { ...track, clips, transitions };
  });
  const retimeOverlay = <T extends {
    startTime: number; duration: number; trackId?: string; keyframes?: readonly unknown[];
    metadata?: Readonly<Record<string, unknown>>;
  }>(item: T, animated = false): T[] => {
    const end = item.startTime + item.duration;
    const duration = map(end) - map(item.startTime);
    const startTime = map(item.startTime);
    unlocked(item.trackId, duration !== item.duration || startTime !== item.startTime);
    if (duration <= 0) return [];
    if (Math.abs(duration - item.duration) > 1e-7 && (animated || item.keyframes?.length)) {
      invalid("The range crosses an animated overlay that cannot be cut precisely.");
    }
    const sourceId = item.metadata?.captionSourceClipId;
    const source = typeof sourceId === "string" ? pieces.get(sourceId) : undefined;
    const captionClip = source?.find(({ original }) => original.end > item.startTime && original.start < end)?.clip;
    return [{ ...item, startTime, duration, ...(captionClip ? {
      metadata: { ...item.metadata, captionSourceClipId: captionClip.id },
    } : {}) }];
  };
  if (project.nestedInstances?.length || project.adjustmentLayers?.length || project.multicamGroups?.length) {
    invalid("Remove unsupported nested, adjustment or multicam layers before cutting ranges.");
  }
  const duration = map(timeline.duration);
  host.setProject({
    ...project, modifiedAt: Date.now(),
    timeline: {
      ...timeline, tracks, duration, beatMarkers: undefined, beatAnalysis: undefined,
      markers: timeline.markers.filter(item => !includes(item.time)).map(item => ({ ...item, time: map(item.time) })),
      subtitles: timeline.subtitles.flatMap(item => {
        const startTime = map(item.startTime);
        const endTime = map(item.endTime);
        return startTime < endTime ? [{ ...item, startTime, endTime,
          words: item.words?.flatMap(word => map(word.endTime) > map(word.startTime) ?
            [{ ...word, startTime: map(word.startTime), endTime: map(word.endTime) }] : []),
        }] : [];
      }),
    },
    textClips: project.textClips?.flatMap(item => retimeOverlay(item, !!item.animation || !!item.emphasisAnimation)),
    shapeClips: project.shapeClips?.flatMap(item => retimeOverlay(item, !!item.emphasisAnimation)),
    svgClips: project.svgClips?.flatMap(item => retimeOverlay(item, !!item.entryAnimation || !!item.exitAnimation || !!item.emphasisAnimation)),
    stickerClips: project.stickerClips?.flatMap(item => retimeOverlay(item, !!item.emphasisAnimation)),
    motionInstances: project.motionInstances?.flatMap(item => retimeOverlay(item, true)),
  });
  return { removedDuration: timeline.duration - duration, duration, ranges };
}

function dialogueCues(project: Project) {
  const tracks = new Set(project.timeline.tracks.filter(track => track.role === "captions").map(track => track.id));
  return [
    ...project.timeline.subtitles,
    ...((project.textClips ?? []).filter(clip => tracks.has(clip.trackId)).map(clip => ({
      id: clip.id, text: clip.text, startTime: clip.startTime, endTime: clip.startTime + clip.duration,
    }))),
  ].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

export function exportCaptions(project: Project) {
  const captions = dialogueCues(project);
  if (!captions.length) invalid("Add editable dialogue captions before exporting SRT.");
  return { format: "srt", cues: captions.length, content: exportSRT(captions) };
}

export function duckMusic(host: HeadlessHost, args: Arguments) {
  const project = host.getProject();
  const clip = writableClip(project, boundedText(args.clipId, "Music clip ID"));
  if (project.mediaLibrary.items.find(media => media.id === clip.mediaId)?.type !== "audio") {
    invalid("Select a standalone audio clip for the background music.");
  }
  const reduction = numeric(args.reductionDb ?? 12, "Music reduction in dB", 1, 30);
  const speech = union(dialogueCues(project).map(cue => ({
    start: Math.max(0, cue.startTime - clip.startTime),
    end: Math.min(clip.duration, cue.endTime - clip.startTime),
  })).filter(range => range.start < range.end));
  if (!speech.length) invalid("No editable dialogue captions overlap the music clip.");
  const points = new Map<number, AutomationPoint>();
  const duckedLevel = clip.volume * Math.pow(10, -reduction / 20);
  function add(time: number, value: number) {
    const prior = points.get(time);
    if (!prior || value < prior.value) points.set(time, { time, value });
  }
  add(0, clip.volume);
  add(clip.duration, clip.volume);
  const windows = union(speech.map(({ start, end }) => ({
    start: Math.max(0, start - .12), end: Math.min(clip.duration, end + .25),
  })));
  for (const window of windows) {
    const cues = speech.filter(({ start, end }) => start >= window.start && end <= window.end);
    add(window.start, clip.volume);
    add(cues[0].start, duckedLevel);
    add(cues.at(-1)!.end, duckedLevel);
    add(window.end, clip.volume);
  }
  const volume = [...points.values()].sort((a, b) => a.time - b.time);
  const tracks = project.timeline.tracks.map(track => track.id !== clip.trackId ? track : ({
    ...track,
    clips: track.clips.map(item => item.id !== clip.id ? item : ({
      ...item, automation: { ...item.automation, volume },
    })),
  }));
  host.setProject({ ...project, timeline: { ...project.timeline, tracks }, modifiedAt: Date.now() });
  return { clipId: clip.id, reductionDb: reduction, dialogueRanges: speech.length, points: volume.length };
}
