"use strict";

const { createHash } = require("node:crypto");

const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FRAME_BYTES / 3) * 4;
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_END = Buffer.from("0000000049454e44ae426082", "hex");

function invalidFrame() {
  return Object.assign(new Error("INVALID_INPUT"), { code: "INVALID_INPUT" });
}

function jpegDimensions(bytes) {
  if (bytes.length < 15 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_SOF.has(marker)) {
      if (length < 11 || length !== 8 + 3 * bytes[offset + 7]) return null;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}

function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER) ||
      !bytes.subarray(-PNG_END.length).equals(PNG_END)) return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function webpDimensions(bytes) {
  if (bytes.length < 25 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) return null;
  const chunkBytes = bytes.readUInt32LE(16);
  if (20 + chunkBytes + (chunkBytes % 2) > bytes.length) return null;
  switch (bytes.toString("ascii", 12, 16)) {
    case "VP8X":
      if (chunkBytes !== 10) return null;
      return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    case "VP8L": {
      if (chunkBytes < 5 || bytes[20] !== 0x2f || (bytes[24] >>> 5) !== 0) return null;
      const dimensions = bytes.readUInt32LE(21);
      return [(dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1];
    }
    case "VP8 ":
      if (chunkBytes < 10 || (bytes[20] & 1) !== 0 || bytes.readUIntBE(23, 3) !== 0x9d012a) return null;
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    default:
      return null;
  }
}

const dimensionsFor = { jpeg: jpegDimensions, png: pngDimensions, webp: webpDimensions };

/** Verify MIME, bounded base64, and declared dimensions before reservation or egress. */
function readFrame(value) {
  if (typeof value !== "string" || value.length > MAX_BASE64_CHARS + 32) throw invalidFrame();
  const prefix = /^data:image\/(jpeg|png|webp);base64,/.exec(value);
  if (!prefix) throw invalidFrame();
  const base64 = value.slice(prefix[0].length);
  if (base64.length > MAX_BASE64_CHARS || base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw invalidFrame();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FRAME_BYTES || bytes.toString("base64") !== base64) throw invalidFrame();
  const [width, height] = dimensionsFor[prefix[1]](bytes) ?? [0, 0];
  if (width < 256 || width > 5760 || height < 256 || height > 5760 ||
      width / height < 0.4 || width / height > 2.5) throw invalidFrame();
  return { url: value, digest: createHash("sha256").update(bytes).digest("hex") };
}

function readReferenceFrames(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((slot) => slot !== "first" && slot !== "last")) throw invalidFrame();
  const first = Object.hasOwn(value, "first") ? readFrame(value.first) : undefined;
  const last = Object.hasOwn(value, "last") ? readFrame(value.last) : undefined;
  if (!first && !last) throw invalidFrame();
  return { first, last, mode: first && last ? "both" : first ? "first" : "last" };
}

module.exports = { readFrame, readReferenceFrames };
