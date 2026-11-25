import type { PiBridge, PiContext } from "./pi-draft";

type Channel = "run" | "previewSilence" | "applySilence" | "applyCaption" | "saveSrt";
export interface SilenceRange { start: number; end: number }
export interface CaptionCue { startTime: number; endTime: number; text: string }
export interface CaptionPreview { cues: CaptionCue[]; replaceCount: number; unknownOverlapCount: number }
interface SilenceResult { ranges: SilenceRange[]; reason?: string }
interface RipplePreview { removedDuration: number; duration: number; affectedTrackIds: string[] }

export interface PiAnalysisTarget {
  readonly context: PiContext;
  readonly revision: number;
  readonly bridge: Pick<PiBridge, "invoke">;
  isCurrent(): boolean;
  refresh(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid OpenReel analysis result.");
  return value as Record<string, unknown>;
}

function time(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createPiAnalysisJob(target: PiAnalysisTarget, jobId: string) {
  const identity = { ...target.context, jobId };
  const scope = { ...identity, expectedRevision: target.revision };
  let cancelled = false;
  const current = () => !cancelled && target.isCurrent();
  const validateScope = () => {
    if (!current()) throw new Error("The saved draft changed. Run analysis again.");
  };

  async function request(method: Channel, args: Record<string, unknown> = {}) {
    validateScope();
    const response = record(await target.bridge.invoke(`openreel.analysis.${method}`, { ...scope, ...args }));
    if (method === "applySilence" || method === "applyCaption") {
      if (response.revision !== target.revision + 1) throw new Error("Invalid OpenReel analysis result.");
      await target.refresh();
    } else {
      validateScope();
      if (response.revision !== target.revision) throw new Error("The saved draft changed. Run analysis again.");
    }
    return record(response.result);
  }

  return {
    async caption(clipId: string, language?: string): Promise<CaptionPreview> {
      const { cues, replaceCount, unknownOverlapCount } = await request("run", { clipId, kind: "caption", ...(language ? { language } : {}) });
      if (!Array.isArray(cues) || !cues.length || !time(replaceCount) || !Number.isSafeInteger(replaceCount) ||
        !time(unknownOverlapCount) || !Number.isSafeInteger(unknownOverlapCount)) throw new Error("Invalid OpenReel analysis result.");
      const parsed = cues.map(cue => {
        const { startTime, endTime, text } = record(cue);
        if (!time(startTime) || !time(endTime) || endTime <= startTime || typeof text !== "string" || !text.trim()) {
          throw new Error("Invalid OpenReel analysis result.");
        }
        return { startTime, endTime, text };
      });
      return { cues: parsed, replaceCount, unknownOverlapCount };
    },
    async silence(clipId: string, settings?: Record<string, unknown>): Promise<SilenceResult> {
      const { ranges, reason } = await request("run", { clipId, kind: "silence", ...(settings ? { settings } : {}) });
      if (!Array.isArray(ranges)) throw new Error("Invalid OpenReel analysis result.");
      return {
        ranges: ranges.map(range => {
          const { start, end } = record(range);
          if (!time(start) || !time(end) || end <= start) throw new Error("Invalid OpenReel analysis result.");
          return { start, end };
        }),
        reason: typeof reason === "string" ? reason : undefined,
      };
    },
    async previewSilence(ranges: SilenceRange[]): Promise<RipplePreview> {
      const { removedDuration, duration, affectedTrackIds } = await request("previewSilence", { ranges });
      if (!time(removedDuration) || !time(duration) || !Array.isArray(affectedTrackIds) ||
          affectedTrackIds.some(id => typeof id !== "string")) throw new Error("Invalid OpenReel analysis result.");
      return { removedDuration, duration, affectedTrackIds };
    },
    applyCaption: () => request("applyCaption", { confirm: true }),
    async saveSrt() {
      const { saved } = await request("saveSrt");
      if (typeof saved !== "boolean") throw new Error("Invalid OpenReel analysis result.");
      return saved;
    },
    applySilence: (ranges: SilenceRange[]) => request("applySilence", { ranges }),
    async cancel() {
      cancelled = true;
      await target.bridge.invoke("openreel.analysis.cancel", identity);
    },
  };
}
