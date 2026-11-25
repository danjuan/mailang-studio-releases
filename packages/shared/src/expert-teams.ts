/** The shipped editing role. Its tools and view are resolved by Electron Main. */
export const OPENREEL_EXPERT_ID = "openreel-video-editor";
export const OPENREEL_EXPERT_PLUGIN_ID = "local.openreel-proof";
export const OPENREEL_EXPERT_VIEW_ID = "editor";
export const OPENREEL_EXPERT_READ_TOOL = "read_draft";
export const OPENREEL_EXPERT_WRITE_TOOL = "apply_edits";
export const OPENREEL_MEDIA_UNAVAILABLE = "OPENREEL_MEDIA_UNAVAILABLE";
export const MAX_OPENREEL_EXPERT_INSTRUCTIONS_BYTES = 32 * 1024;
export const MAX_OPENREEL_EXPERT_DESCRIPTION_CHARS = 2_000;

export type OpenReelExpertProfileText = {
  description: string;
  instructions: string;
};

export type OpenReelExpertProfile = {
  defaults: OpenReelExpertProfileText;
  override: OpenReelExpertProfileText | null;
  workflow: string;
};

export type ExpertUnavailableReason = "PLUGIN_UNAVAILABLE" | "SESSION_UNAVAILABLE";

export type ExpertRole = {
  id: string;
  name: string;
  description: string;
  customDescription?: boolean;
  kind: "openreel" | "subagent";
  available: boolean;
  unavailableReason?: ExpertUnavailableReason;
};

export type ExpertTeam = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  revision: number;
};

export type SaveExpertTeam = {
  id?: string;
  expectedRevision?: number;
  name: string;
  description: string;
  memberIds: string[];
};

export type ExpertCatalog = {
  roles: ExpertRole[];
  teams: ExpertTeam[];
};

export type ExpertSelection = {
  kind: "expert" | "team";
  id: string;
};

/** Durable queue input. Recheck the captured team and attachment workspace at dispatch. */
export type ExpertSelectionSnapshot = ExpertSelection & {
  revision?: number;
  expectedProjectPath?: string;
};

export type OpenReelMediaKind = "video" | "audio" | "image";

export const OPENREEL_IMPORT_ACTION = "import_media";
export const OPENREEL_BATCH_ACTION = "batch_actions";

export const OPENREEL_RIPPLE_ACTION = "ripple_delete_ranges";
export const OPENREEL_RIPPLE_PREVIEW = "preview_ripple_delete";
export const OPENREEL_TEMPLATE_ACTION = "apply_timeline_template";
export const OPENREEL_TEMPLATE_PREVIEW = "preview_timeline_template";
export const OPENREEL_OBJECT_DELETE_ACTION = "delete_objects";
export const OPENREEL_OBJECT_DELETE_PREVIEW = "preview_delete_objects";
export type OpenReelTemplateApproval = { templateId: string; revision: number };
export type OpenReelTimelineObject = {
  kind: "clip" | "caption" | "text" | "transition";
  id: string;
} | {
  kind: "video_effect" | "audio_effect";
  id: string;
  clipId: string;
};
export type OpenReelObjectDeleteApproval = { revision: number; objects: OpenReelTimelineObject[] };
export const OPENREEL_RIPPLE_APPROVAL_REQUIRED = "OPENREEL_RIPPLE_APPROVAL_REQUIRED";
export type OpenReelRippleRange = { start: number; end: number };

export function openReelMediaKind(path: string): OpenReelMediaKind | undefined {
  if (/\.(mp4|mov|webm|mkv)$/i.test(path)) return "video";
  if (/\.(mp3|wav)$/i.test(path)) return "audio";
  if (/\.(png|jpe?g)$/i.test(path)) return "image";
}

export function openReelProjectMediaKind(path: unknown): OpenReelMediaKind | undefined {
  if (typeof path !== "string" || path.length > 1024 || /[\\:\p{Cc}\p{Cs}]/u.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) return;
  return openReelMediaKind(path);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function openReelImportForm(value: unknown): "action" | "batch" | "edits" | undefined {
  const input = record(value);
  if (!input) return;
  if (input.action === OPENREEL_IMPORT_ACTION) return "action";
  const actions = record(input.arguments)?.actions;
  if (input.action === OPENREEL_BATCH_ACTION && Array.isArray(actions)
    && actions.some((entry) => record(entry)?.name === OPENREEL_IMPORT_ACTION)) return "batch";
  if (Array.isArray(input.edits) && input.edits.some((entry) => record(entry)?.type === "import")) return "edits";
}

function openReelEditForm(value: unknown, action: string): "action" | "batch" | undefined {
  const input = record(value);
  if (input?.action === action) return "action";
  const actions = record(input?.arguments)?.actions;
  if (input?.action === OPENREEL_BATCH_ACTION && Array.isArray(actions)
    && actions.some((entry) => record(entry)?.name === action)) return "batch";
}

export const openReelRippleEditForm = (value: unknown) => openReelEditForm(value, OPENREEL_RIPPLE_ACTION);
export const openReelTemplateEditForm = (value: unknown) => openReelEditForm(value, OPENREEL_TEMPLATE_ACTION);
export const openReelObjectDeleteForm = (value: unknown) => openReelEditForm(value, OPENREEL_OBJECT_DELETE_ACTION);
export const isOpenReelObjectDeletePreview = (value: unknown) => record(value)?.tool === OPENREEL_OBJECT_DELETE_PREVIEW;

function validObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function parseOpenReelTimelineObjects(value: unknown): OpenReelTimelineObject[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return;
  const objects: OpenReelTimelineObject[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item || !validObjectId(item.id)) return;
    const { id, kind, clipId } = item;
    if (kind === "video_effect" || kind === "audio_effect") {
      if (!validObjectId(clipId) || Object.keys(item).length !== 3) return;
      objects.push({ kind, id, clipId });
    } else {
      if ((kind !== "clip" && kind !== "caption" && kind !== "text" && kind !== "transition")
        || Object.keys(item).length !== 2) return;
      objects.push({ kind, id });
    }
  }
  if (new Set(objects.map(item => JSON.stringify(item))).size !== objects.length) return;
  return objects;
}

export function exactOpenReelObjectDeleteApproval(value: unknown, args: unknown): OpenReelObjectDeleteApproval | undefined {
  const approval = record(value);
  const request = record(args);
  const arguments_ = record(request?.arguments);
  const revision = approval?.revision;
  const objects = parseOpenReelTimelineObjects(approval?.objects);
  const requested = parseOpenReelTimelineObjects(arguments_?.objects);
  if (!approval || Object.keys(approval).length !== 2
    || request?.action !== OPENREEL_OBJECT_DELETE_ACTION || Object.keys(request).length !== 3
    || !arguments_ || Object.keys(arguments_).length !== 1
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
    || revision !== request.expectedRevision || !objects || !requested
    || JSON.stringify(requested) !== JSON.stringify(objects)) return;
  return { revision, objects };
}

export function exactOpenReelTemplateApproval(value: unknown, args: unknown): OpenReelTemplateApproval | undefined {
  const approval = record(value);
  const request = record(args);
  const templateId = approval?.templateId;
  const revision = approval?.revision;
  if (request?.action !== OPENREEL_TEMPLATE_ACTION || typeof templateId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId)
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
    || revision !== request.expectedRevision || templateId !== record(request.arguments)?.templateId) return;
  return { templateId, revision };
}

export function parseOpenReelRippleRange(value: unknown): OpenReelRippleRange | undefined {
  const entry = record(value);
  if (typeof entry?.start !== "number" || typeof entry?.end !== "number"
    || !Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.start < 0 || entry.end <= entry.start
    || Object.keys(entry).length !== 2) return;
  return { start: entry.start, end: entry.end };
}

export type OpenReelExpertTools = {
  readTool: string;
  writeTool: string;
  description: string;
  instructions: string;
  /** Host-validated media for this turn, with exact import paths and types. */
  media?: readonly { name: string; path: string; kind: OpenReelMediaKind }[];
  /** A single exact deletion spoken by the author of this turn, never an inferred model range. */
  requestedRippleRange?: OpenReelRippleRange;
};

/** Main-resolved turn authority, never accepted directly from the renderer. */
export type ExpertTurnRoute =
  | { kind: "expert"; name: string; openReel: OpenReelExpertTools }
  | { kind: "team"; name: string; description: string; members: string[]; openReel?: OpenReelExpertTools };
