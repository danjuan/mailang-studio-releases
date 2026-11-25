import {
  OPENREEL_DRAFT_VERSION as FORMAT_VERSION, OPENREEL_HISTORY_LIMIT, OPENREEL_MEDIA_LIMIT,
  failure, mediaFormat, mediaPath, validateDraft, validRevision,
} from "../../editor/packages/core/src/pi-draft-format.mjs";

export { failure, mediaPath, validRevision };
export const MAX_MEDIA_BYTES = OPENREEL_MEDIA_LIMIT;
export const MAX_MEDIA_RANGE = 1024 * 1024;
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function decodeDraft(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_DRAFT_BYTES) {
    throw failure("INVALID_DRAFT", "The OpenReel draft exceeds its size limit.");
  }
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    throw failure("INVALID_DRAFT", "The saved OpenReel draft is not valid JSON.");
  }
  return validateDraft(draft);
}

function encodeDraft(draft) {
  const text = JSON.stringify(draft);
  if (Buffer.byteLength(text, "utf8") > MAX_DRAFT_BYTES) {
    throw failure("INVALID_DRAFT", "The OpenReel draft exceeds its size limit.");
  }
  return text;
}

export function draftPath(sessionId) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw failure("INVALID_SESSION", "A tracked 麦浪 studio project conversation is required.");
  }
  return `video-edits/${sessionId}/draft.json`;
}

function workspacePath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw failure("LOCAL_PROJECT_REQUIRED", "Open a local 麦浪 studio project conversation first.");
  }
  return value;
}

function byteArray(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value?.type === "Buffer" && Array.isArray(value.data)) return Uint8Array.from(value.data);
  throw failure("INVALID_MEDIA", "麦浪 studio did not return media bytes.");
}

export function createDraftStore(api) {
  const tails = new Map();
  let guardedHost = false;

  async function checkHost() {
    if (guardedHost) return;
    try {
      await api.fs.readText("video-edits/.workspace-check", {
        workspacePath: "/__pi_openreel_expected_workspace_probe__",
      });
    } catch (error) {
      if (error?.code === "WORKSPACE_CHANGED") {
        guardedHost = true;
        return;
      }
    }
    throw failure("HOST_VERSION_MISMATCH", "This 麦浪 studio build must support workspace-bound draft reads and atomic saves.");
  }

  async function agentContext(context) {
    const path = draftPath(context?.sessionId);
    context.signal?.throwIfAborted();
    const workspace = await api.workspace.get();
    const projectPath = workspacePath(workspace?.path);
    context.signal?.throwIfAborted();
    if (context.projectPath !== undefined && context.projectPath !== projectPath) {
      throw failure("WORKSPACE_CHANGED", "The OpenReel tool workspace changed.");
    }
    await checkHost();
    return { path, projectPath, signal: context.signal };
  }

  async function panelContext(payload) {
    const path = draftPath(payload?.sessionId);
    const projectPath = workspacePath(payload?.projectPath);
    const active = await api.session.getActive();
    if (active?.sessionId !== payload.sessionId || active.projectPath !== projectPath) {
      throw failure("WORKSPACE_CHANGED", "The selected 麦浪 studio conversation changed. Open its draft again.");
    }
    await checkHost();
    return {
      path, projectPath,
      async verifyActive() {
        const current = await api.session.getActive();
        if (current?.sessionId !== payload.sessionId || current.projectPath !== projectPath) {
          throw failure("WORKSPACE_CHANGED", "The selected 麦浪 studio conversation changed. Open its draft again.");
        }
      },
    };
  }

  async function load(context, path = context.path) {
    context.signal?.throwIfAborted();
    let text;
    try {
      const options = { workspacePath: context.projectPath };
      const info = await api.fs.stat(path, undefined, options);
      if (info.size > MAX_DRAFT_BYTES) {
        throw failure("INVALID_DRAFT", "The OpenReel draft exceeds its size limit.");
      }
      text = await api.fs.readText(path, options);
    } catch (error) {
      if (path === context.path && error?.code === "NOT_FOUND") {
        return { formatVersion: FORMAT_VERSION, project: null, revision: 0, mediaPaths: {} };
      }
      throw error;
    }
    return decodeDraft(text);
  }

  // The spare slot keeps every version advertised by the current draft
  // recoverable if the history write succeeds but the draft write aborts.
  function historyPath(context, revision) {
    return context.path.replace(/draft\.json$/, `history/${revision % (OPENREEL_HISTORY_LIMIT + 1)}.json`);
  }

  async function readHistory(context, current, revision) {
    if (!validRevision(revision) || revision < Math.max(1, current.revision - OPENREEL_HISTORY_LIMIT) ||
        revision >= current.revision) {
      throw failure("INVALID_ARGUMENT", "Choose one of the draft's recent saved versions.");
    }
    const historical = await load(context, historyPath(context, revision));
    if (historical.revision !== revision) throw failure("INVALID_DRAFT", "The selected history slot is invalid.");
    return historical;
  }

  async function history(context, current) {
    const revisions = [];
    for (let revision = current.revision - 1; revision >= Math.max(1, current.revision - OPENREEL_HISTORY_LIMIT); revision--) {
      const draft = await readHistory(context, current, revision);
      revisions.push({ revision, name: draft.project.name, duration: draft.project.timeline.duration });
    }
    return { revision: current.revision, revisions };
  }

  function update(context, expectedRevision, edit) {
    if (!validRevision(expectedRevision)) {
      throw failure("INVALID_ARGUMENT", "Read the current draft revision before editing.");
    }
    const key = `${context.projectPath}\u0000${context.path}`;
    const previous = tails.get(key);
    const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(async () => {
      context.signal?.throwIfAborted();
      await context.verifyActive?.();
      const saved = await load(context);
      if (saved.revision !== expectedRevision) {
        throw failure("REVISION_CONFLICT", `Draft changed from revision ${expectedRevision} to ${saved.revision}. Reload it before saving again.`);
      }
      const { project, mediaPaths } = await edit(saved);
      const next = validateDraft({ formatVersion: FORMAT_VERSION, revision: saved.revision + 1, project, mediaPaths });
      const encoded = encodeDraft(next);
      context.signal?.throwIfAborted();
      await context.verifyActive?.();
      const options = { workspacePath: context.projectPath, atomic: true };
      if (saved.revision > 0) {
        await api.fs.writeText(historyPath(context, saved.revision), encodeDraft(saved), options);
        context.signal?.throwIfAborted();
        await context.verifyActive?.();
      }
      await api.fs.writeText(context.path, encoded, options);
      return next;
    });
    tails.set(key, operation);
    return operation.finally(() => {
      if (tails.get(key) === operation) tails.delete(key);
    });
  }

  async function stat(context, path) {
    const input = mediaPath(path);
    const info = await api.fs.stat(input, undefined, { workspacePath: context.projectPath });
    if (!Number.isSafeInteger(info.size) || info.size < 1 ||
        (mediaFormat(input)?.kind !== "video" && info.size > MAX_MEDIA_BYTES)) {
      throw failure("INVALID_MEDIA", "Select nonempty supported media. Audio and image sources may be at most 256 MiB.");
    }
    return info;
  }

  async function read(context, path, offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length) ||
        !Number.isSafeInteger(length) || length < 1 || length > MAX_MEDIA_RANGE) {
      throw failure("INVALID_ARGUMENT", "Invalid media byte range.");
    }
    context.signal?.throwIfAborted();
    const result = await api.fs.readRange(mediaPath(path), offset, length, undefined, {
      workspacePath: context.projectPath,
    });
    context.signal?.throwIfAborted();
    if (!Number.isSafeInteger(result.totalSize) || result.totalSize <= 0 ||
        (mediaFormat(path)?.kind !== "video" && result.totalSize > MAX_MEDIA_BYTES)) {
      throw failure("INVALID_MEDIA", "Source media changed or exceeds the media size limit.");
    }
    return { bytes: byteArray(result.bytes), totalSize: result.totalSize };
  }

  const restore = (context, expectedRevision, revision) =>
    update(context, expectedRevision, saved => readHistory(context, saved, revision));
  return { agentContext, panelContext, load, update, history, restore, stat, read };
}

export function summarize(draft, path) {
  const project = draft.project;
  const tracks = project?.timeline.tracks ?? [];
  const captionTracks = new Set(tracks.filter(track => track.role === "captions").map(track => track.id));
  return {
    revision: draft.revision,
    draftPath: path,
    name: project?.name ?? null,
    duration: project?.timeline.duration ?? 0,
    tracks: tracks.map(({ id, name, type, role, locked }) => ({ id, name, type, role, locked })),
    clips: tracks.flatMap(track => track.clips.map(clip => ({
      id: clip.id,
      trackId: track.id,
      mediaPath: draft.mediaPaths[clip.mediaId],
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      ...(clip.metadata?.audioDetached ? { audioDetached: true } : {}),
      ...(typeof clip.metadata?.separatedFromClipId === "string" ? { separatedFromClipId: clip.metadata.separatedFromClipId } : {}),
      effects: (Array.isArray(clip.effects) ? clip.effects : []).filter(isObject)
        .map(({ id, type, enabled }) => ({ id, type, enabled })),
      audioEffects: (Array.isArray(clip.audioEffects) ? clip.audioEffects : []).filter(isObject)
        .map(({ id, type, enabled }) => ({ id, type, enabled })),
    }))),
    textClips: (Array.isArray(project?.textClips) ? project.textClips : [])
      .filter(isObject)
      .map(({ id, trackId, text, startTime, duration }) => ({
        id, trackId, text, startTime, duration,
        caption: captionTracks.has(trackId),
      })),
    subtitles: (Array.isArray(project?.timeline.subtitles) ? project.timeline.subtitles : [])
      .filter(isObject)
      .map(({ id, text, startTime, endTime }) => ({ id, text, startTime, endTime })),
    transitions: tracks.flatMap(track => (Array.isArray(track.transitions) ? track.transitions : [])
      .filter(isObject)
      .map(({ id, clipAId, clipBId, edge, type, duration }) => ({ id, trackId: track.id, clipAId, clipBId, edge, type, duration }))),
  };
}
