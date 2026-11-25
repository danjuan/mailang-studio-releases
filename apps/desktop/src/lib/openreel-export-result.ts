const exportPath = /^video-edits\/([a-zA-Z0-9_-]{1,128})\/exports\/(revision-([1-9][0-9]*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(mp4|wav))$/;

export function openReelExportResult(payload: unknown, sessionId: string) {
  if (!payload || typeof payload !== "object" || !("artifact" in payload) || !("revision" in payload)) return null;
  const { artifact, revision } = payload;
  if (!artifact || typeof artifact !== "object") return null;
  const { path, format, revision: artifactRevision, bytes, duration, width, height } = artifact as Record<string, unknown>;
  if (typeof path !== "string" || (format !== "mp4" && format !== "wav")
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision !== artifactRevision
    || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 44
    || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
  const pathMatch = exportPath.exec(path);
  if (!pathMatch || pathMatch[1] !== sessionId || Number(pathMatch[3]) !== revision || pathMatch[4] !== format) return null;
  const dimensions = format === "mp4" && typeof width === "number" && Number.isSafeInteger(width) && width > 0
    && typeof height === "number" && Number.isSafeInteger(height) && height > 0 ? { width, height } : null;
  return { path, label: pathMatch[2], format, duration, dimensions, mimeType: format === "mp4" ? "video/mp4" : "audio/wav" };
}
