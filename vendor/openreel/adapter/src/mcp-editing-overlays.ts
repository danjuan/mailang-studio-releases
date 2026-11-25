import { randomUUID } from "node:crypto";
import type { HeadlessHost } from "@openreel/agent/headless-host";
import { GraphicsEngine } from "@openreel/core/graphics/graphics-engine";
import { SHAPE_TYPES } from "@openreel/core/graphics/types";
import type { ShapeClip } from "@openreel/core/graphics/types";
import type { Transform } from "@openreel/core/types/timeline";
import { apply, boundedText, invalid, numeric, object, writableTrack } from "./mcp-editing-native";

type Arguments = Record<string, unknown>;

function only(input: Arguments, fields: string[], label: string) {
  if (Object.keys(input).some(key => !fields.includes(key))) invalid(`${label} has an unsupported field.`);
}

function vector(value: unknown, base: { x: number; y: number }, name: string, min: number, max: number) {
  const input = object(value, name);
  only(input, ["x", "y"], name);
  return {
    x: input.x === undefined ? base.x : numeric(input.x, `${name}.x`, min, max),
    y: input.y === undefined ? base.y : numeric(input.y, `${name}.y`, min, max),
  };
}

export function updateTransform(base: Transform, args: unknown): Transform {
  const input = object(args, "Transform");
  only(input, ["position", "scale", "anchor", "rotation", "opacity"], "Transform");
  return {
    ...base,
    position: input.position === undefined ? base.position : vector(input.position, base.position, "Position", -2, 2),
    scale: input.scale === undefined ? base.scale : vector(input.scale, base.scale, "Scale", 0.001, 100),
    anchor: input.anchor === undefined ? base.anchor : vector(input.anchor, base.anchor, "Anchor", 0, 1),
    rotation: input.rotation === undefined ? base.rotation : numeric(input.rotation, "Rotation", -3600, 3600),
    opacity: input.opacity === undefined ? base.opacity : numeric(input.opacity, "Opacity", 0, 1),
  };
}

function shapeAppearance(clip: ShapeClip, input: Arguments): ShapeClip["style"] {
  const requested = object(input.style ?? {}, "Shape style");
  only(requested, ["cornerRadius"], "Shape style");
  return {
    ...clip.style,
    fill: {
      ...clip.style.fill,
      ...(input.color === undefined ? {} : { type: "solid" as const, color: boundedText(input.color, "Color", 48) }),
      ...(input.opacity === undefined ? {} : { opacity: numeric(input.opacity, "Opacity", 0, 1) }),
    },
    ...(requested.cornerRadius === undefined ? {} : { cornerRadius: numeric(requested.cornerRadius, "Corner radius", 0, 100) }),
  };
}

function shapeTransform(host: HeadlessHost, base: Transform, args: Arguments): Transform {
  if (args.fullFrame !== undefined && typeof args.fullFrame !== "boolean") invalid("fullFrame must be a boolean.");
  const project = host.getProject();
  const transform = args.fullFrame ? {
    ...base,
    position: { x: 0.5, y: 0.5 },
    scale: { x: project.settings.width / 200, y: project.settings.height / 200 },
  } : base;
  return args.transform === undefined ? transform : updateTransform(transform, args.transform);
}

export async function createShape(host: HeadlessHost, args: Arguments) {
  const input = object(args.clip, "Shape clip");
  only(input, ["shapeType", "startTime", "duration", "trackId", "color", "opacity", "fullFrame", "style", "transform"], "Shape clip");
  const project = host.getProject();
  const shapeType = SHAPE_TYPES.find(type => type === (input.shapeType ?? "rectangle"));
  if (!shapeType || ["path", "polygon"].includes(shapeType)) invalid("Choose a built-in shape that needs no custom path.");
  const startTime = numeric(input.startTime ?? 0, "Start time", 0, project.timeline.duration);
  const duration = numeric(input.duration ?? Math.min(3, project.timeline.duration - startTime), "Duration", 0.001, project.timeline.duration - startTime);
  const trackId = input.trackId === undefined
    ? project.timeline.tracks.find(track => track.type === "graphics" && !track.locked)?.id ?? randomUUID()
    : writableTrack(project, input.trackId).id;
  if (!project.timeline.tracks.some(track => track.id === trackId)) {
    await apply(host, { type: "track/add", params: { trackId, trackType: "graphics", position: 0, name: "图形" } });
  }
  if (writableTrack(host.getProject(), trackId).role === "captions") invalid("Choose a track outside the captions lane.");
  const shape = new GraphicsEngine().createShape({ id: randomUUID(), shapeType, width: 200, height: 200 }, trackId, startTime, duration);
  const style = shapeAppearance(shape, { color: "#000000", opacity: 0.45, ...input });
  const transform = shapeTransform(host, shape.transform, input);
  await apply(host, { type: "shape/create", params: { clip: { ...shape, style, transform } } });
  return { id: shape.id, trackId };
}

export async function updateShape(host: HeadlessHost, args: Arguments) {
  const input = object(args.updates, "Shape update");
  only(input, ["color", "opacity", "style", "transform", "fullFrame"], "Shape update");
  const project = host.getProject();
  const clip = project.shapeClips?.find(item => item.id === args.clipId);
  if (!clip) invalid("Shape not found in the current draft.");
  writableTrack(project, clip.trackId);
  const style = shapeAppearance(clip, input);
  const transform = shapeTransform(host, clip.transform, input);
  await apply(host, { type: "shape/update", params: { clipId: clip.id, updates: { style, transform } } });
  return { id: clip.id, trackId: clip.trackId };
}

export async function updateClipTransform(host: HeadlessHost, args: Arguments) {
  const project = host.getProject();
  const clip = project.timeline.tracks.flatMap(track => track.clips).find(item => item.id === args.clipId);
  if (!clip) invalid("Clip not found in this draft.");
  writableTrack(project, clip.trackId);
  const transform = updateTransform(clip.transform, args.transform);
  await apply(host, { type: "transform/update", params: { clipId: clip.id, transform } });
  return { clipId: clip.id, transform };
}
