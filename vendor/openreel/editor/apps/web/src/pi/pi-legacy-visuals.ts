import { STABILIZATION_ANALYSIS_VERSION, type Clip, type Project } from "@openreel/core";
import { piEditorLabel, piEditorLocale } from "./editor-copy-runtime";

export function requiresLegacyStabilization(clip: Pick<Clip, "stabilization">): boolean {
  const stabilization = clip.stabilization;
  return !!stabilization?.enabled &&
    (!stabilization.analyzed || stabilization.analysisVersion !== STABILIZATION_ANALYSIS_VERSION ||
      !stabilization.profile?.corrections.length);
}

export function assertPiVisualExportAvailable(project: Project) {
  if (project.textClips?.some(clip => clip.behindSubject)) {
    throw new Error("Remove legacy text behind subject before exporting video.");
  }
  const timing = new Intl.NumberFormat(piEditorLocale(), { maximumFractionDigits: 2 });
  const affected = project.timeline.tracks.flatMap(track => track.clips
    .filter(requiresLegacyStabilization)
    .map(clip => {
      const name = project.mediaLibrary.items.find(item => item.id === clip.mediaId)?.name ?? clip.id;
      return `${name} (${track.name}, ${timing.format(clip.startTime)}–${timing.format(clip.startTime + clip.duration)} s)`;
    }));
  if (affected.length) {
    const message = piEditorLabel("Remove legacy stabilization without saved analysis before exporting video.");
    throw new Error(`${message} ${affected.join(", ")}`);
  }
}
