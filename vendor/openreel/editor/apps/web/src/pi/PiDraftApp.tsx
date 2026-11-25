import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToastContainer } from "../components/Toast";
import { EditorInterface } from "../components/editor/EditorInterface";
import { useProjectStore } from "../stores/project-store";
import { useEngineStore } from "../stores/engine-store";
import { useThemeStore } from "../stores/theme-store";
import { useTimelineStore } from "../stores/timeline-store";
import { toast, useNotificationStore } from "../stores/notification-store";
import { restoreMediaItem } from "../utils/media-recovery";
import { cancelPiDraftAudioSeparation, registerPiDraftActions, reloadPiDraft } from "./environment";
import { piEditorLabel, usePiEditorCopy, usePiEditorLocale } from "./editor-copy";
import { followPiEditorAppearance } from "./editor-copy-runtime";
import { piPanelError, withOpenReelPanelResults } from "./pi-panel-copy";
import { PiDraftController, parseContext, sameContext, type DraftState, type PiBridge, type PiContext } from "./pi-draft";
import { mergePiDraftJobSnapshot, updatePiDraftJobs, type PiDraftJob } from "./pi-draft-jobs";
import { syncPiTimeline } from "./pi-timeline";
import { PiCaptionDraftContext } from "./pi-caption-draft";
import { PiEditReview, type PiEditReviewSnapshot } from "./PiEditReview";
import { PiAgentAnalysis } from "./PiAgentAnalysis";
import { PiTaskCenter } from "./PiTaskCenter";
import { taskCenterItems, usePiTaskFeed } from "./pi-task-center-model";
import "./pi-draft.css";

declare global { interface Window { pluginBridge?: PiBridge } }

const strings = {
  empty: "Select a conversation in a local project to edit video.",
  loading: "Opening the video editor…",
  saved: "Draft saved",
  retry: "Retry",
  error: "Video draft",
  missing: "The video editor could not connect to 麦浪 studio.",
  projectMismatch: "The open project does not match the selected conversation. Try again.",
  conflict: "A newer saved draft is available. Reload it from the project menu when you are ready.",
  discard: "Discard unsaved changes and reload the saved draft?",
  changed: "The selected conversation changed. Your edits are kept in the original conversation.",
  newerDraft: "A newer draft is available. Your unsaved changes are kept.",
  projectSource: "Choose a supported video, audio or image from the current 麦浪 studio project.",
  missingSource: "Import the missing project media again before saving the draft.",
  mediaRead: "Could not read the selected media. Check that the file is still in the project.",
  mediaChanged: "The selected media changed while being read. Select it again.",
  mediaDecode: "Could not import the media. Check the file format.",
  mediaSupported: "Choose a supported local video, audio or image file.",
  mediaNormalize: "Could not convert the selected video. Check that it plays and try again.",
  mediaSize: "Choose nonempty non-video media no larger than 256 MiB.",
  failed: "Could not complete this draft operation. Try again.",
};

function draftError(message: string, code?: string): string {
  if (/Draft changed from revision|REVISION_CONFLICT/i.test(message)) return piEditorLabel(strings.conflict);
  if (/conversation changed|session changed during|WORKSPACE_CHANGED/i.test(message)) return piEditorLabel(strings.changed);
  if (/select a local project session/i.test(message)) return piEditorLabel(strings.empty);
  if (/choose supported media from the current /i.test(message)) return piEditorLabel(strings.projectSource);
  if (/import each media source/i.test(message)) return piEditorLabel(strings.missingSource);
  if (/could not read the selected media/i.test(message)) return piEditorLabel(strings.mediaRead);
  if (/media changed/i.test(message)) return piEditorLabel(strings.mediaChanged);
  if (/choose supported OpenReel media|UNSUPPORTED_FORMAT/i.test(message)) return piEditorLabel(strings.mediaSupported);
  if (/original media is no longer in the saved draft/i.test(message)) {
    return piEditorLabel("Save the draft before replacing this media.");
  }
  if (/normaliz|convert|transcod/i.test(message)) return piEditorLabel(strings.mediaNormalize);
  if (/media import failed|DECODE_ERROR/i.test(message)) return piEditorLabel(strings.mediaDecode);
  if (/256 MiB/i.test(message)) return piEditorLabel(strings.mediaSize);
  return piPanelError(message, code, strings.failed);
}

const initial: DraftState = { context: null, revision: 0, dirty: false, busy: false, ready: false, error: null, retained: 0, newerRevision: null };
const ACTIVE_TURN_REFRESH_MS = 500;
type SessionBinding = { status: "checking" | "failed" | "disconnected" | "project-mismatch" }
  | { status: "resolved"; context: PiContext | null };

function hasActiveTurn(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("activeTurn" in value)) return false;
  const turn = value.activeTurn;
  return !!turn && typeof turn === "object" && "turnId" in turn && typeof turn.turnId === "string";
}

export function PiDraftApp() {
  const t = usePiEditorCopy();
  const locale = usePiEditorLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = piEditorLabel("OpenReel Video Editing");
  }, [locale]);
  const [state, setState] = useState<DraftState>(initial);
  const [binding, setBinding] = useState<SessionBinding>({ status: "checking" });
  const [palette, setPalette] = useState<"light" | "dark">();
  const [jobs, setJobs] = useState<readonly PiDraftJob[]>([]);
  const { current, latest, receive, reset: resetTasks } = usePiTaskFeed();
  const [review, setReview] = useState<PiEditReviewSnapshot | null>(null);
  const [taskPage, setTaskPage] = useState<{ reviewId?: string } | null>(null);
  const [seenTaskId, setSeenTaskId] = useState<string | null>(null);
  const openedReviewId = useRef<string | null>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const restoreTaskFocus = useRef(false);
  const retrySession = useRef<(() => void) | null>(null);

  const openTasks = useCallback((reviewId?: string) => {
    const playback = useTimelineStore.getState();
    if (playback.playbackState === "playing") playback.pause();
    setTaskPage({ reviewId });
  }, []);

  const boundContext = binding.status === "resolved" ? binding.context : null;
  const draftMatches = sameContext(boundContext, state.context);
  const scopedReview = draftMatches && review && sameContext(review.context, boundContext) ? review : null;
  const pendingReviewId = scopedReview?.state === "pending" ? scopedReview.id : undefined;
  const liveReviewId = pendingReviewId ?? (scopedReview?.state === "confirming" ? scopedReview.id : undefined);
  const showTasks = draftMatches && taskPage !== null;

  useLayoutEffect(() => {
    if (pendingReviewId && openedReviewId.current !== pendingReviewId) {
      openedReviewId.current = pendingReviewId;
      openTasks(pendingReviewId);
    }
  }, [openTasks, pendingReviewId]);

  useLayoutEffect(() => {
    if (!showTasks && restoreTaskFocus.current) {
      restoreTaskFocus.current = false;
      taskButton.current?.focus();
    }
  }, [showTasks]);

  useEffect(() => {
    const nativeBridge = window.pluginBridge;
    if (!nativeBridge) { setBinding({ status: "disconnected" }); return; }
    const bridge = withOpenReelPanelResults(nativeBridge);
    let hostPalette: "light" | "dark" | undefined;
    const offAppearance = followPiEditorAppearance(bridge, next => {
      setPalette(next);
      if (next && next !== hostPalette) useThemeStore.getState().setMode(next);
      hostPalette = next;
    });
    const runtime = new PiDraftController(bridge, {
      getProject: () => useProjectStore.getState().getFullProject(),
      createProject: (name) => useProjectStore.getState().createNewProject(name),
      loadProject: (project) => useProjectStore.getState().loadProject(project),
      addMedia: (items) => useProjectStore.setState(({ project }) => ({ project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: [...project.mediaLibrary.items, ...items] },
        modifiedAt: Date.now(),
      } })),
      replaceMedia: (replacement) => useProjectStore.setState(({ project }) => ({ project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: project.mediaLibrary.items.map(
          item => item.id === replacement.id ? replacement : item,
        ) },
        modifiedAt: Math.max(Date.now(), project.modifiedAt + 1),
      } })),
      syncTimeline: syncPiTimeline,
      prepare: async () => {
        const engines = useEngineStore.getState();
        if (!engines.initialized) await engines.initialize();
      },
      restoreMedia: async (project, blobs, reused) => ({
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: await Promise.all(project.mediaLibrary.items.map(
          (item) => {
            const media = reused.get(item.id);
            if (!media) return restoreMediaItem(item, blobs.get(item.id));
            return { ...item, fileHandle: null, blob: media.blob, thumbnailUrl: media.thumbnailUrl,
              openReelMediaUrl: media.openReelMediaUrl, waveformData: media.waveformData,
              filmstripThumbnails: media.filmstripThumbnails, isPlaceholder: false };
          },
        )) },
      }),
      subscribe: (listener) => useProjectStore.subscribe((next, previous) => {
        if (next.project !== previous.project) listener();
      }),
    });
    let previous = runtime.getState();
    const unsubscribe = runtime.subscribe(() => {
      const next = runtime.getState();
      if (!sameContext(previous.context, next.context) && (previous.context || next.context)) {
        useNotificationStore.getState().clearAll();
      }
      if (next.error && next.error !== previous.error) {
        console.warn("[PiDraft] Draft operation failed", next.error);
        if (next.ready) toast.error(piEditorLabel(strings.error), draftError(next.error, next.errorCode));
      } else if (next.dirty && next.newerRevision !== null && next.newerRevision !== previous.newerRevision) {
        toast.warning(piEditorLabel(strings.newerDraft));
      }
      previous = next;
      setState(next);
    });
    const unregisterActions = registerPiDraftActions({
      captureTarget: () => runtime.captureTarget(),
      captureAnalysisTarget: () => runtime.captureAnalysisTarget(),
      separateAudio: (clipId) => runtime.separateAudio(clipId),
      cancelAudioSeparation: (jobId) => runtime.cancelAudioSeparation(jobId),
      save: async () => {
        const before = runtime.getState();
        await runtime.save();
        const after = runtime.getState();
        if (sameContext(before.context, after.context) && after.revision > before.revision && !after.error) {
          toast.success(piEditorLabel(strings.saved));
        }
      },
      reload: async () => {
        const { dirty } = runtime.getState();
        if (!dirty || window.confirm(piEditorLabel(strings.discard))) await runtime.reload(dirty);
      },
      pickFiles: () => runtime.pickFiles(),
      dropFiles: (files) => runtime.dropFiles(files),
      replaceMedia: (mediaId) => runtime.replaceMedia(mediaId),
      importFile: async (file, performImport) => {
        const result = await runtime.importFile(file, performImport);
        return result.error
          ? { ...result, error: { ...result.error, message: draftError(result.error.message, result.error.code) } }
          : result;
      },
    });
    let sessionRequest = 0;
    let selected: PiContext | null = null;
    let refreshTimer: number | undefined;
    let jobSnapshot: Set<string> | undefined;
    const followSession = (snapshot: unknown, next: PiContext | null, request: number) => {
      const sameSession = sameContext(selected, next);
      if (!sameSession) {
        resetTasks();
        setReview(null);
        setTaskPage(null);
        openedReviewId.current = null;
        setSeenTaskId(null);
        jobSnapshot = next ? new Set<string>() : undefined;
        const changedJobs = jobSnapshot;
        if (next && changedJobs) {
          void bridge.invoke("openreel.jobs.list", { ...next }).then((activeJobs) => {
            if (jobSnapshot !== changedJobs) return;
            jobSnapshot = undefined;
            setJobs(current => mergePiDraftJobSnapshot(current, next.sessionId, activeJobs, changedJobs));
          }).catch((error: unknown) => {
            if (jobSnapshot !== changedJobs) return;
            jobSnapshot = undefined;
            console.warn("[PiDraft] Job progress lookup failed", error);
          });
        }
      }
      if (next && sameSession) {
        const { ready, busy } = runtime.getState();
        if (!ready && !busy) void runtime.activate(next);
        void runtime.refresh(next);
      } else if (next || selected) {
        setJobs(current => current.length ? [] : current);
        void runtime.activate(next);
        if (next) void runtime.refresh(next);
      }
      selected = next;
      setBinding({ status: "resolved", context: next });

      // A tool can commit well before the model finishes writing its reply.
      // Check only the selected session and only while its turn is running.
      if (next && hasActiveTurn(snapshot)) {
        const poll = async () => {
          if (sessionRequest !== request) return;
          await runtime.refresh(next);
          if (sessionRequest === request) refreshTimer = window.setTimeout(poll, ACTIVE_TURN_REFRESH_MS);
        };
        refreshTimer = window.setTimeout(poll, ACTIVE_TURN_REFRESH_MS);
      }
    };
    const checkSession = async (readSnapshot: () => Promise<unknown>) => {
      const request = ++sessionRequest;
      window.clearTimeout(refreshTimer);
      try {
        const snapshot = await readSnapshot();
        if (sessionRequest !== request) return;
        const candidate = parseContext(snapshot);
        const local = candidate && !/^(?:remote:|native-pi:)/.test(candidate.sessionId) &&
          !candidate.projectPath.startsWith("remote-project:");
        const workspace = local ? await bridge.invoke("workspace.get") : null;
        if (sessionRequest !== request) return;
        if (local && (!workspace || typeof workspace !== "object" ||
          !("path" in workspace) || workspace.path !== candidate.projectPath)) {
          setBinding({ status: "project-mismatch" });
          return;
        }
        const remote = workspace && typeof workspace === "object" && "remote" in workspace && workspace.remote;
        const next = local && !remote ? candidate : null;
        followSession(snapshot, next, request);
      } catch (error) {
        if (sessionRequest !== request) return;
        console.error("[PiDraft] Session lookup failed", error);
        setBinding({ status: "failed" });
      }
    };
    const readActiveSession = () => bridge.invoke("session.getActive");
    const refreshSession = () => {
      setBinding({ status: "checking" });
      void checkSession(readActiveSession);
    };
    const recheckSession = () => { void checkSession(readActiveSession); };
    const onVisibilityChange = () => { if (!document.hidden) recheckSession(); };
    const offSession = bridge.on("session:activated", (snapshot) => {
      if (!sameContext(selected, parseContext(snapshot))) setBinding({ status: "checking" });
      void checkSession(() => Promise.resolve(snapshot));
    });
    const offDraftCommit = bridge.on("openreel:draftCommitted", (payload) => {
      void runtime.refreshCommitted(selected, payload);
    });
    const offJobProgress = bridge.on("openreel:jobProgress", (payload) => {
      if (!selected || !payload || typeof payload !== "object") return;
      const job = payload as Record<string, unknown>;
      if (job.sessionId !== selected.sessionId || job.projectPath !== selected.projectPath) return;
      if (typeof job.jobId === "string") jobSnapshot?.add(job.jobId);
      const { sessionId } = selected;
      setJobs(current => updatePiDraftJobs(current, sessionId, job));
    });
    const offTurn = bridge.on("session:turnEnded", (payload) => {
      if (selected && payload && typeof payload === "object" &&
          (payload as { sessionId?: unknown }).sessionId === selected.sessionId) void runtime.refresh(selected);
    });
    const offWorkspace = bridge.on("workspace:changed", recheckSession);
    const offOpen = bridge.on("view:open", recheckSession);
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const { dirty, retained, ready, busy } = runtime.getState();
      if (dirty || retained > 0 || (ready && busy)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("focus", recheckSession);
    document.addEventListener("visibilitychange", onVisibilityChange);
    retrySession.current = refreshSession;
    refreshSession();
    return () => {
      retrySession.current = null;
      ++sessionRequest;
      jobSnapshot = undefined;
      window.clearTimeout(refreshTimer);
      offAppearance(); offSession(); offDraftCommit(); offJobProgress(); offTurn(); offWorkspace(); offOpen();
      unregisterActions(); unsubscribe();
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("focus", recheckSession);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      runtime.dispose();
    };
  }, [resetTasks]);

  const draftReady = draftMatches && state.ready;
  const loading = binding.status === "checking" || (boundContext !== null && (!draftMatches || state.busy));
  const sessionProblem = binding.status === "disconnected" || binding.status === "failed" ? strings.missing :
    binding.status === "project-mismatch" ? strings.projectMismatch : null;
  const draftErrorMessage = draftMatches && state.error && !loading ? draftError(state.error, state.errorCode) : null;
  const separationId = state.separationJobId;
  const items = draftMatches && boundContext ? taskCenterItems({
    current, latest, context: boundContext, revision: state.newerRevision ?? state.revision, jobs, t,
    cancelSeparation: separationId ? { id: separationId, cancel: () => void cancelPiDraftAudioSeparation(separationId) } : undefined,
  }) : [];
  const latestId = draftMatches && latest && sameContext(latest.context, boundContext) ? latest.id : null;
  const taskActivity = Boolean(liveReviewId) || items.some(item => item.state === "running" || item.state === "cancelling")
    || (latestId !== null && latestId !== seenTaskId);

  return (
    <div className="pi-draft-app" data-pi-draft-revision={state.revision}
      data-pi-draft-dirty={state.dirty} data-pi-draft-ready={draftReady}
      data-pi-draft-newer-revision={state.newerRevision ?? undefined}>
      {draftMatches && state.context && (
        <PiEditReview key={`${state.context.sessionId}\u0000${state.context.projectPath}`}
          context={state.context} draft={state} onReviewChange={setReview} />
      )}
      {draftMatches && state.context && (
        <PiAgentAnalysis key={`analysis-${state.context.sessionId}\u0000${state.context.projectPath}`}
          context={state.context} mediaBusy={jobs.some(job => job.kind !== "export")}
          onTaskChange={receive} />
      )}
      <main data-testid="pi-openreel-editor" className="pi-draft-editor" aria-busy={loading && !showTasks}>
        <div className="pi-draft-workspace" data-task-view-open={showTasks || undefined}
          inert={showTasks || (draftReady && loading) || undefined}>
          {draftReady ? (
            <PiCaptionDraftContext.Provider value={state}>
              <EditorInterface editingActive={!showTasks && !loading} taskAction={{
                ref: taskButton, activity: taskActivity, reviewPending: Boolean(liveReviewId),
                open: () => openTasks(liveReviewId),
              }} />
            </PiCaptionDraftContext.Provider>
          ) : (
            <div className="pi-draft-placeholder" data-theme={palette}>
              <p role="status">{sessionProblem ? t(sessionProblem) : draftErrorMessage ??
                t(loading ? strings.loading : strings.empty)}</p>
              {(binding.status === "failed" || binding.status === "project-mismatch") && (
                <Button label={t(strings.retry)} onClick={() => retrySession.current?.()} />
              )}
              {draftErrorMessage && (
                <Button label={t(strings.retry)} onClick={() => void reloadPiDraft()} />
              )}
            </div>
          )}
        </div>
        {showTasks && <PiTaskCenter items={items} review={scopedReview} openReviewId={taskPage.reviewId} onReturn={() => {
          restoreTaskFocus.current = true;
          setSeenTaskId(latestId);
          setTaskPage(null);
        }} />}
      </main>
      <ToastContainer />
    </div>
  );
}
