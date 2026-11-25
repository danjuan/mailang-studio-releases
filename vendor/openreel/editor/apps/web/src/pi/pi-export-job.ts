import { validateDraft } from "@openreel/core/pi-draft-format.mjs";
import { resolveWebCodecsExportLimits, type ExportResult, type Project, type VideoExportProgressInfo } from "@openreel/core";
import { DEFAULT_VIDEO_SETTINGS } from "@openreel/core/export/types";
import { useEngineStore } from "../stores/engine-store";
import { useProjectStore } from "../stores/project-store";
import { assertPiVisualExportAvailable } from "./pi-legacy-visuals";
import { openProjectVideo, readProjectMedia, type PiBridge } from "./pi-draft";

const outputChunkLimit = 512 * 1024;
const namespace = "openreel.export";

export function createExportWritable(bridge: Pick<PiBridge, "invoke">): FileSystemWritableFileStream {
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("The OpenReel export stream is closed.");
  };
  return {
    async write(chunk: FileSystemWriteChunkType) {
      ensureOpen();
      const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk)
        : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : null;
      if (!bytes) throw new Error("OpenReel expected a binary export chunk.");
      for (let offset = 0; offset < bytes.byteLength; offset += outputChunkLimit) {
        await bridge.invoke(`${namespace}.output.write`, {
          bytes: bytes.slice(offset, offset + outputChunkLimit),
        });
      }
    },
    async seek(position: number) {
      ensureOpen();
      await bridge.invoke(`${namespace}.output.seek`, { position });
    },
    async truncate(size: number) {
      ensureOpen();
      await bridge.invoke(`${namespace}.output.truncate`, { size });
    },
    async close() { closed = true; },
    async abort() { closed = true; },
  } as unknown as FileSystemWritableFileStream;
}

interface ExportRecord {
  revision: number;
  project: Project;
  mediaPaths: Record<string, string>;
  format: "mp4" | "wav";
  preset?: "draft" | "landscape1080p" | "portrait1080p" | "square1080p";
}

function claimRecord(value: unknown): ExportRecord {
  const claim = value as { record?: unknown; format?: unknown; preset?: unknown } | null;
  const record = validateDraft(claim?.record);
  const format = claim?.format ?? "mp4";
  const preset = claim?.preset;
  if (!record.project || (format !== "mp4" && format !== "wav") ||
      (preset !== undefined && preset !== "draft" && preset !== "landscape1080p" &&
        preset !== "portrait1080p" && preset !== "square1080p")) {
    throw new Error("OpenReel did not receive a valid export job.");
  }
  return { ...record, project: record.project, format, preset };
}

async function restoreMedia(bridge: PiBridge, record: ExportRecord): Promise<Project> {
  const scopedMedia: PiBridge = {
    invoke(channel, payload) {
      const method = channel === "openreel.media.stat" ? "stat" :
        channel === "openreel.media.read" ? "read" : channel === "openreel.media.source" ? "source" : null;
      if (!method || !payload) throw new Error("Invalid export media operation.");
      const { path, offset, length } = payload;
      return bridge.invoke(`${namespace}.media.${method}`, method === "read" ? { path, offset, length } : { path });
    },
    on: bridge.on,
  };
  const blobs = new Map<string, File>();
  const urls = new Map<string, string>();
  const items = [];
  // The hidden renderer is restricted by its host-bound job identity. Its
  // media bridge does not accept a browser-selected session or workspace.
  const context = { sessionId: "export", projectPath: "export" };
  for (const item of record.project.mediaLibrary.items) {
    const path = record.mediaPaths[item.id];
    if (typeof path !== "string") throw new Error("The saved draft is missing an export source.");
    if (item.type === "video") {
      let url = urls.get(path);
      if (!url) {
        url = (await openProjectVideo(scopedMedia, context, path, () => true)).url;
        urls.set(path, url);
      }
      items.push({ ...item, fileHandle: null, blob: null, openReelMediaUrl: url, isPlaceholder: false });
      continue;
    }
    let blob = blobs.get(path);
    if (!blob) {
      blob = await readProjectMedia(scopedMedia, context, path, () => true);
      blobs.set(path, blob);
    }
    items.push({ ...item, fileHandle: null, blob, isPlaceholder: false });
  }
  return { ...record.project, mediaLibrary: { ...record.project.mediaLibrary, items } };
}

async function render(
  bridge: PiBridge, generator: AsyncGenerator<VideoExportProgressInfo, ExportResult>, audio: boolean,
): Promise<ExportResult> {
  let lastPhase = "";
  let lastProgress = -1;
  let step = await generator.next();
  while (!step.done) {
    const { phase, progress, currentFrame, totalFrames } = step.value;
    if ((!audio || phase !== "complete") && (phase !== lastPhase || progress - lastProgress >= 0.03)) {
      await bridge.invoke(`${namespace}.progress`, { phase, progress, currentFrame, totalFrames });
      lastPhase = phase;
      lastProgress = progress;
    }
    step = await generator.next();
  }
  return step.value;
}

export async function wavDuration(blob: Blob): Promise<number> {
  const header = new DataView(await blob.slice(0, 44).arrayBuffer());
  if (header.byteLength !== 44 || header.getUint32(0) !== 0x52494646 || // RIFF
      header.getUint32(8) !== 0x57415645 || header.getUint32(36) !== 0x64617461) { // WAVE, data
    throw new Error("OpenReel did not produce a WAV audio stream.");
  }
  const byteRate = header.getUint32(28, true);
  const audioBytes = header.getUint32(40, true);
  if (byteRate === 0 || audioBytes === 0 || blob.size !== 44 + audioBytes) {
    throw new Error("OpenReel produced an incomplete WAV audio stream.");
  }
  return audioBytes / byteRate;
}

/** Runs in a fresh, host-owned renderer. Loading does not follow panel focus. */
export async function runPiExportJob(bridge: PiBridge) {
  try {
    const record = claimRecord(await bridge.invoke(`${namespace}.claim`));
    if (record.format === "mp4") assertPiVisualExportAvailable(record.project);
    const restored = await restoreMedia(bridge, record);
    await useEngineStore.getState().initialize();
    const engine = useEngineStore.getState().getExportEngine();
    if (!engine) throw new Error("The OpenReel export engine is unavailable.");
    useProjectStore.getState().loadProject(restored);
    const restoredProject = useProjectStore.getState().getFullProject();
    // The mixer follows the project layout. Use the delivery layout for this
    // job so AAC receives a supported buffer even for mono, low-rate sources.
    const deliveryAudio = { sampleRate: 48000, channels: 2 } as const;
    const project = { ...restoredProject, settings: { ...restoredProject.settings, ...deliveryAudio } };
    const output = createExportWritable(bridge);
    if (record.format === "wav") {
      const audioSettings = { format: "wav", ...deliveryAudio } as const;
      const result = await render(bridge, engine.exportAudio(project, audioSettings), true);
      if (!result.success || !result.blob) throw new Error(result.error?.message ?? "OpenReel did not produce an audio stream.");
      const duration = await wavDuration(result.blob);
      const stream = result.blob.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await stream.read();
          if (done) break;
          await output.write(value);
        }
        await output.close();
      } finally {
        stream.releaseLock();
      }
      await bridge.invoke(`${namespace}.output.finish`, { revision: record.revision, format: "wav", duration });
      return;
    }
    const dimensions = {
      landscape1080p: { width: 1920, height: 1080, frameRate: 30 },
      portrait1080p: { width: 1080, height: 1920, frameRate: 30 },
      square1080p: { width: 1080, height: 1080, frameRate: 30 },
    };
    const { width, height, frameRate } = record.preset && record.preset !== "draft"
      ? dimensions[record.preset] : project.settings;
    const { settings } = resolveWebCodecsExportLimits({
      ...DEFAULT_VIDEO_SETTINGS, codec: "h264", format: "mp4", width, height, frameRate,
      audioSettings: { ...DEFAULT_VIDEO_SETTINGS.audioSettings, ...deliveryAudio },
    }, project.timeline.duration);
    const { success, error, stats } = await render(bridge, engine.exportVideo(project, settings, output), false);
    if (!success || !stats || stats.framesRendered <= 0) {
      throw new Error(error?.message ?? "OpenReel did not produce frames for this draft.");
    }
    await bridge.invoke(`${namespace}.output.finish`, {
      revision: record.revision, format: "mp4",
      duration: stats.framesRendered / settings.frameRate,
      width: settings.width, height: settings.height, frameRate: settings.frameRate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenReel could not export the draft.";
    await bridge.invoke(`${namespace}.fail`, { message: message.slice(0, 1000) });
  }
}
