import type { MediaItem } from "../types/project";

export type LocalMediaSource = Blob | string;

export function localMediaSource(media: MediaItem | undefined): LocalMediaSource | null {
  return media?.openReelMediaUrl ?? media?.blob ?? null;
}

export function createMediaBunnySource(
  mediaBunny: Pick<typeof import("mediabunny"), "BlobSource" | "UrlSource">,
  source: LocalMediaSource,
) {
  return typeof source === "string"
    ? new mediaBunny.UrlSource(source, {
        maxCacheSize: 8 * 1024 * 1024,
        getRetryDelay: () => null,
        requestInit: { credentials: "omit" },
      })
    : new mediaBunny.BlobSource(source);
}

export function localMediaElementUrl(source: LocalMediaSource): string {
  return typeof source === "string" ? source : URL.createObjectURL(source);
}
