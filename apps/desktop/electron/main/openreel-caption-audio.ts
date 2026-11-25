import { execFile, spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openReelAudioInputArgs, openReelPcmRate, packagedOpenReelDecoder, type OpenReelAudioWindow } from "./openreel-audio-decode";

const exec = promisify(execFile);
const maxFlacBytes = 16 * 1024 * 1024;
const flacHeaderSize = 42;
const noLinks = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export async function packagedOpenReelCaptionDecoder(signal: AbortSignal) {
  const code = "OPENREEL_DEPENDENCY_UNAVAILABLE";
  const decoder = await packagedOpenReelDecoder(signal, code);
  try {
    const [encoder, muxer] = await Promise.all(["encoder", "muxer"].map(kind =>
      exec(decoder, ["-hide_banner", "-h", `${kind}=flac`], { timeout: 5_000, signal })));
    if (encoder?.stdout.startsWith("Encoder flac ") && muxer?.stdout.startsWith("Muxer flac ")) return decoder;
  } catch {
    signal.throwIfAborted();
  }
  throw failure(code, "This installation cannot prepare FLAC audio for cloud subtitles.");
}

function sameFile(before: Stats, after: Stats) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** FFmpeg finalizes STREAMINFO on the seekable output descriptor. */
export function readOpenReelFlacDuration(bytes: Buffer, requested: number): number {
  const invalid = () => failure("OPENREEL_AUDIO_DECODE_FAILED", "The extracted audio did not match the requested FLAC format.");
  if (bytes.length <= flacHeaderSize || bytes.toString("ascii", 0, 4) !== "fLaC" ||
      (bytes.readUInt8(4) & 127) !== 0 || bytes.readUIntBE(5, 3) !== 34) throw invalid();
  const streamInfo = bytes.readBigUInt64BE(18);
  const sampleRate = Number(streamInfo >> 44n);
  const channels = Number((streamInfo >> 41n) & 7n) + 1;
  const bitsPerSample = Number((streamInfo >> 36n) & 31n) + 1;
  const samples = Number(streamInfo & ((1n << 36n) - 1n));
  if (sampleRate !== openReelPcmRate || channels !== 1 || bitsPerSample !== 16 ||
      samples < 1 || samples > Math.ceil(requested * openReelPcmRate) + 1) throw invalid();
  return samples / sampleRate;
}

async function encodeFlac(decoder: string, input: OpenReelAudioWindow, source: FileHandle, output: FileHandle, signal: AbortSignal) {
  const args = [
    ...openReelAudioInputArgs(input), "-map_metadata", "-1", "-map_chapters", "-1", "-vn",
    "-ac", "1", "-ar", String(openReelPcmRate), "-sample_fmt", "s16", "-c:a", "flac",
    "-fs", String(maxFlacBytes), "-f", "flac", "-fd", "4", "fd:",
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(decoder, args, { stdio: ["ignore", "ignore", "ignore", source.fd, output.fd], signal, killSignal: "SIGKILL" });
    let processError: unknown;
    child.once("error", error => { processError = error; });
    child.once("close", code => {
      if (signal.aborted) reject(signal.reason);
      else if (processError || code !== 0) reject(failure("OPENREEL_AUDIO_DECODE_FAILED", "OpenReel could not extract the selected audio as FLAC."));
      else resolve();
    });
  });
}

export async function extractOpenReelCaptionFlac(
  decoder: string, sourcePath: string, input: OpenReelAudioWindow, signal: AbortSignal, check: () => void,
) {
  check();
  const source = await open(sourcePath, constants.O_RDONLY | noLinks | constants.O_NONBLOCK);
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size < 1) throw failure("INVALID_MEDIA", "Select a readable OpenReel media source.");
    check();
    const job = await mkdtemp(join(tmpdir(), "pi-openreel-caption-"));
    try {
      const output = await open(join(job, "audio.flac"), "wx+", 0o600);
      try {
        check();
        await encodeFlac(decoder, input, source, output, signal);
        check();
        const current = await lstat(sourcePath).catch(() => undefined);
        if (!current || !sameFile(before, current) || !sameFile(before, await source.stat())) {
          throw failure("WORKSPACE_CHANGED", "The OpenReel source changed while preparing its audio.");
        }
        const { size } = await output.stat();
        if (size <= flacHeaderSize || size >= maxFlacBytes) {
          throw failure("OPENREEL_AUDIO_DECODE_FAILED", "The extracted audio is empty or too large.");
        }
        const bytes = Buffer.allocUnsafe(size);
        const { bytesRead } = await output.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) throw failure("OPENREEL_AUDIO_DECODE_FAILED", "OpenReel could not read the extracted FLAC audio.");
        check();
        return { bytes, duration: readOpenReelFlacDuration(bytes, input.duration) };
      } finally {
        await output.close();
      }
    } finally {
      await rm(job, { recursive: true, force: true });
    }
  } finally {
    await source.close();
  }
}
