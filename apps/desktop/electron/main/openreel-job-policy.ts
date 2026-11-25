export const OPENREEL_JOB_MAX_SECONDS = 300;
export const OPENREEL_NATIVE_JOB_TIMEOUT_MS = 600_000;
export const OPENREEL_JOB_TOOL_TIMEOUT_MS = 630_000;

export type OpenReelVideoPreset = "draft" | "landscape1080p" | "portrait1080p" | "square1080p";

export function isOpenReelVideoPreset(value: unknown): value is OpenReelVideoPreset {
  return value === "draft" || value === "landscape1080p" || value === "portrait1080p" || value === "square1080p";
}

export function isOpenReelLongAction(args: unknown): boolean {
  const action = args && typeof args === "object" && "action" in args ? args.action : undefined;
  return action === "auto_caption" || action === "separate_audio" || action === "export_video" || action === "export_audio";
}

export function isOpenReelSilenceCall(args: unknown): boolean {
  return !!args && typeof args === "object" && "tool" in args && args.tool === "detect_silence";
}

export function isOpenReelLongRpcCall(
  message: { method?: string; params?: unknown }, writeTool: string, readTool?: string,
): boolean {
  const params = message.params;
  if (message.method !== "tools/call" || !params || typeof params !== "object" ||
    !("name" in params) || !("arguments" in params)) return false;
  return params.name === writeTool && isOpenReelLongAction(params.arguments) ||
    readTool !== undefined && params.name === readTool && isOpenReelSilenceCall(params.arguments);
}
