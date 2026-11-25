import { useEffect, useRef } from "react";
import { capturePiAnalysisTarget } from "./environment";
import { createPiAnalysisJob, type CaptionCue, type SilenceRange } from "./pi-analysis";
import type { PiContext } from "./pi-draft";
import { withOpenReelPanelResults } from "./pi-panel-copy";

type Job = {
  id: string;
  expectedRevision: number;
  launch: boolean;
  errorCode?: string;
  state: "running" | "cancelling" | "done" | "cancelled" | "failed";
};
type AnalysisJob = Job & {
  kind: "silence" | "caption";
  clipId: string;
  language?: string;
  settings?: Record<string, unknown>;
  result?: { cues?: CaptionCue[]; ranges?: SilenceRange[] };
};

const mediaActions = ["auto_caption", "export_video", "export_audio", "separate_audio"] as const;
type MediaJob = Job & {
  action: (typeof mediaActions)[number];
  result?: { revision: number; artifact?: { path: string } };
};
type Task = AnalysisJob | MediaJob;
export type PiAgentTaskSnapshot = Task & { context: PiContext; cancel?: () => void };

type NativeTask = {
  id: string;
  stop(): Promise<unknown>;
  requestCancel(): void;
  cancelling: boolean;
};

function parseTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AnalysisJob & MediaJob>;
  if (typeof item.id !== "string" || typeof item.expectedRevision !== "number" || typeof item.state !== "string") return null;
  if ((item.kind === "silence" || item.kind === "caption") && typeof item.clipId === "string") return item as AnalysisJob;
  return mediaActions.some(action => action === item.action) ? item as MediaJob : null;
}

function sameTask(previous: Task, next: Task): boolean {
  if (previous.id !== next.id || previous.expectedRevision !== next.expectedRevision || previous.launch !== next.launch ||
    previous.state !== next.state || previous.errorCode !== next.errorCode) return false;
  if (previous.result === next.result) return true;
  return "action" in previous && "action" in next && previous.result?.revision === next.result?.revision &&
    previous.result?.artifact?.path === next.result?.artifact?.path;
}

function codeFrom(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "TOOL_FAILED";
}

export function PiAgentAnalysis({ context, mediaBusy, onTaskChange }: {
  context: PiContext;
  mediaBusy: boolean;
  onTaskChange: (task: PiAgentTaskSnapshot | null) => void;
}) {
  const observer = useRef(onTaskChange);
  const busy = useRef(mediaBusy);
  useEffect(() => { observer.current = onTaskChange; }, [onTaskChange]);
  useEffect(() => { busy.current = mediaBusy; }, [mediaBusy]);
  const { sessionId, projectPath } = context;

  useEffect(() => {
    const native = window.pluginBridge;
    if (!native) return;
    const bridge = withOpenReelPanelResults(native);
    const scope = { sessionId, projectPath };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastResultId: string | undefined;
    let current: Task | null = null;
    let reported: PiAgentTaskSnapshot | null = null;
    let active: NativeTask | null = null;
    const complete = (id: string, value: Record<string, unknown>) =>
      bridge.invoke("openreel.analysisJob.complete", { ...scope, id, ...value });

    function report() {
      if (disposed) return;
      if (!current) {
        if (reported) {
          reported = null;
          observer.current(null);
        }
        return;
      }
      const cancel = current.state === "running" && active?.id === current.id && !active.cancelling
        ? active.requestCancel : undefined;
      if (reported && sameTask(reported, current) && reported.cancel === cancel) return;
      reported = { ...current, context: scope, ...(cancel ? { cancel } : {}) };
      observer.current(reported);
    }

    async function cancelNative(task: NativeTask) {
      if (task.cancelling) return;
      task.cancelling = true;
      await task.stop().catch(() => {});
    }

    function startNative(descriptor: Task, stop: () => Promise<unknown>) {
      const task: NativeTask = {
        id: descriptor.id,
        stop,
        cancelling: false,
        requestCancel() {
          if (disposed || active !== task || task.cancelling ||
            current?.id !== task.id || current.state !== "running") return;
          void cancelNative(task);
          if ("kind" in descriptor) void complete(task.id, { errorCode: "TOOL_ABORTED" }).catch(() => {});
          report();
        },
      };
      active = task;
      return task;
    }

    function finishNative(task: NativeTask) {
      if (active === task) {
        active = null;
        report();
      }
    }

    async function runAnalysis(descriptor: AnalysisJob) {
      const target = capturePiAnalysisTarget();
      if (!target || target.context.sessionId !== sessionId || target.context.projectPath !== projectPath ||
        target.revision !== descriptor.expectedRevision || !target.isCurrent() || busy.current || active) {
        const errorCode = busy.current || active ? "BUSY" : "REVISION_CONFLICT";
        await complete(descriptor.id, { errorCode }).catch(() => {});
        return;
      }
      const native = createPiAnalysisJob(target, descriptor.id);
      const task = startNative(descriptor, native.cancel);
      try {
        const result = descriptor.kind === "caption"
          ? await native.caption(descriptor.clipId, descriptor.language)
          : await native.silence(descriptor.clipId, descriptor.settings);
        if (!disposed && !task.cancelling) {
          await complete(task.id, { result: { revision: target.revision, result } });
        }
      } catch (error) {
        if (!disposed && !task.cancelling) await complete(task.id, { errorCode: codeFrom(error) }).catch(() => {});
      } finally {
        await cancelNative(task);
        finishNative(task);
      }
    }

    async function runMedia(descriptor: MediaJob) {
      const task = startNative(descriptor, () => bridge.invoke("openreel.mediaJob.cancel", { ...scope, id: descriptor.id }));
      try {
        await bridge.invoke("openreel.mediaJob.run", { ...scope, id: descriptor.id });
      } catch {
        // The native runner records failures against the job ticket.
      } finally {
        finishNative(task);
      }
    }

    async function poll() {
      try {
        const [analysis, media] = await Promise.all([
          bridge.invoke("openreel.analysisJob.get", { ...scope, seenResultId: lastResultId }),
          bridge.invoke("openreel.mediaJob.get", scope),
        ]);
        const next = parseTask(analysis ?? media);
        if (disposed) return;
        if (active && (next?.id !== active.id || next.state === "cancelling" ||
          next.state === "cancelled" || next.state === "failed")) {
          void cancelNative(active);
        }
        lastResultId = next?.state === "done" ? next.id : undefined;
        // The broker omits analysis results after the first poll for this ID.
        current = next?.state === "done" && "kind" in next && current && "kind" in current &&
          next.id === current.id && current.result && !next.result ? { ...next, result: current.result } : next;
        if (next?.launch) {
          if ("kind" in next) void runAnalysis(next);
          else void runMedia(next);
        }
        report();
      } catch {
        if (!disposed && active) {
          void cancelNative(active);
          report();
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (reported) observer.current(null);
      const task = active;
      active = null;
      if (task) void cancelNative(task);
    };
  }, [sessionId, projectPath]);

  return null;
}
