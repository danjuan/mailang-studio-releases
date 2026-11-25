import { parseEffectKeyframeProperty } from "@openreel/core/animation/keyframe-properties";
import { calculateProjectDuration } from "@openreel/core/timeline/project-duration";
import type { Project } from "@openreel/core/types/project";
import type { Clip, Effect, Track } from "@openreel/core/types/timeline";
import { invalid, object } from "./mcp-editing-native";

const kinds = ["clip", "caption", "text", "transition", "video_effect", "audio_effect"] as const;
type Kind = typeof kinds[number];
type TimelineObject = { kind: Kind; id: string; clipId?: string };
type ImpactDisplay = { kind: Kind | "keyframe"; name: string; detail?: string; start?: number; end?: number; attachedCount?: number };
type Impact = { id: string; label: string; display: ImpactDisplay };
const identifier = { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" };
const inputSchema = {
  type: "object", additionalProperties: false, required: ["objects"],
  properties: {
    objects: {
      type: "array", minItems: 1, maxItems: 32,
      items: {
        type: "object", additionalProperties: false, required: ["kind", "id"],
        properties: { kind: { enum: [...kinds] }, id: identifier, clipId: identifier },
      },
    },
  },
};

export const objectDeletionCapabilities = [
  {
    name: "preview_delete_objects", domain: "clip",
    description: "Preview exact saved clip, caption, text, transition, video effect and audio effect IDs. Effects need their owning clipId. Lists affected transitions, retained captions and dependent keyframes. Changes nothing.",
    inputSchema, readOnly: true, destructive: false, expensive: false,
  },
  {
    name: "delete_objects", domain: "clip",
    description: "Delete the exact approved timeline objects in one revision. Leaves surviving timeline positions and source files intact. Must run separately after confirmation of preview_delete_objects.",
    inputSchema, readOnly: false, destructive: true, expensive: false,
  },
] as const;

const effectKind = (kind: Kind) => kind === "audio_effect" || kind === "video_effect";
const matches = (first: TimelineObject, second: TimelineObject) =>
  first.kind === second.kind && first.id === second.id && first.clipId === second.clipId;

function readObjects(value: unknown): TimelineObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid("Choose one to 32 timeline objects.");
  const objects = value.map(entry => {
    const fields = object(entry, "Timeline object");
    const { id, clipId } = fields;
    const kind = kinds.find(candidate => candidate === fields.kind);
    if (!kind || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      invalid("Choose an exact timeline object kind and ID from the saved draft.");
    }
    if (effectKind(kind)) {
      if (typeof clipId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(clipId) || Object.keys(fields).length !== 3) {
        invalid("A clip effect needs its exact owning clip ID.");
      }
      return { kind, id, clipId };
    }
    if (Object.keys(fields).length !== 2) invalid("Only clip effects take an owning clip ID.");
    return { kind, id };
  });
  if (objects.some((target, i) => objects.slice(0, i).some(other => matches(target, other)))) {
    invalid("Each object may appear only once.");
  }
  return objects;
}

export function matchesObjectDeletion(approval: unknown, revision: number, requested: unknown): boolean {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
  const grant = approval as Record<string, unknown>;
  if (Object.keys(grant).length !== 2 || grant.revision !== revision || revision < 1) return false;
  const objects = readObjects(requested);
  const accepted = readObjects(grant.objects);
  return accepted.length === objects.length && objects.every((item, index) => matches(item, accepted[index]));
}

const cleanName = (name: string) => name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 96);

const describe = (type: string, name: string, start?: number, end?: number) => {
  const label = cleanName(name);
  const timing = start !== undefined ? ` at ${Number(start.toFixed(3))}–${Number((end ?? start).toFixed(3))} s` : "";
  return `${type} · ${label}${timing}`.slice(0, 190);
};

function impactDisplay(kind: ImpactDisplay["kind"], name: string, extra: Partial<Omit<ImpactDisplay, "kind" | "name">> = {}): ImpactDisplay {
  return { kind, name: cleanName(name), ...extra };
}

function single<T>(entries: T[], label: string): T {
  if (entries.length !== 1) invalid(`The ${label} ID must identify exactly one saved object.`);
  return entries[0];
}

function unlocked(track: Track | undefined) {
  if (!track || track.locked) invalid("Unlock the affected track before removing these objects.");
}

/** Resolves impact from the draft for both the preview and the final atomic edit. */
export function planObjectDeletion(project: Project, input: unknown) {
  const objects = readObjects(input);
  const { timeline } = project;
  const clips = timeline.tracks.flatMap(track => track.clips.map(clip => ({ clip, track })));
  const transitions = timeline.tracks.flatMap(track => (track.transitions ?? []).map(transition => ({ transition, track })));
  const titles = project.textClips ?? [];
  const subtitles = timeline.subtitles ?? [];
  const clipIds = new Set(objects.filter(item => item.kind === "clip").map(item => item.id));
  const transitionIds = new Set<string>();
  const titleIds = new Set<string>();
  const subtitleIds = new Set<string>();
  const effects = new Map<string, { audio: Set<string>; video: Set<string> }>();
  const affectedCaptionIds = new Set<string>();
  const removedTransitions: Impact[] = [];
  const retainedCaptions: Impact[] = [];
  const removedKeyframes: Impact[] = [];
  const trackOf = (trackId: string) => timeline.tracks.find(track => track.id === trackId);
  const displayClip = (clip: Clip) => project.mediaLibrary.items.find(item => item.id === clip.mediaId)?.name ?? clip.id;
  const target = (object: TimelineObject, label: string, display: ImpactDisplay) => ({ ...object, label, display });
  const targets = objects.map(item => {
    const { kind, id, clipId } = item;
    if (kind === "clip" || effectKind(kind)) {
      const { clip, track } = single(clips.filter(entry => entry.clip.id === (clipId ?? id)), "clip");
      unlocked(track);
      if (clip.metadata?.motionClip || clip.metadata?.templateSource || clip.metadata?.templateManaged ||
          clip.metadata?.appliedTemplates?.length) invalid("This clip is part of a composition or an applied template.");
      if (kind === "clip") {
        if (project.masks?.some(mask => mask.clipId === id || mask.sourceClipId === id)
          || timeline.beatAnalysis?.sourceClipId === id) {
          invalid("Remove the clip's mask or beat analysis links before deleting it.");
        }
        const attachments = (clip.effects?.length ?? 0) + (clip.audioEffects?.length ?? 0) + (clip.keyframes?.length ?? 0);
        const type = attachments ? `Clip with ${attachments} effects or keyframes` : "Clip";
        const name = `${track.name} / ${displayClip(clip)}`;
        const start = clip.startTime;
        const end = start + clip.duration;
        return target(item, describe(type, name, start, end), impactDisplay(kind, name, { start, end, attachedCount: attachments }));
      }
      if (clipIds.has(clip.id)) invalid("The clip already includes its effects. Select either the clip or its effects.");
      const pool = kind === "video_effect" ? clip.effects : clip.audioEffects;
      const effect = single((pool ?? []).filter(candidate => candidate.id === id), "effect");
      if (effect.metadata?.templateSource) invalid("This effect is part of an applied template.");
      const groups = effects.get(clip.id) ?? { audio: new Set<string>(), video: new Set<string>() };
      (kind === "video_effect" ? groups.video : groups.audio).add(id);
      effects.set(clip.id, groups);
      const label = (kind === "video_effect" ? "Video effect" : "Audio effect");
      const name = `${track.name} / ${displayClip(clip)}`;
      const start = clip.startTime;
      const end = start + clip.duration;
      return target(item, describe(label, `${effect.type} on ${name}`, start, end), impactDisplay(kind, name, { start, end, detail: effect.type }));
    }
    if (kind === "transition") {
      const { transition, track } = single(transitions.filter(entry => entry.transition.id === id), "transition");
      unlocked(track);
      transitionIds.add(id);
      const source = clips.find(entry => entry.clip.id === transition.clipAId)?.clip;
      const at = source && (transition.edge === "in" ? source.startTime : source.startTime + source.duration);
      return target(item, describe("Transition", `${track.name} / ${transition.type}`, at), impactDisplay(kind, track.name, { start: at, detail: transition.type }));
    }
    const typed = titles.filter(title => title.id === id && (trackOf(title.trackId)?.role === "captions") === (kind === "caption"));
    const legacy = kind === "caption" ? subtitles.filter(subtitle => subtitle.id === id) : [];
    if (typed.length + legacy.length !== 1) invalid("Choose the exact caption or ordinary text ID.");
    const title = typed[0];
    if (title) {
      unlocked(trackOf(title.trackId));
      if (title.metadata?.templateSource || project.masks?.some(mask => mask.clipId === id || mask.sourceClipId === id)) {
        invalid("Remove the text's template or mask links before deleting it.");
      }
      titleIds.add(id);
      const start = title.startTime;
      const end = start + title.duration;
      return target(item, describe(kind === "caption" ? "Caption" : "Text", title.text, start, end), impactDisplay(kind, title.text, { start, end }));
    }
    // The legacy subtitle layer has no track of its own.
    const subtitle = legacy[0];
    subtitleIds.add(id);
    return target(item, describe("Caption", subtitle.text, subtitle.startTime, subtitle.endTime),
      impactDisplay(kind, subtitle.text, { start: subtitle.startTime, end: subtitle.endTime }));
  });

  for (const { transition, track } of transitions) {
    if (!clipIds.has(transition.clipAId) && (!transition.clipBId || !clipIds.has(transition.clipBId))) continue;
    unlocked(track);
    if (!transitionIds.has(transition.id)) {
      removedTransitions.push({
        id: transition.id, label: describe("Transition", `${transition.type} (${transition.id})`),
        display: impactDisplay("transition", track.name, { detail: transition.type }),
      });
    }
    transitionIds.add(transition.id);
  }
  for (const title of titles) {
    const sourceId = title.metadata?.captionSourceClipId;
    if (typeof sourceId !== "string" || !clipIds.has(sourceId) || titleIds.has(title.id)) continue;
    unlocked(trackOf(title.trackId));
    if (trackOf(title.trackId)?.role !== "captions") invalid("A non-caption item is linked to the clip.");
    affectedCaptionIds.add(title.id);
    const start = title.startTime;
    const end = start + title.duration;
    retainedCaptions.push({
      id: title.id, label: describe("Caption", title.text, start, end),
      display: impactDisplay("caption", title.text, { start, end }),
    });
  }
  const keepEffects = (clip: Clip) => {
    const picked = effects.get(clip.id);
    if (!picked) return clip;
    const keyframes = (clip.keyframes ?? []).filter(frame => {
      const effectId = parseEffectKeyframeProperty(frame.property)?.effectId;
      if (!effectId || !picked.video.has(effectId)) return true;
      const start = clip.startTime + frame.time;
      removedKeyframes.push({
        id: frame.id, label: describe("Keyframe", frame.property, start),
        display: impactDisplay("keyframe", frame.property, { start }),
      });
      return false;
    });
    const keep = (list: Effect[] | undefined, selected: Set<string>) => (list ?? []).filter(effect => !selected.has(effect.id));
    return { ...clip, effects: keep(clip.effects, picked.video), audioEffects: keep(clip.audioEffects, picked.audio), keyframes };
  };
  const next: Project = {
    ...project, modifiedAt: Date.now(),
    timeline: {
      ...timeline,
      tracks: timeline.tracks.map(track => ({
        ...track,
        clips: track.clips.filter(clip => !clipIds.has(clip.id)).map(keepEffects),
        transitions: (track.transitions ?? []).filter(transition => !transitionIds.has(transition.id)),
      })),
      subtitles: subtitles.filter(subtitle => !subtitleIds.has(subtitle.id)),
    },
    ...(project.textClips ? { textClips: titles.filter(title => !titleIds.has(title.id)).map(title => {
      if (!affectedCaptionIds.has(title.id)) return title;
      const metadata = { ...title.metadata };
      delete metadata.captionSourceClipId;
      return { ...title, metadata };
    }) } : {}),
  };
  if ([removedTransitions, retainedCaptions, removedKeyframes].some(items => items.length > 64)) {
    invalid("Choose fewer objects so the confirmation can show every affected item.");
  }
  const duration = clipIds.size || titleIds.size || subtitleIds.size ? calculateProjectDuration(next) : timeline.duration;
  return {
    project: { ...next, timeline: { ...next.timeline, duration } },
    preview: { objects, targets, removedTransitions, retainedCaptions, removedKeyframes, duration, previousDuration: timeline.duration },
  };
}
