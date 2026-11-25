import { extractOpenReelCaptionFlac, packagedOpenReelCaptionDecoder } from "./openreel-caption-audio";
import { openReelAudioWindow, type OpenReelAudioWindow } from "./openreel-audio-decode";
import { normalizeOpenReelCaptionEndpoint, resolveOpenReelCaptionDestination, uploadOpenReelCaptionFlac, type CaptionPhase } from "./openreel-caption-network";
import { OPENREEL_NATIVE_JOB_TIMEOUT_MS } from "./openreel-job-policy";
import { parseOpenReelServiceSrt, type CaptionCue } from "./openreel-srt";

export { normalizeOpenReelCaptionEndpoint, type CaptionPhase, type CaptionCue };

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function busy() {
  return failure("OPENREEL_TRANSCRIPTION_BUSY", "An OpenReel subtitle request is already running.");
}

function interrupted(signal: AbortSignal) {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return failure("TIMEOUT", "OpenReel transcription timed out.");
  }
  if (reason instanceof Error && "code" in reason && reason.code === "OPENREEL_CAPTION_SETTINGS_CHANGED") {
    return failure(reason.code, "The caption service settings changed.");
  }
  return failure("TOOL_ABORTED", "OpenReel transcription was stopped.");
}

export type CaptionInput = OpenReelAudioWindow & { language?: string };

export function readCaptionInput(value: unknown): CaptionInput {
  const input = value && typeof value === "object" ? value as { language?: unknown } : {};
  if (input.language !== undefined && (typeof input.language !== "string" || input.language.length > 24
    || !/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{1,8})*)$/i.test(input.language))) {
    throw failure("INVALID_ARGUMENT", "Provide a supported OpenReel transcription language code.");
  }
  const primaryLanguage = typeof input.language === "string" ? input.language.toLowerCase().split("-")[0] : undefined;
  return { ...openReelAudioWindow(value), language: primaryLanguage === "auto" ? undefined : primaryLanguage };
}

export class OpenReelTranscription {
  private running = false;

  async preflight(endpoint: string, signal: AbortSignal): Promise<void> {
    if (this.running) throw busy();
    const admission = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    try {
      await Promise.all([
        resolveOpenReelCaptionDestination(endpoint, admission),
        packagedOpenReelCaptionDecoder(admission),
      ]);
    } catch (error) {
      if (signal.aborted) throw interrupted(signal);
      if (admission.aborted) throw failure("TIMEOUT", "OpenReel subtitle service preflight timed out.");
      throw error;
    }
  }

  async run(
    endpoint: string, source: string, input: CaptionInput, turnSignal: AbortSignal,
    guard: () => void, progress: (phase: CaptionPhase, fraction?: number) => void,
    beforeUpload?: () => Promise<void>,
  ): Promise<{ cues: CaptionCue[]; srt: Buffer }> {
    if (this.running) throw busy();
    this.running = true;
    const signal = AbortSignal.any([turnSignal, AbortSignal.timeout(OPENREEL_NATIVE_JOB_TIMEOUT_MS)]);
    const check = () => { signal.throwIfAborted(); guard(); };
    try {
      check();
      const origin = normalizeOpenReelCaptionEndpoint(endpoint);
      const decoder = await packagedOpenReelCaptionDecoder(signal);
      check();
      progress("extracting", 0);
      const audio = await extractOpenReelCaptionFlac(decoder, source, input, signal, check);
      progress("extracting", 1);
      const srt = await uploadOpenReelCaptionFlac(origin, audio.bytes, input.language, signal, check, progress, beforeUpload);
      check();
      return { cues: parseOpenReelServiceSrt(srt, audio.duration), srt };
    } catch (error) {
      if (signal.aborted) throw interrupted(signal);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
