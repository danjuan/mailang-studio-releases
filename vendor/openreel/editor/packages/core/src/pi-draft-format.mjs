export const OPENREEL_DRAFT_VERSION = 2;
export const OPENREEL_MEDIA_LIMIT = 256 * 1024 * 1024;
export const OPENREEL_HISTORY_LIMIT = 10;

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const formats = {
  mp4: { kind: "video", mime: "video/mp4" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
};
formats.jpeg = formats.jpg;

export function mediaFormat(path) {
  if (typeof path !== "string" || path.length > 1024 ||
      /[\\:\u0000-\u001f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")) {
    return undefined;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  return extension && Object.hasOwn(formats, extension) ? formats[extension] : undefined;
}

export function mediaPath(value) {
  if (!mediaFormat(value)) {
    throw failure("INVALID_ARGUMENT", "Choose a project-relative MP4, MP3, WAV, PNG or JPEG path.");
  }
  return value;
}

export function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isRemoteMedia = value => typeof value === "string" && /^(?:https?:)?\/\//i.test(value);

export function validateDraft(value, allowEmpty = false) {
  if (!isObject(value) || value.formatVersion !== OPENREEL_DRAFT_VERSION ||
      !validRevision(value.revision) || !isObject(value.mediaPaths)) {
    throw failure("INVALID_DRAFT", "Expected an OpenReel v2 draft.");
  }
  const { project, mediaPaths } = value;
  if (allowEmpty && value.revision === 0 && project === null && !Object.keys(mediaPaths).length) return value;
  if (value.revision === 0 || !isObject(project) || typeof project.id !== "string" || typeof project.name !== "string" ||
      !isObject(project.settings) || !Array.isArray(project.mediaLibrary?.items) ||
      !Array.isArray(project.timeline?.tracks) || !Number.isFinite(project.timeline.duration) || project.timeline.duration < 0) {
    throw failure("INVALID_DRAFT", "Invalid OpenReel project.");
  }
  const compositions = project.motionCompositions ?? [];
  const instances = project.motionInstances ?? [];
  if (!Array.isArray(compositions) || !Array.isArray(instances) ||
      compositions.some(composition => typeof composition?.id !== "string" || !Array.isArray(composition.layers))) {
    throw failure("INVALID_DRAFT", "Invalid OpenReel motion composition.");
  }
  if (project.creation ||
      compositions.some(composition => composition.layers.some(layer => layer?.type === "scene3d")) ||
      project.textClips?.some(clip => clip.text3d?.enabled) ||
      project.shapeClips?.some(clip => typeof clip.shapeType === "string" && clip.shapeType.startsWith("mesh-"))) {
    throw failure("UNSUPPORTED", "The short-drama editor supports 2D drafts.");
  }
  const mediaIds = new Set();
  const legacySourceUrls = new Set();
  for (const item of project.mediaLibrary.items) {
    const path = mediaPaths[item?.id];
    const format = mediaFormat(path);
    const legacySourceUrl = isRemoteMedia(item?.originalUrl);
    if (!format && (legacySourceUrl || isRemoteMedia(path))) {
      throw failure("REMOTE_MEDIA_UNAVAILABLE", "This draft references online media. Import the original file from your computer.");
    }
    const metadata = item?.metadata;
    if (typeof item?.id !== "string" || mediaIds.has(item.id) || !Object.hasOwn(mediaPaths, item.id) ||
        !format || format.kind !== item.type || item.blob != null || item.fileHandle != null ||
        (item.originalUrl != null && !legacySourceUrl) || item.openReelMediaUrl != null ||
        !Number.isFinite(metadata?.duration) || metadata.duration < 0 || (item.type !== "image" && metadata.duration === 0)) {
      throw failure("INVALID_DRAFT", "Each media item must match a supported local source.");
    }
    mediaIds.add(item.id);
    if (legacySourceUrl) legacySourceUrls.add(item.id);
  }
  if (Object.keys(mediaPaths).length !== mediaIds.size) {
    throw failure("INVALID_DRAFT", "The draft contains unknown source paths.");
  }
  const compositionIds = new Set(compositions.map(composition => composition.id));
  const motionInstances = new Map();
  for (const instance of instances) {
    if (typeof instance?.id !== "string" || motionInstances.has(instance.id) ||
        !compositionIds.has(instance.compositionId) || typeof instance.trackId !== "string" ||
        !Number.isFinite(instance.startTime) || instance.startTime < 0 ||
        !Number.isFinite(instance.duration) || instance.duration <= 0) {
      throw failure("INVALID_DRAFT", "Invalid OpenReel motion instance.");
    }
    motionInstances.set(instance.id, instance);
  }
  const seenMotionClips = new Set();
  for (const track of project.timeline.tracks) {
    if (!Array.isArray(track?.clips)) throw failure("INVALID_DRAFT", "Invalid OpenReel track.");
    for (const clip of track.clips) {
      if (typeof clip?.id !== "string" ||
          ![clip.startTime, clip.duration, clip.inPoint, clip.outPoint].every(Number.isFinite)) {
        throw failure("INVALID_DRAFT", "Invalid clip in the draft timeline.");
      }
      const { motionClip, motionInstanceId, motionCompositionId } = clip.metadata ?? {};
      if (motionClip || motionInstanceId !== undefined || motionCompositionId !== undefined) {
        const instance = motionInstances.get(motionInstanceId);
        if (motionClip !== true || !instance || seenMotionClips.has(instance.id) ||
            motionCompositionId !== instance.compositionId || track.id !== instance.trackId || clip.trackId !== track.id ||
            clip.id !== `motion-clip-${instance.id}` || clip.mediaId !== `motion-${instance.id}` || mediaIds.has(clip.mediaId)) {
          throw failure("INVALID_DRAFT", "Motion clip must reference a saved composition instance.");
        }
        seenMotionClips.add(instance.id);
      } else if (!mediaIds.has(clip.mediaId)) {
        throw failure("INVALID_DRAFT", "Clip must reference a supported local media item.");
      }
    }
  }
  if (!legacySourceUrls.size) return value;
  const items = project.mediaLibrary.items.map(item => {
    if (!legacySourceUrls.has(item.id)) return item;
    const { originalUrl, ...local } = item;
    return local;
  });
  return { ...value, project: { ...project, mediaLibrary: { ...project.mediaLibrary, items } } };
}
