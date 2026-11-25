function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

export function committedOpenReelRevision(path: string, sessionId: string, content: string): number | undefined {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || path !== `video-edits/${sessionId}/draft.json`) return;
  if (Buffer.byteLength(content, "utf8") > 8 * 1024 * 1024) return;
  let saved: Record<string, unknown> | undefined;
  try {
    saved = record(JSON.parse(content));
  } catch {
    return;
  }
  if (saved?.formatVersion !== 2 || typeof saved.revision !== "number"
    || !Number.isSafeInteger(saved.revision) || saved.revision <= 0) return;
  return saved.revision;
}
