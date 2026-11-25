import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { OPENREEL_JOB_MAX_SECONDS } from "./openreel-job-policy";

export const openReelPcmRate = 16_000;
const runCommand = promisify(execFile);
const demuxers = new Map([[".mp4", "mov"], [".mp3", "mp3"], [".wav", "wav"]]);

export type OpenReelAudioWindow = {
  path: string;
  workspacePath: string;
  startTime: number;
  duration: number;
};

export function openReelAudioWindow(value: unknown): OpenReelAudioWindow {
  const input = value && typeof value === "object" ? value as Partial<OpenReelAudioWindow> : {};
  if (typeof input.path !== "string" || input.path.length > 1024 || !demuxers.has(extname(input.path).toLowerCase())
    || /[\\:\u0000-\u001f]/.test(input.path)
    || input.path.split("/").some(part => !part || part === "." || part === "..")
    || typeof input.workspacePath !== "string" || !input.workspacePath
    || typeof input.startTime !== "number" || !Number.isFinite(input.startTime) || input.startTime < 0
    || typeof input.duration !== "number" || !Number.isFinite(input.duration)
    || input.duration <= 0 || input.duration > OPENREEL_JOB_MAX_SECONDS) {
    throw Object.assign(new Error(`Choose a local MP4, MP3, or WAV audio window of at most ${OPENREEL_JOB_MAX_SECONDS} seconds.`), {
      code: "INVALID_ARGUMENT",
    });
  }
  return { path: input.path, workspacePath: input.workspacePath, startTime: input.startTime, duration: input.duration };
}

export async function packagedOpenReelDecoder(signal: AbortSignal, code: string): Promise<string> {
  const decoder = process.platform === "darwin" && process.resourcesPath
    ? join(process.resourcesPath, "bin", "ffmpeg")
    : undefined;
  if (decoder && existsSync(decoder)) {
    try {
      const { stdout } = await runCommand(decoder, ["-hide_banner", "-protocols"], { timeout: 5_000, signal });
      const inputs = stdout.split("Output:")[0];
      if (inputs?.split(/\r?\n/).some(line => line.trim() === "fd")) return decoder;
    } catch {
      signal.throwIfAborted();
    }
  }
  throw Object.assign(new Error("This installation is missing the local OpenReel audio decoder."), { code });
}

export function openReelAudioInputArgs(input: OpenReelAudioWindow): string[] {
  const demuxer = demuxers.get(extname(input.path).toLowerCase());
  if (!demuxer) throw Object.assign(new Error("Select an MP4, MP3, or WAV source."), { code: "INVALID_MEDIA" });
  // MOV data references and other file or network protocols stay off.
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "fd,pipe",
    ...(demuxer === "mov" ? ["-enable_drefs", "0"] : []),
    "-f", demuxer, "-ss", String(input.startTime), "-fd", "3",
    "-i", "fd:", "-t", String(input.duration), "-map", "0:a:0",
  ];
}

/** Stream only the bounded audio window from the admitted descriptor. */
export async function decodeOpenReelPcm(
  decoder: string, fd: number, input: OpenReelAudioWindow, channels: 1 | 2, signal: AbortSignal,
  guard: () => void, receive: (chunk: Buffer) => void,
): Promise<void> {
  guard();
  signal.throwIfAborted();
  const args = [
    ...openReelAudioInputArgs(input), "-ac", String(channels),
    "-ar", String(openReelPcmRate), "-acodec", "pcm_f32le", "-f", "f32le", "pipe:1",
  ];
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(decoder, args, { stdio: ["ignore", "pipe", "ignore", fd], signal });
    let length = 0;
    const frameBytes = channels * 4;
    const bytesLimit = (Math.ceil(input.duration * openReelPcmRate) + openReelPcmRate) * frameBytes;
    let processError: unknown;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (processError) return;
      length += chunk.length;
      try {
        guard();
        if (length > bytesLimit) throw Object.assign(new Error("The decoded audio exceeds its window."), { code: "INVALID_MEDIA" });
        receive(chunk);
      } catch (error) {
        processError = error;
        child.kill();
      }
    });
    child.once("error", error => { processError ??= error; });
    child.once("close", (code) => {
      if (signal.aborted) reject(signal.reason);
      else if (processError) reject(processError);
      else if (code !== 0 || !length || length % frameBytes !== 0) {
        reject(Object.assign(new Error("The local decoder could not read an audio track from this clip."), { code: "INVALID_MEDIA" }));
      } else resolve();
    });
  });
}
