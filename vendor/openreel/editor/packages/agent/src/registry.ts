// Tool implementations used by the private OpenReel short-drama editor.
import type { Action } from "@openreel/core/types/actions";
import { DEFAULT_SHAPE_STYLE, SHAPE_TYPES, type ShapeType, type GradientStyle, type GradientStop, type ShadowStyle, type CornerRadii, type ShapeStyle } from "@openreel/core/graphics/types";
import { motionEngine } from "@openreel/core/motion/motion-engine";
import { isMotionAnimatableProperty, upsertMotionLayerKeyframe, getMotionLayerPropertyKeyframes, getMotionLayerPropertyValueAtTime, getMotionLayerMaskPropertyDescriptors, getMotionLayerEffectPropertyDescriptors, getMotionLayerShapeModifierPropertyDescriptors, getMotionLayerContentsPropertyDescriptors, getMotionLayerPuppetPropertyDescriptors, getMotionLayerShaderFillPropertyDescriptors, setMotionKeyframeRoving, MOTION_ANIMATABLE_PROPERTIES, type MotionAnimatableProperty } from "@openreel/core/motion/motion-keyframes";
import { createMotionAdjustmentLayer } from "@openreel/core/motion/motion-adjustment-layers";
import { createMotionNullLayer } from "@openreel/core/motion/motion-null-layers";
import { createMotionParticleLayer } from "@openreel/core/motion/motion-particles";
import { getMotionShaderFillDefs, getMotionShaderEffectDefs, getMotionShaderTextDefs, getMotionShaderDef } from "@openreel/core/motion/shaders/index";
import type { MotionShaderDef, MotionShaderParamDef } from "@openreel/core/motion/shaders/index";
import { buildMotionPathData, parseMotionPathSegments, type MotionShapePathPoint } from "@openreel/core/motion/motion-shape-path";
import { createMotionImageLayerFromAsset } from "@openreel/core/motion/motion-assets";
import { buildMotionShapeStyle, reflowMotionAutoLayoutGroups, type MotionUiShapeStyleSpec } from "@openreel/core/motion/motion-ui-builder";
import { setMotionLayersVisible } from "@openreel/core/motion/motion-layer-commands";
import { updateMotionCompositionLayerTiming, moveMotionLayerInTime, trimMotionLayerOutPoint } from "@openreel/core/motion/motion-layer-timing";
import { DEFAULT_MOTION_TRANSFORM, type MotionComposition, type MotionLayer, type MotionShapeLayer, type MotionTextLayer, type MotionImageLayer, type MotionAsset, type MotionParticleEmitter } from "@openreel/core/motion/types";
import type { MediaItem } from "@openreel/core/types/project";
import { EASING_TYPES, type EasingType } from "@openreel/core/types/timeline";
import type { EditingHost } from "./host";
import type { JSONSchema, ToolDef, ToolDomain, ToolResult } from "./types";
import { serializeEditorState, listMedia, listTracks, listClips, getClipDetail, type ClipFilter } from "./serialize";

export type ToolHandler = (
  args: Record<string, unknown>,
  host: EditingHost,
) => Promise<ToolResult> | ToolResult;

export interface RegisteredTool extends ToolDef {
  readonly handler: ToolHandler;
}

const genId = (): string =>
  (
    globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  ).crypto?.randomUUID?.() ??
  `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const str: JSONSchema = { type: "string" };

const num: JSONSchema = { type: "number" };

const bool: JSONSchema = { type: "boolean" };

const obj = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: true });

function vec2FromObject(
  value: unknown,
): { readonly x: number; readonly y: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = optionalNumber(record.x);
  const y = optionalNumber(record.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

function ok(summary: string, data?: unknown): ToolResult {
  return { ok: true, summary, data };
}

function fail(message: string, code = "ERROR"): ToolResult {
  return { ok: false, summary: message, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseShapePathPoints(
  value: unknown,
): readonly MotionShapePathPoint[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const points: MotionShapePathPoint[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const candidate = entry as {
      x?: unknown;
      y?: unknown;
      inX?: unknown;
      inY?: unknown;
      outX?: unknown;
      outY?: unknown;
    };
    if (
      typeof candidate.x !== "number" ||
      typeof candidate.y !== "number" ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y)
    ) {
      return undefined;
    }
    for (const handle of [candidate.inX, candidate.inY, candidate.outX, candidate.outY]) {
      if (handle !== undefined && handle !== null) {
        if (typeof handle !== "number" || !Number.isFinite(handle)) return undefined;
      }
    }
    points.push({
      x: candidate.x,
      y: candidate.y,
      ...(typeof candidate.inX === "number" && Number.isFinite(candidate.inX)
        ? { inX: candidate.inX }
        : {}),
      ...(typeof candidate.inY === "number" && Number.isFinite(candidate.inY)
        ? { inY: candidate.inY }
        : {}),
      ...(typeof candidate.outX === "number" && Number.isFinite(candidate.outX)
        ? { outX: candidate.outX }
        : {}),
      ...(typeof candidate.outY === "number" && Number.isFinite(candidate.outY)
        ? { outY: candidate.outY }
        : {}),
    });
  }
  return points;
}

function resolveShapePathData(
  args: Record<string, unknown>,
): { readonly pathData: string } | { readonly error: string } {
  const pathData = optionalString(args.pathData);
  if (pathData) {
    const parsed = parseMotionPathSegments(pathData);
    if (parsed.length < 2) {
      return { error: "pathData must describe at least 2 points" };
    }
    return { pathData };
  }
  if (args.pathPoints !== undefined) {
    const supplied = parseShapePathPoints(args.pathPoints);
    if (!supplied) {
      return {
        error:
          "pathPoints must be an array of >=2 finite {x,y,inX?,inY?,outX?,outY?} vertices",
      };
    }
    return { pathData: buildMotionPathData(supplied) };
  }
  return { error: "provide pathData or pathPoints for a path shape" };
}

function parseGradientStops(value: unknown): GradientStop[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const stops: GradientStop[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const offset = optionalNumber(record?.offset);
    const color = optionalString(record?.color);
    if (offset === undefined || !color) return undefined;
    const opacity = optionalNumber(record?.opacity);
    stops.push({
      offset: clampNumber(offset, 0, 1),
      color,
      ...(opacity !== undefined ? { opacity: clampNumber(opacity, 0, 1) } : {}),
    });
  }
  return stops;
}

function parseGradientStyle(value: unknown): GradientStyle | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const type = optionalString(record.type);
  if (type !== "linear" && type !== "radial" && type !== "conic") return undefined;
  const stops = parseGradientStops(record.stops);
  if (!stops) return undefined;
  const angle = optionalNumber(record.angle);
  const center = asRecord(record.center);
  const centerX = optionalNumber(center?.x);
  const centerY = optionalNumber(center?.y);
  return {
    type,
    ...(angle !== undefined ? { angle } : {}),
    ...(centerX !== undefined && centerY !== undefined
      ? { center: { x: centerX, y: centerY } }
      : {}),
    stops,
  };
}

function parseShadowStyle(value: unknown): ShadowStyle | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const color = optionalString(record.color);
  if (!color) return undefined;
  const blur = optionalNumber(record.blur) ?? 0;
  const offsetX = optionalNumber(record.offsetX) ?? 0;
  const offsetY = optionalNumber(record.offsetY) ?? 0;
  const spread = optionalNumber(record.spread);
  const inset = typeof record.inset === "boolean" ? record.inset : undefined;
  return {
    color,
    blur,
    offsetX,
    offsetY,
    ...(spread !== undefined ? { spread } : {}),
    ...(inset !== undefined ? { inset } : {}),
  };
}

function parseShadowStyles(value: unknown): ShadowStyle[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const shadows: ShadowStyle[] = [];
  for (const entry of value) {
    const shadow = parseShadowStyle(entry);
    if (!shadow) return undefined;
    shadows.push(shadow);
  }
  return shadows;
}

function parseCornerRadii(value: unknown): CornerRadii | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const topLeft = optionalNumber(record.topLeft);
  const topRight = optionalNumber(record.topRight);
  const bottomRight = optionalNumber(record.bottomRight);
  const bottomLeft = optionalNumber(record.bottomLeft);
  if (
    topLeft === undefined ||
    topRight === undefined ||
    bottomRight === undefined ||
    bottomLeft === undefined
  ) {
    return undefined;
  }
  return {
    topLeft: Math.max(0, topLeft),
    topRight: Math.max(0, topRight),
    bottomRight: Math.max(0, bottomRight),
    bottomLeft: Math.max(0, bottomLeft),
  };
}

function applyExtendedShapeStyle(
  base: ShapeStyle,
  args: Record<string, unknown>,
): ShapeStyle | string {
  let style: ShapeStyle = base;

  const fillRecord = asRecord(args.fill);
  const fillGradientRaw = fillRecord?.gradient;
  if (fillGradientRaw !== undefined) {
    const gradient = parseGradientStyle(fillGradientRaw);
    if (!gradient) return "fill.gradient is invalid";
    style = {
      ...style,
      fill: { ...style.fill, type: "gradient", gradient },
    };
  }

  const strokeRecord = asRecord(args.stroke);
  const strokeGradientRaw = strokeRecord?.gradient;
  if (strokeGradientRaw !== undefined) {
    const gradient = parseGradientStyle(strokeGradientRaw);
    if (!gradient) return "stroke.gradient is invalid";
    style = { ...style, stroke: { ...style.stroke, gradient } };
  }

  if (args.shadow !== undefined) {
    const shadow = parseShadowStyle(args.shadow);
    if (!shadow) return "shadow is invalid";
    style = { ...style, shadow };
  }

  if (args.shadows !== undefined) {
    const shadows = parseShadowStyles(args.shadows);
    if (!shadows) return "shadows must be a non-empty array of valid shadows";
    style = { ...style, shadows };
  }

  if (args.cornerRadii !== undefined) {
    const cornerRadii = parseCornerRadii(args.cornerRadii);
    if (!cornerRadii) {
      return "cornerRadii requires topLeft, topRight, bottomRight, bottomLeft";
    }
    style = { ...style, cornerRadii };
  }

  return style;
}

function getMotionComposition(
  host: EditingHost,
  compositionId: unknown,
): MotionComposition | undefined {
  if (typeof compositionId !== "string") return undefined;
  return (host.getProject().motionCompositions ?? []).find(
    (composition) => composition.id === compositionId,
  );
}

const VALID_EASINGS: ReadonlySet<string> = new Set(EASING_TYPES);

function isValidEasing(value: unknown): value is EasingType {
  return typeof value === "string" && VALID_EASINGS.has(value);
}

function getMotionLayer(
  composition: MotionComposition,
  layerId: unknown,
): MotionLayer | undefined {
  if (typeof layerId !== "string") return undefined;
  return composition.layers.find((layer) => layer.id === layerId);
}

function replaceMotionLayer(
  composition: MotionComposition,
  layerId: string,
  next: MotionLayer,
): MotionComposition {
  return {
    ...composition,
    layers: composition.layers.map((layer) =>
      layer.id === layerId ? next : layer,
    ),
    modifiedAt: Date.now(),
  };
}

function motionTimingOptions(composition: MotionComposition): {
  readonly compositionDuration: number;
  readonly frameRate: number;
} {
  return {
    compositionDuration: composition.duration,
    frameRate: composition.frameRate,
  };
}

async function commitMotionComposition(
  host: EditingHost,
  composition: MotionComposition,
): Promise<ToolResult> {
  const reflowed = reflowMotionAutoLayoutGroups(composition);
  return applyMotionAction(host, "motion/upsertComposition", {
    composition: { ...reflowed, modifiedAt: Date.now() },
  });
}

const MOTION_SHAPE_TYPES: ReadonlySet<ShapeType> = new Set(SHAPE_TYPES);

function serializeMotionLayerDetail(layer: MotionLayer): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    name: layer.name,
    startTime: layer.startTime,
    duration: layer.duration,
    visible: layer.visible,
    locked: layer.locked,
    transform: layer.transform,
    keyframes: layer.keyframes.map((keyframe) => ({
      id: keyframe.id,
      property: keyframe.property,
      time: keyframe.time,
      value: keyframe.value,
      easing: keyframe.easing,
    })),
    parentId: layer.parentId,
    blendMode: layer.blendMode,
    expressions: layer.expressions,
    effects: layer.effects,
    masks: layer.masks,
    trackMatte: layer.trackMatte,
    variableBindings: layer.variableBindings,
  };
  switch (layer.type) {
    case "text":
      detail.text = layer.text;
      detail.style = layer.style;
      detail.textAnimators = layer.textAnimators;
      break;
    case "shape":
      detail.shapeType = layer.shapeType;
      detail.width = layer.width;
      detail.height = layer.height;
      detail.style = layer.style;
      detail.modifiers = layer.modifiers;
      detail.puppetPins = layer.puppetPins;
      break;
    case "image":
      detail.assetId = layer.assetId;
      detail.fit = layer.fit;
      break;
    case "composition":
      detail.refCompositionId = layer.compositionId;
      detail.timeOffset = layer.timeOffset;
      detail.playbackRate = layer.playbackRate;
      break;
    case "group":
      detail.children = layer.children;
      break;
    case "particle":
      detail.emitter = layer.emitter;
      break;
    default:
      break;
  }
  return detail;
}

function serializeMotionComposition(
  composition: MotionComposition,
): Record<string, unknown> {
  return {
    id: composition.id,
    name: composition.name,
    width: composition.width,
    height: composition.height,
    frameRate: composition.frameRate,
    duration: composition.duration,
    backgroundColor: composition.backgroundColor,
    layers: composition.layers.map(serializeMotionLayerDetail),
    variables: composition.variables.map((variable) => ({
      id: variable.id,
      name: variable.name,
      type: variable.type,
      value: variable.value,
    })),
    assets: composition.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      name: asset.name,
      mediaId: asset.mediaId,
    })),
    markers: composition.markers,
    beatMarkers: composition.beatMarkers ?? [],
    camera: composition.camera,
    lights: composition.lights ?? [],
  };
}

async function applyMotionAction(
  host: EditingHost,
  type: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const action: Action = {
    type,
    id: genId(),
    timestamp: Date.now(),
    params,
  };
  const result = await host.applyAction(action);
  return result.success
    ? ok(`${type} applied`, { actionId: action.id })
    : fail(result.error?.message ?? `${type} failed`, result.error?.code);
}

interface ActionToolSpec {
  name: string;
  domain: ToolDomain;
  actionType: string;
  title: string;
  description: string;
  inputSchema: JSONSchema;
  destructive?: boolean;
  expensive?: boolean;
  /** Transform tool args → action params (default: identity). */
  mapParams?: (args: Record<string, unknown>) => Record<string, unknown>;
}

function actionTool(spec: ActionToolSpec): RegisteredTool {
  return {
    name: spec.name,
    domain: spec.domain,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    readOnly: false,
    destructive: spec.destructive ?? false,
    expensive: spec.expensive ?? false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const params = spec.mapParams ? spec.mapParams(args) : args;
      const action: Action = {
        type: spec.actionType,
        id: genId(),
        timestamp: Date.now(),
        params,
      };
      const result = await host.applyAction(action);
      if (result.success) return ok(`${spec.name} applied`, { actionId: action.id });
      return fail(
        result.error?.message ?? `${spec.name} failed`,
        result.error?.code ?? "ACTION_FAILED",
      );
    },
  };
}

function readTool(
  name: string,
  title: string,
  description: string,
  inputSchema: JSONSchema,
  run: (args: Record<string, unknown>, host: EditingHost) => unknown,
): RegisteredTool {
  return {
    name,
    domain: "read",
    title,
    description,
    inputSchema,
    readOnly: true,
    destructive: false,
    expensive: false,
    handler: (args, host) => {
      const data = run(args, host);
      return ok(`${name} ok`, data);
    },
  };
}

const TOOLS: RegisteredTool[] = [
  readTool("get_editor_state", "Editor state", "Project settings, durations, and counts.", obj({}), (_a, h) =>
    serializeEditorState(h.getProject()),
  ),
  readTool("list_media", "List media", "Media library items (blob-free).", obj({}), (_a, h) =>
    listMedia(h.getProject()),
  ),
  readTool("list_tracks", "List tracks", "All timeline tracks.", obj({}), (_a, h) =>
    listTracks(h.getProject()),
  ),
  readTool(
    "list_clips",
    "List clips",
    "Compact clip list. Optional filters: trackIndex, fromSec, toSec; paginate huge timelines with offset/limit.",
    obj({ trackIndex: num, fromSec: num, toSec: num, offset: num, limit: num }),
    (a, h) => listClips(h.getProject(), a as ClipFilter),
  ),
  readTool("get_clip", "Get clip", "Full detail for one clip by id.", obj({ clipId: str }, ["clipId"]), (a, h) =>
    getClipDetail(h.getProject(), a.clipId as string),
  ),
  readTool("get_capabilities", "Capabilities", "Valid enums + parameter ranges.", obj({}), (_a, h) =>
    h.capabilities(),
  ),
  readTool(
    "list_motion_compositions",
    "List motion compositions",
    "Compact list of Motion Creator scenes, layers, variables, and editor instances.",
    obj({}),
    (_a, h) => {
      const project = h.getProject();
      return {
        compositions: (project.motionCompositions ?? []).map((composition) => ({
          id: composition.id,
          name: composition.name,
          width: composition.width,
          height: composition.height,
          duration: composition.duration,
          frameRate: composition.frameRate,
          layerCount: composition.layers.length,
          variableCount: composition.variables.length,
          markers: composition.markers.length,
          beatMarkers: composition.beatMarkers?.length ?? 0,
        })),
        instances: (project.motionInstances ?? []).map((instance) => ({
          id: instance.id,
          compositionId: instance.compositionId,
          name: instance.name,
          startTime: instance.startTime,
          duration: instance.duration,
          trackId: instance.trackId,
        })),
      };
    },
  ),
  {
    name: "create_project",
    domain: "project",
    title: "Create project",
    description: "Create a new blank project and make it active. Call this first when starting from scratch. Defaults to 1920x1080 at 30fps.",
    inputSchema: obj({ name: str, width: num, height: num, frameRate: num }),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      if (typeof host.createProject !== "function") {
        return fail("create_project is not available in this host", "UNSUPPORTED");
      }
      const ref = await host.createProject({
        name: typeof args.name === "string" ? args.name : undefined,
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        frameRate: typeof args.frameRate === "number" ? args.frameRate : undefined,
      });
      return ok(`Created project "${ref.name}" (${ref.width}x${ref.height} @ ${ref.frameRate}fps)`, ref);
    },
  },
  {
    name: "list_projects",
    domain: "project",
    title: "List projects",
    description: "List saved projects (id + name + modifiedAt). Use an id with open_project.",
    inputSchema: obj({}),
    readOnly: true,
    destructive: false,
    expensive: false,
    handler: async (_args, host) => {
      if (typeof host.listProjects !== "function") {
        return fail("list_projects is not available in this host", "UNSUPPORTED");
      }
      const projects = await host.listProjects();
      return ok(`${projects.length} saved project(s)`, { projects });
    },
  },
  actionTool({ name: "update_project_settings", domain: "project", actionType: "project/updateSettings", title: "Update settings", description: "Update resolution/fps/etc.", inputSchema: obj({ width: num, height: num, frameRate: num }) }),
  actionTool({ name: "rename_project", domain: "project", actionType: "project/rename", title: "Rename project", description: "Rename the project.", inputSchema: obj({ name: str }, ["name"]) }),
  actionTool({ name: "set_canvas_background", domain: "project", actionType: "project/setCanvasBackground", title: "Canvas background", description: "Set background fill mode/color.", inputSchema: obj({ backgroundFillMode: str, layoutBackgroundColor: str }) }),
  actionTool({ name: "add_track", domain: "track", actionType: "track/add", title: "Add track", description: "Add a track (video|audio|image|text|graphics).", inputSchema: obj({ trackType: str, position: num }, ["trackType"]) }),
  actionTool({ name: "duplicate_track", domain: "track", actionType: "track/duplicate", title: "Duplicate track", description: "Duplicate a timeline-backed video, image, or audio track with fresh track, clip, and transition identities. Inserts the copy after the source unless position is supplied.", inputSchema: obj({ sourceTrackId: str, position: num }, ["sourceTrackId"]) }),
  actionTool({ name: "rename_track", domain: "track", actionType: "track/rename", title: "Rename track", description: "Rename a track.", inputSchema: obj({ trackId: str, name: str }, ["trackId", "name"]) }),
  actionTool({ name: "reorder_track", domain: "track", actionType: "track/reorder", title: "Reorder track", description: "Move a track to a new stacking position (0 = top of the timeline / front-most).", inputSchema: obj({ trackId: str, newPosition: num }, ["trackId", "newPosition"]) }),
  actionTool({ name: "lock_track", domain: "track", actionType: "track/lock", title: "Lock track", description: "Lock/unlock a track.", inputSchema: obj({ trackId: str, locked: bool }, ["trackId", "locked"]) }),
  actionTool({ name: "hide_track", domain: "track", actionType: "track/hide", title: "Hide track", description: "Show/hide a track.", inputSchema: obj({ trackId: str, hidden: bool }, ["trackId", "hidden"]) }),
  actionTool({ name: "mute_track", domain: "track", actionType: "track/mute", title: "Mute track", description: "Mute/unmute a track.", inputSchema: obj({ trackId: str, muted: bool }, ["trackId", "muted"]) }),
  actionTool({ name: "solo_track", domain: "track", actionType: "track/solo", title: "Solo track", description: "Solo/unsolo a track.", inputSchema: obj({ trackId: str, solo: bool }, ["trackId", "solo"]) }),
  actionTool({ name: "consolidate_track", domain: "track", actionType: "track/consolidate", title: "Consolidate", description: "Close gaps on a track.", inputSchema: obj({ trackId: str }, ["trackId"]) }),
  actionTool({ name: "rename_media", domain: "media", actionType: "media/rename", title: "Rename media", description: "Rename a media item.", inputSchema: obj({ mediaId: str, name: str }, ["mediaId", "name"]) }),
  actionTool({ name: "add_clip", domain: "clip", actionType: "clip/add", title: "Add clip", description: "Add a media clip to a track at a time.", inputSchema: obj({ trackId: str, mediaId: str, startTime: num }, ["trackId", "mediaId", "startTime"]) }),
  actionTool({ name: "move_clip", domain: "clip", actionType: "clip/move", title: "Move clip", description: "Move a clip to a new start time / track.", inputSchema: obj({ clipId: str, startTime: num, trackId: str }, ["clipId", "startTime"]) }),
  actionTool({ name: "trim_clip", domain: "clip", actionType: "clip/trim", title: "Trim clip", description: "Set a clip's in/out points (seconds).", inputSchema: obj({ clipId: str, inPoint: num, outPoint: num }, ["clipId"]) }),
  actionTool({ name: "split_clip", domain: "clip", actionType: "clip/split", title: "Split clip", description: "Split a clip at a time.", inputSchema: obj({ clipId: str, time: num }, ["clipId", "time"]) }),
  actionTool({ name: "slip_clip", domain: "clip", actionType: "clip/slip", title: "Slip clip", description: "Slip a clip's source by delta.", inputSchema: obj({ clipId: str, delta: num }, ["clipId", "delta"]) }),
  actionTool({ name: "slide_clip", domain: "clip", actionType: "clip/slide", title: "Slide clip", description: "Slide a clip by delta.", inputSchema: obj({ clipId: str, delta: num, prevClipId: str, nextClipId: str }, ["clipId", "delta"]) }),
  actionTool({ name: "roll_edit", domain: "clip", actionType: "clip/roll", title: "Roll edit", description: "Roll the edit point between two clips.", inputSchema: obj({ leftClipId: str, rightClipId: str, delta: num }, ["leftClipId", "rightClipId", "delta"]) }),
  actionTool({ name: "trim_to_playhead", domain: "clip", actionType: "clip/trimToPlayhead", title: "Trim to playhead", description: "Trim a clip's start/end to a time.", inputSchema: obj({ clipId: str, playheadTime: num, trimStart: bool }, ["clipId", "playheadTime", "trimStart"]) }),
  actionTool({ name: "close_gap", domain: "clip", actionType: "clip/closeGapBefore", title: "Close gap", description: "Close the gap before a clip.", inputSchema: obj({ clipId: str }, ["clipId"]) }),
  actionTool({ name: "set_clip_speed", domain: "speed", actionType: "clip/setSpeed", title: "Set speed", description: "Set clip playback speed (recomputes duration).", inputSchema: obj({ clipId: str, speed: num }, ["clipId", "speed"]) }),
  actionTool({ name: "set_clip_reverse", domain: "speed", actionType: "clip/setReverse", title: "Reverse clip", description: "Toggle clip reverse.", inputSchema: obj({ clipId: str, reversed: bool }, ["clipId", "reversed"]) }),
  actionTool({ name: "set_clip_pitch_correction", domain: "speed", actionType: "clip/setPitchCorrection", title: "Pitch correction", description: "Toggle pitch correction on speed changes.", inputSchema: obj({ clipId: str, pitchCorrection: bool }, ["clipId", "pitchCorrection"]) }),
  actionTool({ name: "set_clip_transform", domain: "transform", actionType: "transform/update", title: "Transform clip", description: "Set position/scale/rotation/opacity/crop/fitMode.", inputSchema: obj({ clipId: str, transform: { type: "object" } }, ["clipId", "transform"]) }),
  actionTool({ name: "set_clip_blend_mode", domain: "transform", actionType: "clip/setBlendMode", title: "Blend mode", description: "Set a clip's blend mode.", inputSchema: obj({ clipId: str, blendMode: str }, ["clipId", "blendMode"]) }),
  actionTool({ name: "set_clip_blend_opacity", domain: "transform", actionType: "clip/setBlendOpacity", title: "Blend opacity", description: "Set a clip's blend opacity (0..1).", inputSchema: obj({ clipId: str, opacity: num }, ["clipId", "opacity"]) }),
  {
    name: "add_video_effect",
    domain: "effect",
    title: "Add effect",
    description:
      "Add a video effect to a clip. Standard effectType values include brightness, contrast, saturation, blur, sharpen, vignette, grain, temperature, tint, shadow, glow, motion-blur, radial-blur, chromatic-aberration. Set effectType to 'shader' to run a GPU shader effect from the Motion shader library (only category 'effect' shaders, e.g. the Paper Design catalog like paper-halftone-dots or paper-liquid-metal — use list_motion_shaders with category 'effect' to discover ids); for shader effects, params MUST include a valid shaderId plus optional numeric params (name/value pairs from the shader's params) and an optional numeric time. Shader effects no-op gracefully when WebGL2 is unavailable.",
    inputSchema: obj(
      { clipId: str, effectType: str, params: { type: "object" } },
      ["clipId", "effectType"],
    ),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const effectType = optionalString(args.effectType);
      if (!effectType) return fail("effectType is required", "INVALID_PARAMS");
      const params =
        typeof args.params === "object" && args.params !== null
          ? (args.params as Record<string, unknown>)
          : {};
      if (effectType === "shader") {
        const shaderId = optionalString(params.shaderId);
        if (!shaderId) {
          return fail(
            "shader effect requires params.shaderId",
            "INVALID_PARAMS",
          );
        }
        const def = getMotionShaderDef(shaderId);
        if (!def || def.category !== "effect") {
          return fail(
            `Unknown effect shader: ${shaderId}`,
            "INVALID_PARAMS",
          );
        }
      }
      const action: Action = {
        type: "effect/add",
        id: genId(),
        timestamp: Date.now(),
        params: args,
      };
      const result = await host.applyAction(action);
      if (result.success) return ok("add_video_effect applied", { actionId: action.id });
      return fail(
        result.error?.message ?? "add_video_effect failed",
        result.error?.code ?? "ACTION_FAILED",
      );
    },
  },
  actionTool({ name: "update_video_effect", domain: "effect", actionType: "effect/update", title: "Update effect", description: "Update a video effect's params.", inputSchema: obj({ clipId: str, effectId: str, params: { type: "object" } }, ["clipId", "effectId", "params"]) }),
  actionTool({ name: "toggle_video_effect", domain: "effect", actionType: "effect/toggle", title: "Toggle effect", description: "Enable/disable a video effect.", inputSchema: obj({ clipId: str, effectId: str, enabled: bool }, ["clipId", "effectId", "enabled"]) }),
  actionTool({ name: "set_effect_order", domain: "effect", actionType: "effect/setOrder", title: "Reorder effects", description: "Set the full effect order for a clip.", inputSchema: obj({ clipId: str, effectIds: { type: "array" } }, ["clipId", "effectIds"]) }),
  actionTool({ name: "set_color_grading", domain: "color", actionType: "clip/setColorGrading", title: "Color grading", description: "Set a clip's color grading (wheels/curves/lut/hsl/temp/tint).", inputSchema: obj({ clipId: str, colorGrading: { type: "object" } }, ["clipId"]) }),
  actionTool({ name: "set_clip_volume", domain: "audio", actionType: "audio/setVolume", title: "Set volume", description: "Set a clip's volume (0..1+).", inputSchema: obj({ clipId: str, volume: num }, ["clipId", "volume"]) }),
  actionTool({ name: "set_clip_fade", domain: "audio", actionType: "audio/setFade", title: "Set fade", description: "Set audio fade in/out seconds.", inputSchema: obj({ clipId: str, fadeIn: num, fadeOut: num }, ["clipId"]) }),
  actionTool({ name: "add_audio_automation", domain: "audio", actionType: "audio/addAutomation", title: "Audio automation", description: "Add audio automation points.", inputSchema: obj({ clipId: str, points: { type: "array" } }, ["clipId", "points"]) }),
  actionTool({ name: "add_audio_effect", domain: "audio", actionType: "audio/addEffect", title: "Add audio effect", description: "Add an audio effect to a clip.", inputSchema: obj({ clipId: str, effect: { type: "object" } }, ["clipId", "effect"]) }),
  actionTool({ name: "update_audio_effect", domain: "audio", actionType: "audio/updateEffect", title: "Update audio effect", description: "Update an audio effect's params.", inputSchema: obj({ clipId: str, effectId: str, params: { type: "object" } }, ["clipId", "effectId", "params"]) }),
  actionTool({ name: "toggle_audio_effect", domain: "audio", actionType: "audio/toggleEffect", title: "Toggle audio effect", description: "Enable/disable an audio effect.", inputSchema: obj({ clipId: str, effectId: str, enabled: bool }, ["clipId", "effectId", "enabled"]) }),
  actionTool({ name: "add_subtitle", domain: "subtitle", actionType: "subtitle/add", title: "Add subtitle", description: "Add a subtitle (text, start, end seconds).", inputSchema: obj({ text: str, startTime: num, endTime: num }, ["text", "startTime", "endTime"]) }),
  actionTool({ name: "update_subtitle", domain: "subtitle", actionType: "subtitle/update", title: "Update subtitle", description: "Update a subtitle's text and/or timing (text, startTime, endTime seconds).", inputSchema: obj({ subtitleId: str, text: str, startTime: num, endTime: num }, ["subtitleId"]) }),
  actionTool({ name: "import_srt", domain: "subtitle", actionType: "subtitle/import", title: "Import SRT", description: "Import subtitles from SRT content.", inputSchema: obj({ srtContent: str }, ["srtContent"]) }),
  actionTool({ name: "set_subtitle_style", domain: "subtitle", actionType: "subtitle/setStyle", title: "Subtitle style", description: "Set the global subtitle style.", inputSchema: obj({ style: { type: "object" } }, ["style"]) }),
  actionTool({ name: "add_keyframe", domain: "keyframe", actionType: "keyframe/add", title: "Add keyframe", description: "Add a keyframe for a clip property.", inputSchema: obj({ clipId: str, property: str, time: num, value: {} }, ["clipId", "property", "time"]) }),
  actionTool({ name: "add_transition", domain: "transition", actionType: "transition/add", title: "Add transition", description: "Add a transition between two clips.", inputSchema: obj({ clipAId: str, clipBId: str, transitionType: str, duration: num }, ["clipAId", "clipBId", "transitionType", "duration"]) }),
  actionTool({ name: "update_transition", domain: "transition", actionType: "transition/update", title: "Update transition", description: "Update a transition.", inputSchema: obj({ transitionId: str, type: str, duration: num }, ["transitionId"]) }),
  actionTool({ name: "add_marker", domain: "marker", actionType: "marker/add", title: "Add marker", description: "Add a timeline marker.", inputSchema: obj({ time: num, label: str, color: str }, ["time", "label", "color"]) }),
  actionTool({ name: "update_marker", domain: "marker", actionType: "marker/update", title: "Update marker", description: "Update a marker.", inputSchema: obj({ markerId: str, updates: { type: "object" } }, ["markerId", "updates"]) }),
  {
    name: "create_text_clip",
    domain: "text",
    title: "Create text",
    description: "Create a text overlay that renders immediately. Pass { clip: { text, startTime, duration, style?, trackId? } }. A text track is created automatically if needed.",
    inputSchema: obj({ clip: { type: "object" } }, ["clip"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const clip = (args.clip ?? {}) as Record<string, unknown>;
      const text = String(clip.text ?? "");
      if (!text) return fail("clip.text is required", "INVALID_PARAMS");
      if (typeof host.createTextOverlay === "function") {
        const animObj = (clip.animation ?? {}) as Record<string, unknown>;
        const animation =
          typeof clip.animation === "string"
            ? clip.animation
            : typeof animObj.type === "string"
              ? animObj.type
              : typeof animObj.preset === "string"
                ? animObj.preset
                : undefined;
        const ref = await host.createTextOverlay({
          text,
          startSec: typeof clip.startTime === "number" ? clip.startTime : 0,
          durationSec: typeof clip.duration === "number" ? clip.duration : 3,
          trackId: typeof clip.trackId === "string" ? clip.trackId : undefined,
          style: (clip.style as Record<string, unknown>) ?? undefined,
          animation,
        });
        return ok(`Created text "${text}"${animation ? ` (${animation})` : ""}`, ref);
      }
      const action: Action = {
        type: "text/create",
        id: genId(),
        timestamp: Date.now(),
        params: { clip },
      };
      const result = await host.applyAction(action);
      return result.success
        ? ok(`Created text "${text}"`, { actionId: result.actionId })
        : fail(result.error?.message ?? "text/create failed", result.error?.code);
    },
  },
  {
    name: "update_text_clip",
    domain: "text",
    title: "Update text",
    description: "Update a text overlay clip's content/style/animation/transform. Pass { clipId, updates: { text?, style?, animation?, transform? } }. Renders immediately.",
    inputSchema: obj({ clipId: str, updates: { type: "object" } }, ["clipId", "updates"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      if (typeof args.clipId !== "string" || !args.clipId.trim()) {
        return fail("clipId is required", "INVALID_PARAMS");
      }
      const clipId = args.clipId;
      const updates = asRecord(args.updates);
      if (!updates) return fail("updates object is required", "INVALID_PARAMS");
      if (typeof host.updateTextOverlay === "function") {
        const animObj = asRecord(updates.animation);
        const animation =
          typeof updates.animation === "string"
            ? updates.animation
            : typeof animObj?.type === "string"
              ? animObj.type
              : typeof animObj?.preset === "string"
                ? animObj.preset
                : undefined;
        const ref = await host.updateTextOverlay(clipId, {
          text: typeof updates.text === "string" ? updates.text : undefined,
          style: asRecord(updates.style),
          transform: asRecord(updates.transform),
          animation,
          animationInSec: optionalNumber(animObj?.inDuration ?? updates.animationInSec),
          animationOutSec: optionalNumber(animObj?.outDuration ?? updates.animationOutSec),
        });
        return ok("Updated text overlay", ref);
      }
      const result = await host.applyAction({ type: "text/update", id: genId(), timestamp: Date.now(), params: { clipId, updates } });
      return result.success ? ok("Updated text (action)", { clipId }) : fail(result.error?.message ?? "text/update failed", result.error?.code);
    },
  },
  {
    name: "create_shape_clip",
    domain: "graphics",
    title: "Create shape",
    description: "Create a graphic/shape overlay that renders above the video and image tracks (e.g. a full-frame black scrim). Pass { clip: { shapeType?, startTime, duration, color?, opacity?, fullFrame?, trackId? } }.",
    inputSchema: obj({ clip: { type: "object" } }, ["clip"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const clip = (args.clip ?? {}) as Record<string, unknown>;
      if (typeof host.createShapeOverlay === "function") {
        const ref = await host.createShapeOverlay({
          shapeType: typeof clip.shapeType === "string" ? clip.shapeType : undefined,
          startSec: typeof clip.startTime === "number" ? clip.startTime : 0,
          durationSec: typeof clip.duration === "number" ? clip.duration : 3,
          trackId: typeof clip.trackId === "string" ? clip.trackId : undefined,
          color: typeof clip.color === "string" ? clip.color : undefined,
          opacity: typeof clip.opacity === "number" ? clip.opacity : undefined,
          fullFrame: clip.fullFrame === true,
        });
        return ok("Created shape overlay", ref);
      }
      const action: Action = { type: "shape/create", id: genId(), timestamp: Date.now(), params: { clip } };
      const result = await host.applyAction(action);
      return result.success ? ok("Created shape (action)") : fail(result.error?.message ?? "shape/create failed", result.error?.code);
    },
  },
  {
    name: "update_shape_clip",
    domain: "graphics",
    title: "Update shape",
    description: "Update a shape overlay's color/opacity/style/transform/fullFrame. Pass { clipId, updates: { color?, opacity?, style?, transform?, fullFrame? } }. Renders immediately.",
    inputSchema: obj({ clipId: str, updates: { type: "object" } }, ["clipId", "updates"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      if (typeof args.clipId !== "string" || !args.clipId.trim()) {
        return fail("clipId is required", "INVALID_PARAMS");
      }
      const clipId = args.clipId;
      const updates = asRecord(args.updates);
      if (!updates) return fail("updates object is required", "INVALID_PARAMS");
      if (typeof host.updateShapeOverlay === "function") {
        const ref = await host.updateShapeOverlay(clipId, {
          color: typeof updates.color === "string" ? updates.color : undefined,
          opacity: typeof updates.opacity === "number" ? updates.opacity : undefined,
          style: asRecord(updates.style),
          transform: asRecord(updates.transform),
          fullFrame: updates.fullFrame === true,
        });
        return ok("Updated shape overlay", ref);
      }
      const result = await host.applyAction({ type: "shape/update", id: genId(), timestamp: Date.now(), params: { clipId, updates } });
      return result.success ? ok("Updated shape (action)", { clipId }) : fail(result.error?.message ?? "shape/update failed", result.error?.code);
    },
  },
  {
    name: "create_motion_composition",
    domain: "motion",
    title: "Create motion composition",
    description:
      "Create a standalone Motion Creator composition with starter layers. Useful for intros, lower thirds, ads, app demos, and reusable scene graphics.",
    inputSchema: obj({
      name: str,
      width: num,
      height: num,
      frameRate: num,
      duration: num,
      backgroundColor: str,
    }),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const project = host.getProject();
      const composition = motionEngine.createStarterComposition({
        name: typeof args.name === "string" ? args.name : undefined,
        width: optionalNumber(args.width) ?? project.settings.width,
        height: optionalNumber(args.height) ?? project.settings.height,
        frameRate: optionalNumber(args.frameRate) ?? project.settings.frameRate,
        duration: optionalNumber(args.duration),
        backgroundColor:
          typeof args.backgroundColor === "string"
            ? args.backgroundColor
            : undefined,
      });
      const result = await applyMotionAction(host, "motion/createComposition", {
        composition,
      });
      return result.ok
        ? ok(`Created motion composition "${composition.name}"`, {
            compositionId: composition.id,
            composition,
          })
        : result;
    },
  },
  {
    name: "add_motion_layer",
    domain: "motion",
    title: "Add motion layer",
    description:
      "Add a layer to a Motion Creator composition. layerType is one of text|shape|image|group|null|composition|adjustment|particle. For image pass assetId (a composition asset id) or mediaId (a media library image). For composition pass refCompositionId (the nested comp to embed). For a bezier PEN shape set shapeType:'path' and supply pathData (an SVG path string, e.g. 'M 0 0 C 10 -20 40 -20 50 0') or pathPoints (an array of >=2 {x,y,inX?,inY?,outX?,outY?} vertices in layer-local pixels; in/out are absolute bezier handle coordinates) plus pathClosed (default true). Simple fields: name, text, color, width, height, shapeType.",
    inputSchema: obj({
      compositionId: str,
      layerType: str,
      type: str,
      layer: { type: "object" },
      name: str,
      text: str,
      color: str,
      width: num,
      height: num,
      shapeType: str,
      pathData: str,
      pathPoints: { type: "array" },
      pathClosed: bool,
      assetId: str,
      mediaId: str,
      refCompositionId: str,
      emitter: { type: "object" },
    }, ["compositionId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");

      const layerInput = asRecord(args.layer);
      const layerType = String(
        layerInput?.type ?? args.layerType ?? args.type ?? "text",
      );
      const layerName = String(layerInput?.name ?? args.name ?? "Motion Layer");
      const startTime = optionalNumber(layerInput?.startTime) ?? 0;
      const duration =
        optionalNumber(layerInput?.duration) ?? composition.duration;
      const base = {
        id: genId(),
        name: layerName,
        startTime,
        duration,
        visible: layerInput?.visible !== false,
        locked: layerInput?.locked === true,
        transform: {
          ...DEFAULT_MOTION_TRANSFORM,
          position: { x: composition.width / 2, y: composition.height / 2 },
          ...(asRecord(layerInput?.transform) ?? {}),
        },
        keyframes: Array.isArray(layerInput?.keyframes) ? layerInput.keyframes : [],
      };

      let layer: MotionLayer;
      let nextComposition: MotionComposition = composition;

      switch (layerType) {
        case "text":
          layer = {
            ...base,
            type: "text",
            text: String(layerInput?.text ?? args.text ?? "New text"),
            style: {
              fontFamily: "Inter",
              fontSize: optionalNumber(layerInput?.fontSize) ?? 96,
              fontWeight: 800,
              color: String(layerInput?.color ?? args.color ?? "#ffffff"),
              align: "center",
              lineHeight: 1.05,
              ...(asRecord(layerInput?.style) ?? {}),
            },
          } as MotionTextLayer;
          break;
        case "shape": {
          const shapeType = (layerInput?.shapeType ??
            args.shapeType ??
            "rectangle") as MotionShapeLayer["shapeType"];
          if (!MOTION_SHAPE_TYPES.has(shapeType)) {
            return fail(`Unknown shapeType: ${String(shapeType)}`, "INVALID_PARAMS");
          }
          let pathData: string | undefined;
          let pathClosed: boolean | undefined;
          if (shapeType === "path") {
            const resolved = resolveShapePathData({
              pathData: layerInput?.pathData ?? args.pathData,
              pathPoints: layerInput?.pathPoints ?? args.pathPoints,
            });
            if ("error" in resolved) {
              return fail(resolved.error, "INVALID_PARAMS");
            }
            pathData = resolved.pathData;
            const closedRaw = layerInput?.pathClosed ?? args.pathClosed;
            pathClosed = closedRaw === undefined ? true : closedRaw === true;
          }
          layer = {
            ...base,
            type: "shape",
            shapeType,
            width:
              optionalNumber(layerInput?.width) ??
              optionalNumber(args.width) ??
              520,
            height:
              optionalNumber(layerInput?.height) ??
              optionalNumber(args.height) ??
              220,
            ...(pathData !== undefined ? { pathData } : {}),
            ...(pathClosed !== undefined ? { pathClosed } : {}),
            style: {
              ...DEFAULT_SHAPE_STYLE,
              fill: {
                type: "solid",
                color: String(layerInput?.color ?? args.color ?? "#14b8a6"),
                opacity: 1,
              },
            },
          } as MotionShapeLayer;
          break;
        }
        case "adjustment":
          layer = {
            ...createMotionAdjustmentLayer({
              id: base.id,
              name: layerName,
              startTime,
              duration,
              compositionWidth: composition.width,
              compositionHeight: composition.height,
            }),
            keyframes: base.keyframes,
          };
          break;
        case "null":
          layer = {
            ...createMotionNullLayer(composition, {
              id: base.id,
              name: layerName,
              startTime,
              duration,
              position: base.transform.position,
            }),
            keyframes: base.keyframes,
          };
          break;
        case "particle":
          layer = {
            ...createMotionParticleLayer(composition, {
              id: base.id,
              name: layerName,
              duration,
              position: base.transform.position,
              emitter: asRecord(args.emitter) as
                | Partial<MotionParticleEmitter>
                | undefined,
            }),
            startTime,
            keyframes: base.keyframes,
          };
          break;
        case "group":
          layer = {
            ...base,
            type: "group",
            children: Array.isArray(layerInput?.children)
              ? (layerInput.children as string[])
              : [],
          };
          break;
        case "image": {
          const assetId = optionalString(args.assetId) ?? optionalString(layerInput?.assetId);
          const mediaId = optionalString(args.mediaId) ?? optionalString(layerInput?.mediaId);
          let asset: MotionAsset | undefined = assetId
            ? composition.assets.find((candidate) => candidate.id === assetId)
            : undefined;
          if (!asset && mediaId) {
            const media = host
              .getProject()
              .mediaLibrary.items.find(
                (item: MediaItem) => item.id === mediaId,
              );
            if (!media) return fail(`Media not found: ${mediaId}`, "NOT_FOUND");
            if (media.type !== "image") {
              return fail("Only image media can back an image layer", "INVALID_PARAMS");
            }
            asset = {
              id: genId(),
              type: "image",
              name: media.name,
              mediaId: media.id,
              width: media.metadata.width,
              height: media.metadata.height,
            };
            nextComposition = {
              ...composition,
              assets: [...composition.assets, asset],
            };
          }
          if (!asset) {
            return fail(
              "image layer requires an existing assetId or an image mediaId",
              "INVALID_PARAMS",
            );
          }
          const imageLayer = createMotionImageLayerFromAsset(asset, {
            id: base.id,
            name: layerName,
            startTime,
            duration,
            compositionWidth: composition.width,
            compositionHeight: composition.height,
          });
          layer = { ...imageLayer, keyframes: base.keyframes } as MotionImageLayer;
          break;
        }
        case "composition": {
          const refCompositionId =
            optionalString(args.refCompositionId) ?? optionalString(layerInput?.compositionId);
          if (!refCompositionId) {
            return fail(
              "composition layer requires refCompositionId",
              "INVALID_PARAMS",
            );
          }
          const ref = getMotionComposition(host, refCompositionId);
          if (!ref) return fail(`Nested composition not found: ${refCompositionId}`, "NOT_FOUND");
          if (ref.id === composition.id) {
            return fail("A composition cannot embed itself", "INVALID_PARAMS");
          }
          layer = {
            ...base,
            type: "composition",
            compositionId: ref.id,
            width: ref.width,
            height: ref.height,
            timeOffset: optionalNumber(layerInput?.timeOffset) ?? 0,
            playbackRate: optionalNumber(layerInput?.playbackRate) ?? 1,
            fit: "contain",
          };
          break;
        }
        default:
          return fail(
            `Unsupported motion layer type: ${layerType}`,
            "INVALID_PARAMS",
          );
      }

      const committed: MotionComposition = {
        ...nextComposition,
        layers: [...nextComposition.layers, layer],
        modifiedAt: Date.now(),
      };
      const result = await applyMotionAction(host, "motion/upsertComposition", {
        composition: committed,
      });
      return result.ok
        ? ok(`Added ${layer.type} layer "${layer.name}"`, {
            compositionId: composition.id,
            layerId: layer.id,
          })
        : result;
    },
  },
  readTool(
    "list_motion_animatable_properties",
    "List animatable properties",
    "List the animatable properties of a motion layer (Transform always; Shape/Particle/Precomp by type; plus this layer's masks, effects, shape modifiers, and puppet pins), each with its current value at a time and every existing keyframe (id, time, value, easing, whether it has graph-editor bezier handles). Use this to discover keyframe ids before move/remove/re-ease, and to drive a graph-editor workflow.",
    obj({ compositionId: str, layerId: str, atTime: num }, ["compositionId", "layerId"]),
    (args, host) => {
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return { error: "Motion composition not found" };
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return { error: "Motion layer not found" };
      const atTime = optionalNumber(args.atTime) ?? 0;
      const staticDescriptors = MOTION_ANIMATABLE_PROPERTIES.filter((descriptor) => {
        if (descriptor.group === "Transform") return true;
        if (descriptor.group === "Shape") return layer.type === "shape";
        if (descriptor.group === "Particles") return layer.type === "particle";
        if (descriptor.group === "Precomp") return layer.type === "composition";
        return false;
      });
      const descriptors = [
        ...staticDescriptors,
        ...getMotionLayerMaskPropertyDescriptors(layer),
        ...getMotionLayerEffectPropertyDescriptors(layer),
        ...getMotionLayerShapeModifierPropertyDescriptors(layer),
        ...getMotionLayerContentsPropertyDescriptors(layer),
        ...getMotionLayerPuppetPropertyDescriptors(layer),
        ...getMotionLayerShaderFillPropertyDescriptors(layer),
      ];
      const properties = descriptors.map((descriptor) => {
        const property = descriptor.property as MotionAnimatableProperty;
        return {
          property: descriptor.property,
          label: descriptor.label,
          group: descriptor.group,
          unit: descriptor.unit,
          currentValue: getMotionLayerPropertyValueAtTime(layer, property, atTime),
          keyframes: getMotionLayerPropertyKeyframes(layer, descriptor.property).map((keyframe) => ({
            id: keyframe.id,
            time: keyframe.time,
            value: keyframe.value,
            easing: keyframe.easing,
            bezier: Boolean(keyframe.bezierHandles),
          })),
        };
      });
      return {
        compositionId: composition.id,
        layerId: layer.id,
        layerType: layer.type,
        atTime,
        propertyCount: properties.length,
        properties,
      };
    },
  ),
  {
    name: "add_motion_keyframe",
    domain: "motion",
    title: "Add/update motion keyframe",
    description:
      "Add or update a single keyframe at a time on a motion layer property (the AE 'stopwatch + set value at playhead' action). property is any animatable id: transform.* (e.g. transform.scale.x, transform.position.y, transform.opacity), shape.* (e.g. shape.cornerRadius), effect.<effectId>.<param>, mask.<maskId>.<prop> (prop = x|y|width|height|rotation|feather|expansion|opacity — mask bounds/feather keyframes), modifier.<modifierId>.<prop> (shape modifier fields, including repeater transform.position.x/y, transform.scale.x/y, transform.rotation, transform.opacity), and puppet.<pinId>.<prop>. Call list_motion_animatable_properties to enumerate the exact ids (including mask and modifier ids) for a layer. value defaults to the property's current value if omitted. easing is any known easing name. For a graph-editor curve, pass easing='bezier' with bezierIn {x,y} and bezierOut {x,y} normalized control points: bezierIn is P1 and bezierOut is P2 of the OUTGOING segment (this keyframe → the next one), normalized to that segment — x is the time fraction 0..1 across the segment and y is the value fraction of the segment's value delta. y may exceed [0,1] (e.g. y>1 overshoots past the target before settling, y<0 anticipates below the start). Re-calling at the same time updates that keyframe in place. roving (boolean) marks a middle keyframe as roving: its time is then AUTO-DERIVED (dropped from your input) so the property moves at constant speed between the surrounding non-roving anchor keyframes. A property's first and last keyframes can NEVER rove — requesting roving on an endpoint is a no-op. Toggling roving off restores an editable time.",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      property: str,
      time: num,
      value: num,
      easing: str,
      bezierIn: { type: "object" },
      bezierOut: { type: "object" },
      roving: bool,
    }, ["compositionId", "layerId", "property", "time"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      const property = optionalString(args.property);
      if (!property || !isMotionAnimatableProperty(property)) {
        return fail(`Unsupported motion property: ${String(args.property)}`, "INVALID_PARAMS");
      }
      const time = optionalNumber(args.time);
      if (time === undefined) return fail("time is required", "INVALID_PARAMS");

      const bezierIn = vec2FromObject(args.bezierIn);
      const bezierOut = vec2FromObject(args.bezierOut);
      const bezierHandles =
        bezierIn && bezierOut ? { in: bezierIn, out: bezierOut } : undefined;
      const easingInput = optionalString(args.easing);
      const easing = bezierHandles
        ? ("bezier" as const)
        : isValidEasing(easingInput)
          ? easingInput
          : undefined;

      const priorKeyframeIds = new Set(
        getMotionLayerPropertyKeyframes(layer, property).map(
          (keyframe) => keyframe.id,
        ),
      );
      const upserted = upsertMotionLayerKeyframe(layer, property, time, {
        value: optionalNumber(args.value),
        easing,
        bezierHandles,
      });
      const rovingRequested =
        typeof args.roving === "boolean" ? args.roving : undefined;
      const upsertedKeyframes = getMotionLayerPropertyKeyframes(
        upserted,
        property,
      );
      const upsertedKeyframe =
        upsertedKeyframes.find(
          (keyframe) => !priorKeyframeIds.has(keyframe.id),
        ) ??
        upsertedKeyframes.reduce<(typeof upsertedKeyframes)[number] | undefined>(
          (closest, keyframe) =>
            closest === undefined ||
            Math.abs(keyframe.time - time) < Math.abs(closest.time - time)
              ? keyframe
              : closest,
          undefined,
        );
      const nextLayer =
        rovingRequested !== undefined && upsertedKeyframe
          ? setMotionKeyframeRoving(
              upserted,
              property,
              upsertedKeyframe.id,
              rovingRequested,
            )
          : upserted;
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      if (!result.ok) return result;
      const keyframes = getMotionLayerPropertyKeyframes(nextLayer, property);
      const committedKeyframe = upsertedKeyframe
        ? keyframes.find((keyframe) => keyframe.id === upsertedKeyframe.id)
        : undefined;
      return ok(`Set keyframe on ${property} @ ${time.toFixed(3)}s`, {
        compositionId: composition.id,
        layerId: layer.id,
        property,
        time: committedKeyframe?.time ?? time,
        easing: easing ?? "ease",
        bezier: Boolean(bezierHandles),
        roving: committedKeyframe?.roving === true,
        keyframeCount: keyframes.length,
        keyframeIds: keyframes.map((keyframe) => keyframe.id),
      });
    },
  },
  {
    name: "insert_motion_into_editor",
    domain: "motion",
    title: "Insert motion into editor",
    description:
      "Place a motion composition into the normal video-editor timeline as a reusable rendered scene.",
    inputSchema: obj({
      compositionId: str,
      startTime: num,
      duration: num,
      trackId: str,
      name: str,
    }, ["compositionId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const instance = motionEngine.createInstance(composition, {
        startTime: optionalNumber(args.startTime),
        duration: optionalNumber(args.duration),
        trackId: typeof args.trackId === "string" ? args.trackId : undefined,
        name: typeof args.name === "string" ? args.name : undefined,
      });
      const result = await applyMotionAction(host, "motion/insertInstance", {
        instance,
      });
      return result.ok
        ? ok(`Inserted motion scene "${composition.name}"`, {
            instanceId: instance.id,
            compositionId: composition.id,
          })
        : result;
    },
  },
  readTool(
    "get_motion_composition",
    "Get motion composition",
    "Full detail for one Motion Creator composition: every layer with its id, type, transform, keyframes, and type-specific fields, plus variables, markers, beat markers, camera, and lights. Use this to recover auto-generated layer ids before animating or editing.",
    obj({ compositionId: str }, ["compositionId"]),
    (args, host) => {
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) {
        return { error: "Motion composition not found", compositionId: args.compositionId };
      }
      return serializeMotionComposition(composition);
    },
  ),
  {
    name: "set_motion_layer_transform",
    domain: "motion",
    title: "Set motion layer transform",
    description:
      "Set a layer's static transform without keyframes. Optional: x, y (pixel center), scale (uniform), scaleX, scaleY, rotation (degrees), opacity (0-1), anchorX, anchorY (pixels). Only the fields you pass change.",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      x: num,
      y: num,
      scale: num,
      scaleX: num,
      scaleY: num,
      rotation: num,
      opacity: num,
      anchorX: num,
      anchorY: num,
    }, ["compositionId", "layerId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      const transform = layer.transform;
      const x = optionalNumber(args.x);
      const y = optionalNumber(args.y);
      const scale = optionalNumber(args.scale);
      const scaleX = optionalNumber(args.scaleX) ?? scale;
      const scaleY = optionalNumber(args.scaleY) ?? scale;
      const rotation = optionalNumber(args.rotation);
      const opacity = optionalNumber(args.opacity);
      const anchorX = optionalNumber(args.anchorX);
      const anchorY = optionalNumber(args.anchorY);
      const nextLayer: MotionLayer = {
        ...layer,
        transform: {
          ...transform,
          position: {
            ...transform.position,
            x: x ?? transform.position.x,
            y: y ?? transform.position.y,
          },
          scale: {
            x: scaleX ?? transform.scale.x,
            y: scaleY ?? transform.scale.y,
          },
          rotation: rotation ?? transform.rotation,
          opacity:
            opacity !== undefined ? clampNumber(opacity, 0, 1) : transform.opacity,
          anchor: {
            x: anchorX ?? transform.anchor.x,
            y: anchorY ?? transform.anchor.y,
          },
        },
      };
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      return result.ok
        ? ok("Set motion layer transform", {
            compositionId: composition.id,
            layerId: layer.id,
          })
        : result;
    },
  },
  {
    name: "set_motion_layer_name",
    domain: "motion",
    title: "Rename motion layer",
    description:
      "Rename any layer in a composition. name is the new label shown in the timeline/layer list (must be non-empty).",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      name: str,
    }, ["compositionId", "layerId", "name"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      const name = optionalString(args.name)?.trim();
      if (!name) return fail("name must be a non-empty string", "INVALID_PARAMS");
      const nextLayer: MotionLayer = { ...layer, name };
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      return result.ok
        ? ok(`Renamed layer to "${name}"`, {
            compositionId: composition.id,
            layerId: layer.id,
            name,
          })
        : result;
    },
  },
  {
    name: "set_motion_layer_solo",
    domain: "motion",
    title: "Solo motion layer",
    description:
      "Toggle a layer's solo flag. solo=true isolates soloed layers in preview/render (all non-soloed, non-guide layers are hidden). solo=false clears it.",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      solo: bool,
    }, ["compositionId", "layerId", "solo"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      if (typeof args.solo !== "boolean") {
        return fail("solo must be a boolean", "INVALID_PARAMS");
      }
      const nextLayer: MotionLayer = { ...layer, solo: args.solo };
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      return result.ok
        ? ok(args.solo ? "Soloed layer" : "Cleared layer solo", {
            compositionId: composition.id,
            layerId: layer.id,
            solo: args.solo,
          })
        : result;
    },
  },
  {
    name: "set_motion_layer_timing",
    domain: "motion",
    title: "Set motion layer timing",
    description:
      "Move a layer on the timeline by setting its startTime and/or duration (seconds). Values snap to the composition frame rate and are clamped to be non-negative; duration and the resulting out point are clamped to the composition duration. Pass at least one of startTime, duration; only the fields you pass change.",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      startTime: num,
      duration: num,
    }, ["compositionId", "layerId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      const startTime = optionalNumber(args.startTime);
      const duration = optionalNumber(args.duration);
      if (startTime === undefined && duration === undefined) {
        return fail("Provide startTime and/or duration", "INVALID_PARAMS");
      }
      const timing = motionTimingOptions(composition);
      const nextComposition = updateMotionCompositionLayerTiming(
        composition,
        layer.id,
        (current) => {
          const withDuration =
            duration !== undefined
              ? trimMotionLayerOutPoint(
                  current,
                  current.startTime + Math.max(0, duration),
                  timing,
                )
              : current;
          return startTime !== undefined
            ? moveMotionLayerInTime(withDuration, startTime, timing)
            : withDuration;
        },
      );
      const nextLayer = getMotionLayer(nextComposition, layer.id);
      const result = await commitMotionComposition(host, nextComposition);
      return result.ok
        ? ok("Set motion layer timing", {
            compositionId: composition.id,
            layerId: layer.id,
            startTime: nextLayer?.startTime,
            duration: nextLayer?.duration,
          })
        : result;
    },
  },
  {
    name: "update_motion_composition",
    domain: "motion",
    title: "Update motion composition",
    description:
      "Update a composition's top-level settings. Optional: name, width, height, frameRate, duration, backgroundColor. Only the fields you pass change.",
    inputSchema: obj({
      compositionId: str,
      name: str,
      width: num,
      height: num,
      frameRate: num,
      duration: num,
      backgroundColor: str,
    }, ["compositionId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const name = optionalString(args.name);
      const width = optionalNumber(args.width);
      const height = optionalNumber(args.height);
      const frameRate = optionalNumber(args.frameRate);
      const duration = optionalNumber(args.duration);
      const backgroundColor = optionalString(args.backgroundColor);
      const nextComposition: MotionComposition = {
        ...composition,
        name: name ?? composition.name,
        width: width !== undefined ? Math.max(1, Math.round(width)) : composition.width,
        height:
          height !== undefined ? Math.max(1, Math.round(height)) : composition.height,
        frameRate:
          frameRate !== undefined ? Math.max(1, frameRate) : composition.frameRate,
        duration:
          duration !== undefined ? Math.max(0, duration) : composition.duration,
        backgroundColor: backgroundColor ?? composition.backgroundColor,
      };
      const result = await commitMotionComposition(host, nextComposition);
      return result.ok
        ? ok("Updated motion composition", {
            compositionId: composition.id,
          })
        : result;
    },
  },
  {
    name: "set_motion_text_content",
    domain: "motion",
    title: "Set motion text content",
    description:
      "Replace the source text string of an existing text layer. Only mutates the layer's `.text`; styling, animators, and keyframes are untouched. Pass an empty string to clear the text. The layer referenced by layerId must be a text layer (else INVALID_PARAMS).",
    inputSchema: obj({ compositionId: str, layerId: str, text: str }, [
      "compositionId",
      "layerId",
      "text",
    ]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      if (layer.type !== "text") {
        return fail("set_motion_text_content requires a text layer", "INVALID_PARAMS");
      }
      if (typeof args.text !== "string") {
        return fail("text is required and must be a string", "INVALID_PARAMS");
      }
      const nextLayer: MotionTextLayer = { ...layer, text: args.text };
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      return result.ok
        ? ok("Set motion text content", {
            compositionId: composition.id,
            layerId: layer.id,
            text: args.text,
          })
        : result;
    },
  },
  {
    name: "list_motion_shaders",
    domain: "motion",
    title: "List motion shaders",
    description:
      "Enumerate the built-in GPU shader library for Motion Creator. Returns fill shaders (procedural fills for shape/text layers), effect shaders (post-process effects on any visual layer), and text shaders (per-glyph animator shaders for text layers), each with its parameters (name, label, type, min, max, default, step) and its collection ('Paper' for the Paper Design catalog, null for the original built-ins). Use before set_motion_shader_fill / add_motion_shader_effect / add_motion_text_shader_animator to pick a valid shaderId and know its params. Optional category filter: 'fill', 'effect', or 'text'. Optional collection filter (e.g. 'Paper') narrows to one collection; an unknown collection returns empty lists, not an error.",
    inputSchema: obj({ category: str, collection: str }, []),
    readOnly: true,
    destructive: false,
    expensive: false,
    handler: (args) => {
      const toInfo = (def: MotionShaderDef) => ({
        id: def.id,
        name: def.name,
        category: def.category,
        collection: def.collection ?? null,
        params: def.params.map((p: MotionShaderParamDef) => ({
          name: p.name,
          label: p.label,
          type: p.type,
          min: p.min,
          max: p.max,
          default: p.default,
          step: p.step,
          control: p.control ?? null,
        })),
      });
      const category = optionalString(args.category);
      const collection = optionalString(args.collection);
      const inCollection = (def: MotionShaderDef): boolean =>
        collection === undefined || (def.collection ?? null) === collection;
      const fills = getMotionShaderFillDefs().filter(inCollection).map(toInfo);
      const effects = getMotionShaderEffectDefs().filter(inCollection).map(toInfo);
      const text = getMotionShaderTextDefs().filter(inCollection).map(toInfo);
      if (category === "fill") return ok(`${fills.length} fill shaders`, { fills });
      if (category === "effect") return ok(`${effects.length} effect shaders`, { effects });
      if (category === "text") return ok(`${text.length} text shaders`, { text });
      return ok(
        `${fills.length} fill + ${effects.length} effect + ${text.length} text shaders`,
        { fills, effects, text },
      );
    },
  },
  {
    name: "set_motion_layer_visibility",
    domain: "motion",
    title: "Set motion layer visibility",
    description: "Show or hide a motion layer.",
    inputSchema: obj({ compositionId: str, layerId: str, visible: bool }, [
      "compositionId",
      "layerId",
      "visible",
    ]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      if (typeof args.visible !== "boolean") {
        return fail("visible must be a boolean", "INVALID_PARAMS");
      }
      const nextComposition = setMotionLayersVisible(composition, [layer.id], args.visible);
      const result = await commitMotionComposition(host, nextComposition);
      return result.ok
        ? ok(`${args.visible ? "Showed" : "Hid"} motion layer`, {
            compositionId: composition.id,
            layerId: layer.id,
          })
        : result;
    },
  },
  {
    name: "set_motion_shape_style",
    domain: "motion",
    title: "Set motion shape style",
    description:
      "Set the full visual style of a shape layer so any card/button/panel look is reproducible. Optional: shapeType (rectangle|circle|ellipse|line|polygon|star|triangle|arrow|...), width, height, fill { type: solid|gradient|none, color, opacity, gradient: { type: linear|radial|conic, angle, center {x,y}, stops: [{offset 0..1, color, opacity?}] } }, stroke { color, width, opacity, dashArray, dashOffset, lineCap, lineJoin, gradient }, shadow { color, blur, offsetX, offsetY, spread?, inset? }, shadows [array of shadow], cornerRadius, cornerRadii { topLeft, topRight, bottomRight, bottomLeft }, points (star), innerRadius (star 0..1).",
    inputSchema: obj({
      compositionId: str,
      layerId: str,
      shapeType: str,
      width: num,
      height: num,
      fill: { type: "object" },
      stroke: { type: "object" },
      shadow: { type: "object" },
      shadows: { type: "array" },
      cornerRadius: num,
      cornerRadii: { type: "object" },
      points: num,
      innerRadius: num,
    }, ["compositionId", "layerId"]),
    readOnly: false,
    destructive: false,
    expensive: false,
    handler: async (args, host) => {
      host.requireOpenProject();
      const composition = getMotionComposition(host, args.compositionId);
      if (!composition) return fail("Motion composition not found", "NOT_FOUND");
      const layer = getMotionLayer(composition, args.layerId);
      if (!layer) return fail("Motion layer not found", "NOT_FOUND");
      if (layer.type !== "shape") {
        return fail("set_motion_shape_style requires a shape layer", "INVALID_PARAMS");
      }
      const shapeType = optionalString(args.shapeType) as ShapeType | undefined;
      if (shapeType && !MOTION_SHAPE_TYPES.has(shapeType)) {
        return fail(`Unknown shapeType: ${String(args.shapeType)}`, "INVALID_PARAMS");
      }
      const styleSpec: MotionUiShapeStyleSpec = {
        fill: asRecord(args.fill) as MotionUiShapeStyleSpec["fill"],
        stroke: asRecord(args.stroke) as MotionUiShapeStyleSpec["stroke"],
        shadow: asRecord(args.shadow) as MotionUiShapeStyleSpec["shadow"],
        cornerRadius: optionalNumber(args.cornerRadius),
        points: optionalNumber(args.points),
        innerRadius: optionalNumber(args.innerRadius),
      };
      const baseStyle = buildMotionShapeStyle(styleSpec, layer.style);
      const nextStyle = applyExtendedShapeStyle(baseStyle, args);
      if (typeof nextStyle === "string") {
        return fail(nextStyle, "INVALID_PARAMS");
      }
      const nextLayer: MotionShapeLayer = {
        ...layer,
        shapeType: shapeType ?? layer.shapeType,
        width: optionalNumber(args.width) ?? layer.width,
        height: optionalNumber(args.height) ?? layer.height,
        style: nextStyle,
      };
      const result = await commitMotionComposition(
        host,
        replaceMotionLayer(composition, layer.id, nextLayer),
      );
      return result.ok
        ? ok("Set motion shape style", {
            compositionId: composition.id,
            layerId: layer.id,
          })
        : result;
    },
  },
];

const REGISTRY = new Map<string, RegisteredTool>(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): RegisteredTool | undefined {
  return REGISTRY.get(name);
}

export function listTools(): RegisteredTool[] {
  return [...REGISTRY.values()];
}

export function toolDefs(): ToolDef[] {
  return listTools().map(({ handler: _handler, ...def }) => def);
}

function selectedTools(names?: Iterable<string>): RegisteredTool[] {
  if (!names) return listTools();
  const selected = new Set(names);
  return listTools().filter((tool) => selected.has(tool.name));
}

interface NamedToolSchema {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export function toAnthropicTools(names?: Iterable<string>): NamedToolSchema[] {
  return selectedTools(names).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function toOpenAITools(names?: Iterable<string>): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JSONSchema };
}> {
  return selectedTools(names).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function toMcpTools(): Array<{
  name: string;
  description: string;
  inputSchema: JSONSchema;
}> {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function toCapabilityDoc(names?: Iterable<string>): string {
  const byDomain = new Map<string, RegisteredTool[]>();
  for (const t of selectedTools(names)) {
    const arr = byDomain.get(t.domain) ?? [];
    arr.push(t);
    byDomain.set(t.domain, arr);
  }
  let out = "# OpenReel Agent Tools\n";
  for (const [domain, tools] of byDomain) {
    out += `\n## ${domain}\n`;
    for (const t of tools) {
      const flags = [
        t.readOnly ? "read-only" : null,
        t.destructive ? "destructive" : null,
        t.expensive ? "expensive" : null,
      ]
        .filter(Boolean)
        .join(", ");
      out += `- **${t.name}**${flags ? ` (${flags})` : ""} — ${t.description}\n`;
    }
  }
  return out;
}
