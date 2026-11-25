"use strict";

const longVideoMinSeconds = 16;
const longVideoMaxSeconds = 180;

function splitLongVideoDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < longVideoMinSeconds || seconds > longVideoMaxSeconds) {
    return null;
  }

  const count = Math.ceil(seconds / 15);
  const base = Math.floor(seconds / count);
  const remainder = seconds % count;
  return Array.from({ length: count }, (_, index) => base + Number(index < remainder));
}

if (typeof module === "object" && module.exports) {
  module.exports = { longVideoMinSeconds, longVideoMaxSeconds, splitLongVideoDuration };
}
