import type { OpenReelMediaScope } from "./openreel-media-protocol";
import type { OpenReelCaptionBinding } from "./openreel-caption-settings";

type Range = { start: number; end: number };
type CaptionCue = { startTime: number; endTime: number; text: string };
type PanelContext = { sessionId: string; projectPath: string; jobId: string };
type AnalysisInput = PanelContext & { expectedRevision: number };
type CaptionLaunch = OpenReelCaptionBinding & { clipId: string; expectedRevision: number; recordSrt(bytes: Buffer): void };
type Launch = (payload: AnalysisInput, operation: "run" | "previewSilence" | "applySilence" | "applyCaption" | "separateAudio",
  signal: AbortSignal, guard: () => void, caption?: CaptionLaunch) => Promise<unknown>;
type CaptionAccess = {
  bind(): OpenReelCaptionBinding;
  save(input: AnalysisInput, bytes: Buffer, guard: () => void): Promise<boolean>;
};
type PanelJob = {
  input: AnalysisInput;
  page: AbortSignal;
  controller: AbortController;
  candidates: Range[];
  captionBinding?: OpenReelCaptionBinding;
  caption?: { clipId: string; cues: CaptionCue[]; replaceCaptionIds: string[] };
  srt?: Buffer;
  savingSrt?: boolean;
  approvedPreview?: Range[];
  attempt: number;
};

const channelPrefix = "openreel.analysis.";

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sameContext(left: PanelContext, right: PanelContext) {
  return left.jobId === right.jobId && left.sessionId === right.sessionId && left.projectPath === right.projectPath;
}

function rangesOf(value: unknown, allowEmpty: boolean): Range[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 32) {
    throw failure("INVALID_ARGUMENT", "Select up to 32 silence ranges from the analysis.");
  }
  return value.map(entry => {
    if (!entry || Object.keys(entry).length !== 2 || typeof entry.start !== "number" || !Number.isFinite(entry.start) ||
      typeof entry.end !== "number" || !Number.isFinite(entry.end) || entry.start < 0 || entry.start >= entry.end) {
      throw failure("INVALID_ARGUMENT", "Select valid silence ranges from the analysis.");
    }
    return { start: entry.start, end: entry.end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}

const sameRange = (a: Range, b: Range) => a.start === b.start && a.end === b.end;

export class OpenReelPanelAnalyses {
  private readonly jobs = new WeakMap<OpenReelMediaScope, PanelJob>();

  async invoke(
    channel: string, owner: OpenReelMediaScope, payload: Record<string, unknown> | undefined,
    assertCurrent: (context: PanelContext) => void, launch: Launch, captionAccess?: CaptionAccess,
  ) {
    const operation = channel.slice(channelPrefix.length);
    const { sessionId, projectPath, jobId, expectedRevision } = payload ?? {};
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
      || typeof projectPath !== "string" || !projectPath
      || typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      throw failure("INVALID_ARGUMENT", "OpenReel analysis requires an active project, conversation, and job.");
    }
    const context = { sessionId, projectPath, jobId };
    const previous = this.jobs.get(owner);
    if (operation === "cancel") {
      if (previous && sameContext(previous.input, context)) this.clear(owner, previous);
      return { ok: true };
    }
    assertCurrent(context);
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw failure("INVALID_ARGUMENT", "Save the OpenReel draft before analyzing it.");
    }

    if (operation === "separateAudio") {
      const clipId = payload?.clipId;
      if (typeof clipId !== "string" || !clipId || clipId.length > 128) {
        throw failure("INVALID_ARGUMENT", "Select one video clip to separate the audio.");
      }
      if (previous) this.clear(owner, previous);
      const job: PanelJob = { input: { ...context, expectedRevision }, page: owner.signal, controller: new AbortController(), candidates: [], attempt: 0 };
      this.jobs.set(owner, job);
      try {
        return await this.launch(owner, job, assertCurrent, launch, { ...job.input, clipId }, operation);
      } finally {
        this.clear(owner, job);
      }
    }

    if (operation === "run") {
      const kind = payload?.kind;
      const clipId = payload?.clipId;
      if ((kind !== "silence" && kind !== "caption") || typeof clipId !== "string" || !clipId || clipId.length > 128) {
        throw failure("INVALID_ARGUMENT", "Select one clip for local OpenReel analysis.");
      }
      if (previous) this.clear(owner, previous);
      const job: PanelJob = { input: { ...context, expectedRevision }, page: owner.signal, controller: new AbortController(), candidates: [], attempt: 0 };
      if (kind === "caption") {
        if (!captionAccess) throw failure("UNSUPPORTED", "Cloud captions are unavailable in this OpenReel pane.");
        job.captionBinding = captionAccess.bind();
      }
      this.jobs.set(owner, job);
      try {
        const response = await this.launch(owner, job, assertCurrent, launch, {
          ...job.input, kind, clipId,
          ...(kind === "silence" && payload?.settings !== undefined ? { settings: payload.settings } : {}),
          ...(kind === "caption" && payload?.language !== undefined ? { language: payload.language } : {}),
        }, "run");
        const result = response as { revision?: unknown; result?: {
          ranges?: unknown; cues?: unknown; replaceCaptionIds?: unknown; unknownOverlapCount?: unknown;
        } };
        if (result?.revision !== expectedRevision) throw failure("REVISION_CONFLICT", "The analysis returned another saved draft revision.");
        this.assertJob(owner, job);
        if (kind === "silence") job.candidates = rangesOf(result.result?.ranges, true);
        else {
          const { cues, replaceCaptionIds, unknownOverlapCount } = result.result ?? {};
          if (!job.srt || !Array.isArray(cues) || cues.length === 0 || cues.length > 500 ||
            !Array.isArray(replaceCaptionIds) || replaceCaptionIds.some(id => typeof id !== "string") ||
            typeof unknownOverlapCount !== "number" || !Number.isSafeInteger(unknownOverlapCount) || unknownOverlapCount < 0) {
            throw failure("INVALID_DRAFT", "OpenReel returned an invalid caption preview.");
          }
          job.caption = { clipId, cues, replaceCaptionIds };
          return { revision: expectedRevision, result: { cues, replaceCount: replaceCaptionIds.length, unknownOverlapCount } };
        }
        return response;
      } catch (error) {
        this.clear(owner, job);
        throw error;
      }
    }

    if (operation !== "previewSilence" && operation !== "applySilence" && operation !== "applyCaption" && operation !== "saveSrt") {
      throw failure("UNSUPPORTED", "Unknown OpenReel analysis action.");
    }
    if (!previous || !sameContext(previous.input, context) || expectedRevision !== previous.input.expectedRevision) {
      throw failure("APPROVAL_REQUIRED", "Analyze the current draft before applying results.");
    }
    if (operation === "saveSrt") {
      if (!previous.caption || !previous.srt || !captionAccess) {
        throw failure("APPROVAL_REQUIRED", "Open a caption preview before saving its SRT.");
      }
      if (previous.savingSrt) throw failure("BUSY", "The subtitle save dialog is already open.");
      const guard = () => { this.assertJob(owner, previous); assertCurrent(previous.input); };
      guard();
      previous.savingSrt = true;
      try {
        return { revision: expectedRevision, result: { saved: await captionAccess.save(previous.input, previous.srt, guard) } };
      } finally {
        previous.savingSrt = false;
      }
    }
    if (operation === "applyCaption") {
      const prepared = previous.caption;
      if (!prepared || payload?.confirm !== true) throw failure("APPROVAL_REQUIRED", "Confirm the caption preview before applying captions.");
      if (previous.savingSrt) throw failure("BUSY", "Close the subtitle save dialog first.");
      previous.caption = undefined;
      try {
        return await this.launch(owner, previous, assertCurrent, launch, { ...previous.input, ...prepared }, operation);
      } finally {
        this.clear(owner, previous);
      }
    }
    const ranges = rangesOf(payload?.ranges, false);
    if (ranges.some((range, index) =>
      (index > 0 && sameRange(range, ranges[index - 1])) || !previous.candidates.some(candidate => sameRange(range, candidate)))) {
      throw failure("APPROVAL_REQUIRED", "Only unchanged ranges from the current silence analysis may be selected.");
    }
    const exact = previous.approvedPreview;
    previous.approvedPreview = undefined;
    const attempt = ++previous.attempt;
    if (operation === "applySilence" && (!exact || exact.length !== ranges.length ||
      !exact.every((range, index) => sameRange(range, ranges[index])))) {
      throw failure("APPROVAL_REQUIRED", "Preview these exact silence ranges before applying them.");
    }
    try {
      const result = await this.launch(owner, previous, assertCurrent, launch, { ...previous.input, ranges }, operation);
      if (operation === "previewSilence" && attempt === previous.attempt) {
        this.assertJob(owner, previous);
        previous.approvedPreview = ranges;
      }
      return result;
    } finally {
      if (operation === "applySilence") this.clear(owner, previous);
    }
  }

  private assertJob(owner: OpenReelMediaScope, job: PanelJob) {
    job.controller.signal.throwIfAborted();
    job.page.throwIfAborted();
    if (this.jobs.get(owner) !== job || owner.signal !== job.page) {
      throw failure("TOOL_ABORTED", "OpenReel analysis was canceled.");
    }
    job.captionBinding?.assertCurrent();
  }

  private launch(
    owner: OpenReelMediaScope, job: PanelJob, assertCurrent: (context: PanelContext) => void, launch: Launch,
    payload: AnalysisInput & Record<string, unknown>, operation: Parameters<Launch>[1],
  ) {
    const guard = () => {
      this.assertJob(owner, job);
      assertCurrent(job.input);
    };
    guard();
    const caption = job.captionBinding && operation === "run" && typeof payload.clipId === "string" ? {
      ...job.captionBinding,
      clipId: payload.clipId, expectedRevision: job.input.expectedRevision,
      recordSrt: (bytes: Buffer) => {
        guard();
        if (job.srt) throw failure("INVALID_DRAFT", "The caption panel must analyze only one audio window.");
        job.srt = bytes;
      },
    } : undefined;
    return launch(payload, operation, AbortSignal.any([job.page, job.controller.signal]), guard, caption);
  }

  private clear(owner: OpenReelMediaScope, job: PanelJob) {
    if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    job.controller.abort(failure("TOOL_ABORTED", "OpenReel analysis was canceled or replaced."));
  }
}
