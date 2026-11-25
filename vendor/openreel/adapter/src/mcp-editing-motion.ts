import { EASING_TYPES } from "@openreel/core/types/timeline";
import type { Project } from "@openreel/core/types/project";
import { boundedText, invalid, numeric, object } from "./mcp-editing-native";

type Arguments = Record<string, unknown>;

function checkTransform(args: Arguments) {
  const position = ["x", "y", "z", "anchorX", "anchorY"];
  const rotations = ["rotation", "rotationX", "rotationY", "rotationZ"];
  const scales = ["scale", "scaleX", "scaleY"];
  for (const field of position) if (args[field] !== undefined) numeric(args[field], field, -32768, 32768);
  for (const field of rotations) if (args[field] !== undefined) numeric(args[field], field, -3600, 3600);
  for (const field of scales) if (args[field] !== undefined) numeric(args[field], field, 0.001, 100);
  if (args.perspective !== undefined) numeric(args.perspective, "Perspective", 1, 32768);
}

function checkHandle(value: unknown) {
  const handle = object(value, "Keyframe handle");
  if (Object.keys(handle).some(key => key !== "x" && key !== "y")) invalid("Use x and y for keyframe handles.");
  numeric(handle.x, "Handle x", 0, 1);
  numeric(handle.y, "Handle y", -4, 4);
}

function checkShapeStyle(args: Arguments) {
  if (args.shadows !== undefined || args.shadow !== undefined || args.cornerRadii !== undefined) {
    invalid("Use basic fill, stroke and a uniform corner radius in this editor tool.");
  }
  if (args.cornerRadius !== undefined) numeric(args.cornerRadius, "Corner radius", 0, 4096);
  if (args.points !== undefined && !Number.isSafeInteger(numeric(args.points, "Shape points", 3, 100))) {
    invalid("Shape points must be an integer.");
  }
  if (args.innerRadius !== undefined) numeric(args.innerRadius, "Inner radius", 0, 1);
  for (const field of ["fill", "stroke"]) {
    if (args[field] === undefined) continue;
    const style = object(args[field], "Shape style");
    const permitted = field === "fill" ? ["type", "color", "opacity"] : ["color", "width", "opacity"];
    if (Object.keys(style).some(key => !permitted.includes(key))) invalid("Use a solid fill and basic stroke.");
    if (style.type !== undefined && style.type !== "solid" && style.type !== "none") invalid("Choose a solid fill or no fill.");
    if (style.color !== undefined) boundedText(style.color, "Color", 48);
    if (style.opacity !== undefined) numeric(style.opacity, "Opacity", 0, 1);
    if (style.width !== undefined) numeric(style.width, "Stroke width", 0, 512);
  }
}

export function checkMotionEdit(project: Project, name: string, args: Arguments) {
  if (name === "add_motion_layer") {
    if (args.layer !== undefined || args.assetId !== undefined || args.mediaId !== undefined ||
      args.refCompositionId !== undefined || args.emitter !== undefined) invalid("Use typed built-in layers for this capability.");
    const type = args.layerType ?? args.type ?? "text";
    if (!["text", "shape", "group", "null"].includes(String(type))) invalid("Choose a built-in motion layer.");
  }
  if (args.backgroundColor !== undefined) boundedText(args.backgroundColor, "Background color", 48);
  if (args.compositionId === undefined) {
    if (name === "create_motion_composition" && args.duration !== undefined) numeric(args.duration, "Duration", 0.001, 3600);
    return;
  }
  const composition = project.motionCompositions?.find(item => item.id === args.compositionId);
  if (!composition) invalid("Motion composition not found in this draft.");
  const layer = args.layerId === undefined ? undefined : composition.layers.find(item => item.id === args.layerId);
  if (args.layerId !== undefined && !layer) invalid("Motion layer not found in this draft.");
  if (layer?.locked) invalid("The target motion layer is locked.");
  if (name === "update_motion_composition" && args.duration !== undefined) {
    const existingLayerEnd = Math.max(0, ...composition.layers.map(item => item.startTime + item.duration));
    const existingInstances = (project.motionInstances ?? []).filter(item => item.compositionId === composition.id);
    const longestInstance = Math.max(0, ...existingInstances.map(item => item.duration));
    numeric(args.duration, "Composition duration", Math.max(existingLayerEnd, longestInstance, 0.001), 3600);
  } else if (args.duration !== undefined) numeric(args.duration, "Duration", 0.001, composition.duration);
  if (name === "set_motion_layer_transform") checkTransform(args);
  if (name === "set_motion_shape_style") checkShapeStyle(args);
  if (name === "set_motion_layer_timing" && layer) {
    const start = numeric(args.startTime ?? layer.startTime, "Start time", 0, composition.duration);
    numeric(args.duration ?? layer.duration, "Layer duration", 1 / composition.frameRate, composition.duration - start);
  }
  if (name === "add_motion_keyframe") {
    numeric(args.time, "Keyframe time", 0, composition.duration);
    if (args.value !== undefined) numeric(args.value, "Keyframe value", -32768, 32768);
    if (args.easing !== undefined && !EASING_TYPES.some(easing => easing === args.easing)) invalid("Choose a supported easing.");
    if (args.bezierIn !== undefined || args.bezierOut !== undefined) {
      checkHandle(args.bezierIn);
      checkHandle(args.bezierOut);
    }
  }
}
