export const OPENREEL_SRT_MAX_BYTES = 1024 * 1024;
const maxCues = 500;
const maxCueTextLength = 4096;
const timecodePattern = "\\d{2}:[0-5]\\d:[0-5]\\d,\\d{3}";
const timingLine = new RegExp(`^(${timecodePattern})[ \\t]+-->[ \\t]+(${timecodePattern})[ \\t]*$`);

export type CaptionCue = { text: string; startTime: number; endTime: number };

function invalidSrt() {
  return Object.assign(new Error("The subtitle service returned an invalid SRT file."), { code: "OPENREEL_CAPTION_INVALID_SRT" });
}

function timecodeMs(time: string) {
  return (Number(time.slice(0, 2)) * 3600 + Number(time.slice(3, 5)) * 60 +
    Number(time.slice(6, 8))) * 1000 + Number(time.slice(9));
}

/** Reject the entire response if any cue is incomplete or outside the actual submitted audio. */
export function parseOpenReelServiceSrt(bytes: Uint8Array, duration: number): CaptionCue[] {
  if (bytes.byteLength > OPENREEL_SRT_MAX_BYTES || !Number.isFinite(duration) || duration <= 0) throw invalidSrt();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  } catch {
    throw invalidSrt();
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw invalidSrt();
  if (!text.trim()) {
    throw Object.assign(new Error("The subtitle service returned no usable subtitles."), { code: "OPENREEL_CAPTION_EMPTY_SRT" });
  }
  const blocks = text.trim().split(/\n(?:[ \t]*\n)+/);
  if (blocks.length > maxCues) throw invalidSrt();
  return blocks.map(block => {
    const [index, timing, ...lines] = block.split("\n");
    const times = timingLine.exec(timing ?? "");
    if (!/^0*[1-9]\d*$/.test(index ?? "") || !times) throw invalidSrt();
    const startTime = timecodeMs(times[1]!) / 1000;
    const endTime = timecodeMs(times[2]!) / 1000;
    const cueText = lines.join("\n").trim();
    if (startTime >= endTime || endTime > duration || !cueText || cueText.length > maxCueTextLength ||
        lines.some(line => timingLine.test(line))) throw invalidSrt();
    return { text: cueText, startTime, endTime };
  });
}
