import { isAbsolute } from "node:path";
import { openReelMediaKind, type OpenReelMediaKind } from "@pi-desktop/shared";
import { referenceComposerFiles } from "./composer-file-references.ts";
import { prepareOpenReelMedia, stageOpenReelMedia, type OpenReelMediaSource } from "./openreel-media.ts";

type PanelImport = {
  dataDir: string;
  sessionId: string;
  projectPath: string;
  pick(): Promise<string[]>;
  signal: AbortSignal;
  assertCurrent(): void;
  assertSourceAllowed?(path: string): void;
  replacementKind?: OpenReelMediaKind;
  authorizeDestination(path: string): Promise<void>;
  describe(path: string, kind: OpenReelMediaSource["kind"]): Promise<{ metadata: unknown; url?: string }>;
};

export type OpenReelPanelSelection = {
  sessionId: string;
  projectPath: string | null;
  signal: AbortSignal;
};

type Replacement = { expectedRevision: number; mediaId: string };

export function readOpenReelPanelReplacement(input: Record<string, unknown> | undefined): Replacement | undefined {
  const { mode, expectedRevision, mediaId } = input ?? {};
  if (mode === undefined && expectedRevision === undefined && mediaId === undefined) return;
  if (mode !== "replace" || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || typeof mediaId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
    throw importError("INVALID_ARGUMENT", "Select the original OpenReel media and saved draft revision before replacing it.");
  }
  return { expectedRevision, mediaId };
}

export function openReelPanelReplacementKind(draft: unknown, replacement: Replacement): OpenReelMediaKind {
  const value = draft as { revision?: unknown; project?: { mediaLibrary?: { items?: unknown } } } | null;
  if (value?.revision !== replacement.expectedRevision) {
    throw importError("REVISION_CONFLICT", "The OpenReel draft changed before media replacement.");
  }
  const items = value.project?.mediaLibrary?.items;
  const item = Array.isArray(items) ? items.find(item => item?.id === replacement.mediaId) : undefined;
  if (item?.type === "video" || item?.type === "audio" || item?.type === "image") return item.type;
  throw importError("NOT_FOUND", "The original media is no longer in the saved draft.");
}

const DROP_TTL_MS = 30_000;
const MAX_PANEL_FILES = 20;

function importError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function nativePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PANEL_FILES) return;
  const paths: string[] = [];
  for (const path of value) {
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || path.includes("\0") || paths.includes(path)) return;
    paths.push(path);
  }
  return paths;
}

/** One genuine drop batch per live OpenReel document. Never persist authority. */
export class OpenReelPanelDrops {
  private readonly now: () => number;
  private readonly pending = new WeakMap<object, {
    paths: string[];
    selection: OpenReelPanelSelection;
    document: AbortSignal;
    expiresAt: number;
  }>();

  constructor(now = Date.now) {
    this.now = now;
  }

  record(sender: object, rawPaths: unknown, selection: OpenReelPanelSelection | null, document: AbortSignal): void {
    this.pending.delete(sender);
    const paths = nativePaths(rawPaths);
    if (!paths || !selection?.projectPath || selection.signal.aborted || document.aborted) return;
    this.pending.set(sender, { paths, selection, document, expiresAt: this.now() + DROP_TTL_MS });
  }

  consume(sender: object, rawPaths: unknown, sessionId: unknown, projectPath: unknown): string[] {
    const batch = this.pending.get(sender);
    const invalid = () => importError("PERMISSION_DENIED", "Drop the files into this OpenReel editor again.");
    if (!batch) throw invalid();
    if (batch.expiresAt <= this.now() || batch.selection.signal.aborted || batch.document.aborted) {
      this.pending.delete(sender);
      throw invalid();
    }
    if (batch.selection.sessionId !== sessionId || batch.selection.projectPath !== projectPath) {
      throw importError("WORKSPACE_CHANGED", "The OpenReel editor's session or project changed.");
    }
    const paths = nativePaths(rawPaths);
    if (!paths || paths.length !== batch.paths.length || !paths.every((path, index) => path === batch.paths[index])) throw invalid();
    this.pending.delete(sender);
    return batch.paths;
  }
}

/** Only authenticated drops and the native picker supply paths. */
export async function importOpenReelPanelMedia(options: PanelImport) {
  const { dataDir, sessionId, projectPath, signal, authorizeDestination } = options;
  const assertCurrent = () => {
    signal.throwIfAborted();
    options.assertCurrent();
  };
  assertCurrent();
  const paths = await options.pick();
  assertCurrent();
  if (!paths.length) return { files: [] };
  if (!nativePaths(paths)) throw importError("INVALID_ARGUMENT", "Choose up to 20 distinct local media files.");
  if (options.replacementKind && (paths.length !== 1 || openReelMediaKind(paths[0]) !== options.replacementKind)) {
    throw importError("INVALID_MEDIA", "Choose one file with the same media kind as the original.");
  }
  for (const path of paths) options.assertSourceAllowed?.(path);
  const attachments = await referenceComposerFiles(dataDir, sessionId, projectPath, paths);
  assertCurrent();
  const sources = await prepareOpenReelMedia({ dataDir, sessionId, projectPath, attachments });
  if (sources.length !== paths.length) throw importError("INVALID_MEDIA", "Choose supported OpenReel media files.");
  for (const source of sources) {
    options.assertSourceAllowed?.(source.sourcePath);
    if (source.importPath.toLowerCase().startsWith("video-edits/") &&
        !source.importPath.startsWith(`video-edits/${sessionId}/`)) {
      throw importError("PERMISSION_DENIED", "The selected media belongs to a different OpenReel draft.");
    }
  }
  if (options.replacementKind && sources[0]?.kind !== options.replacementKind) {
    throw importError("INVALID_MEDIA", "Choose one file with the same media kind as the original.");
  }
  const files = [];
  for (const source of sources) {
    assertCurrent();
    const path = await stageOpenReelMedia(source, { signal, assertCurrent, authorizeDestination });
    const details = await options.describe(path, source.kind);
    assertCurrent();
    files.push({ path, name: source.name, kind: source.kind, ...details });
  }
  return { files };
}
