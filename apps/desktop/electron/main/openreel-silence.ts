import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { decodeOpenReelPcm, openReelAudioWindow, openReelPcmRate, packagedOpenReelDecoder } from "./openreel-audio-decode";
import { OPENREEL_NATIVE_JOB_TIMEOUT_MS } from "./openreel-job-policy";

type SilenceInput = ReturnType<typeof openReelAudioWindow> & {
  channels: 1 | 2;
  threshold: number;
  minFrameSeconds: number;
};

export function readSilenceInput(value: unknown): SilenceInput {
  const window = openReelAudioWindow(value);
  const input = value as { channels?: unknown; threshold?: unknown; minFrameSeconds?: unknown };
  if ((input.channels !== 1 && input.channels !== 2)
    || typeof input.threshold !== "number" || !Number.isFinite(input.threshold) || input.threshold < -80 || input.threshold > -20
    || typeof input.minFrameSeconds !== "number" || !Number.isFinite(input.minFrameSeconds) || input.minFrameSeconds < 0.1 || input.minFrameSeconds > 48) {
    throw Object.assign(new Error("Choose mono or stereo audio and supported OpenReel silence settings."), { code: "INVALID_ARGUMENT" });
  }
  return { ...window, channels: input.channels, threshold: input.threshold, minFrameSeconds: input.minFrameSeconds };
}

/** Preserve channel peaks across fragmented PCM and continuous 100 ms windows. */
export class OpenReelSilenceDetector {
  private readonly channelCount: 1 | 2;
  private readonly threshold: number;
  private readonly frameLimit: number;
  private readonly minimum: number;
  private readonly windows = 1600;
  private frame = 0;
  private peak = 0;
  private firstQuiet: number | null = null;
  private hasSignal = false;
  private ranges: Array<{ start: number; end: number }> = [];
  private pending = Buffer.alloc(0);

  constructor(channels: 1 | 2, thresholdDb: number, duration: number, minimum: number) {
    this.channelCount = channels;
    this.threshold = 10 ** (thresholdDb / 20);
    this.frameLimit = Math.round(duration * openReelPcmRate);
    this.minimum = Math.round(minimum * openReelPcmRate);
  }

  private finishWindow(start: number) {
    if (this.peak < this.threshold) this.firstQuiet ??= start;
    else {
      this.hasSignal = true;
      this.finishRange(start);
    }
    this.peak = 0;
  }

  private finishRange(end: number) {
    if (this.firstQuiet !== null && end - this.firstQuiet >= this.minimum) {
      this.ranges.push({ start: this.firstQuiet / openReelPcmRate, end: end / openReelPcmRate });
    }
    this.firstQuiet = null;
  }

  push(chunk: Buffer): number {
    const pcm = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frameBytes = this.channelCount * 4;
    const complete = pcm.length - pcm.length % frameBytes;
    this.pending = Buffer.from(pcm.subarray(complete));
    for (let offset = 0; offset < complete && this.frame < this.frameLimit; offset += frameBytes) {
      for (let channel = 0; channel < this.channelCount; channel++) {
        const sample = pcm.readFloatLE(offset + channel * 4);
        // A corrupt non-finite sample must not be interpreted as quiet.
        this.peak = Math.max(this.peak, Number.isFinite(sample) ? Math.abs(sample) : 1);
      }
      this.frame++;
      if (this.frame % this.windows === 0) this.finishWindow(this.frame - this.windows);
    }
    return Math.min(1, this.frame / this.frameLimit);
  }

  finish() {
    if (this.frame % this.windows !== 0) this.finishWindow(this.frame - this.frame % this.windows);
    this.finishRange(this.frame);
    return { ranges: this.hasSignal ? this.ranges : [], allQuiet: !this.hasSignal };
  }
}

export class OpenReelSilence {
  private running = false;

  async run(
    source: string, input: SilenceInput, invocationSignal: AbortSignal, guard: () => void, progress: (fraction: number) => void,
  ) {
    if (this.running) throw Object.assign(new Error("A local OpenReel silence analysis is already running."), { code: "BUSY" });
    this.running = true;
    const signal = AbortSignal.any([invocationSignal, AbortSignal.timeout(OPENREEL_NATIVE_JOB_TIMEOUT_MS)]);
    const check = () => { signal.throwIfAborted(); guard(); };
    try {
      check();
      const decoder = await packagedOpenReelDecoder(signal, "OPENREEL_SILENCE_UNAVAILABLE");
      check();
      const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size <= 0) throw Object.assign(new Error("Select a readable OpenReel media source."), { code: "INVALID_MEDIA" });
        const detector = new OpenReelSilenceDetector(input.channels, input.threshold, input.duration, input.minFrameSeconds);
        let lastProgress = 0;
        await decodeOpenReelPcm(decoder, file.fd, input, input.channels, signal, check, chunk => {
          const fraction = detector.push(chunk);
          if (fraction >= lastProgress + 0.01) {
            progress(fraction);
            lastProgress = fraction;
          }
        });
        check();
        const final = await file.stat();
        const current = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const now = await current.stat();
          if ([final, now].some(info => info.dev !== stat.dev || info.ino !== stat.ino || info.size !== stat.size || info.mtimeMs !== stat.mtimeMs)) {
            throw Object.assign(new Error("The OpenReel source changed during silence analysis."), { code: "WORKSPACE_CHANGED" });
          }
        } finally {
          await current.close();
        }
        check();
        progress(1);
        return detector.finish();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (invocationSignal.aborted) throw invocationSignal.reason;
      if (signal.aborted) throw Object.assign(new Error("OpenReel silence analysis timed out."), { code: "TIMEOUT" });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
