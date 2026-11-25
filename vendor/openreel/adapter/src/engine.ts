import { randomUUID } from "node:crypto";
import { HeadlessHost } from "@openreel/agent/headless-host";
import type { MediaItem, Project } from "@openreel/core/types/project";
import type { Clip } from "@openreel/core/types/timeline";
import { failure, mediaPath } from "./drafts.mjs";
import { mediaFormat } from "../../editor/packages/core/src/pi-draft-format.mjs";
import { probeMedia, type MediaReader } from "./media-probe";
import { apply, retimeAutoCaptions, trimClip } from "./mcp-editing-native";

export { editOpenReelTools, openReelToolCatalog, readOpenReelTool } from "./mcp-editing";

export type Edit =
  | ImportEdit
  | { type: "trim"; clipId: string; inPoint?: number; outPoint?: number }
  | { type: "split"; clipId: string; time: number }
  | { type: "move"; clipId: string; startTime: number };

export type ImportEdit = { type: "import"; path: string; kind?: string; outPoint?: number; startTime?: number; trackId?: string };

export type EditingDraft = { project: Project | null; mediaPaths: Record<string, string> };

function emptyProject(source: MediaItem): Project {
  const now = Date.now();
  const { width, height, frameRate, sampleRate, channels } = source.metadata;
  return {
    id: randomUUID(),
    name: "会话视频",
    createdAt: now,
    modifiedAt: now,
    settings: { width: source.type === "video" ? width : 1080, height: source.type === "video" ? height : 1920,
      frameRate: frameRate || 30, sampleRate: sampleRate || 48000, channels: channels || 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks: [], subtitles: [], duration: 0, markers: [] },
  };
}

function seconds(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw failure("INVALID_EDIT", `${label} must be a nonnegative number of seconds.`);
  return value;
}

function findClip(project: Project, clipId: string): Clip {
  const clip = project.timeline.tracks.flatMap(track => track.clips).find(item => item.id === clipId);
  if (!clip) throw failure("INVALID_EDIT", "Clip not found. Read the draft for its current clip IDs.");
  return clip;
}

async function appendClip(host: HeadlessHost, source: MediaItem, edit: ImportEdit) {
  const project = host.getProject();
  const still = source.type === "image";
  const duration = seconds(edit.outPoint ?? (still ? 3 : source.metadata.duration), "Clip duration");
  if (duration <= 0 || duration > (still ? 300 : source.metadata.duration)) {
    throw failure("INVALID_EDIT", "The imported clip must have a positive duration within the supported source range.");
  }
  const compatible = (track: Project["timeline"]["tracks"][number]) =>
    track.type === source.type && !track.locked && track.role !== "captions";
  const track = edit.trackId ? project.timeline.tracks.find(item => item.id === edit.trackId)
    : project.timeline.tracks.find(compatible);
  if (edit.trackId && (!track || !compatible(track))) {
    throw failure("INVALID_EDIT", "Choose an unlocked track matching the source type.");
  }
  const startTime = seconds(edit.startTime ?? (source.type === "video" ? project.timeline.duration : 0), "Start time");
  let trackId = track?.id;
  if (!trackId) {
    trackId = randomUUID();
    const label = { video: "视频", audio: "音频", image: "图片" }[source.type];
    const count = project.timeline.tracks.filter(item => item.type === source.type).length + 1;
    await apply(host, { type: "track/add", params: {
      trackId, trackType: source.type, name: `${label} ${count}`,
      ...(source.type === "image" ? { position: 0 } : {}),
    } });
  }
  await apply(host, {
    type: "clip/add",
    params: { clipId: randomUUID(), trackId, mediaId: source.id, startTime, duration },
  });
}

export async function editDraft(saved: EditingDraft, edits: Edit[], reader: MediaReader, signal?: AbortSignal): Promise<EditingDraft> {
  let project = saved.project ? structuredClone(saved.project) : null;
  const host = new HeadlessHost(project);
  const mediaPaths = { ...saved.mediaPaths };
  for (const edit of edits) {
    signal?.throwIfAborted();
    if (edit.type === "import") {
      const path = mediaPath(edit.path);
      if (edit.kind !== undefined && mediaFormat(path)?.kind !== edit.kind) {
        throw failure("INVALID_MEDIA", "The supplied media kind does not match the source format.");
      }
      const existingId = Object.keys(mediaPaths).find(id => mediaPaths[id] === path);
      const existing = project?.mediaLibrary.items.find(item => item.id === existingId);
      const media = existing ?? await probeMedia(reader, path);
      signal?.throwIfAborted();
      if (!project) {
        project = emptyProject(media);
        host.setProject(project);
      }
      if (!existing) {
        project.mediaLibrary.items.push(media);
        mediaPaths[media.id] = path;
      }
      await appendClip(host, media, edit);
      continue;
    }
    if (!project) {
      throw failure("INVALID_EDIT", "Import local media before editing the timeline.");
    }
    const clip = findClip(host.getProject(), edit.clipId);
    if (edit.type === "trim") {
      await trimClip(host, clip, edit, signal);
    } else if (edit.type === "split") {
      const time = seconds(edit.time, "Split time");
      if (time <= clip.startTime || time >= clip.startTime + clip.duration) {
        throw failure("INVALID_EDIT", "Split time must be inside the timeline clip.");
      }
      await apply(host, { type: "clip/split", params: { clipId: clip.id, time } });
    } else {
      const startTime = seconds(edit.startTime, "Start time");
      await apply(host, { type: "clip/move", params: { clipId: clip.id, startTime } });
      await retimeAutoCaptions(host, clip, findClip(host.getProject(), clip.id), signal);
    }
  }
  return { project: { ...host.getProject(), modifiedAt: Date.now() }, mediaPaths };
}
