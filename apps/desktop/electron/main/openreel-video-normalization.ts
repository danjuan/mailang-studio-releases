import { spawn } from "node:child_process";
import { constants, existsSync, type Stats } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { extname, join } from "node:path";

type Phase = "probing" | "normalizing";
type NormalizeOptions = {
  inputPath: string;
  outputPath: string;
  originalName?: string;
  signal: AbortSignal;
  onProgress?: (phase: Phase, progress?: number) => void;
};
type Stream = {
  codec_name?: string;
  codec_type?: string;
  channels?: number;
  profile?: string;
  pix_fmt?: string;
  color_transfer?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
};
type VideoProbe = {
  video: Stream;
  audio: Stream[];
  duration?: number;
  brand?: string;
};
type NativeOperation =
  | { kind: "probe" }
  | { kind: "transcode"; progress(seconds: number): void };

const formats = new Map([[".mp4", "mov"], [".mov", "mov"], [".webm", "matroska"], [".mkv", "matroska"]]);
const maxProbeBytes = 1024 * 1024;
const maxSingleAllocation = 256 * 1024 * 1024;
// Darwin's open(2) flag also rejects symlinks in parent path components.
const noSymlinks = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
const stallMs = 90_000;

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function bundledTools() {
  const root = process.resourcesPath && join(process.resourcesPath, "bin");
  const probe = root && join(root, "ffprobe");
  const encode = root && join(root, "ffmpeg");
  if (!probe || !encode || !existsSync(probe) || !existsSync(encode)) {
    throw failure("OPENREEL_CONVERSION_UNAVAILABLE", "This installation is missing the local OpenReel media converters.");
  }
  return { probe, encode };
}

function inputArguments(format: string): string[] {
  return [
    "-protocol_whitelist", "fd,pipe", "-max_alloc", String(maxSingleAllocation),
    ...(format === "mov" ? ["-enable_drefs", "0"] : []),
    "-f", format, "-fd", "3", "-i", "fd:",
  ];
}

function childOutput(binary: string, args: string[], input: FileHandle, output: FileHandle | undefined,
  signal: AbortSignal, operation: NativeOperation): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe", input.fd, output?.fd ?? "ignore"],
      signal,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = "";
    let progress = "";
    let seconds = -1;
    let reportedFailure: unknown;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: unknown) => {
      reportedFailure ??= error;
      child.kill("SIGKILL");
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(failure("OPENREEL_MEDIA_STALLED", "OpenReel could not make progress reading or converting this video."));
      }, stallMs);
      timer.unref();
    };
    reset();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (operation.kind === "probe") {
        length += chunk.length;
        if (length <= maxProbeBytes) chunks.push(chunk);
        else fail(failure("INVALID_MEDIA", "The video contains more stream metadata than OpenReel can inspect."));
        return;
      }
      const lines = (progress + chunk.toString("utf8")).split("\n");
      progress = (lines.pop() ?? "").slice(0, 128);
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (!match) continue;
        const next = Number(match[1]) / 1_000_000;
        if (!Number.isFinite(next) || next <= seconds) continue;
        seconds = next;
        reset();
        try { operation.progress(seconds); } catch (error) { fail(error); }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
    child.once("error", error => { reportedFailure ??= error; });
    child.once("close", code => {
      clearTimeout(timer);
      if (signal.aborted) reject(signal.reason);
      else if (reportedFailure) reject(reportedFailure);
      else if (code === 0) resolve(Buffer.concat(chunks, length));
      else if (stderr.includes("No space left on device")) {
        reject(failure("OPENREEL_MEDIA_NO_SPACE", "Free disk space in the project and import the video again."));
      } else if (stderr.includes("cannot create compression session")) {
        reject(failure("OPENREEL_CONVERSION_UNAVAILABLE", "The macOS H.264 encoder could not start for this video."));
      } else if (operation.kind === "probe") {
        reject(failure("INVALID_MEDIA", "OpenReel could not read the selected video format."));
      } else {
        reject(failure("OPENREEL_CONVERSION_FAILED", "OpenReel could not convert this video to H.264 MP4 with AAC audio."));
      }
    });
  });
}

function stable(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino
    && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

async function readSource(path: string, expected?: Stats): Promise<{ handle: FileHandle; stat: Stats }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noSymlinks);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1) throw failure("INVALID_MEDIA", "Select a nonempty local video file.");
    if (expected && !stable(expected, stat)) throw failure("WORKSPACE_CHANGED", "The video changed while OpenReel was importing it.");
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const codecFields = "stream=codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,color_transfer,channels";
const inspectVideo = [
  "format=duration", "format_tags=major_brand", codecFields,
  "stream_disposition=attached_pic", "stream_side_data=rotation",
].join(":");

async function probeVideo(probe: string, input: FileHandle, format: string, signal: AbortSignal): Promise<VideoProbe> {
  const bytes = await childOutput(probe, [
    "-hide_banner", "-v", "error", ...inputArguments(format), "-show_entries", inspectVideo, "-of", "json",
  ], input, undefined, signal, { kind: "probe" });
  const report = JSON.parse(bytes.toString("utf8")) as {
    streams?: Stream[];
    format?: { duration?: string; tags?: { major_brand?: string } };
  };
  const video = report.streams?.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video || !video.width || !video.height) {
    throw failure("INVALID_MEDIA", "The selected file does not contain a supported video stream.");
  }
  const duration = Number(report.format?.duration);
  return {
    video, audio: report.streams?.filter(stream => stream.codec_type === "audio") ?? [],
    brand: report.format?.tags?.major_brand,
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  };
}


export async function probeOpenReelAudioChannels(path: string, signal: AbortSignal): Promise<1 | 2> {
  const { probe } = bundledTools();
  const { handle } = await readSource(path);
  try {
    const { audio } = await probeVideo(probe, handle, "mov", signal);
    const channels = audio[0]?.channels;
    if (audio.length !== 1 || (channels !== 1 && channels !== 2)) {
      throw failure("INVALID_MEDIA", "Choose a video with exactly one mono or stereo audio stream.");
    }
    return channels;
  } finally {
    await handle.close();
  }
}

function compatibleVideo(stream: Stream) {
  return stream.codec_name === "h264" && (stream.pix_fmt === "yuv420p" || stream.pix_fmt === "yuvj420p");
}

function compatibleAudio(stream: Stream) {
  return stream.codec_name === "aac" && stream.profile === "LC";
}

function frameRate(stream: Stream): number {
  const [num, denom] = (stream.avg_frame_rate ?? "").split("/").map(Number);
  const rate = Number(num) / Number(denom);
  return Number.isFinite(rate) && rate > 0 ? rate : 30;
}

function quarterTurn(stream: Stream): boolean {
  const angle = stream.side_data_list?.find(item => typeof item.rotation === "number")?.rotation;
  return angle !== undefined && Math.abs(angle % 180) === 90;
}

function displaySize(stream: Stream) {
  const { width = 0, height = 0 } = stream;
  return quarterTurn(stream) ? { width: height, height: width } : { width, height };
}

function renderArguments(source: VideoProbe, format: string) {
  // Preserve an already-compatible AVC stream even when its container or
  // audio needs conversion. Decode other supported video with display rotation.
  const rate = Math.min(60, frameRate(source.video));
  const pixels = (source.video.width ?? 0) * (source.video.height ?? 0);
  const bitrate = Math.max(1_500_000, Math.min(55_000_000, Math.round(rate * pixels * 0.17)));
  const video = compatibleVideo(source.video)
    ? ["-c:v", "copy"]
    : ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-b:v", String(bitrate), "-fps_mode:v", "passthrough"];
  const audio = source.audio.flatMap((stream, index) => compatibleAudio(stream)
    ? [`-c:a:${index}`, "copy"]
    : [`-c:a:${index}`, "aac", `-b:a:${index}`, "192k", `-ar:a:${index}`, "48000", `-ac:a:${index}`, "2"]);
  return [
    "-hide_banner", "-v", "error", "-nostdin", "-stats_period", "0.5", "-progress", "pipe:1",
    "-threads", "4", "-filter_threads", "2", ...inputArguments(format),
    "-map", "0:V:0", "-map", "0:a?", ...video, ...audio,
    "-map_metadata", "-1", "-map_chapters", "-1", "-f", "mp4", "-fd", "4", "fd:",
  ];
}

function verifyNormalized(before: VideoProbe, after: VideoProbe): void {
  const inputSize = displaySize(before.video);
  const outputSize = displaySize(after.video);
  if (!compatibleVideo(after.video) || !after.audio.every(compatibleAudio) || after.audio.length !== before.audio.length
    || inputSize.width !== outputSize.width || inputSize.height !== outputSize.height || !after.duration
    || (before.duration !== undefined && Math.abs(after.duration - before.duration) > Math.max(0.3, 2 / frameRate(before.video)))) {
    throw failure("OPENREEL_CONVERSION_FAILED", "The converted video did not preserve its expected duration, picture orientation, or audio tracks.");
  }
}

export async function normalizeOpenReelVideo(options: NormalizeOptions): Promise<"unchanged" | "normalized"> {
  const { inputPath, outputPath, signal, onProgress } = options;
  const extension = extname(options.originalName ?? inputPath).toLowerCase();
  const format = formats.get(extension);
  if (!format) throw failure("INVALID_MEDIA", "Choose an MP4, MOV, WebM, or MKV video.");
  const tools = bundledTools();
  signal.throwIfAborted();
  onProgress?.("probing");
  const source = await readSource(inputPath);
  let input: VideoProbe;
  try {
    input = await probeVideo(tools.probe, source.handle, format, signal);
    if (!stable(source.stat, await source.handle.stat())) {
      throw failure("WORKSPACE_CHANGED", "The video changed while OpenReel was probing it.");
    }
  } finally {
    await source.handle.close();
  }
  signal.throwIfAborted();
  if (extension === ".mp4" && input.brand && input.brand !== "qt  "
    && compatibleVideo(input.video) && input.audio.every(compatibleAudio)) return "unchanged";
  if (!compatibleVideo(input.video) && ["smpte2084", "arib-std-b67"].includes(input.video.color_transfer ?? "")) {
    throw failure("INVALID_MEDIA", "Use an SDR source, or convert this HDR video to SDR before importing.");
  }
  if (!["h264", "hevc", "vp8", "vp9"].includes(input.video.codec_name ?? "")) {
    throw failure("INVALID_MEDIA", "This OpenReel preview can import H.264, HEVC, VP8, and VP9 video.");
  }

  const verified = await readSource(inputPath, source.stat);
  let created = false;
  try {
    signal.throwIfAborted();
    const output = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noSymlinks, 0o600);
    created = true;
    try {
      onProgress?.("normalizing", 0);
      await childOutput(tools.encode, renderArguments(input, format), verified.handle, output, signal, {
        kind: "transcode",
        progress(seconds) {
          onProgress?.("normalizing", input.duration ? Math.min(0.98, seconds / input.duration) : undefined);
        },
      });
      signal.throwIfAborted();
      if (!stable(verified.stat, await verified.handle.stat())) {
        throw failure("WORKSPACE_CHANGED", "The video changed while OpenReel was converting it.");
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const result = await readSource(outputPath);
    try {
      verifyNormalized(input, await probeVideo(tools.probe, result.handle, "mov", signal));
      if (!stable(result.stat, await result.handle.stat())) {
        throw failure("WORKSPACE_CHANGED", "The converted video changed while OpenReel was validating it.");
      }
    } finally {
      await result.handle.close();
    }
    signal.throwIfAborted();
    onProgress?.("normalizing", 1);
    return "normalized";
  } catch (error) {
    if (created) {
      await unlink(outputPath).catch(cleanupError => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError([error, cleanupError], "OpenReel could not clean up its incomplete video.");
        }
      });
    }
    throw error;
  } finally {
    await verified.handle.close();
  }
}
