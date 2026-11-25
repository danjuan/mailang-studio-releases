import { createDraftStore, failure, mediaPath, summarize, validRevision } from "./drafts.mjs";
import { checkArguments, createMcpServer } from "./mcp-server.mjs";
import { exportCapabilities, exportFormat, exportSavedMedia } from "./export-job.mjs";
import { createEditReview, isReviewChannel, reviewedActions } from "./review-edits.mjs";
import { createOpenReelPanelJobs, isOpenReelJobChannel } from "./analysis-jobs.mjs";
import { createOpenEditorTool } from "./open-editor.mjs";

const number = { type: "number", minimum: 0 };
const string = { type: "string", minLength: 1 };
const BATCH_ACTION = "batch_actions";
const batchCapability = {
  name: BATCH_ACTION,
  domain: "raw",
  description: "Apply one to 32 named OpenReel edit capabilities in order to one saved revision. Each entry needs name and arguments from the capability catalog. Approval-dependent and long-running tools are excluded.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: { ...string, maxLength: 128 }, arguments: { type: "object" } },
          required: ["name", "arguments"],
        },
      },
    },
    required: ["actions"],
  },
  readOnly: false,
  destructive: false,
  expensive: false,
  available: true,
};

const historyCapabilities = [
  {
    name: "list_draft_history", domain: "project",
    description: "List up to ten earlier saved versions of this conversation's draft.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    readOnly: true, destructive: false, expensive: false, available: true,
  },
  {
    name: "restore_draft_revision", domain: "project",
    description: "Restore a recent saved draft version as a new revision.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { revision: { type: "integer", minimum: 1 } }, required: ["revision"] },
    readOnly: false, destructive: false, expensive: false, available: true,
  },
];

function editSchema(type, fields, required) {
  return {
    type: "object",
    additionalProperties: false,
    properties: { type: { type: "string", const: type }, ...fields },
    required: ["type", ...required],
  };
}

const readInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 128 },
    offset: { type: "integer", minimum: 0 },
    tool: { type: "string", minLength: 1, maxLength: 128 },
    arguments: { type: "object" },
    preflight: { type: "string", minLength: 1, maxLength: 128 },
    expectedRevision: { type: "integer", minimum: 0 },
  },
};
const editsInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    action: { type: "string", minLength: 1, maxLength: 128 },
    arguments: { type: "object" },
    edits: {
      type: "array", minItems: 1, maxItems: 32,
      items: {
        oneOf: [
          editSchema("import", { path: string, outPoint: number }, ["path"]),
          editSchema("trim", { clipId: string, inPoint: number, outPoint: number }, ["clipId"]),
          editSchema("split", { clipId: string, time: number }, ["clipId", "time"]),
          editSchema("move", { clipId: string, startTime: number }, ["clipId", "startTime"]),
        ],
      },
    },
  },
  required: ["expectedRevision"],
};
const reviewInput = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "action", "arguments"],
  properties: {
    expectedRevision: editsInput.properties.expectedRevision,
    action: { type: "string", enum: reviewedActions },
    arguments: { type: "object" },
  },
};
const editPreviews = {
  delete_objects: "preview_delete_objects",
  ripple_delete_ranges: "preview_ripple_delete",
  apply_timeline_template: "preview_timeline_template",
};

function isText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function time(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseEdits(value) {
  if (!validRevision(value?.expectedRevision) ||
      !Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 32) {
    throw failure("INVALID_ARGUMENT", "Provide expectedRevision and one to 32 timeline edits.");
  }
  return value.edits.map(edit => {
    if (edit?.type === "import" && (edit.outPoint === undefined || time(edit.outPoint))) {
      return { type: edit.type, path: mediaPath(edit.path), outPoint: edit.outPoint };
    }
    if (edit?.type === "trim" && isText(edit.clipId) &&
        (edit.inPoint === undefined || time(edit.inPoint)) &&
        (edit.outPoint === undefined || time(edit.outPoint)) &&
        (edit.inPoint !== undefined || edit.outPoint !== undefined)) {
      return { type: edit.type, clipId: edit.clipId, inPoint: edit.inPoint, outPoint: edit.outPoint };
    }
    if (edit?.type === "split" && isText(edit.clipId) && time(edit.time)) {
      return { type: edit.type, clipId: edit.clipId, time: edit.time };
    }
    if (edit?.type === "move" && isText(edit.clipId) && time(edit.startTime)) {
      return { type: edit.type, clipId: edit.clipId, startTime: edit.startTime };
    }
    throw failure("INVALID_ARGUMENT", "Edit must be a valid import, trim, split, or move.");
  });
}

export function createOpenReelPlugin(api, editDraft, engine) {
  const store = createDraftStore(api);
  const byName = new Map((engine?.catalog() ?? []).map(tool => [tool.name, tool]));
  const review = createEditReview(api, store, previewReview, applyReview);
  const analysisJobs = createOpenReelPanelJobs(api, store, (args, media) => {
    if (media) checkCapability(args.action, args.arguments, false);
    else if (args.kind === "silence") {
      checkCapability("detect_silence", { clipId: args.clipId, ...(args.settings === undefined ? {} : { settings: args.settings }) }, true);
    } else checkCapability("auto_caption", { clipId: args.clipId, ...(args.language === undefined ? {} : { language: args.language }) }, false);
  });
  if (engine) {
    byName.set(BATCH_ACTION, batchCapability);
    for (const capability of [...exportCapabilities, ...historyCapabilities]) byName.set(capability.name, capability);
  }

  function availability(tool) {
    if (!tool.available) return tool.unavailableReason ?? "The required OpenReel implementation is unavailable.";
    const format = exportFormat(tool.name);
    if ((tool.destructive && !["ripple_delete_ranges", "delete_objects"].includes(tool.name))
      || (tool.expensive && !["auto_caption", "detect_silence", "separate_audio"].includes(tool.name) && !format)) {
      return "This operation requires dedicated approval or job support.";
    }
    if (tool.name === "auto_caption" && typeof api.openReel?.transcribe !== "function") {
      return "This 麦浪 studio build does not provide OpenReel caption service access.";
    }
    if (tool.name === "detect_silence" && (typeof api.openReel?.detectSilence !== "function" || !engine?.analyzeSilence)) {
      return "This 麦浪 studio build does not provide local OpenReel silence analysis.";
    }
    if (tool.name === "separate_audio" && (typeof api.openReel?.prepareSeparatedAudio !== "function"
      || typeof api.openReel?.discardSeparatedAudio !== "function" || !engine?.editSeparatedAudio || !engine?.checkAudioSeparation)) {
      return "This 麦浪 studio build does not provide local OpenReel WAV separation.";
    }
    if (format && typeof api.openReel?.export !== "function") {
      return "This 麦浪 studio build does not provide a session-bound OpenReel export renderer.";
    }
    return null;
  }

  function checkCapability(name, args, readOnly) {
    const tool = byName.get(name);
    if (!tool || tool.readOnly !== readOnly) throw failure("INVALID_ARGUMENT", "Choose an OpenReel capability for this tool.");
    const unavailable = availability(tool);
    if (unavailable) throw failure("UNSUPPORTED", unavailable);
    checkArguments(args);
    const { properties = {}, required = [] } = tool.inputSchema;
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) ||
        required.some(key => !Object.hasOwn(args, key))) {
      throw failure("INVALID_ARGUMENT", "OpenReel arguments do not match the capability definition.");
    }
    return tool;
  }

  function discover(query, offset) {
    if (!isText(query) || !Number.isSafeInteger(offset) || offset < 0 || offset > byName.size) {
      throw failure("INVALID_ARGUMENT", "Provide a valid OpenReel capability query and offset.");
    }
    const terms = query.toLowerCase().split(/[\s_-]+/).filter(Boolean);
    const matches = [...byName.values()].filter(tool => {
      const text = `${tool.name.replaceAll("_", " ")} ${tool.domain} ${tool.description}`.toLowerCase();
      return query === "*" || terms.every(term => text.includes(term));
    }).sort((a, b) => Number(Boolean(availability(a))) - Number(Boolean(availability(b))));
    const end = offset + 12;
    return { total: matches.length, nextOffset: end < matches.length ? end : null,
      capabilities: matches.slice(offset, end).map(tool => {
        const reason = availability(tool);
        return { name: tool.name, description: tool.description, domain: tool.domain,
          inputSchema: tool.inputSchema, readOnly: tool.readOnly, available: reason === null,
          ...(reason ? { unavailableReason: reason } : {}) };
      }) };
  }

  async function assertRevision(context, expected) {
    const draft = await store.load(context);
    if (draft.revision !== expected) {
      throw failure("REVISION_CONFLICT", "Read the latest OpenReel draft before using this analysis.");
    }
    return draft;
  }

  async function transcribeInput(context, path, startTime, duration, language, { clipId, expectedRevision }) {
    if (typeof api.openReel?.transcribe !== "function") {
      throw failure("UNSUPPORTED", "This 麦浪 studio build does not provide OpenReel caption service access.");
    }
    await context.verifyActive?.();
    context.signal?.throwIfAborted();
    return api.openReel.transcribe({
      path: mediaPath(path), workspacePath: context.projectPath, startTime, duration, clipId, expectedRevision,
      ...(language ? { language } : {}),
    });
  }

  function captionReader(context, expectedRevision) {
    return (path, startTime, duration, language, { clipId }) =>
      transcribeInput(context, path, startTime, duration, language, { clipId, expectedRevision });
  }

  async function detectSilence(context, draft, args) {
    if (!draft.project) throw failure("INVALID_DRAFT", "Import local media before analyzing silence.");
    const result = await engine.analyzeSilence(draft.project, args, draft.mediaPaths,
      (path, startTime, duration, channels, threshold, minFrameSeconds) => api.openReel.detectSilence({
        path: mediaPath(path), workspacePath: context.projectPath, startTime, duration, channels, threshold, minFrameSeconds,
      }), context.signal);
    await assertRevision(context, draft.revision);
    return result;
  }

  function rippleDetails(project, result) {
    const first = result.ranges[0].start;
    const affected = item => item.startTime + item.duration > first;
    const text = project.textClips ?? [];
    const captionTracks = new Set(project.timeline.tracks.filter(track => track.role === "captions").map(track => track.id));
    const overlays = [project.shapeClips, project.svgClips, project.stickerClips, project.motionInstances]
      .flatMap(items => items ?? []);
    const graphicsMedia = new Set(project.mediaLibrary.items.filter(item => item.type === "image").map(item => item.id));
    const affectedTracks = project.timeline.tracks.filter(track =>
      [...track.clips, ...text.filter(item => item.trackId === track.id), ...overlays.filter(item => item.trackId === track.id)].some(affected),
    );
    return {
      ...result, previousDuration: project.timeline.duration, affectedTrackIds: affectedTracks.map(track => track.id),
      impact: {
        captionCount: project.timeline.subtitles.filter(item => item.endTime > first).length +
          text.filter(item => captionTracks.has(item.trackId) && affected(item)).length,
        musicClipCount: affectedTracks.filter(track => track.role === "music").flatMap(track => track.clips).filter(affected).length,
        overlayCount: overlays.filter(affected).length + text.filter(item => !captionTracks.has(item.trackId) && affected(item)).length +
          affectedTracks.flatMap(track => track.clips).filter(item => graphicsMedia.has(item.mediaId) && affected(item)).length,
      },
    };
  }

  async function previewReview(context, draft, { action, arguments: args }) {
    checkCapability(action, args, false);
    const read = action === "apply_timeline_template" ? { templateId: args.templateId } : args;
    const previewName = editPreviews[action];
    checkCapability(previewName, read, true);
    const result = await engine.read(draft.project, previewName, read, context.signal);
    if (action === "apply_timeline_template") {
      if (!result.confirmationRequired) return null;
      if (draft.project.timeline.tracks.some(track => track.locked)) {
        throw failure("INVALID_ARGUMENT", "Unlock the affected tracks before replacing this draft.");
      }
      return { name: result.name, duration: result.duration, previousDuration: result.replacedDuration };
    }
    if (action === "ripple_delete_ranges") return rippleDetails(draft.project, result);
    const texts = new Map([
      ...(draft.project.textClips ?? []).map(({ id, text }) => [id, text]),
      ...draft.project.timeline.subtitles.map(({ id, text }) => [id, text]),
    ]);
    return { ...result, targets: result.targets.map(target => ({
      ...target, ...(target.kind === "caption" || target.kind === "text" ? { text: texts.get(target.id) } : {}),
    })) };
  }

  async function applyReview(context, { action, arguments: args, expectedRevision }, approvedImpact) {
    const saved = await store.update(context, expectedRevision, async draft => {
      const current = await previewReview(context, draft, { action, arguments: args });
      if (JSON.stringify(current) !== JSON.stringify(approvedImpact)) {
        throw failure("REVISION_CONFLICT", "The saved draft no longer matches the approved OpenReel preview.");
      }
      const approved = {
        ...(action === "apply_timeline_template" ? { templateReplacement: args.templateId } : {}),
        ...(action === "delete_objects" ? { objectDelete: {
          revision: expectedRevision, approval: { revision: expectedRevision, objects: args.objects },
        } } : {}),
      };
      return engine.edit(draft, [{ name: action, arguments: args }], context.signal, approved);
    });
    return saved.revision;
  }

  async function readCapability(name, args, toolContext) {
    checkCapability(name, args, true);
    const context = await store.agentContext(toolContext);
    const draft = await store.load(context);
    const result = name === "list_draft_history" ? await store.history(context, draft)
      : name === "detect_silence" ? await detectSilence(context, draft, args)
      : await engine.read(draft.project, name, args, context.signal);
    return { revision: draft.revision,
      result: name === "preview_ripple_delete" ? rippleDetails(draft.project, result) : result };
  }

  async function separateAudio(context, saved, args, log) {
    const expectedRevision = saved.revision;
    engine.checkAudioSeparation(saved.project, args.clipId);
    await context.verifyActive?.();
    context.signal?.throwIfAborted();
    const source = await api.openReel.prepareSeparatedAudio({
      workspacePath: context.projectPath, expectedRevision, clipId: args.clipId,
    });
    const root = context.path.replace(/draft\.json$/, "media/");
    if (typeof source?.path !== "string" || !source.path.startsWith(root) || !source.path.endsWith(".wav")) {
      throw failure("INVALID_MEDIA", "OpenReel did not receive a current-session WAV asset.");
    }
    let committed;
    try {
      context.signal?.throwIfAborted();
      const pending = await engine.editSeparatedAudio(saved, args.clipId, source, {
        stat: path => store.stat(context, path),
        read: (path, offset, length) => store.read(context, path, offset, length),
      }, context.signal);
      committed = await store.update(context, expectedRevision, () => pending);
    } catch (error) {
      try {
        await api.openReel.discardSeparatedAudio({ workspacePath: context.projectPath, path: source.path });
      } catch {
        log?.("OpenReel could not discard the unused WAV in-band. Invocation cleanup will retry.");
      }
      throw error;
    }
    return summarize(committed, context.path);
  }

  async function editCapability(name, args, expectedRevision, toolContext) {
    checkCapability(name, args, false);
    if (name === "delete_objects" || name === "ripple_delete_ranges") {
      throw failure("APPROVAL_REQUIRED", "Use prepare_edit to review the exact change in the OpenReel panel.");
    }
    let calls = [{ name, arguments: args }];
    if (name === BATCH_ACTION) {
      if (!Array.isArray(args.actions) || args.actions.length === 0 || args.actions.length > 32) {
        throw failure("INVALID_ARGUMENT", "Provide one to 32 named OpenReel edits.");
      }
      calls = args.actions.map(item => {
        checkArguments(item);
        if (Object.keys(item).length !== 2 || !isText(item.name) || item.name === BATCH_ACTION) {
          throw failure("INVALID_ARGUMENT", "Each batch entry must contain one edit name and its arguments.");
        }
        const tool = checkCapability(item.name, item.arguments, false);
        if (tool.expensive || tool.destructive || item.name === "restore_draft_revision" || item.name === "apply_timeline_template") {
          throw failure("UNSUPPORTED", "This OpenReel tool must be called separately.");
        }
        return { name: item.name, arguments: item.arguments };
      });
    }
    const context = await store.agentContext(toolContext);
    if (!validRevision(expectedRevision)) throw failure("INVALID_ARGUMENT", "Read the draft revision before editing.");
    if (name === "restore_draft_revision") {
      return summarize(await store.restore(context, expectedRevision, args.revision), context.path);
    }
    if (name === "separate_audio") {
      if (!toolContext?.turnId || !toolContext.projectPath) {
        throw failure("PERMISSION_DENIED", "Separate audio from an active OpenReel expert turn.");
      }
      return separateAudio(context, await assertRevision(context, expectedRevision), args, toolContext.log);
    }
    const format = exportFormat(name);
    if (format) {
      const artifact = await exportSavedMedia(api, store, context, expectedRevision, format, args);
      return { revision: expectedRevision, artifact };
    }
    const reader = {
      stat: path => store.stat(context, path),
      read: (path, offset, length) => store.read(context, path, offset, length),
      importMedia(saved, args) {
        return editDraft(saved, [{ ...args, type: "import" }], reader, context.signal);
      },
    };
    let draft;
    if (name === "auto_caption") {
      const saved = await store.load(context);
      if (saved.revision !== expectedRevision) {
        throw failure("REVISION_CONFLICT", "Read the latest OpenReel draft before transcribing.");
      }
      const pending = await engine.edit(saved, calls, context.signal, { ...reader, transcribe: captionReader(context, saved.revision) });
      draft = await store.update(context, expectedRevision, () => pending);
    } else {
      draft = await store.update(context, expectedRevision, saved => engine.edit(saved, calls, context.signal, reader));
    }
    return summarize(draft, context.path);
  }

  const tools = [
    createOpenEditorTool(api),
    {
      name: "read_draft",
      description: "Read the current conversation's OpenReel draft. Use query (an English term or * for all) with optional offset to discover OpenReel capabilities and input schemas. Use tool and arguments to run a read-only capability. Use preflight and expectedRevision to check the current session and local dependencies before a planned action.",
      risk: "low",
      schema: readInput,
      async execute(args, toolContext) {
        checkArguments(args);
        if (args.preflight !== undefined) {
          if (Object.keys(args).some(key => key !== "preflight" && key !== "expectedRevision")) {
            throw failure("INVALID_ARGUMENT", "Check one OpenReel action at a time.");
          }
          const action = byName.get(args.preflight);
          if (!action) throw failure("UNSUPPORTED", "Unknown OpenReel capability.");
          const reason = availability(action);
          if (reason) return { ready: false, reason: { code: "UNSUPPORTED", message: reason } };
          const context = await store.agentContext(toolContext);
          const draft = await store.load(context);
          if (args.expectedRevision !== undefined && draft.revision !== args.expectedRevision) {
            return { ready: false, revision: draft.revision, reason: {
              code: "REVISION_CONFLICT", message: "Reload the latest draft before applying this action.",
            } };
          }
          const status = typeof api.openReel?.preflight === "function"
            ? await api.openReel.preflight({ workspacePath: context.projectPath, operation: action.name, expectedRevision: draft.revision })
            : { ready: true };
          return { ...status, revision: draft.revision };
        }
        if (args.expectedRevision !== undefined) throw failure("INVALID_ARGUMENT", "Set preflight before expectedRevision.");
        if (args.query !== undefined) {
          if (args.tool !== undefined || args.arguments !== undefined) {
            throw failure("INVALID_ARGUMENT", "Choose either discovery or a read-only capability.");
          }
          return discover(args.query, args.offset ?? 0);
        }
        if (args.offset !== undefined || (args.arguments !== undefined && args.tool === undefined)) {
          throw failure("INVALID_ARGUMENT", "Set query before offset or tool before arguments.");
        }
        if (args.tool !== undefined) return readCapability(args.tool, args.arguments ?? {}, toolContext);
        const context = await store.agentContext(toolContext);
        return summarize(await store.load(context), context.path);
      },
    },
    {
      name: "prepare_edit",
      description: "Preview exact object deletion, a ripple cut, or replacement of an existing timeline. Read the saved draft for its revision and exact IDs first. If the user approves the preview in the OpenReel panel, the plugin will save one revision. Do not ask a chat question to authorize the edit.",
      risk: "low",
      schema: reviewInput,
      execute: review.prepare,
    },
    ...analysisJobs.tools,
    {
      name: "apply_edits",
      description: "Edit the current conversation's OpenReel draft. Read its revision first. Set edits for import, trim, split or move, or set action and arguments for a capability found through read_draft. Use prepare_edit for object deletion, ripple cuts or replacement of an existing timeline. The auto_caption action sends selected clip audio to the configured subtitle service. Use import_media with a project-relative path or the exact attachment path explicitly included in the current user request. Trim adjusts source endpoints; split and move use absolute timeline seconds. Use separate calls for meaningful stages of a multi-step edit, starting with import. Each call commits one atomic revision. Use the returned revision for the next call.",
      risk: "medium",
      schema: editsInput,
      async execute(args, toolContext) {
        checkArguments(args);
        if (args.action !== undefined) {
          if (args.edits !== undefined) throw failure("INVALID_ARGUMENT", "Choose either edits or a capability.");
          return editCapability(args.action, args.arguments ?? {}, args.expectedRevision, toolContext);
        }
        if (args.arguments !== undefined) throw failure("INVALID_ARGUMENT", "Set action before arguments.");
        const edits = parseEdits(args);
        const context = await store.agentContext(toolContext);
        const draft = await store.update(context, args.expectedRevision, saved => editDraft(saved, edits, {
          stat: path => store.stat(context, path),
          read: (path, offset, length) => store.read(context, path, offset, length),
        }, context.signal));
        return summarize(draft, context.path);
      },
    },
  ];

  const mcpTools = [
    ...tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: tool.risk === "low", destructiveHint: false,
        openWorldHint: ["apply_edits", "start_analysis_job", "start_media_job"].includes(tool.name) } })),
    ...[...byName.values()].filter(tool => !availability(tool) &&
      (tool.name !== "delete_objects" && tool.name !== "ripple_delete_ranges") && !tools.some(alias => alias.name === tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.readOnly ? tool.inputSchema : {
          type: "object",
          additionalProperties: false,
          properties: { expectedRevision: editsInput.properties.expectedRevision, arguments: tool.inputSchema },
          required: ["expectedRevision", "arguments"],
        },
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: tool.name === "auto_caption" },
      })),
  ];
  const invokeMcp = createMcpServer(() => mcpTools, (name, args, toolContext) => {
    const alias = tools.find(candidate => candidate.name === name);
    if (alias) return alias.execute(args, toolContext);
    const tool = byName.get(name);
    if (!tool) throw failure("INVALID_ARGUMENT", "Unknown OpenReel capability.");
    if (tool.readOnly) return readCapability(name, args, toolContext);
    return editCapability(name, args.arguments, args.expectedRevision, toolContext);
  });
  let nextRequestId = 0;
  let connection;
  async function callMcpTool(name, args, toolContext) {
    if (!connection) {
      connection = (async () => {
        await invokeMcp({ jsonrpc: "2.0", id: "plugin-init", method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "麦浪 studio", version: "1" },
        } });
        await invokeMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    await connection;
    const reply = await invokeMcp({ jsonrpc: "2.0", id: `plugin-${++nextRequestId}`, method: "tools/call",
      params: { name, arguments: args } }, toolContext);
    const result = reply?.result;
    if (result?.isError) {
      if (result.structuredContent.code === "TOOL_ABORTED") toolContext?.signal?.throwIfAborted();
      throw failure(result.structuredContent.code, result.structuredContent.message);
    }
    if (!result) throw failure("TOOL_FAILED", reply?.error?.message ?? "OpenReel MCP did not return a tool result.");
    return result.structuredContent;
  }

  async function invokePanelAnalysis(channel, payload, scope) {
    if (!scope?.signal || !validRevision(payload?.expectedRevision) || payload.expectedRevision < 1) {
      throw failure("INVALID_ARGUMENT", "Select a saved OpenReel draft before analyzing.");
    }
    const context = { ...await store.panelContext(payload), signal: scope.signal };
    const draft = await assertRevision(context, payload.expectedRevision);
    if (!draft.project) throw failure("INVALID_DRAFT", "Import local media before analyzing.");
    if (channel === "openreel.analysis.run") {
      if (payload.kind === "silence") {
        const args = { clipId: payload.clipId, ...(payload.settings ? { settings: payload.settings } : {}) };
        checkCapability("detect_silence", args, true);
        const result = await detectSilence(context, draft, args);
        await context.verifyActive();
        return { revision: draft.revision, result };
      }
      if (payload.kind !== "caption") throw failure("INVALID_ARGUMENT", "Choose silence or caption analysis.");
      const args = { clipId: payload.clipId, ...(payload.language ? { language: payload.language } : {}) };
      checkCapability("auto_caption", args, false);
      if (!engine.previewCaptions) throw failure("UNSUPPORTED", "OpenReel caption previews are unavailable.");
      const result = await engine.previewCaptions(draft.project, args, draft.mediaPaths, captionReader(context, draft.revision), context.signal);
      await context.verifyActive();
      await assertRevision(context, draft.revision);
      return { revision: draft.revision, result };
    }
    if (channel === "openreel.analysis.applyCaption") {
      if (!engine.applyCaptions) throw failure("UNSUPPORTED", "OpenReel caption editing is unavailable.");
      let cues;
      const persisted = await store.update(context, draft.revision, async current => {
        const result = await engine.applyCaptions(current.project, payload.clipId, payload.cues, payload.replaceCaptionIds, context.signal);
        cues = result.cues;
        return { project: result.project, mediaPaths: current.mediaPaths };
      });
      return { revision: persisted.revision, result: { cues } };
    }
    if (channel === "openreel.analysis.separateAudio") {
      const args = { clipId: payload.clipId };
      checkCapability("separate_audio", args, false);
      return separateAudio(context, draft, args, scope.log);
    }
    const args = { ranges: payload.ranges };
    checkCapability("preview_ripple_delete", args, true);
    const detail = result => rippleDetails(draft.project, result);
    if (channel === "openreel.analysis.previewSilence") {
      const result = detail(await engine.read(draft.project, "preview_ripple_delete", args, context.signal));
      await context.verifyActive();
      await assertRevision(context, draft.revision);
      return { revision: draft.revision, result };
    }
    if (channel === "openreel.analysis.applySilence") {
      let result;
      const persisted = await store.update(context, draft.revision, async current => {
        const pending = await engine.edit(current, [{ name: "ripple_delete_ranges", arguments: args }], context.signal);
        result = detail(pending.results[0]);
        return pending;
      });
      return { revision: persisted.revision, result };
    }
    throw failure("UNSUPPORTED", "Unknown OpenReel analysis action.");
  }

  async function invokePanel(channel, payload, scope) {
    if (isReviewChannel(channel)) return review.fromPanel(channel, payload);
    if (isOpenReelJobChannel(channel)) return analysisJobs.fromPanel(channel, payload);
    if (channel.startsWith("openreel.analysis.")) return invokePanelAnalysis(channel, payload, scope);
    if (!["openreel.draft.load", "openreel.draft.save", "openreel.media.stat", "openreel.media.read", "openreel.media.describe"].includes(channel)) {
      throw failure("UNSUPPORTED", "Unknown OpenReel panel action.");
    }
    const context = await store.panelContext(payload);
    if (channel === "openreel.media.describe") {
      if (!engine?.probeMedia) throw failure("UNSUPPORTED", "Media description is unavailable.");
      const { metadata } = await engine.probeMedia({
        stat: path => store.stat(context, path),
        read: (path, offset, length) => store.read(context, path, offset, length),
      }, payload.path);
      await context.verifyActive();
      return metadata;
    }
    if (channel === "openreel.draft.save") {
      return store.update(context, payload.expectedRevision, () => ({
        project: payload.project,
        mediaPaths: payload.mediaPaths,
      }));
    }
    let result;
    if (channel === "openreel.draft.load") {
      const newerThan = payload.newerThan;
      if (newerThan !== undefined && !validRevision(newerThan)) {
        throw failure("INVALID_ARGUMENT", "The known draft revision is invalid.");
      }
      const draft = await store.load(context);
      result = newerThan !== undefined && draft.revision <= newerThan ? null : draft;
    } else if (channel === "openreel.media.stat") result = await store.stat(context, payload.path);
    else result = await store.read(context, payload.path, payload.offset, payload.length);
    await context.verifyActive();
    return result;
  }

  return {
    tools: tools.map(tool => ({ ...tool, execute: (args, context) => callMcpTool(tool.name, args, context) })),
    invokePanel, invokeMcp,
    scopeChanged(active) {
      review.scopeChanged(active);
      analysisJobs.scopeChanged(active);
    },
    turnEnded: analysisJobs.turnEnded,
  };
}
