import { v4 as uuidv4 } from "uuid";
import type { MediaItem, MediaMetadata } from "../types/project";
import type {
  ProcessedMedia,
  MediaImportResult,
  ThumbnailResult,
  WaveformData,
} from "./types";
import {
  MediaBunnyEngine,
  getMediaEngine,
  isSupportedFormat,
  inferMediaType,
} from "./mediabunny-engine";
export interface MediaImportOptions {
  generateThumbnails?: boolean;
  thumbnailCount?: number;
  thumbnailWidth?: number;
  generateWaveform?: boolean;
  waveformSamplesPerSecond?: number;
  quickMode?: boolean;
}

const DEFAULT_OPTIONS: Required<MediaImportOptions> = {
  generateThumbnails: true,
  thumbnailCount: 5,
  thumbnailWidth: 320,
  generateWaveform: true,
  waveformSamplesPerSecond: 100,
  quickMode: false,
};

export class MediaImportService {
  private mediaEngine: MediaBunnyEngine;
  private initialized = false;

  constructor(mediaEngine?: MediaBunnyEngine) {
    this.mediaEngine = mediaEngine || getMediaEngine();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.mediaEngine.initialize();
    this.initialized = true;
  }

  async importMedia(
    file: File,
    options: MediaImportOptions = {},
  ): Promise<MediaImportResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const warnings: string[] = [];
    const validation = await this.validateFormat(file);
    if (!validation.supported) {
      return {
        success: false,
        error: validation.error || "Unsupported format",
      };
    }

    try {
      const metadata = await this.mediaEngine.extractMetadata(file);
      const mediaType = inferMediaType(file.type);

      if (!mediaType) {
        return {
          success: false,
          error: "Could not determine media type",
        };
      }

      if (mediaType === "video" && !metadata.canDecode) {
        warnings.push("Codec may not be fully supported. Playback might be limited.");
      }
      let thumbnails: ThumbnailResult[] = [];
      if (opts.generateThumbnails && !opts.quickMode) {
        if (mediaType === "video" && metadata.hasVideo) {
          try {
            thumbnails = await this.mediaEngine.generateThumbnails(
              file,
              opts.thumbnailCount,
              opts.thumbnailWidth,
            );
          } catch (error) {
            warnings.push(
              `Thumbnail generation failed: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }
        } else if (mediaType === "image") {
          try {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);

            await new Promise<void>((resolve, reject) => {
              img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve();
              };
              img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error("Failed to load image"));
              };
              img.src = objectUrl;
            });

            const canvas = document.createElement("canvas");
            const targetWidth = opts.thumbnailWidth || 320;
            const aspectRatio = img.height / img.width;
            const targetHeight = Math.round(targetWidth * aspectRatio);

            canvas.width = targetWidth;
            canvas.height = targetHeight;

            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
              const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
              thumbnails = [
                {
                  timestamp: 0,
                  canvas,
                  dataUrl,
                },
              ];
            }
          } catch (error) {
            warnings.push(
              `Image thumbnail generation failed: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }
        }
      }
      let waveformData: WaveformData | null = null;
      if (opts.generateWaveform && metadata.hasAudio && !opts.quickMode) {
        try {
          waveformData = await this.mediaEngine.generateWaveform(
            file,
            opts.waveformSamplesPerSecond,
          );
        } catch (error) {
          warnings.push(
            `Waveform generation failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          );
        }
      }

      const processedMedia: ProcessedMedia = {
        id: uuidv4(),
        name: file.name,
        type: mediaType,
        blob: file,
        metadata,
        thumbnails,
        waveformData,
      };

      return {
        success: true,
        media: processedMedia,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: `Import failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  async validateFormat(file: File | Blob): Promise<{
    supported: boolean;
    format: string | null;
    error?: string;
  }> {
    if (!isSupportedFormat(file.type)) {
      return {
        supported: false,
        format: null,
        error: `Unsupported format: ${
          file.type || "unknown"
        }. Supported formats: MP4, WebM, MOV, MP3, WAV, AAC, JPG, PNG, WebP`,
      };
    }
    if (this.mediaEngine.isAvailable()) {
      return this.mediaEngine.validateFormat(file);
    }
    return {
      supported: true,
      format: file.type,
    };
  }

  processedMediaToMediaItem(
    processedMedia: ProcessedMedia,
    thumbnailUrl?: string,
  ): MediaItem {
    const metadata: MediaMetadata = {
      duration: processedMedia.metadata.duration,
      width: processedMedia.metadata.width,
      height: processedMedia.metadata.height,
      frameRate: processedMedia.metadata.frameRate,
      codec: processedMedia.metadata.codec,
      sampleRate: processedMedia.metadata.sampleRate,
      channels: processedMedia.metadata.channels,
      fileSize: processedMedia.metadata.fileSize,
      audioTrackCount: processedMedia.metadata.audioTrackCount,
    };

    return {
      id: processedMedia.id,
      name: processedMedia.name,
      type: processedMedia.type,
      fileHandle: null,
      blob: processedMedia.blob,
      metadata,
      thumbnailUrl: thumbnailUrl || null,
      waveformData: processedMedia.waveformData?.peaks || null,
    };
  }

  async importMultiple(
    files: File[],
    options: MediaImportOptions = {},
    onProgress?: (completed: number, total: number, current: string) => void,
  ): Promise<MediaImportResult[]> {
    const results: MediaImportResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(i, files.length, file.name);

      const result = await this.importMedia(file, options);
      results.push(result);
    }

    onProgress?.(files.length, files.length, "Complete");
    return results;
  }

  getSupportedFormats(): {
    video: string[];
    audio: string[];
    image: string[];
  } {
    return {
      video: ["MP4", "WebM", "MOV", "MKV"],
      audio: ["MP3", "WAV", "AAC", "OGG", "FLAC"],
      image: ["JPEG", "PNG", "WebP", "GIF"],
    };
  }

  async generateThumbnailsForMedia(
    file: File | Blob,
    mediaType: "video" | "audio" | "image",
    options: { count?: number; width?: number } = {},
  ): Promise<ThumbnailResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { count = 10, width = 160 } = options;

    if (mediaType === "video") {
      return this.mediaEngine.generateThumbnails(file, count, width);
    }

    if (mediaType === "image") {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Failed to load image"));
        };
        img.src = objectUrl;
      });

      const canvas = document.createElement("canvas");
      const aspectRatio = img.height / img.width;
      const targetHeight = Math.round(width * aspectRatio);

      canvas.width = width;
      canvas.height = targetHeight;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, targetHeight);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        return [{ timestamp: 0, canvas, dataUrl }];
      }
    }

    return [];
  }

  async generateWaveformForMedia(
    file: File | Blob,
    samplesPerSecond = 100,
  ): Promise<WaveformData | null> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.mediaEngine.generateWaveform(file, samplesPerSecond);
  }
}
let importServiceInstance: MediaImportService | null = null;

export function getMediaImportService(): MediaImportService {
  if (!importServiceInstance) {
    importServiceInstance = new MediaImportService();
  }
  return importServiceInstance;
}

export async function initializeMediaImportService(): Promise<MediaImportService> {
  const service = getMediaImportService();
  await service.initialize();
  return service;
}
