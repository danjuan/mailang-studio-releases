import { randomUUID } from "node:crypto";
import { Input, MP3, MP4, StreamSource, WAVE } from "mediabunny";
import type { MediaItem, MediaMetadata } from "@openreel/core/types/project";
import { mediaFormat } from "../../editor/packages/core/src/pi-draft-format.mjs";
import { failure, MAX_MEDIA_RANGE } from "./drafts.mjs";

export type MediaReader = {
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  read(path: string, offset: number, length: number): Promise<{ bytes: Uint8Array; totalSize: number }>;
};

function invalidMedia(message: string): never {
  throw failure("INVALID_MEDIA", message);
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 33 &&
      data.getUint32(0) === 0x89504e47 && data.getUint32(4) === 0x0d0a1a0a &&
      data.getUint32(8) === 13 && data.getUint32(12) === 0x49484452) {
    return { width: data.getUint32(16), height: data.getUint32(20) };
  }
  if (mime === "image/jpeg" && bytes.length >= 4 && data.getUint16(0) === 0xffd8) {
    for (let cursor = 2; cursor + 4 <= bytes.length;) {
      if (bytes[cursor++] !== 0xff) break;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xd9 || marker === 0xda || cursor + 2 > bytes.length) break;
      const length = data.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        return { width: data.getUint16(cursor + 5), height: data.getUint16(cursor + 3) };
      }
      cursor += length;
    }
  }
  return invalidMedia("The image header does not match a supported PNG or JPEG.");
}

export async function probeMedia(reader: MediaReader, path: string): Promise<MediaItem> {
  const format = mediaFormat(path);
  if (!format) invalidMedia("The source is not a supported local media file.");
  const info = await reader.stat(path);
  async function read(start: number, end: number) {
    // Limit individual parser allocations such as malformed container atoms.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        end < start || end > info.size || end - start > 16 * MAX_MEDIA_RANGE) {
      invalidMedia("The media contains an unsupported metadata or packet range.");
    }
    const bytes = new Uint8Array(end - start);
    for (let offset = start; offset < end; offset += MAX_MEDIA_RANGE) {
      const length = Math.min(MAX_MEDIA_RANGE, end - offset);
      const chunk = await reader.read(path, offset, length);
      if (chunk.totalSize !== info.size || chunk.bytes.length !== length) {
        invalidMedia("The source media changed while it was being read.");
      }
      bytes.set(chunk.bytes, offset - start);
    }
    return bytes;
  }
  let metadata: MediaMetadata = {
    duration: 0, width: 0, height: 0, frameRate: 0, codec: "",
    sampleRate: 0, channels: 0, fileSize: info.size, hasVideo: false, hasAudio: false,
  };
  if (format.kind === "image") {
    const dimensions = imageDimensions(await read(0, Math.min(info.size, MAX_MEDIA_RANGE)), format.mime);
    if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192) {
      invalidMedia("Use a PNG or JPEG no larger than 8192 pixels per side.");
    }
    metadata = { ...metadata, ...dimensions, codec: format.mime };
  } else {
    const container = format.kind === "video" ? MP4 : format.mime === "audio/mpeg" ? MP3 : WAVE;
    const input = new Input({ formats: [container], source: new StreamSource({ getSize: () => info.size, read }) });
    try {
      const audio = await input.getPrimaryAudioTrack();
      if (format.kind === "video") {
        const [video, tracks] = await Promise.all([input.getPrimaryVideoTrack(), input.getAudioTracks()]);
        if (!video || video.codec !== "avc" || tracks.some(track => track.codec !== "aac")) {
          invalidMedia("Use H.264 MP4 with AAC audio when audio is present.");
        }
        const [duration, stats] = await Promise.all([video.computeDuration(), video.computePacketStats(24)]);
        if (!video.displayWidth || !video.displayHeight) invalidMedia("The source video dimensions are invalid.");
        metadata = {
          ...metadata, duration, width: video.displayWidth, height: video.displayHeight,
          frameRate: stats.averagePacketRate || 30, codec: "avc", hasVideo: true, audioTrackCount: tracks.length,
        };
      } else {
        if (!audio?.codec || (format.mime === "audio/mpeg" ? audio.codec !== "mp3" : !audio.codec.startsWith("pcm-"))) {
          invalidMedia("Use MP3 or an uncompressed PCM WAV.");
        }
        metadata = { ...metadata, duration: await audio.computeDuration(), codec: audio.codec, audioTrackCount: 1 };
      }
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) invalidMedia("The media has no readable duration.");
      if (audio) metadata = { ...metadata, sampleRate: audio.sampleRate, channels: audio.numberOfChannels, hasAudio: true };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      invalidMedia("OpenReel could not read the selected media stream.");
    } finally {
      input.dispose();
    }
  }
  const after = await reader.stat(path);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) invalidMedia("The source media changed during probing.");
  const name = path.split("/").at(-1)!;
  return {
    id: randomUUID(), type: format.kind, name, metadata, blob: null, fileHandle: null,
    sourceFile: { name, size: info.size, lastModified: info.mtimeMs },
    thumbnailUrl: null, waveformData: null,
  };
}
