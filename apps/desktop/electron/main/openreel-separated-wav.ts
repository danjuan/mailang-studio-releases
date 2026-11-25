import { spawn } from "node:child_process";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OPENREEL_JOB_MAX_SECONDS, OPENREEL_NATIVE_JOB_TIMEOUT_MS } from "./openreel-job-policy";

import { probeOpenReelAudioChannels } from "./openreel-video-normalization";

const sampleRate = 48_000;
const bytesPerSample = 2;
const maxHeaderSize = 4096;

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function inspectSeparatedWav(header: Buffer, bytes: number, channels: number, duration: number) {
  if (header.length < 44 || header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WAVE" || header.readUInt32LE(4) + 8 !== bytes) {
    throw failure("INVALID_MEDIA", "The local decoder returned an invalid WAV file.");
  }
  let validFormat = false;
  for (let start = 12; start + 8 <= header.length;) {
    const chunk = header.toString("ascii", start, start + 4);
    const length = header.readUInt32LE(start + 4);
    const body = start + 8;
    if (chunk === "fmt " && length >= 16 && body + 16 <= header.length) {
      validFormat = header.readUInt16LE(body) === 1 && header.readUInt16LE(body + 2) === channels &&
        header.readUInt32LE(body + 4) === sampleRate && header.readUInt16LE(body + 14) === bytesPerSample * 8;
    } else if (chunk === "data" && validFormat && body + length <= bytes && length > 0) {
      const seconds = length / (sampleRate * channels * bytesPerSample);
      if (Math.abs(seconds - duration) <= 0.03) return seconds;
      break;
    }
    start = body + length + length % 2;
  }
  throw failure("INVALID_MEDIA", "The separated audio did not match the requested format and duration.");
}

export async function decodeOpenReelSeparatedWav(input: {
  source: string;
  temporary: string;
  startTime: number;
  duration: number;
  signal: AbortSignal;
  guard(): void;
  progress(fraction: number): void;
}) {
  const { source, temporary, startTime, duration, guard, progress } = input;
  if (!Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(duration) || duration <= 0 ||
      duration > OPENREEL_JOB_MAX_SECONDS) {
    throw failure("INVALID_ARGUMENT", "Select a nonempty mono or stereo video range of up to 300 seconds.");
  }
  const decoder = process.resourcesPath && join(process.resourcesPath, "bin", "ffmpeg");
  if (!decoder || !existsSync(decoder)) {
    throw failure("OPENREEL_DEPENDENCY_UNAVAILABLE", "The local OpenReel decoder is not installed.");
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(OPENREEL_NATIVE_JOB_TIMEOUT_MS)]);
  const check = () => { signal.throwIfAborted(); guard(); };
  check();
  const noLinks = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
  const channels = await probeOpenReelAudioChannels(source, signal);
  check();
  const sourceHandle = await open(source, constants.O_RDONLY | noLinks | constants.O_NONBLOCK);
  let created: Stats | undefined;
  let completed = false;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size < 1) throw failure("INVALID_MEDIA", "Choose a readable OpenReel video.");
    const output = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noLinks, 0o600);
    try {
      created = await output.stat();
      check();
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:1",
        "-protocol_whitelist", "fd,pipe", "-max_alloc", "268435456", "-enable_drefs", "0", "-f", "mov", "-ss", String(startTime), "-fd", "3", "-i", "fd:",
        "-t", String(duration), "-map", "0:a:0", "-vn", "-ar", String(sampleRate), "-ac", String(channels), "-c:a", "pcm_s16le",
        "-f", "wav", "-fd", "4", "fd:"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(decoder, args, { stdio: ["ignore", "pipe", "pipe", sourceHandle.fd, output.fd], signal, killSignal: "SIGKILL" });
        let error: unknown;
        let diagnostics = "";
        let pending = "";
        child.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString("utf8")).slice(-512); });
        child.stdout?.on("data", (chunk: Buffer) => {
          const lines = (pending + chunk.toString("utf8")).split("\n");
          pending = (lines.pop() ?? "").slice(0, 256);
          try {
            check();
            for (const line of lines) {
              const match = /^out_time_us=(\d+)$/.exec(line.trim());
              if (match) progress(Math.min(1, Number(match[1]) / 1_000_000 / duration));
            }
          } catch (cause) { error ??= cause; child.kill("SIGKILL"); }
        });
        child.once("error", cause => { error ??= cause; });
        child.once("close", code => {
          if (signal.aborted) reject(signal.reason);
          else if (error) reject(error);
          else if (code === 0) resolve();
          else if (diagnostics.includes("No space left on device")) {
            reject(failure("OPENREEL_MEDIA_NO_SPACE", "Free disk space in the project and separate the audio again."));
          } else reject(failure("OPENREEL_AUDIO_DECODE_FAILED", "OpenReel could not write the selected audio as a local WAV."));
        });
      });
      check();
      if (!sameFile(before, await sourceHandle.stat())) throw failure("WORKSPACE_CHANGED", "The source video changed while separating its audio.");
      const info = await output.stat();
      const header = Buffer.alloc(Math.min(info.size, maxHeaderSize));
      const { bytesRead } = await output.read(header, 0, header.length, 0);
      const seconds = inspectSeparatedWav(header.subarray(0, bytesRead), info.size, channels, duration);
      await output.sync();
      check();
      completed = true;
      return { duration: seconds, bytes: info.size, channels, identity: info };
    } finally {
      await output.close();
    }
  } finally {
    await sourceHandle.close();
    if (created && !completed) {
      try {
        const actual = await lstat(temporary);
        if (actual.isFile() && actual.dev === created.dev && actual.ino === created.ino) await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
