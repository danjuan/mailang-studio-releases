import { randomUUID } from "node:crypto";
import { HeadlessHost } from "@openreel/agent/headless-host";
import { getLinkedAudioClips } from "@openreel/core/audio/clip-audio-resolution";
import { getTrackTransitionAudioFades } from "@openreel/core/audio/transition-audio-fades";
import type { Project } from "@openreel/core/types/project";
import type { Clip, Track } from "@openreel/core/types/timeline";
import type { EditingDraft } from "./engine";
import { apply, invalid, writableClip, writableTrack } from "./mcp-editing-native";
import { probeMedia, type MediaReader } from "./media-probe";
import { failure, mediaPath } from "./drafts.mjs";

export const separateAudioCapability = {
  name: "separate_audio", domain: "audio",
  description: "Move the dialogue audio from an exact saved video clip into an independent local WAV clip at the same timeline position. Mutes the video's original audio. Requires a forward, normal-speed clip with one supported audio stream.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: { clipId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["clipId"],
  },
  readOnly: false, destructive: false, expensive: true,
} as const;

type PreparedAudio = { path: string; duration: number; bytes: number; channels: number };

function separationSource(project: Project, clipId: unknown) {
  const clip = writableClip(project, clipId);
  const track = writableTrack(project, clip.trackId);
  const media = project.mediaLibrary.items.find(item => item.id === clip.mediaId);
  if (!media || media.type !== "video" || media.metadata.hasAudio === false) invalid("Choose a video clip with local audio.");
  if (clip.metadata?.audioDetached || project.timeline.tracks.some(track =>
    track.clips.some(item => item.metadata?.separatedFromClipId === clip.id)) ||
    getLinkedAudioClips(clip, project.timeline).some(({ track }) => track.type === "audio")) {
    throw failure("AUDIO_ALREADY_SEPARATED", "This video clip already has separate audio.");
  }
  if (clip.metadata?.templateSource || clip.metadata?.templateManaged || clip.metadata?.appliedTemplates?.length ||
    clip.reversed || (clip.speed ?? 1) !== 1 || clip.speedKeyframes?.length || clip.freezeFrames?.length ||
    (clip.audioTrackIndex ?? 0) !== 0 || (media.metadata.audioTrackCount ?? 1) !== 1) {
    invalid("Choose normal-speed forward video with one audio stream and no applied editing template.");
  }
  if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 300.001 ||
    !Number.isFinite(clip.inPoint) || clip.inPoint < 0 || !Number.isFinite(clip.outPoint) ||
    clip.outPoint > media.metadata.duration + 0.001 || Math.abs(clip.duration - (clip.outPoint - clip.inPoint)) > 0.001) {
    invalid("Choose a clip with a defined source range of up to 300 seconds.");
  }
  const linkedCaptions = (project.textClips ?? []).filter(title => title.metadata?.captionSourceClipId === clip.id);
  for (const caption of linkedCaptions) writableTrack(project, caption.trackId);
  return { clip, track, media, linkedCaptions };
}

export function checkAudioSeparation(project: Project | null, clipId: unknown): void {
  if (!project) invalid("Open a saved draft before separating audio.");
  separationSource(project, clipId);
}

export async function editSeparatedAudio(
  saved: EditingDraft, clipId: unknown, prepared: PreparedAudio, reader: MediaReader, signal?: AbortSignal,
): Promise<EditingDraft> {
  if (!saved.project) invalid("Open a saved draft before separating audio.");
  const host = new HeadlessHost(structuredClone(saved.project));
  const { clip, track, media, linkedCaptions } = separationSource(host.getProject(), clipId);
  const path = mediaPath(prepared.path);
  if (!path.endsWith(".wav") || Object.values(saved.mediaPaths).includes(path)) {
    throw failure("INVALID_MEDIA", "OpenReel did not receive a new WAV asset.");
  }
  const wave = await probeMedia(reader, path);
  signal?.throwIfAborted();
  if (wave.type !== "audio" || wave.metadata.fileSize !== prepared.bytes ||
    wave.metadata.channels !== prepared.channels || ![1, 2].includes(prepared.channels) ||
    wave.metadata.sampleRate !== 48000 || Math.abs(wave.metadata.duration - clip.duration) > 1 / 48000 ||
    Math.abs(wave.metadata.duration - prepared.duration) > 1 / 48000) {
    throw failure("INVALID_MEDIA", "The WAV stream does not match the selected clip's duration or audio format.");
  }
  const audioId = randomUUID();
  const trackId = randomUUID();
  host.getProject().mediaLibrary.items.push({ ...wave, name: `${media.name} · 音频` });
  await apply(host, { type: "track/add", params: { trackId, trackType: "audio", role: "dialogue", name: "分离音频" } });
  await apply(host, { type: "clip/add", params: {
    clipId: audioId, mediaId: wave.id, trackId, startTime: clip.startTime, duration: clip.duration,
  } });
  signal?.throwIfAborted();
  const transitionFades = getTrackTransitionAudioFades(track, clip.id);
  const captionIds = new Set(linkedCaptions.map(title => title.id));
  const moveAudio = (candidate: Clip): Clip => {
    if (candidate.id === clip.id) {
      return { ...candidate, volume: 0, audioEffects: [], metadata: { ...candidate.metadata, audioDetached: true } };
    }
    if (candidate.id !== audioId) return candidate;
    const audioEffects = clip.audioEffects?.length ? clip.audioEffects : (clip.effects ?? []).filter(effect => effect.type === "pan");
    return {
      ...candidate, volume: clip.volume, audioEffects,
      automation: clip.automation,
      fade: {
        fadeIn: Math.max(clip.fade?.fadeIn ?? 0, transitionFades.fadeIn),
        fadeOut: Math.max(clip.fade?.fadeOut ?? 0, transitionFades.fadeOut),
      },
      metadata: { separatedFromClipId: clip.id },
    };
  };
  const project = host.getProject();
  const tracks = project.timeline.tracks.map((candidate): Track => ({
    ...candidate, clips: candidate.clips.map(moveAudio),
    ...(candidate.id === trackId ? { muted: track.muted, solo: track.solo, hidden: track.hidden } : {}),
  }));
  return {
    project: {
      ...project, modifiedAt: Date.now(), timeline: { ...project.timeline, tracks },
      ...(project.textClips ? { textClips: project.textClips.map(title => captionIds.has(title.id)
        ? { ...title, metadata: { ...title.metadata, captionSourceClipId: audioId } }
        : title) } : {}),
    },
    mediaPaths: { ...saved.mediaPaths, [wave.id]: path },
  };
}
