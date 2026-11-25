import { isAbsolute } from "node:path";
import {
  OPENREEL_IMPORT_ACTION,
  OPENREEL_MEDIA_UNAVAILABLE,
  openReelImportForm,
  openReelMediaKind,
  type AgentPromptAttachment,
  type MessageAttachment,
} from "@pi-desktop/shared";
import {
  isOpenReelMediaAlias,
  openReelInputAttachments,
  prepareOpenReelMedia,
  stageOpenReelMedia,
} from "./openreel-media.ts";

export type OpenReelTurnInput = {
  content: string;
  attachments?: MessageAttachment[];
};

type ChatImportOptions = {
  dataDir: string;
  sessionId: string;
  projectPath: string;
  loadTurnInput(): Promise<OpenReelTurnInput | null>;
  signal: AbortSignal;
  assertCurrent(): void;
  authorizeDestination(path: string): Promise<void>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unavailable(): Error {
  return Object.assign(new Error("Use an exact media attachment from this request or a project-relative file."), {
    code: OPENREEL_MEDIA_UNAVAILABLE,
  });
}

/** Project-relative paths still go through the adapter's regular file checks. */
export function hasOpenReelChatImport(args: unknown): boolean {
  return importFields(args).some(requestsAttachment);
}

function requestsAttachment(value: unknown): value is Record<string, unknown> & { path: string } {
  const path = record(value)?.path;
  return typeof path === "string" && (isAbsolute(path) || isOpenReelMediaAlias(path));
}

function importFields(value: unknown): unknown[] {
  const input = record(value);
  switch (openReelImportForm(value)) {
    case "action": return [input?.arguments];
    case "batch": {
      const { actions } = record(input?.arguments) ?? {};
      return Array.isArray(actions) ? actions.filter(item => record(item)?.name === OPENREEL_IMPORT_ACTION)
        .map(item => record(item)?.arguments) : [];
    }
    case "edits":
      return Array.isArray(input?.edits) ? input.edits.filter(item => record(item)?.type === "import") : [];
    default: return [];
  }
}

export async function prepareOpenReelChatImport(args: unknown, options: ChatImportOptions): Promise<unknown> {
  const { dataDir, sessionId, projectPath, signal, assertCurrent } = options;
  const input = record(args);
  const fields = importFields(args).filter(requestsAttachment);
  if (!input || !fields.length) return args;
  const form = openReelImportForm(input);
  const argumentsObject = record(input.arguments);
  const entries = form === "edits" ? input.edits : argumentsObject?.actions;
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 ||
      (input.action !== undefined && input.edits !== undefined) ||
      (form !== "action" && (!Array.isArray(entries) || entries.length > 32))) {
    throw Object.assign(new Error("Read the draft revision before editing and provide up to 32 edits."), {
      code: "INVALID_ARGUMENT",
    });
  }

  const requested = fields.map(field => {
    const { path } = field;
    const kind = openReelMediaKind(path);
    const trackId = field.trackId;
    const timeValid = (time: unknown) => time === undefined
      || (typeof time === "number" && Number.isFinite(time) && time >= 0);
    const allowed = form === "edits"
      ? ["type", "path", "outPoint"]
      : ["path", "kind", "trackId", "outPoint", "startTime"];
    if (!isAbsolute(path) || path.length > 4096 || /[\p{Cc}\p{Cs}]/u.test(path) || !kind ||
        (form === "edits" && kind !== "video") || (field.kind !== undefined && field.kind !== kind) ||
        (trackId !== undefined && (typeof trackId !== "string" || !trackId.trim() || trackId.length > 128)) ||
        !timeValid(field.outPoint) || (form !== "edits" && field.outPoint === 0) || !timeValid(field.startTime) ||
        Object.keys(field).some(key => !allowed.includes(key))) {
      throw unavailable();
    }
    return { field, path };
  });
  const paths = [...new Set(requested.map(({ path }) => path))];
  const check = () => {
    signal.throwIfAborted();
    assertCurrent();
  };
  check();
  const turn = await options.loadTurnInput();
  check();
  if (!turn) throw unavailable();

  // Inline scratch copies and genuine file-picker references are admitted only
  // from the user row for this durable turn. Tool arguments carry no grant.
  const attachments: AgentPromptAttachment[] = (turn.attachments ?? []).flatMap(attachment => {
    if (attachment.lineRange || (attachment.kind !== "image" && attachment.kind !== "file") ||
        !paths.includes(attachment.ref)) return [];
    return [{
      path: attachment.ref, kind: attachment.kind, name: attachment.name,
      ...(attachment.localReference ? { localReference: attachment.localReference } : {}),
    }];
  });
  const candidates = openReelInputAttachments(dataDir, sessionId, turn.content, attachments);
  const selection = paths.map(path => candidates.find(candidate => candidate.path === path));
  if (selection.some(candidate => !candidate)) throw unavailable();
  const sources = await prepareOpenReelMedia({
    dataDir, sessionId, projectPath,
    attachments: selection.filter((candidate): candidate is AgentPromptAttachment => candidate !== undefined),
  });
  check();
  if (sources.length !== selection.length || sources.some(source =>
    source.importPath.toLowerCase().startsWith("video-edits/") &&
    !source.importPath.startsWith(`video-edits/${sessionId}/`),
  )) throw unavailable();

  const staged = new Map<string, string>();
  for (const [index, source] of sources.entries()) {
    const path = await stageOpenReelMedia(source, { ...options, assertCurrent: check });
    check();
    staged.set(paths[index], path);
  }
  const replacements = new Map<unknown, string | undefined>(requested.map(({ field, path }) => [field, staged.get(path)]));
  const rewrite = (value: unknown) => {
    const path = replacements.get(value);
    return path ? { ...record(value), path } : value;
  };
  if (form === "action") return { ...input, arguments: rewrite(input.arguments) };
  if (!Array.isArray(entries)) throw unavailable();
  if (form === "edits") return { ...input, edits: entries.map(rewrite) };
  return { ...input, arguments: { ...argumentsObject, actions: entries.map(item => {
    const entry = record(item);
    return entry?.name === OPENREEL_IMPORT_ACTION ? { ...entry, arguments: rewrite(entry.arguments) } : item;
  }) } };
}
