import type { MotionComposition, Project } from "@openreel/core";

function hasComposition(
  compositions: readonly MotionComposition[],
  compositionId: string | null | undefined,
): compositionId is string {
  return !!compositionId && compositions.some((item) => item.id === compositionId);
}

function clampTime(time: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.min(duration, Math.max(0, time));
}

function defaultPreviewTime(
  composition: MotionComposition,
  fraction: number,
): number {
  const duration = Math.max(0, composition.duration);
  return clampTime(Math.max(0.6, duration * fraction), duration);
}

function firstExistingCompositionId(
  compositions: readonly MotionComposition[],
  ids: readonly string[],
): string | null {
  for (const id of ids) {
    if (hasComposition(compositions, id)) return id;
  }
  return null;
}

export function resolveMotionCreatorCompositionId({
  project,
  compositions,
  activeCompositionId,
  routeCompositionId,
}: {
  readonly project: Project;
  readonly compositions: readonly MotionComposition[];
  readonly activeCompositionId?: string | null;
  readonly routeCompositionId?: string | null;
}): string | null {
  if (compositions.length === 0) return null;
  if (hasComposition(compositions, routeCompositionId)) return routeCompositionId;
  if (hasComposition(compositions, activeCompositionId)) return activeCompositionId;

  const timelineCompositionId = firstExistingCompositionId(
    compositions,
    [...(project.motionInstances ?? [])]
      .sort((a, b) => a.startTime - b.startTime)
      .map((instance) => instance.compositionId),
  );
  if (timelineCompositionId) return timelineCompositionId;

  return compositions[0].id;
}

export function resolveMotionCreatorPreviewTime(
  composition: MotionComposition,
): number {
  return defaultPreviewTime(composition, 0.5);
}
