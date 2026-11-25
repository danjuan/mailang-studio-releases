import { parseOpenReelRippleRange, type OpenReelRippleRange } from "./expert-teams.js";

export const openReelApprovalChoices = {
  ripple: "Delete ranges and close gaps",
  template: "Replace timeline with template",
  objects: "Delete these timeline objects",
} as const;
export const keepOpenReelDraftChoice = "Keep the draft";

const objectKinds = ["clip", "caption", "text", "transition", "video_effect", "audio_effect", "keyframe"] as const;
export type OpenReelApprovalImpact = {
  kind: typeof objectKinds[number];
  name: string;
  detail?: string;
  start?: number;
  end?: number;
  attachedCount?: number;
};

type TimelineChange = { previousDuration: number; duration: number };
type RippleImpact = TimelineChange & {
  captionCount: number;
  musicClipCount: number;
  overlayCount: number;
};
type RemovalImpact = TimelineChange & {
  targets: OpenReelApprovalImpact[];
  removedTransitions: OpenReelApprovalImpact[];
  retainedCaptions: OpenReelApprovalImpact[];
  removedKeyframes: OpenReelApprovalImpact[];
};

/** Optional, host-generated display data. Acceptance still uses the original option values. */
export type OpenReelApprovalPresentation =
  | { kind: "ripple"; revision: number; ranges: OpenReelRippleRange[]; impact?: RippleImpact }
  | { kind: "template"; revision: number; templateId: string; name: string; replacedDuration: number }
  | { kind: "objects"; revision: number; impact?: RemovalImpact };

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return seconds(value) && Number.isSafeInteger(value);
}

function parseImpactItems(value: unknown): OpenReelApprovalImpact[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return;
  const items: OpenReelApprovalImpact[] = [];
  for (const value_ of value) {
    const item = record(value_);
    if (!item) return;
    const { name, detail, start, end, attachedCount } = item;
    const kind = objectKinds.find(kind => item.kind === kind);
    if (!kind || typeof name !== "string" || name.length > 128
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
      || (detail !== undefined && (typeof detail !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(detail)))
      || (start !== undefined && !seconds(start))
      || (end !== undefined && (!seconds(end) || start === undefined || end < start))
      || (attachedCount !== undefined && !count(attachedCount))) return;
    items.push({
      kind, name,
      ...(detail !== undefined ? { detail } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(attachedCount !== undefined ? { attachedCount } : {}),
    });
  }
  return items;
}

/** Parse persisted/transported presentation before interpolating it into the UI. */
export function parseOpenReelApprovalPresentation(value: unknown): OpenReelApprovalPresentation | undefined {
  const source = record(value);
  if (!source || !count(source.revision)) return;
  const { kind, revision } = source;
  const impact = record(source.impact);
  const { previousDuration, duration } = impact ?? {};
  const timing = seconds(previousDuration) && seconds(duration) ? { previousDuration, duration } : undefined;
  if (kind === "ripple") {
    if (!Array.isArray(source.ranges) || source.ranges.length < 1 || source.ranges.length > 32) return;
    const ranges: OpenReelRippleRange[] = [];
    for (const value_ of source.ranges) {
      const range = parseOpenReelRippleRange(value_);
      if (!range) return;
      ranges.push(range);
    }
    const { captionCount, musicClipCount, overlayCount } = impact ?? {};
    return {
      kind, revision, ranges,
      ...(timing && timing.duration <= timing.previousDuration && count(captionCount) && count(musicClipCount) && count(overlayCount)
        ? { impact: { ...timing, captionCount, musicClipCount, overlayCount } } : {}),
    };
  }
  if (kind === "template") {
    const { templateId, name, replacedDuration } = source;
    if (typeof templateId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) || typeof name !== "string"
      || !name.trim() || name.length > 128 || !seconds(replacedDuration)) return;
    return { kind, revision, templateId, name, replacedDuration };
  }
  if (kind === "objects") {
    const targets = parseImpactItems(impact?.targets);
    const removedTransitions = parseImpactItems(impact?.removedTransitions);
    const retainedCaptions = parseImpactItems(impact?.retainedCaptions);
    const removedKeyframes = parseImpactItems(impact?.removedKeyframes);
    return {
      kind, revision,
      ...(timing && targets?.length && targets.length <= 32 && removedTransitions && retainedCaptions && removedKeyframes
        ? { impact: { ...timing, targets, removedTransitions, retainedCaptions, removedKeyframes } } : {}),
    };
  }
}
