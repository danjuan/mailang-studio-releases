"use strict";

const MENTION = /@\[([^\][@\p{Cc}]{1,80})\]/gu;
const LABEL = /^[^\][@\p{Cc}]{1,80}$/u;

function isReferenceLabel(value) {
  return typeof value === "string" && value === value.trim() && LABEL.test(value);
}

function resolveMentions(text, labels) {
  function missing() {
    return Object.assign(new Error("REFERENCE_MISSING"), { code: "REFERENCE_MISSING" });
  }

  const resolved = text.replace(MENTION, (_token, label) => {
    if (!labels.has(label)) throw missing();
    return labels.get(label);
  });
  if (resolved.includes("@[")) throw missing();
  return resolved;
}

function stripMentionMarkup(text) {
  return text.replace(MENTION, (_token, label) => label);
}

module.exports = { isReferenceLabel, resolveMentions, stripMentionMarkup };
