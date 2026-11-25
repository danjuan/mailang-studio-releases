import type { ActionResult, MediaItem, Project } from "@openreel/core";
import type { PiAnalysisTarget } from "./pi-analysis";
import { OPENREEL_DRAFT_VERSION, OPENREEL_MEDIA_LIMIT, mediaFormat, validateDraft, type DraftRecord } from "@openreel/core/pi-draft-format.mjs";

export type { DraftRecord };

export interface PiContext { sessionId: string; projectPath: string }
export interface PiBridge {
  invoke(channel: string, payload?: Record<string, unknown>): Promise<unknown>;
  invokeOpenReel?(channel: string, payload?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
  getDroppedFilePath?(file: File): string | null;
}
export interface DraftState {
  context: PiContext | null;
  revision: number;
  dirty: boolean;
  busy: boolean;
  ready: boolean;
  error: string | null;
  errorCode?: string;
  retained: number;
  newerRevision: number | null;
  separationJobId?: string;
}
function draftFailure(error: unknown): { error: string; errorCode?: string } {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return { error: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" ? { errorCode: code } : {}) };
}

export interface DraftEditor {
  getProject(): Project;
  createProject(name: string): void;
  loadProject(project: Project): void;
  addMedia(items: readonly MediaItem[]): void;
  replaceMedia(item: MediaItem): void;
  syncTimeline(duration: number, switched: boolean): void;
  prepare(): Promise<void>;
  restoreMedia(project: Project, blobs: ReadonlyMap<string, Blob>, reused: ReadonlyMap<string, MediaItem>): Promise<Project>;
  subscribe(listener: () => void): () => void;
}
interface PendingDraft extends DraftRecord { project: Project }

export function parseContext(value: unknown): PiContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" && record.sessionId.length > 0 &&
    typeof record.projectPath === "string" && record.projectPath.length > 0
    ? { sessionId: record.sessionId, projectPath: record.projectPath } : null;
}

export function serializeDraft(project: Project): Project {
  return JSON.parse(JSON.stringify(project, (key: string, value: unknown) => {
    if (key === "blob" || key === "fileHandle") return null;
    if (key === "openReelMediaUrl") return undefined;
    if (key === "waveformData" || key === "thumbnailUrl") return null;
    if (key === "filmstripThumbnails") return undefined;
    if (typeof Blob !== "undefined" && value instanceof Blob) return undefined;
    return value;
  })) as Project;
}

function retainProject(project: Project): Project {
  const plain = serializeDraft(project);
  return { ...plain, mediaLibrary: { ...plain.mediaLibrary, items: plain.mediaLibrary.items.map((item) => {
    const original = project.mediaLibrary.items.find((candidate) => candidate.id === item.id);
    return { ...item, blob: original?.blob ?? null, thumbnailUrl: original?.thumbnailUrl ?? null };
  }) } };
}

function key(context: PiContext): string { return JSON.stringify([context.projectPath, context.sessionId]); }
export const sameContext = (a: PiContext | null, b: PiContext | null) => a !== null && b !== null && key(a) === key(b);
const fingerprint = (project: Project) => JSON.stringify(serializeDraft(project));
const READ_SIZE = 1024 * 1024;
const MAX_MEDIA_SIZE = OPENREEL_MEDIA_LIMIT;
interface MediaStat { size: number; mtimeMs: number }
const sourceStats = new WeakMap<File, MediaStat>();
const panelVideoUrl = /^openreel-media:\/\/asset\/[a-z0-9_-]+$/i;

function pickedMedia(value: unknown): { path: string; item: MediaItem } {
  if (!value || typeof value !== "object") throw new Error("Invalid OpenReel media selection");
  const { path, name, kind, metadata, url } = value as Record<string, unknown>;
  const format = typeof path === "string" && mediaFormat(path);
  if (typeof path !== "string" || !format || kind !== format.kind || typeof name !== "string" || !name.trim() ||
      !metadata || typeof metadata !== "object" ||
      (kind === "video" && (typeof url !== "string" || !panelVideoUrl.test(url)))) {
    throw new Error("Invalid OpenReel media selection");
  }
  const fields = metadata as Record<string, unknown>;
  const { duration, width, height, frameRate, sampleRate, channels, fileSize, codec, hasVideo, hasAudio, audioTrackCount } = fields;
  const valid = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number >= 0;
  if (!valid(duration) || (format.kind !== "image" && duration === 0) || !valid(width) || !valid(height) ||
      !valid(frameRate) || !valid(sampleRate) || !valid(channels) || !valid(fileSize) || fileSize === 0 ||
      typeof codec !== "string") throw new Error("Invalid OpenReel media selection");
  return { path, item: {
    id: crypto.randomUUID(), name, type: format.kind, fileHandle: null, blob: null,
    thumbnailUrl: null, waveformData: null, isPlaceholder: false,
    ...(format.kind === "video" && typeof url === "string" ? { openReelMediaUrl: url } : {}),
    metadata: { duration, width, height, frameRate, sampleRate, channels, fileSize, codec,
      ...(typeof hasVideo === "boolean" ? { hasVideo } : {}),
      ...(typeof hasAudio === "boolean" ? { hasAudio } : {}),
      ...(valid(audioTrackCount) ? { audioTrackCount } : {}),
    },
  } };
}

function pickedFiles(reply: unknown): ReturnType<typeof pickedMedia>[] {
  if (!reply || typeof reply !== "object" || !("files" in reply) || !Array.isArray(reply.files)) {
    throw new Error("Invalid OpenReel media selection");
  }
  return reply.files.map(pickedMedia);
}

export async function openProjectVideo(
  bridge: PiBridge, context: PiContext, path: string, current: () => boolean,
): Promise<MediaStat & { url: string }> {
  if (mediaFormat(path)?.kind !== "video") throw new Error("Choose a project-relative video path");
  if (!current()) throw new Error("Session changed during media loading");
  const source = await bridge.invoke("openreel.media.source", { ...context, path });
  if (!current()) throw new Error("Session changed during media loading");
  if (!source || typeof source !== "object") throw new Error("Invalid OpenReel video source");
  const { url, size, mtimeMs } = source as Record<string, unknown>;
  if (typeof url !== "string" || !panelVideoUrl.test(url) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 ||
      typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
    throw new Error("Invalid OpenReel video source");
  }
  return { url, size, mtimeMs };
}

async function readMediaStat(bridge: PiBridge, context: PiContext, path: string): Promise<MediaStat> {
  const stat = await bridge.invoke("openreel.media.stat", { ...context, path });
  if (!stat || typeof stat !== "object") throw new Error("Invalid media stat response");
  const { size, mtimeMs } = stat as { size: unknown; mtimeMs: unknown };
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_SIZE ||
      typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
    throw new Error("Media must be between 1 byte and 256 MiB");
  }
  return { size, mtimeMs };
}

export async function readProjectMedia(
  bridge: PiBridge, context: PiContext, path: string, current: () => boolean,
): Promise<File> {
  const format = mediaFormat(path);
  if (!format || format.kind === "video") throw new Error("Use a project-relative audio or image path");
  const { size, mtimeMs } = await readMediaStat(bridge, context, path);
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < size;) {
    if (!current()) throw new Error("Session changed during media loading");
    const length = Math.min(READ_SIZE, size - offset);
    const reply = await bridge.invoke("openreel.media.read", { ...context, path, offset, length });
    if (!reply || typeof reply !== "object") throw new Error("Invalid media read response");
    const { bytes, totalSize } = reply as { bytes: unknown; totalSize: unknown };
    const data = bytes instanceof Uint8Array ? bytes : Array.isArray(bytes) &&
      bytes.every((byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)
      ? Uint8Array.from(bytes) : null;
    if (totalSize !== size || !data || data.byteLength !== length) throw new Error("Media changed or read was incomplete");
    chunks.push(new Uint8Array(data).buffer);
    offset += data.byteLength;
  }
  const after = await readMediaStat(bridge, context, path);
  if (!current() || after.size !== size || after.mtimeMs !== mtimeMs) {
    throw new Error("Media changed during loading");
  }
  const file = new File(chunks, path.split("/").at(-1)!, { type: format.mime, lastModified: mtimeMs });
  // File.lastModified truncates the filesystem's fractional milliseconds.
  sourceStats.set(file, { size, mtimeMs });
  return file;
}

export class PiDraftController {
  private state: DraftState = { context: null, revision: 0, dirty: false, busy: false, ready: false, error: null, retained: 0, newerRevision: null };
  private pending = new Map<string, PendingDraft>();
  private paths: Record<string, string> = {};
  private baseline = "";
  private editorContext: PiContext | null = null;
  private generation = 0;
  private disposed = false;
  private applying = false;
  private audioSeparation: { scope: PiContext & { jobId: string }; cancelled: boolean } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;

  constructor(private bridge: PiBridge, private editor: DraftEditor) {
    this.unsubscribe = editor.subscribe(() => {
      if (this.applying || !this.state.ready) return;
      const { context, dirty: wasDirty, newerRevision } = this.state;
      const dirty = fingerprint(editor.getProject()) !== this.baseline;
      this.publish({ dirty });
      if (context && wasDirty && !dirty && newerRevision !== null) void this.refresh(context);
    });
  }
  getState = (): DraftState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  captureTarget(): ((apply: () => void) => Promise<boolean>) | null {
    const { context, revision, ready, busy, newerRevision } = this.state;
    if (!context || !ready || busy || this.disposed) return null;

    const generation = this.generation;
    const project = fingerprint(this.editor.getProject());
    const current = () => !this.disposed && this.generation === generation &&
      this.state.ready && !this.state.busy && sameContext(this.state.context, context) &&
      this.state.revision === revision && this.state.newerRevision === newerRevision &&
      fingerprint(this.editor.getProject()) === project;

    return async (apply) => {
      if (!current()) return false;
      const [active, newer] = await Promise.all([
        this.bridge.invoke("session.getActive"),
        this.bridge.invoke("openreel.draft.load", { ...context, newerThan: revision }),
      ]);
      if (!current() || !sameContext(parseContext(active), context) || newer !== null) return false;
      apply();
      return true;
    };
  }
  captureAnalysisTarget(): PiAnalysisTarget | null {
    const { context, revision } = this.state;
    const generation = this.generation;
    if (!context || revision < 1) return null;
    const isCurrent = () => !this.disposed && generation === this.generation &&
      sameContext(context, this.state.context) && this.state.revision === revision &&
      this.state.ready && !this.state.busy && !this.state.dirty && this.state.newerRevision === null;
    return isCurrent() ? { context, revision, bridge: this.bridge, isCurrent, refresh: () => this.refresh(context) } : null;
  }
  async separateAudio(clipId: string): Promise<void> {
    const target = this.captureAnalysisTarget();
    if (!target) {
      this.publish({ error: "Save the current draft before separating audio." });
      return;
    }
    if (this.audioSeparation && sameContext(target.context, this.audioSeparation.scope)) return;

    const generation = this.generation;
    const scope = { ...target.context, jobId: crypto.randomUUID() };
    const job = { scope, cancelled: false };
    this.audioSeparation = job;
    this.publish({ error: null, separationJobId: scope.jobId });
    try {
      const result = await this.bridge.invoke("openreel.audio.separate", {
        ...scope, expectedRevision: target.revision, clipId,
      });
      if (!result || typeof result !== "object" || !("revision" in result) || result.revision !== target.revision + 1) {
        throw new Error("Invalid OpenReel audio separation result.");
      }
      await this.refresh(target.context, result.revision);
    } catch (error) {
      if (!job.cancelled && this.generation === generation && sameContext(this.state.context, target.context)) {
        this.publish(draftFailure(error));
      }
    } finally {
      if (this.audioSeparation === job) {
        this.audioSeparation = null;
        this.publish({ separationJobId: undefined });
      }
    }
  }
  async cancelAudioSeparation(jobId: string): Promise<void> {
    const job = this.audioSeparation;
    if (!job || job.scope.jobId !== jobId || job.cancelled) return;
    job.cancelled = true;
    try {
      await this.bridge.invoke("openreel.analysis.cancel", { ...job.scope });
    } catch (error) {
      job.cancelled = false;
      if (this.audioSeparation === job && sameContext(this.state.context, job.scope)) {
        this.publish(draftFailure(error));
      }
    }
  }
  private publish(next: Partial<DraftState>): void {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      ...(Object.hasOwn(next, "error") ? { errorCode: undefined } : {}),
      ...next,
      retained: this.pending.size,
    };
    this.listeners.forEach((listener) => listener());
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }
  private runDraftOperation(operation: () => Promise<void>): Promise<void> {
    return this.enqueue(operation).catch((error: unknown) => {
      this.publish({ busy: false, ...draftFailure(error) });
    });
  }
  private retain(): void {
    if (this.state.context && this.state.ready && this.state.dirty) this.pending.set(key(this.state.context), {
      formatVersion: OPENREEL_DRAFT_VERSION, revision: this.state.revision, project: retainProject(this.editor.getProject()), mediaPaths: { ...this.paths },
    });
  }
  private async prepareProject(
    record: DraftRecord, context: PiContext, current: () => boolean, reuseLoadedMedia = false,
  ): Promise<Project | null> {
    await this.editor.prepare();
    if (!record.project || !current()) return record.project;
    const active = reuseLoadedMedia && sameContext(context, this.editorContext) ? this.editor.getProject() : null;
    const previousItems = new Map(active?.id === record.project.id
      ? active.mediaLibrary.items.map((item) => [item.id, item])
      : []);
    const blobs = new Map<string, Blob>();
    const reused = new Map<string, MediaItem>();
    for (const item of record.project.mediaLibrary.items) {
      if (!current()) return null;
      const path = record.mediaPaths[item.id];
      if (!path) continue;
      const previous = previousItems.get(item.id);
      if (item.type === "video") {
        const source = await openProjectVideo(this.bridge, context, path, current);
        reused.set(item.id, { ...item, blob: null, fileHandle: null, openReelMediaUrl: source.url,
          ...(previous?.openReelMediaUrl === source.url ? {
            thumbnailUrl: previous.thumbnailUrl, filmstripThumbnails: previous.filmstripThumbnails,
          } : {}), isPlaceholder: false });
        continue;
      }
      if (previous?.type === item.type && path === this.paths[item.id] && previous.blob instanceof File) {
        const previousStat = sourceStats.get(previous.blob);
        if (previousStat) {
          const stat = await readMediaStat(this.bridge, context, path);
          if (!current()) return null;
          if (stat.size === previousStat.size && stat.mtimeMs === previousStat.mtimeMs) {
            reused.set(item.id, previous);
            continue;
          }
        }
      }
      blobs.set(item.id, await readProjectMedia(this.bridge, context, path, current));
    }
    if (!current()) return null;
    return this.editor.restoreMedia(record.project, blobs, reused);
  }
  private applyProject(context: PiContext, record: DraftRecord, project: Project | null, retained = false): void {
    this.applying = true;
    try {
      if (project) this.editor.loadProject(project);
      else this.editor.createProject("会话视频");
      this.editor.syncTimeline(project?.timeline.duration ?? 0, !sameContext(context, this.editorContext));
      this.editorContext = context;
      this.paths = { ...record.mediaPaths };
      this.baseline = retained ? "" : fingerprint(this.editor.getProject());
      this.publish({ revision: record.revision, ready: true, dirty: retained, busy: false, newerRevision: null, error: null });
    } finally {
      this.applying = false;
    }
  }
  async refreshCommitted(context: PiContext | null, payload: unknown): Promise<void> {
    if (!context || !payload || typeof payload !== "object" ||
        !("sessionId" in payload) || payload.sessionId !== context.sessionId ||
        !("revision" in payload) || typeof payload.revision !== "number" ||
        !Number.isSafeInteger(payload.revision) || payload.revision < 1) return;
    await this.refresh(context, payload.revision);
  }
  refresh(context: PiContext, committedRevision?: number): Promise<void> {
    const token = this.generation;
    const current = () => !this.disposed && token === this.generation &&
      this.state.ready && sameContext(context, this.state.context);
    return this.runDraftOperation(async () => {
      if (!current()) return;
      const { dirty, revision, newerRevision } = this.state;
      const knownRevision = dirty ? newerRevision ?? revision : revision;
      if (committedRevision !== undefined && committedRevision <= knownRevision) return;
      try {
        const response = await this.bridge.invoke("openreel.draft.load", {
          ...context, newerThan: knownRevision,
        });
        if (!current() || response === null) return;
        const record = validateDraft(response, true);
        if (record.revision <= this.state.revision) return;
        // Keep the editor available while preparing the newer draft. Recheck
        // after loading media, since a manual edit may have started meanwhile.
        const project = this.state.dirty ? null : await this.prepareProject(record, context, current, true);
        if (!current()) return;
        if (this.state.dirty) {
          this.publish({ newerRevision: record.revision });
        } else if (project || record.project === null) {
          this.applyProject(context, record, project);
        }
      } catch (error) {
        if (current()) throw error;
      }
    });
  }
  activate(context: PiContext | null, discard = false, force = false): Promise<void> {
    const token = ++this.generation;
    return this.runDraftOperation(async () => {
      if (this.disposed || token !== this.generation) return;
      if (sameContext(context, this.state.context) && this.state.dirty && !discard) return;
      let fetched: DraftRecord | undefined;
      if (context && sameContext(context, this.state.context) && this.state.ready && !force && !discard) {
        fetched = validateDraft(await this.bridge.invoke("openreel.draft.load", { ...context }), true);
        if (this.disposed || token !== this.generation || this.state.dirty) return;
        if (fetched.revision === this.state.revision) return;
      }
      if (!discard) this.retain();
      else if (this.state.context) this.pending.delete(key(this.state.context));
      this.publish({ context, ready: false, busy: context !== null, error: null, dirty: false, newerRevision: null });
      if (!context) { this.publish({ busy: false }); return; }
      const pending = this.pending.get(key(context));
      const record = pending ?? fetched ?? validateDraft(await this.bridge.invoke("openreel.draft.load", { ...context }), true);
      if (token !== this.generation || this.disposed) return;
      const current = () => token === this.generation && !this.disposed;
      const project = await this.prepareProject(record, context, current);
      if (!current()) return;
      this.applyProject(context, record, project, Boolean(pending));
    });
  }
  reload(discard = false): Promise<void> { return this.activate(this.state.context, discard, true); }
  save(): Promise<void> {
    const context = this.state.context ? { ...this.state.context } : null;
    const token = this.generation;
    return this.runDraftOperation(async () => {
      if (!context || !this.state.ready) throw new Error("Select a local project session first");
      if (this.disposed || token !== this.generation || !sameContext(context, this.state.context)) {
        throw new Error("The selected 麦浪 studio conversation changed");
      }
      const project = serializeDraft(this.editor.getProject());
      if (project.mediaLibrary.items.some((item) => !this.paths[item.id])) {
        throw new Error("Import each media source from the current 麦浪 studio project before saving");
      }
      const mediaPaths = Object.fromEntries(project.mediaLibrary.items.map((item) => [item.id, this.paths[item.id]]));
      const sent = fingerprint(project);
      this.publish({ busy: true, error: null });
      const record = validateDraft(await this.bridge.invoke("openreel.draft.save", {
        ...context, expectedRevision: this.state.revision, project, mediaPaths,
      }));
      if (this.disposed || !sameContext(context, this.state.context)) return;
      this.baseline = sent;
      this.paths = { ...record.mediaPaths };
      this.pending.delete(key(context));
      this.publish({ revision: record.revision, dirty: fingerprint(this.editor.getProject()) !== sent, busy: false, newerRevision: null });
    });
  }
  async pickFiles(): Promise<void> {
    await this.importMediaSelection("openreel.media.pick");
  }

  dropFiles(files: readonly File[]): Promise<MediaItem[]> {
    if (!files.length) return Promise.resolve([]);
    const paths = files.map(file => this.bridge.getDroppedFilePath?.(file));
    if (paths.some(path => !path)) {
      this.publish({ error: "Only files dropped from your computer can be imported." });
      return Promise.resolve([]);
    }
    return this.importMediaSelection("openreel.media.drop", { paths });
  }

  private importMediaSelection(
    channel: "openreel.media.pick" | "openreel.media.drop",
    request: Record<string, unknown> = {},
  ): Promise<MediaItem[]> {
    const { context } = this.state;
    const token = this.generation;
    const current = () => !this.disposed && token === this.generation && sameContext(context, this.state.context);
    return this.enqueue(async () => {
      if (!context || !this.state.ready) throw new Error("Select a local project session first");
      if (!current()) throw new Error("The selected 麦浪 studio conversation changed");
      this.publish({ busy: true, error: null });
      const reply = await this.bridge.invoke(channel, { ...context, ...request });
      if (!current()) { this.publish({ busy: false }); return []; }
      const sources = pickedFiles(reply);
      const items: MediaItem[] = await Promise.all(sources.map(async ({ item, path }) => {
        if (item.type === "video") return item;
        const blob = await readProjectMedia(this.bridge, context, path, current);
        return { ...item, blob };
      }));
      if (!current()) { this.publish({ busy: false }); return []; }
      if (items.length > 0) {
        this.paths = { ...this.paths, ...Object.fromEntries(sources.map(({ item, path }) => [item.id, path])) };
        this.editor.addMedia(items.map(item => item.type === "image" && item.blob
          ? { ...item, thumbnailUrl: URL.createObjectURL(item.blob) } : item));
      }
      this.publish({ busy: false });
      return items;
    }).catch((error: unknown) => {
      if (current()) this.publish({ busy: false, ...draftFailure(error) });
      return [];
    });
  }

  replaceMedia(mediaId: string): Promise<void> {
    const { context, revision } = this.state;
    const token = this.generation;
    const originalPath = this.paths[mediaId];
    const current = () => !this.disposed && token === this.generation && sameContext(context, this.state.context);
    const replacementConflict = () => Object.assign(new Error("The saved draft changed while replacing media."), { code: "REVISION_CONFLICT" });

    return this.runDraftOperation(async () => {
      if (!context || !this.state.ready) throw new Error("Select a local project session first");
      if (!current()) throw new Error("The selected 麦浪 studio conversation changed");
      if (this.state.revision !== revision || this.state.newerRevision !== null ||
          this.paths[mediaId] !== originalPath) throw replacementConflict();
      if (revision < 1) throw new Error("Save the draft before replacing this media.");
      if (!originalPath || !this.editor.getProject().mediaLibrary.items.some(item => item.id === mediaId && item.type === "video")) {
        throw new Error("Choose a video in this draft to replace.");
      }

      this.publish({ busy: true, error: null });
      try {
        const reply = await this.bridge.invoke("openreel.media.pick", { ...context, mode: "replace", expectedRevision: revision, mediaId });
        if (!current()) return;
        const sources = pickedFiles(reply);
        if (!sources.length) return;
        const replacement = sources[0];
        if (sources.length !== 1 || replacement.item.type !== "video" || replacement.item.metadata.hasVideo === false) {
          throw new Error("Choose one replacement video.");
        }
        const saved = await this.bridge.invoke("openreel.draft.load", { ...context, newerThan: revision });
        if (!current()) return;
        if (saved !== null || this.paths[mediaId] !== originalPath) throw replacementConflict();
        const project = this.editor.getProject();
        if (!project.mediaLibrary.items.some(item => item.id === mediaId && item.type === "video")) {
          throw new Error("Choose a video in this draft to replace.");
        }
        if (project.timeline.tracks.some(track => track.clips.some(clip =>
          clip.mediaId === mediaId && clip.outPoint > replacement.item.metadata.duration + 0.001))) {
          throw new Error("The replacement video is too short for the existing timeline clips.");
        }

        this.editor.replaceMedia({ ...replacement.item, id: mediaId });
        this.paths = { ...this.paths, [mediaId]: replacement.path };
        this.publish({ dirty: true });
      } finally {
        this.publish({ busy: false });
      }
    });
  }

  importFile(selected: File, performImport: (file: File) => Promise<ActionResult>): Promise<ActionResult> {
    const context = this.state.context;
    const token = this.generation;
    const current = () => !this.disposed && token === this.generation && sameContext(context, this.state.context);
    return this.enqueue<ActionResult>(async () => {
      if (!context || !this.state.ready) throw new Error("Select a local project session first");
      if (!current()) throw new Error("The selected 麦浪 studio conversation changed");

      const root = `${context.projectPath.replace(/\/+$/, "")}/`;
      const selectedPath = this.bridge.getDroppedFilePath?.(selected);
      const path = selectedPath?.startsWith(root) ? selectedPath.slice(root.length) : "";
      const format = mediaFormat(path);
      if (!format) throw new Error("Choose supported media from the current 麦浪 studio project");

      this.publish({ busy: true, error: null });
      const file = await (async () => {
        if (format.kind !== "video") return readProjectMedia(this.bridge, context, path, current);
        const source = await openProjectVideo(this.bridge, context, path, current);
        if (source.size !== selected.size || Math.trunc(source.mtimeMs) !== selected.lastModified) {
          throw new Error("The selected video changed. Select it again.");
        }
        // The browser's native picker File is disk-backed. Keep its lazy reader
        // for this interactive import; the saved version uses the scoped URL.
        return selected;
      })().catch(() => {
        if (!current()) throw new Error("The selected 麦浪 studio conversation changed");
        throw new Error("Could not read the selected media in this 麦浪 studio project");
      });
      if (!current()) throw new Error("The selected 麦浪 studio conversation changed");
      const result = await performImport(file);
      if (!result.success || !result.actionId) {
        const message = result.error?.message ?? "Media import failed";
        this.publish({ busy: false, error: message, errorCode: result.error?.code });
        return { ...result, success: false, error: result.error ?? { code: "DECODE_ERROR", message } };
      }
      // The next session waits in the queue while decoding finishes. Attach
      // the reference to this draft before the pending switch retains it.
      this.paths = { ...this.paths, [result.actionId]: path };
      this.publish({ busy: false, dirty: true });
      return result;
    }).catch((error: unknown): ActionResult => {
      const message = error instanceof Error ? error.message : "Media import failed";
      this.publish({ busy: false, ...draftFailure(error), error: message });
      return { success: false, error: { code: "INVALID_PARAMS", message } };
    });
  }
  dispose(): void { this.retain(); this.disposed = true; ++this.generation; this.unsubscribe(); this.listeners.clear(); }
}
