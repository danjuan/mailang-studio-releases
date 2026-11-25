"use strict";

const { createHash } = require("node:crypto");
const { splitLongVideoDuration } = require("./long-video-plan.js");
const { readFrame, readReferenceFrames } = require("./reference-frames.js");
const { isReferenceLabel, resolveMentions, stripMentionMarkup } = require("./reference-mentions.js");

const MODES = new Set(["omni", "frames", "multiframe", "edit", "long", "remake"]);
const RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"]);
const RESOLUTIONS = new Set(["480P", "768P"]);
const MODELS = new Set(["MiniMax-H3-Lite", "MiniMax-H3-Highspeed"]);
const REMAKE_STRATEGIES = new Set(["creative", "replace-subject", "imitate-motion"]);
const REFERENCE_LIMITS = { image: 9, video: 3, audio: 3 };
const REFERENCE_NAMES = { image: "图片", video: "视频", audio: "音频" };
const MAX_REFERENCE_MEDIA_BYTES = { video: 50_000_000, audio: 15_000_000 };
// Leave room in the provider's 64 MB request envelope for text and JSON.
const REFERENCE_BODY_LIMIT = 63_500_000;

function fail(code = "INVALID_INPUT") {
  return Object.assign(new Error(code), { code });
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value;
}

function within(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function promptText(value, optional = false) {
  const prompt = typeof value === "string" ? value.trim() : "";
  if ((!prompt && !optional) || prompt.length > 8000 || Array.from(prompt).length > 4000) throw fail();
  return prompt;
}

function readReference(value) {
  const prefix = typeof value === "string" && /^data:(image\/(?:jpeg|png|webp)|video\/mp4|audio\/(?:wav|x-wav|mp3|mpeg));base64,/.exec(value);
  if (!prefix) throw fail();
  const [kind, subtype] = prefix[1].split("/");
  if (kind === "image") return { kind, ...readFrame(value) };
  const maxBytes = MAX_REFERENCE_MEDIA_BYTES[kind];
  const base64 = value.slice(prefix[0].length);
  if (base64.length > Math.ceil(maxBytes / 3) * 4 || base64.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fail();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== base64) throw fail();
  let valid;
  let format = subtype;
  if (kind === "video") {
    valid = bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp" &&
      bytes.readUInt32BE(0) >= 12 && bytes.readUInt32BE(0) <= bytes.length;
  } else if (subtype === "wav" || subtype === "x-wav") {
    valid = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE";
    format = "wav";
  } else {
    valid = bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3" ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    format = "mp3";
  }
  if (!valid) throw fail();
  return { kind, url: `data:${kind}/${format};base64,${base64}`, digest: createHash("sha256").update(bytes).digest("hex") };
}

function readReferences(raw = []) {
  if (!Array.isArray(raw) || raw.length > 12) throw fail();
  const references = [];
  const labels = new Map();
  const counts = { image: 0, video: 0, audio: 0 };
  let total = 0;
  let length = 0;
  for (const entry of raw) {
    const { label, urls } = object(entry);
    if (!isReferenceLabel(label) || labels.has(label) ||
        !Array.isArray(urls) || urls.length === 0 || urls.length > 12) throw fail();
    const numbered = [];
    for (const url of urls) {
      if (typeof url !== "string" || ++total > 12 || (length += url.length) > REFERENCE_BODY_LIMIT) throw fail();
      const reference = readReference(url);
      const index = ++counts[reference.kind];
      if (index > REFERENCE_LIMITS[reference.kind]) throw fail();
      numbered.push(REFERENCE_NAMES[reference.kind] + index);
      references.push(reference);
    }
    labels.set(label, numbered.join("、"));
  }
  // The provider requires a picture or video alongside any audio references.
  if (counts.audio && counts.image + counts.video === 0) throw fail("REFERENCE_VISUAL_REQUIRED");
  return { references, labels, hasVideo: counts.video > 0 };
}

function editRegionGuidance(value) {
  const { x, y, width, height, atSeconds } = object(value);
  const edge = 1 + Number.EPSILON;
  if (![x, y, width, height, atSeconds].every(Number.isFinite) ||
      x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 ||
      x + width > edge || y + height > edge || atSeconds < 0 || atSeconds > 15) throw fail();

  const percentage = (value) => `${Number((Math.min(1, value) * 100).toFixed(3))}%`;
  const seconds = Number(atSeconds.toFixed(3));
  return `请根据视频1第 ${seconds} 秒的画面定位编辑对象。以画面左上角为原点，标记区域左上坐标为（${percentage(x)}, ${percentage(y)}），右下坐标为（${percentage(x + width)}, ${percentage(y + height)}）。请将修改集中在该区域指示的对象，尽量保留其他内容。\n`;
}

function remakeGuidance(strategy, references) {
  if (strategy === undefined) return "参考视频1的动作、镜头和节奏，生成新的画面。\n";

  const [template, ...materials] = references;
  if (template?.kind !== "video") throw fail("REFERENCE_VIDEO_REQUIRED");
  if (strategy === "creative") {
    return "参考视频1的镜头语言、动作与节奏，结合提示词和参考素材重新创作构图、场景或主体。\n";
  }

  const counts = { image: 0, video: 1 };
  for (const { kind, digest } of materials) {
    if (kind === "audio") continue;
    const index = ++counts[kind];
    if (digest === template.digest) continue;
    const material = REFERENCE_NAMES[kind] + index;
    if (strategy === "replace-subject") {
      return `用${material}中的主体替换视频1中的主要主体，保持新主体的身份与外观，尽量延续模板的背景、构图、镜头运动及节奏。\n`;
    }
    return `让${material}中的主体模仿视频1的动作和节奏，保持新主体的外观。按提示词使用新场景和构图。\n`;
  }
  throw fail("REMAKE_MATERIAL_REQUIRED");
}

function ordinaryParts(input, prompt, duration, longDurations) {
  const { mode } = input;
  if (mode === "frames") {
    if (input.references?.length || input.frames === undefined) throw fail();
    const { first, last, mode: frameMode } = readReferenceFrames(input.frames);
    return { parts: [{ prompt: resolveMentions(prompt, new Map()), duration, first, last }], frameMode };
  }
  if (input.frames !== undefined) throw fail();
  const { references, labels, hasVideo } = readReferences(input.references);
  const resolved = resolveMentions(prompt, labels);
  if ((mode === "edit" || mode === "remake") && !hasVideo) throw fail("REFERENCE_VIDEO_REQUIRED");
  if (mode === "edit") {
    const guidance = input.editRegion === undefined ? "" : editRegionGuidance(input.editRegion);
    return { parts: [{ prompt: "编辑视频1中的内容。\n" + guidance + resolved, duration, references }] };
  }
  if (mode === "remake") {
    return { parts: [{ prompt: remakeGuidance(input.remakeStrategy, references) + resolved, duration, references }] };
  }
  if (!longDurations) return { parts: [{ prompt: resolved, duration, references }] };
  return {
    parts: longDurations.map((seconds, index) => ({
      prompt: index === 0 ? resolved : "从给定首帧自然接续上一段，保持主体、场景和运动连续。\n" +
        stripMentionMarkup(prompt),
      duration: seconds,
      ...(index === 0 ? { references } : { continuation: true }),
    })),
  };
}

function multiframeParts(input, prompt) {
  const { keyframes } = input;
  if (!Array.isArray(keyframes) || !within(keyframes.length, 2, 10) || input.frames !== undefined || input.references?.length) {
    throw fail();
  }
  const base = resolveMentions(prompt, new Map());
  const frames = keyframes.map((value, index) => {
    const { url, duration, prompt: transition } = object(value);
    const frame = readFrame(url);
    if (index === keyframes.length - 1) return { frame };
    if (!within(duration, 4, 15)) throw fail();
    return { frame, duration, prompt: promptText(transition, true) };
  });
  const transitions = frames.slice(0, -1);
  return {
    parts: transitions.map(({ frame, prompt: transition, duration }, index) => ({
      first: frame, last: frames[index + 1].frame, duration,
      prompt: resolveMentions(transition ? base + "\n" + transition : base, new Map()),
    })),
    // The workbench limits each description to 300 UTF-16 units. Longer
    // descriptions from older API clients still generate without a reuse plan.
    keyframeTransitions: transitions.every(({ prompt }) => prompt.length <= 300)
      ? transitions.map(({ duration, prompt }) => ({ duration, prompt }))
      : undefined,
  };
}

function planVideo(raw) {
  const input = object(raw);
  const { sessionId, mode, resolution = "480P", ratio = "16:9", count = 1, duration = 4,
    model = "MiniMax-H3-Lite", remakeStrategy } = input;
  if (typeof sessionId !== "string" || !sessionId || !MODES.has(mode) || !RESOLUTIONS.has(resolution) ||
      !MODELS.has(model) || !RATIOS.has(ratio) || !within(count, 1, 4) ||
      (mode !== "edit" && input.editRegion !== undefined) ||
      (remakeStrategy !== undefined && (mode !== "remake" || !REMAKE_STRATEGIES.has(remakeStrategy))) ||
      (input.references !== undefined && !Array.isArray(input.references))) throw fail();
  const prompt = promptText(input.prompt);
  const longDurations = mode === "long" ? splitLongVideoDuration(duration) : null;
  const validDuration = mode === "long" ? longDurations !== null : within(duration, 4, 15);
  if (mode !== "multiframe" && (!validDuration || input.keyframes !== undefined)) throw fail();
  const { parts, frameMode, keyframeTransitions } = mode === "multiframe"
    ? multiframeParts(input, prompt) : ordinaryParts(input, prompt, duration, longDurations);
  // MiniMax allows up to 7,000 code points after expanding reference labels.
  if (parts.some((part) => Array.from(part.prompt).length > 7000)) throw fail();
  const resultDuration = parts.reduce((sum, part) => sum + part.duration, 0);
  const record = {
    sessionId, kind: "video", prompt, ratio, duration: resultDuration, workflow: mode, resolution, model,
    plannedRequests: parts.length,
    ...(keyframeTransitions ? { keyframeTransitions } : {}),
    ...(frameMode ? { frameMode } : {}),
    ...(remakeStrategy === undefined ? {} : { remakeStrategy }),
  };
  return {
    record, parts, count,
    generateAudio: mode === "edit" || mode === "remake" ||
      parts.some((part) => part.references?.some((reference) => reference.kind === "audio")),
    requests: parts.length * count,
    totalSeconds: resultDuration * count,
    fingerprint: JSON.stringify([record, count, parts.map((part) => [
      part.duration, part.prompt, part.first?.digest, part.last?.digest,
      part.references?.map((reference) => reference.digest),
    ])]),
  };
}

module.exports = { planVideo };
