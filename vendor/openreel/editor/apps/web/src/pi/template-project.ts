import { BUILTIN_TEMPLATES, type TemplateEngine } from "@openreel/core/template/template-engine";
import { TitleEngine } from "@openreel/core/text/title-engine";
import { calculateProjectDuration } from "@openreel/core/timeline/project-duration";
import type { Project } from "@openreel/core/types/project";
import type { Template } from "@openreel/core/types/template";
import { piEditorLabel } from "./editor-copy-runtime";

export function applyPiProjectTemplate(engine: TemplateEngine, template: Template, current: Project): Project {
  const { project, textClips } = engine.applyTemplate(template, {});
  const textEngine = new TitleEngine();
  const textById = new Map(textClips.map((clip) => [clip.id, clip.text]));
  const knownMedia = new Set(current.mediaLibrary.items.map((item) => item.id));
  const builtIn = BUILTIN_TEMPLATES.some((entry) => entry.id === template.id);
  const tracks = project.timeline.tracks.map((track) => {
    for (const clip of track.clips) {
      const text = textById.get(clip.id);
      if (track.type !== "text" || text === undefined) continue;
      textEngine.createTextClip({
        id: clip.id,
        trackId: track.id,
        startTime: clip.startTime,
        duration: clip.duration,
        text: builtIn ? piEditorLabel(text) : text,
        transform: clip.transform,
        animation: {
          preset: "fade",
          params: { easing: "ease-out" },
          inDuration: 0.5,
          outDuration: 0.3,
        },
      });
    }
    // Source placeholders have no project-local file. Text lives in the editor's
    // native overlay collection instead of pretending to be a media-library item.
    return {
      ...track,
      name: builtIn ? piEditorLabel(track.name) : track.name,
      clips: track.clips.filter((clip) => track.type !== "text" && knownMedia.has(clip.mediaId)),
    };
  });

  const updated: Project = {
    ...project,
    id: current.id,
    name: current.name,
    createdAt: current.createdAt,
    mediaLibrary: current.mediaLibrary,
    timeline: { ...project.timeline, tracks },
    textClips: textEngine.getAllTextClips(),
  };
  return { ...updated, timeline: { ...updated.timeline, duration: calculateProjectDuration(updated) } };
}
