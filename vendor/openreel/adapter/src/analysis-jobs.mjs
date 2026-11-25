import { failure, validRevision } from "./drafts.mjs";
import { checkArguments } from "./mcp-server.mjs";

const jobChannels = new Set([
  "openreel.analysisJob.get", "openreel.analysisJob.complete", "openreel.analysisJob.release",
  "openreel.mediaJob.get", "openreel.mediaJob.authorize", "openreel.mediaJob.complete", "openreel.mediaJob.release",
]);
export const isOpenReelJobChannel = channel => jobChannels.has(channel);
export const mediaActions = ["auto_caption", "export_video", "export_audio", "separate_audio"];
const MAX_JOB_AGE_MS = 10 * 60_000;
const clipId = { type: "string", minLength: 1, maxLength: 128 };
const identifier = { type: "object", additionalProperties: false, required: ["jobId"], properties: {
  jobId: { type: "string", minLength: 36, maxLength: 36 },
} };
const startInput = { type: "object", additionalProperties: false, required: ["expectedRevision", "kind", "clipId"], properties: {
  expectedRevision: { type: "integer", minimum: 1 }, kind: { type: "string", enum: ["silence", "caption"] }, clipId,
  language: { type: "string", minLength: 2, maxLength: 24 }, settings: { type: "object" },
} };
const mediaInput = { type: "object", additionalProperties: false, required: ["expectedRevision", "action", "arguments"], properties: {
  expectedRevision: startInput.properties.expectedRevision, action: { type: "string", enum: mediaActions }, arguments: { type: "object" },
} };
const idOf = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const time = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const activeJob = record => record.state === "queued" || record.state === "running" || record.state === "cancelling";
const withScope = (active, origin) => active?.sessionId === origin.sessionId && active.projectPath === origin.projectPath;

function failJob(record, state, errorCode) {
  record.state = state;
  if (errorCode) record.errorCode = errorCode;
}

function stopJob(record, errorCode) {
  if (activeJob(record)) failJob(record, record.authorized ? "cancelling" : "cancelled", errorCode);
}

function readAnalysis(record, value) {
  checkArguments(value);
  if (value.revision !== record.request.expectedRevision) {
    throw failure("REVISION_CONFLICT", "The caption or silence preview belongs to another saved draft revision.");
  }
  const normalized = value.result;
  if (record.request.kind === "silence") {
    const ranges = normalized?.ranges;
    if (!Array.isArray(ranges) || ranges.length > 32 ||
      ranges.some(range => !time(range?.start) || !time(range.end) || range.start >= range.end)) {
      throw failure("INVALID_ARGUMENT", "The silence preview contains invalid time ranges.");
    }
    return { ranges: ranges.map(({ start, end }) => ({ start, end })) };
  }
  const cues = normalized?.cues;
  if (!Array.isArray(cues) || !cues.length || cues.length > 500 ||
    cues.some(cue => !time(cue?.startTime) || !time(cue.endTime) || cue.startTime >= cue.endTime ||
      typeof cue.text !== "string" || !cue.text.trim())) {
    throw failure("INVALID_ARGUMENT", "The caption preview contains invalid subtitle cues.");
  }
  return { cues: cues.map(({ startTime, endTime, text }) => ({ startTime, endTime, text })) };
}

function readMedia(record, value) {
  checkArguments(value);
  const { action, expectedRevision } = record.request;
  const exported = action === "export_video" || action === "export_audio";
  const revision = expectedRevision + Number(!exported);
  if (value.revision !== revision) {
    throw failure("REVISION_CONFLICT", "The OpenReel media result belongs to another draft revision.");
  }
  const artifact = value.artifact;
  if (exported && (typeof artifact?.path !== "string" || !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 || artifact.revision !== revision ||
      artifact.format !== (action === "export_video" ? "mp4" : "wav"))) {
    throw failure("INVALID_ARGUMENT", "The OpenReel media result does not contain a valid export.");
  }
  return { revision, ...(exported ? { artifact } : {}) };
}

export function createOpenReelPanelJobs(api, store, validate) {
  let job;

  function refresh() {
    if (job && activeJob(job) && Date.now() >= job.expiresAt) {
      if (job.authorized) stopJob(job, "TIMEOUT");
      else failJob(job, "failed", "TIMEOUT");
    }
    return job;
  }

  function status(record) {
    const { id, request, state, result, errorCode } = record;
    return { jobId: id, revision: request.expectedRevision, state,
      ...(record.media ? { action: request.action } : { kind: request.kind }),
      ...(errorCode ? { errorCode } : {}),
      ...(result ? request.kind === "caption" ? { cueCount: result.cues.length } : result : {}),
    };
  }

  async function start(args, scope, media) {
    checkArguments(args);
    const { expectedRevision, kind, clipId, language, settings } = args;
    if (!validRevision(expectedRevision) || expectedRevision < 1) {
      throw failure("INVALID_ARGUMENT", "Read the saved draft revision before starting an OpenReel job.");
    }
    if (media) {
      if (Object.keys(args).length !== 3 || !mediaActions.includes(args.action)) {
        throw failure("INVALID_ARGUMENT", "Choose one supported OpenReel media action.");
      }
      checkArguments(args.arguments);
    } else if (Object.keys(args).some(key => !Object.hasOwn(startInput.properties, key)) ||
        !idOf(clipId) || (kind !== "silence" && kind !== "caption") ||
        (language !== undefined && (kind !== "caption" || typeof language !== "string" ||
          !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language) || language.length > 24)) ||
        (settings !== undefined && kind !== "silence")) {
        throw failure("INVALID_ARGUMENT", "Choose a saved clip and its caption or silence analysis options.");
    }
    if (!scope?.signal || !scope.turnId) throw failure("PERMISSION_DENIED", "Start analysis from an active OpenReel turn.");
    const context = await store.agentContext(scope);
    const origin = { projectPath: context.projectPath, sessionId: scope.sessionId, turnId: scope.turnId };
    const saved = await store.load(context);
    if (saved.revision !== expectedRevision) throw failure("REVISION_CONFLICT", "Read the latest draft before analyzing a clip.");
    if (!media && !saved.project?.timeline.tracks.some(track => track.clips.some(candidate => candidate.id === clipId))) {
      throw failure("INVALID_ARGUMENT", "Choose the exact ID of a saved clip.");
    }
    validate(args, media);
    const active = await api.session.getActive();
    if (!withScope(active, origin) || active.activeTurn?.turnId !== scope.turnId) {
      throw failure("WORKSPACE_CHANGED", "Open the originating conversation to begin OpenReel analysis.");
    }
    scope.signal.throwIfAborted();
    if (refresh() && activeJob(job)) throw failure("BUSY", "An OpenReel analysis is already active.");
    const record = {
      id: globalThis.crypto.randomUUID(), origin, request: structuredClone(args), media, state: "queued",
      expiresAt: Date.now() + MAX_JOB_AGE_MS,
    };
    job = record;
    try {
      await api.ui.revealView({ viewId: "editor", sessionId: origin.sessionId });
      scope.signal.throwIfAborted();
      return status(record);
    } catch (error) {
      if (job === record) stopJob(record);
      throw error;
    }
  }

  async function fromTool(args, scope, cancel, media) {
    checkArguments(args);
    const context = await store.agentContext(scope);
    const record = refresh();
    if (!record || record.media !== media || record.id !== args.jobId || Object.keys(args).length !== 1 ||
      !withScope({ sessionId: scope.sessionId, projectPath: context.projectPath }, record.origin)) {
      throw failure("NOT_FOUND", "No OpenReel analysis matches this conversation and job.");
    }
    if (cancel) stopJob(record);
    return status(record);
  }

  async function fromPanel(channel, payload) {
    if (typeof payload?.ownerId !== "string" || !payload.ownerId) {
      throw failure("PERMISSION_DENIED", "Open the originating OpenReel panel first.");
    }
    const record = refresh();
    const media = channel.startsWith("openreel.mediaJob.");
    if (channel.endsWith(".release")) {
      if (record?.media === media && record.ownerId === payload.ownerId && withScope(payload, record.origin)) {
        if (record.authorized && activeJob(record)) stopJob(record);
        else job = undefined;
      }
      return null;
    }
    // Media completion is sent by the native runner even if its pane was closed.
    if (channel !== "openreel.mediaJob.complete") await store.panelContext(payload);
    if (!record || record.media !== media || record !== job || !withScope(payload, record.origin) ||
      (record.ownerId && record.ownerId !== payload.ownerId)) {
      if (channel.endsWith(".get")) return null;
      throw failure("NOT_FOUND", "No OpenReel analysis matches the current panel.");
    }
    if (channel.endsWith(".get")) {
      let launch = false;
      if (record.state === "queued") {
        record.ownerId = payload.ownerId;
        record.state = "running";
        launch = true;
      }
      const request = media ? { action: record.request.action, expectedRevision: record.request.expectedRevision } : record.request;
      return { id: record.id, ...request, state: record.state, launch,
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        ...(record.result && payload.seenResultId !== record.id ? { result: record.result } : {}) };
    }
    if (payload.id !== record.id || record.ownerId !== payload.ownerId ||
        (record.state !== "running" && !(record.authorized && record.state === "cancelling"))) {
      throw failure("NOT_FOUND", "No active OpenReel analysis matches this result.");
    }
    if (channel === "openreel.mediaJob.authorize") {
      if (record.authorized || record.state !== "running") {
        throw failure("BUSY", "The requested OpenReel media job already started or was cancelled.");
      }
      record.authorized = true;
      return { ...record.origin, ...record.request };
    }
    if (typeof payload.errorCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(payload.errorCode)) {
      const aborted = payload.errorCode === "TOOL_ABORTED" || payload.errorCode === "PLUGIN_TOOL_ABORTED";
      failJob(record, aborted ? "cancelled" : "failed", payload.errorCode);
    } else {
      if (media && !record.authorized) throw failure("PERMISSION_DENIED", "Start the exact OpenReel media job before completing it.");
      record.result = media ? readMedia(record, payload.result) : readAnalysis(record, payload.result);
      delete record.errorCode;
      record.state = "done";
    }
    return status(record);
  }

  return {
    tools: [
      { name: "start_analysis_job", description: "Request a non-writing preview from the active OpenReel pane for one saved clip. Choose silence analysis or caption preview. Caption previews upload selected audio only to the configured caption service and stay in the panel. Query the returned analysis job ID to see its status.",
        schema: startInput, risk: "medium", execute: (args, scope) => start(args, scope, false) },
      { name: "analysis_job_status", description: "Check an OpenReel analysis job. Completed silence jobs return candidate ranges. Completed caption jobs report the cue count; captions stay in the panel.",
        schema: identifier, risk: "low", execute: (args, scope) => fromTool(args, scope, false, false) },
      { name: "cancel_analysis_job", description: "Cancel an OpenReel analysis job for this conversation without changing the draft.",
        schema: identifier, risk: "low", execute: (args, scope) => fromTool(args, scope, true, false) },
      { name: "start_media_job", description: "Run a long OpenReel task in the current pane and return its job ID. Use auto_caption to append captions to the requested saved clips through the configured service, export_video or export_audio to publish a saved revision, or separate_audio to extract one saved clip. Pass the action's arguments from the draft capability catalog.",
        schema: mediaInput, risk: "medium", execute: (args, scope) => start(args, scope, true) },
      { name: "media_job_status", description: "Check an OpenReel media job and return its committed revision or export artifact when complete.",
        schema: identifier, risk: "low", execute: (args, scope) => fromTool(args, scope, false, true) },
      { name: "cancel_media_job", description: "Cancel the matching OpenReel media job. If it was already committed, the result remains available.",
        schema: identifier, risk: "low", execute: (args, scope) => fromTool(args, scope, true, true) },
    ],
    fromPanel,
    scopeChanged(active) {
      if (job && !withScope(active, job.origin)) {
        if (job.authorized && activeJob(job)) stopJob(job);
        else job = undefined;
      }
    },
    turnEnded(event) {
      if (job && activeJob(job) && event?.sessionId === job.origin.sessionId && event.turnId === job.origin.turnId &&
        event.reason !== "completed") stopJob(job);
    },
  };
}
