"use strict";

const { readFrame } = require("./reference-frames.js");
const { isReferenceLabel, resolveMentions } = require("./reference-mentions.js");

const AREAS = new Set(["1K", "2K", "4K"]);
const MODELS = new Set(["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"]);
const RATIOS = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "21:9"]);
const MAX_REFERENCES = 9;

function fail(code = "INVALID_INPUT") {
  return Object.assign(new Error(code), { code });
}

function readImages(groups = []) {
  if (!Array.isArray(groups) || groups.length > MAX_REFERENCES) throw fail();
  const images = [];
  const labels = new Map();
  for (const group of groups) {
    const { label, urls } = group ?? {};
    if (!isReferenceLabel(label) || labels.has(label) ||
        !Array.isArray(urls) || !urls.length || images.length + urls.length > MAX_REFERENCES) throw fail();
    const numbers = [];
    for (const url of urls) {
      images.push(readFrame(url));
      numbers.push("图" + images.length);
    }
    labels.set(label, numbers.join("、"));
  }
  return { images, labels };
}

function planImage(input) {
  const { sessionId, ratio, area, model, count, confirmedCount, references } = input ?? {};
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (typeof sessionId !== "string" || !sessionId || !prompt || prompt.length > 8000 ||
      Array.from(prompt).length > 4000 || !RATIOS.has(ratio) || !AREAS.has(area) || !MODELS.has(model) ||
      !Number.isInteger(count) || count < 1 || count > 4) throw fail();
  if ((count > 1 || confirmedCount !== undefined) && count !== confirmedCount) throw fail("CONFIRM_REQUESTS");

  const { images, labels } = readImages(references);
  const providerPrompt = resolveMentions(prompt, labels);
  const record = {
    sessionId, kind: "image", prompt, ratio, imageArea: area, imageModel: model, imageReferenceCount: images.length,
  };
  return {
    record, count, providerPrompt, images,
    fingerprint: JSON.stringify([record, count, providerPrompt, images.map(({ digest }) => digest)]),
  };
}

module.exports = { planImage };
