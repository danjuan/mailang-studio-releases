class NoAudioStreamError extends Error {
  constructor() {
    super("Media has no matching audio stream.");
    this.name = "NoAudioStreamError";
  }
}

export interface ExtractAudioProgressOptions {
  onProgress?: (progress: { phase?: string; progress: number }) => void;
}

// Scoped project sources are decoded separately without materializing the source.
export async function extractAudioWav(
  file: File | Blob,
  audioTrackIndex = 0,
  options?: ExtractAudioProgressOptions,
): Promise<Blob> {
  const { Input, BlobSource, Output, BufferTarget, WavOutputFormat, ALL_FORMATS, Conversion } =
    await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = (await input.getAudioTracks())[audioTrackIndex];
    if (!track) throw new NoAudioStreamError();

    const target = new BufferTarget();
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: new WavOutputFormat(), target }),
      video: { discard: true },
      audio: (candidate) => candidate === track
        ? { codec: "pcm-s16" }
        : { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("Cannot decode the selected audio track locally.");
    if (options?.onProgress) {
      const onProgress = options.onProgress;
      conversion.onProgress = (progress) => onProgress({ phase: "encoding", progress });
    }
    await conversion.execute();
    if (!target.buffer) throw new Error("Decoded audio is empty.");
    return new Blob([target.buffer], { type: "audio/wav" });
  } finally {
    input.dispose();
  }
}
