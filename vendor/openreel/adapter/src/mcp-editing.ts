import { detectSilenceCapability } from "./silence-analysis";
import { duckMusic, exportCaptions, rippleDelete, shortDramaCapabilities } from "./short-drama";
import { randomUUID } from "node:crypto";
import { executeTool } from "@openreel/agent/executor";
import { HeadlessHost } from "@openreel/agent/headless-host";
import { listTools } from "@openreel/agent/registry";
import type { JSONSchema, ToolDef } from "@openreel/agent/types";
import { getMotionShaderDef } from "@openreel/core/motion/shaders";
import { BUILTIN_TEMPLATES, TemplateEngine } from "@openreel/core/template/template-engine";
import { TRANSITION_TYPES } from "@openreel/core/types/effects";
import type { Project } from "@openreel/core/types/project";
import { BLEND_MODES } from "@openreel/core/video/types";
import { applyPiProjectTemplate } from "@openreel/pi-template-project";
import { failure } from "./drafts.mjs";
import type { EditingDraft } from "./engine";
import {
  addClipEdgeTransition, addKeyframe, addSubtitle, addTransition, apply, applyFilterPreset, autoCaption, boundedText,
  createText, importSrt, invalid, listFilterPresets, numeric, object,
  retimeAutoCaptions, setSubtitleStyle, trimClip, updateSubtitle, updateText, updateTransition, writableClip, writableTrack,
  type Transcribe,
} from "./mcp-editing-native";
import { createShape, updateClipTransform, updateShape } from "./mcp-editing-overlays";
import { checkMotionEdit } from "./mcp-editing-motion";
import { rollEdit, slideClip, slipClip, trimToPlayhead } from "./mcp-editing-retime";
import { matchesObjectDeletion, objectDeletionCapabilities, planObjectDeletion } from "./mcp-delete-objects";
import { separateAudioCapability } from "./mcp-separate-audio";

type Arguments = Record<string, unknown>;
type ToolCall = { name: string; arguments: Arguments };
type CatalogEntry = Omit<ToolDef, "title"> & { available: boolean; unavailableReason?: string };
type EditHandler = (host: HeadlessHost, args: Arguments, signal?: AbortSignal) => Promise<unknown>;

const nativeEdits = new Map<string, EditHandler>([
  ["add_subtitle", addSubtitle], ["update_subtitle", updateSubtitle], ["import_srt", importSrt],
  ["set_subtitle_style", setSubtitleStyle], ["create_text_clip", createText], ["update_text_clip", updateText],
  ["add_transition", addTransition], ["update_transition", updateTransition],
  ["add_clip_edge_transition", addClipEdgeTransition], ["apply_filter_preset", applyFilterPreset],
  ["create_shape_clip", createShape], ["update_shape_clip", updateShape], ["set_clip_transform", updateClipTransform],
  ["add_keyframe", addKeyframe],
  ["roll_edit", rollEdit], ["slide_clip", slideClip], ["slip_clip", slipClip], ["trim_to_playhead", trimToPlayhead],
]);
const videoEffects = [
  "brightness", "contrast", "saturation", "grayscale", "sepia", "invert", "hue",
  "blur", "sharpen", "vignette", "grain", "temperature", "tint", "tonal", "chromaKey",
  "shadow", "glow", "motion-blur", "radial-blur", "chromatic-aberration", "shader",
];
const trackTypes = ["video", "audio", "image", "text", "graphics"];
const identifier = { type: "string", minLength: 1, maxLength: 128 };
const extras: Omit<ToolDef, "title">[] = [
  ...shortDramaCapabilities,
  detectSilenceCapability,
  ...objectDeletionCapabilities,
  separateAudioCapability,
  {
    name: "import_media", domain: "media", description: "Import a verified project-local MP4, MP3/WAV, PNG/JPEG into the right track. Use an exact current attachment path when supplied.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      path: { type: "string", minLength: 1, maxLength: 1024 },
      kind: { enum: ["video", "audio", "image"] }, trackId: identifier,
      startTime: { type: "number", minimum: 0 }, outPoint: { type: "number", exclusiveMinimum: 0 },
    }, required: ["path"] },
    readOnly: false, destructive: false, expensive: false,
  },
  {
    name: "preview_timeline_template", domain: "project", description: "Inspect a local timeline template's contents and whether it would replace saved edits. This call changes nothing.",
    inputSchema: { type: "object", additionalProperties: false, properties: { templateId: identifier }, required: ["templateId"] },
    readOnly: true, destructive: false, expensive: false,
  },
  {
    name: "add_clip_edge_transition", domain: "transition",
    description: "Add an in or out transition to a single clip. Does not split or move the video.",
    inputSchema: { type: "object", properties: {
      clipId: identifier, edge: { enum: ["in", "out"] },
      transitionType: { enum: TRANSITION_TYPES }, duration: { type: "number", minimum: 0.001 },
    }, required: ["clipId", "edge", "transitionType", "duration"], additionalProperties: false },
    readOnly: false, destructive: false, expensive: false,
  },
  {
    name: "list_filter_presets", domain: "effect", description: "List the editor's built-in filter presets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true, destructive: false, expensive: false,
  },
  {
    name: "apply_filter_preset", domain: "effect",
    description: "Apply a built-in OpenReel filter preset to a video clip, keeping existing effects.",
    inputSchema: { type: "object", properties: { clipId: identifier, presetId: identifier },
      required: ["clipId", "presetId"], additionalProperties: false },
    readOnly: false, destructive: false, expensive: false,
  },
  {
    name: "auto_caption", domain: "subtitle",
    description: "Send selected clip audio to the configured OpenReel subtitle service and add editable captions. Select clipId or clipIds, or omit both for video and dialogue tracks. Excludes standalone music by default.",
    inputSchema: { type: "object", properties: { clipId: identifier,
      clipIds: { type: "array", minItems: 1, maxItems: 50, items: identifier },
      language: { type: "string", minLength: 1, maxLength: 24 } }, additionalProperties: false },
    readOnly: false, destructive: false, expensive: true,
  },
  {
    name: "apply_timeline_template", domain: "project",
    description: "Apply a built-in editor timeline template to a blank conversation draft. Existing content requires approval in the editor.",
    inputSchema: { type: "object", properties: { templateId: identifier },
      required: ["templateId"], additionalProperties: false },
    readOnly: false, destructive: false, expensive: false,
  },
  {
    name: "list_timeline_templates", domain: "project", description: "List the editor's built-in timeline templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true, destructive: false, expensive: false,
  },
];

const catalog = [...listTools(), ...extras].map((tool): CatalogEntry => {
  const { name, description, inputSchema, domain, readOnly, expensive, destructive } = tool;
  return {
    name, description: name === "create_project" ? "Create a blank OpenReel draft only when the current conversation has no saved draft."
      : name === "list_projects" ? "List the saved OpenReel project bound to this conversation."
      : name === "slide_clip" ? "Slide a clip and move the cut points of its two explicitly selected adjacent clips."
      : description,
    inputSchema: { ...inputSchema, additionalProperties: false,
      ...(name === "slide_clip" ? { required: ["clipId", "delta", "prevClipId", "nextClipId"] } : {}) }, domain,
    readOnly, destructive, expensive, available: true,
  };
});
const catalogByName = new Map(catalog.map(tool => [tool.name, tool]));

export function openReelToolCatalog(): CatalogEntry[] {
  return catalog;
}

function checkJson(value: unknown, depth = 0): void {
  if (depth > 12) invalid("OpenReel tool arguments are nested too deeply.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 64 * 1024) return;
  if (Array.isArray(value) && value.length <= 500) {
    value.forEach(item => checkJson(item, depth + 1));
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length <= 128 && entries.every(([key]) => key.length <= 128 &&
      !["__proto__", "prototype", "constructor"].includes(key))) {
      for (const [, item] of entries) checkJson(item, depth + 1);
      return;
    }
  }
  invalid("OpenReel tool arguments must use bounded JSON values.");
}

function checkSchema(value: unknown, schema: JSONSchema, field: string): void {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) invalid(`${field} has an unsupported value.`);
  if (schema.type === "number" || schema.type === "integer") {
    numeric(value, field, typeof schema.minimum === "number" ? schema.minimum : -Number.MAX_VALUE,
      typeof schema.maximum === "number" ? schema.maximum : Number.MAX_VALUE);
    if (typeof schema.exclusiveMinimum === "number" && typeof value === "number" && value <= schema.exclusiveMinimum) {
      invalid(`${field} must exceed ${schema.exclusiveMinimum}.`);
    }
    if (schema.type === "integer" && !Number.isSafeInteger(value)) invalid(`${field} must be an integer.`);
    return;
  }
  if (schema.type === "string" &&
    (typeof value !== "string" || value.length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? 128))) invalid(`${field} must be bounded text.`);
  if (schema.type === "boolean" && typeof value !== "boolean") invalid(`${field} must be a boolean.`);
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > Number(schema.maxItems ?? 500) ||
      value.length < Number(schema.minItems ?? 0)) invalid(`${field} must be a bounded array.`);
    if (schema.items) for (const item of value) checkSchema(item, object(schema.items, field), field);
  }
  if (schema.type === "object") {
    const record = object(value, field);
    const properties = object(schema.properties ?? {}, field);
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === "string" && !Object.hasOwn(record, key))) {
      invalid(`${field} is missing a required field.`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) checkSchema(item, object(properties[key], key), key);
      else if (schema.additionalProperties === false) invalid(`${field} has an unsupported field.`);
    }
  }
}

function checked(name: string, args: Arguments, readOnly: boolean): CatalogEntry {
  const tool = catalogByName.get(name);
  if (!tool?.available) throw failure("UNSUPPORTED", tool?.unavailableReason ?? "Unknown OpenReel capability.");
  if (readOnly !== tool.readOnly) throw failure("PERMISSION_DENIED", "This OpenReel capability requires a different operation.");
  checkJson(args);
  const properties = { ...object(tool.inputSchema.properties ?? {}, "Input schema") };
  if (name === "add_subtitle" || name === "update_subtitle") properties.text = { type: "string", maxLength: 4096 };
  if (name === "import_srt") properties.srtContent = { type: "string", maxLength: 64 * 1024 };
  checkSchema(args, { ...tool.inputSchema, properties }, name);
  return tool;
}

function checkTimelineEdit(project: Project, name: string, args: Arguments) {
  const clip = args.clipId === undefined ? undefined : writableClip(project, args.clipId);
  if (args.trackId !== undefined && name !== "lock_track") writableTrack(project, args.trackId);
  if (name === "lock_track" && !project.timeline.tracks.some(track => track.id === args.trackId)) {
    invalid("Track not found in this draft.");
  }
  if (args.sourceTrackId !== undefined) writableTrack(project, args.sourceTrackId);
  if (args.mediaId !== undefined && !project.mediaLibrary.items.some(item => item.id === args.mediaId)) {
    invalid("Media item not found in this draft.");
  }
  if (args.trackType !== undefined && !trackTypes.includes(String(args.trackType))) invalid("Choose an OpenReel track type.");
  if (args.name !== undefined) boundedText(args.name, "Name");
  for (const position of ["position", "newPosition"]) {
    if (args[position] !== undefined && !Number.isSafeInteger(numeric(args[position], position, 0, project.timeline.tracks.length))) {
      invalid("Track position must be an integer.");
    }
  }
  for (const size of ["width", "height"]) {
    if (args[size] !== undefined && !Number.isSafeInteger(numeric(args[size], size, 2, 8192))) invalid("Frame size must be an integer.");
  }
  if (args.frameRate !== undefined) numeric(args.frameRate, "Frame rate", 1, 120);
  if (args.startTime !== undefined) numeric(args.startTime, "Start time", 0, 8 * 60 * 60);
  if (args.opacity !== undefined) numeric(args.opacity, "Opacity", 0, 1);
  if (args.volume !== undefined) numeric(args.volume, "Volume", 0, 4);
  if (args.speed !== undefined) numeric(args.speed, "Playback speed", 0.05, 32);
  if (args.fadeIn !== undefined) numeric(args.fadeIn, "Fade in", 0, clip?.duration ?? 0);
  if (args.fadeOut !== undefined) numeric(args.fadeOut, "Fade out", 0, clip?.duration ?? 0);
  if (args.backgroundFillMode !== undefined && !["color", "blur"].includes(String(args.backgroundFillMode))) {
    invalid("Canvas background fill must be color or blur.");
  }
  if (args.layoutBackgroundColor !== undefined) boundedText(args.layoutBackgroundColor, "Background color", 48);
  if (args.blendMode !== undefined && !BLEND_MODES.some(mode => mode === args.blendMode)) invalid("Choose an OpenReel blend mode.");
  if (name === "split_clip" && clip) {
    const time = numeric(args.time, "Split time");
    if (time <= clip.startTime || time >= clip.startTime + clip.duration) invalid("Split time must be inside the timeline clip.");
  }
  if (name === "move_clip" || name === "add_clip") {
    const track = args.trackId === undefined ? undefined : writableTrack(project, args.trackId);
    if (track?.role === "captions") invalid("Place source media on a video track outside the captions lane.");
  }
  if (name === "add_video_effect") {
    if (!videoEffects.includes(String(args.effectType))) invalid("Choose a supported OpenReel effect type.");
    const params = object(args.params ?? {}, "Effect parameters");
    if (args.effectType === "shader" &&
      getMotionShaderDef(boundedText(params.shaderId, "Shader ID"))?.category !== "effect") invalid("Choose a built-in effect shader.");
  }
  if (name === "set_color_grading") {
    const grade = object(args.colorGrading, "Color grading settings");
    for (const [key, value] of Object.entries(grade)) {
      if (key !== "temperature" && key !== "tint") invalid("This editor endpoint supports temperature and tint.");
      numeric(value, key, -100, 100);
    }
    args.colorGrading = { ...clip?.colorGrading, ...grade };
  }
  if (name === "add_audio_effect") {
    const effect = object(args.effect, "Audio effect");
    if (Object.keys(effect).some(key => !["type", "params", "enabled"].includes(key))) invalid("Unsupported audio effect field.");
    if (effect.enabled !== undefined && typeof effect.enabled !== "boolean") invalid("Effect enabled must be a boolean.");
    args.effect = {
      id: randomUUID(), type: effect.type, enabled: effect.enabled ?? true,
      params: checkAudioParameters(effect.type, effect.params),
    };
  }
  if (args.effectId !== undefined) {
    const effects = name.includes("_audio_") ? clip?.audioEffects : clip?.effects;
    const effect = effects?.find(item => item.id === args.effectId);
    if (!effect) invalid("Effect not found on the clip.");
    if (name === "update_audio_effect") args.params = checkAudioParameters(effect.type, args.params);
    if (name === "update_video_effect" && effect.type === "shader") {
      const params = object(args.params, "Effect parameters");
      const id = boundedText(params.shaderId ?? effect.params.shaderId, "Shader ID");
      if (getMotionShaderDef(id)?.category !== "effect") invalid("Choose a built-in effect shader.");
    }
  }
  if (name === "add_audio_automation") {
    let previousTime = -1;
    const points = args.points as unknown[];
    if (!points.length) invalid("Supply at least one automation point.");
    args.points = points.map(value => {
      const point = object(value, "Automation point");
      const time = numeric(point.time, "Time", 0, clip?.duration ?? 0);
      if (time <= previousTime) invalid("Automation points must have increasing times.");
      previousTime = time;
      return { time, value: numeric(point.value, "Volume", 0, 4) };
    });
  }
  if (name === "set_effect_order" && clip) {
    const ids = args.effectIds as string[];
    if (ids.length !== clip.effects.length || new Set(ids).size !== ids.length ||
      ids.some(id => !clip.effects.some(effect => effect.id === id))) invalid("Supply every effect ID on the clip exactly once.");
  }
  if (name === "add_marker") {
    numeric(args.time, "Marker time", 0, project.timeline.duration);
    boundedText(args.label, "Marker label");
    boundedText(args.color, "Marker color", 48);
  }
  if (name === "update_marker") {
    if (!project.timeline.markers.some(marker => marker.id === args.markerId)) invalid("Marker not found in this draft.");
    const update = object(args.updates, "Marker update");
    for (const [key, value] of Object.entries(update)) {
      if (key === "time") numeric(value, "Marker time", 0, project.timeline.duration);
      else if (key === "label" || key === "color") boundedText(value, key);
      else invalid("Unsupported marker update field.");
    }
  }
  if (name === "set_clip_reverse" && clip && project.textClips?.some(title => title.metadata?.captionSourceClipId === clip.id &&
      title.metadata.captionSource === "openreel-transcription")) invalid("Update the automatic captions before reversing their source.");
  return clip;
}

function checkAudioParameters(type: unknown, value: unknown): Arguments {
  const params = object(value ?? {}, "Audio effect parameters");
  const ranges: Record<string, [number, number]> | undefined = type === "gain" ? { value: [0, 4] }
    : type === "compressor" ? { threshold: [-60, 0], ratio: [1, 20], attack: [0.001, 1], release: [0.01, 3], knee: [0, 40] }
      : undefined;
  if (!ranges) invalid("This editor endpoint supports the native gain and compressor effects.");
  for (const [key, item] of Object.entries(params)) {
    const range = ranges[key];
    if (!range) invalid("Unsupported audio effect parameter.");
    numeric(item, key, range[0], range[1]);
  }
  return params;
}

async function callPinnedTool(host: HeadlessHost, name: string, args: Arguments) {
  const result = await executeTool(name, args, host);
  if (!result.ok) throw failure(result.error?.code ?? "INVALID_EDIT", result.error?.message ?? result.summary);
  return result.data ?? { summary: result.summary };
}

export async function readOpenReelTool(project: Project | null, name: string, args: Arguments, signal?: AbortSignal) {
  signal?.throwIfAborted();
  checked(name, args, true);
  if (name === "list_filter_presets") return listFilterPresets();
  if (name === "list_timeline_templates") {
    return { templates: BUILTIN_TEMPLATES.map(({ id, name, category, description }) => ({ id, name, category, description })) };
  }
  if (name === "preview_ripple_delete") {
    if (!project) invalid("Import local media before previewing a cut.");
    return rippleDelete(new HeadlessHost(project), args);
  }
  if (name === "preview_delete_objects") {
    if (!project) invalid("Open a saved draft before previewing object deletion.");
    return planObjectDeletion(project, args.objects).preview;
  }
  if (name === "export_srt") {
    if (!project) invalid("Add editable captions before exporting SRT.");
    return exportCaptions(project);
  }
  if (name === "preview_timeline_template") {
    const template = BUILTIN_TEMPLATES.find(item => item.id === args.templateId);
    if (!template) invalid("Choose a built-in OpenReel timeline template.");
    const preview = applyPiProjectTemplate(new TemplateEngine(), template, blankProject({}));
    return {
      id: template.id, name: template.name, description: template.description,
      duration: preview.timeline.duration, tracks: preview.timeline.tracks.map(({ name, type }) => ({ name, type })),
      titles: preview.textClips?.map(({ text, startTime, duration }) => ({ text, startTime, duration })) ?? [],
      confirmationRequired: hasTimelineContents(project),
      replacedDuration: project?.timeline.duration ?? 0,
    };
  }
  if (name === "list_projects") {
    return { projects: project ? [{ id: project.id, name: project.name, modifiedAt: project.modifiedAt }] : [] };
  }
  if (!project && name !== "get_capabilities") invalid("Import local media before reading the timeline.");
  return callPinnedTool(new HeadlessHost(project), name, args);
}

function blankProject(args: Arguments): Project {
  const width = numeric(args.width ?? 1920, "Width", 2, 8192);
  const height = numeric(args.height ?? 1080, "Height", 2, 8192);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) invalid("Frame size must be an integer.");
  const now = Date.now();
  return {
    id: randomUUID(), name: boundedText(args.name ?? "会话视频", "Project name"),
    createdAt: now, modifiedAt: now,
    settings: { width, height, frameRate: numeric(args.frameRate ?? 30, "Frame rate", 1, 120), sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] }, timeline: { tracks: [], duration: 0, subtitles: [], markers: [] },
  };
}

const hasTimelineContents = (project: Project | null) => Boolean(project &&
  (project.timeline.duration > 0 || project.timeline.tracks.length || project.timeline.markers.length ||
    project.mediaLibrary.items.length || project.motionCompositions?.length));

function applyTemplate(current: Project | null, templateId: unknown, replacement: string | undefined): Project {
  const template = BUILTIN_TEMPLATES.find(item => item.id === templateId);
  if (!template) invalid("Choose a built-in OpenReel timeline template.");
  if (hasTimelineContents(current) && replacement !== template.id) {
    throw failure("APPROVAL_REQUIRED", "This draft already has content. Preview the template and confirm replacement of the saved timeline.");
  }
  return applyPiProjectTemplate(new TemplateEngine(), template, current ?? blankProject({}));
}

export async function editOpenReelTools(
  saved: EditingDraft, calls: ToolCall[], signal?: AbortSignal, reader?: {
    transcribe?: Transcribe;
    importMedia?: (saved: EditingDraft, args: Arguments) => Promise<EditingDraft>;
    templateReplacement?: string;
    objectDelete?: { revision: number; approval: unknown };
  },
) {
  if (!calls.length || calls.length > 32) invalid("Provide between one and 32 OpenReel tool calls.");
  const host = new HeadlessHost(saved.project ? structuredClone(saved.project) : null);
  let hasProject = saved.project !== null;
  let mediaPaths = { ...saved.mediaPaths };
  const results: unknown[] = [];
  for (const call of calls) {
    signal?.throwIfAborted();
    const args = { ...call.arguments };
    const specification = checked(call.name, args, false);
    if (call.name === "import_media") {
      if (!reader?.importMedia) invalid("OpenReel media import is unavailable.");
      const imported = await reader.importMedia({ project: hasProject ? host.getProject() : null, mediaPaths }, args);
      if (!imported.project) invalid("The imported media did not produce a draft.");
      host.setProject(imported.project);
      mediaPaths = imported.mediaPaths;
      hasProject = true;
      continue;
    }
    if (call.name === "create_project") {
      if (hasProject) throw failure("DRAFT_EXISTS", "The current conversation already has an OpenReel draft.");
      const project = blankProject(args);
      host.setProject(project);
      hasProject = true;
      results.push({ id: project.id, name: project.name });
      continue;
    }
    if (call.name === "apply_timeline_template") {
      const replacement = calls.length === 1 ? reader?.templateReplacement : undefined;
      const project = applyTemplate(hasProject ? host.getProject() : null, args.templateId, replacement);
      mediaPaths = Object.fromEntries(project.mediaLibrary.items
        .filter(({ id }) => Object.hasOwn(mediaPaths, id))
        .map(({ id }) => [id, mediaPaths[id]]));
      host.setProject(project);
      hasProject = true;
      results.push({ templateId: args.templateId, projectId: project.id, textClips: project.textClips?.length ?? 0 });
      continue;
    }
    if (!hasProject) invalid("Import local media or create a blank draft before editing.");
    const edit = nativeEdits.get(call.name);
    if (call.name === "ripple_delete_ranges") results.push(rippleDelete(host, args));
    else if (call.name === "delete_objects") {
      const grant = reader?.objectDelete;
      if (calls.length !== 1 || !grant || !matchesObjectDeletion(grant.approval, grant.revision, args.objects)) {
        throw failure("APPROVAL_REQUIRED", "Approve the exact standalone OpenReel deletion preview.");
      }
      const deletion = planObjectDeletion(host.getProject(), args.objects);
      host.setProject(deletion.project);
      results.push(deletion.preview);
    }
    else if (call.name === "duck_music") results.push(duckMusic(host, args));
    else if (call.name === "auto_caption") {
      if (!reader?.transcribe) throw failure("UNSUPPORTED", "Local speech transcription is unavailable in this 麦浪 studio build.");
      results.push(await autoCaption(host, args, mediaPaths, reader.transcribe, signal));
    } else if (edit) results.push(await edit(host, args, signal));
    else {
      const project = host.getProject();
      const clip = checkTimelineEdit(project, call.name, args);
      if (specification.domain === "motion") checkMotionEdit(project, call.name, args);
      if (call.name === "trim_clip" && clip) {
        if (args.inPoint === undefined && args.outPoint === undefined) invalid("Provide an in or out point.");
        await trimClip(host, clip, args, signal);
        results.push({ clipId: clip.id });
      } else if (call.name === "add_video_effect" && clip) {
        const id = randomUUID();
        await apply(host, { type: "effect/add", params: { ...args, effectId: id } });
        results.push({ id, clipId: clip.id });
      } else {
        results.push(await callPinnedTool(host, call.name, args));
        if (clip && (call.name === "move_clip" || call.name === "set_clip_speed")) {
          await retimeAutoCaptions(host, clip, writableClip(host.getProject(), clip.id), signal);
        }
      }
    }
  }
  signal?.throwIfAborted();
  return { project: host.getProject(), mediaPaths, results };
}
