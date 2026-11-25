import { useCallback, useState } from "react";
import type { PiAgentTaskSnapshot } from "./PiAgentAnalysis";
import type { PiTaskCenterItem } from "./PiTaskCenter";
import { sameContext, type PiContext } from "./pi-draft";
import type { PiDraftJob } from "./pi-draft-jobs";
import { piPanelError } from "./pi-panel-copy";

const phases: Record<PiDraftJob["kind"], Record<string, string>> = {
  caption: { extracting: "Extracting the audio track", uploading: "Uploading clip audio", waiting: "Waiting for subtitles" },
  silence: { decoding: "Extracting the audio track", analyzing: "Detecting silence" },
  separation: { preparing: "Preparing audio separation", extracting: "Separating audio" },
  export: { preparing: "Preparing export", rendering: "Rendering", encoding: "Encoding", muxing: "Combining audio and video" },
};

const kinds = {
  caption: { title: "Generating captions", icon: "captions" },
  silence: { title: "Detecting silence", icon: "silence" },
  separation: { title: "Separating audio", icon: "audio" },
  export: { title: "Exporting", icon: "video" },
} as const;

const media = {
  auto_caption: { title: "Append automatic captions", kind: "caption", icon: "captions" },
  export_video: { title: "Export MP4", kind: "export", icon: "video" },
  export_audio: { title: "Export WAV", kind: "export", icon: "audio" },
  separate_audio: { title: "Separate audio", kind: "separation", icon: "audio" },
} as const;

const isActive = ({ state }: { state: PiAgentTaskSnapshot["state"] }) => state === "running" || state === "cancelling";

function phaseLabel(job: PiDraftJob): string {
  const labels = phases[job.kind];
  return Object.hasOwn(labels, job.phase) ? labels[job.phase] : kinds[job.kind].title;
}

export function usePiTaskFeed() {
  const [feed, setFeed] = useState<{ current: PiAgentTaskSnapshot | null; latest: PiAgentTaskSnapshot | null }>({
    current: null, latest: null,
  });
  const receive = useCallback((current: PiAgentTaskSnapshot | null) => {
    setFeed(previous => current || previous.current ? {
      current,
      latest: current && !isActive(current) ? current : previous.latest,
    } : previous);
  }, []);
  const reset = useCallback(() => setFeed({ current: null, latest: null }), []);
  return { ...feed, receive, reset };
}

function taskDetails(task: PiAgentTaskSnapshot, revision: number): PiTaskCenterItem["details"] {
  if (task.state !== "done") return undefined;
  if ("kind" in task) {
    if (task.expectedRevision !== revision) return { kind: "stale" };
    if (!task.result) return undefined;
    return task.kind === "caption"
      ? { kind: "captions", cues: task.result.cues ?? [] }
      : { kind: "silence", ranges: task.result.ranges ?? [] };
  }
  if (task.result?.artifact) return { kind: "export", path: task.result.artifact.path };
  return task.result ? { kind: "saved" } : undefined;
}

export function taskCenterItems({ current, latest, context, revision, jobs, cancelSeparation, t }: {
  current: PiAgentTaskSnapshot | null;
  latest: PiAgentTaskSnapshot | null;
  context: PiContext;
  revision: number;
  jobs: readonly PiDraftJob[];
  cancelSeparation?: { id: string; cancel: () => void };
  t: (text: string) => string;
}): PiTaskCenterItem[] {
  const active: PiTaskCenterItem[] = [];
  let completed: PiTaskCenterItem | undefined;
  const consumed = new Set<PiDraftJob>();
  for (const task of [current, latest]) {
    if (!task || !sameContext(task.context, context)) continue;
    const presentation = "kind" in task
      ? task.kind === "caption"
        ? { title: "Caption analysis", kind: "caption", icon: "captions" } as const
        : { title: "Silence analysis", kind: "silence", icon: "silence" } as const
      : media[task.action];
    const matching = jobs.find(job => job.id === task.id && job.kind === presentation.kind);
    if (matching) consumed.add(matching);
    const item = {
      id: task.id, title: t(presentation.title), icon: presentation.icon,
      state: task.state, cancel: task.cancel, details: taskDetails(task, revision),
      ...(matching && isActive(task) ? {
        phase: t(phaseLabel(matching)),
        progress: matching.progress,
      } : {}),
      ...(task.state === "failed" ? {
        error: piPanelError("", task.errorCode, "Could not complete the requested OpenReel job."),
      } : {}),
    };
    if (isActive(item)) active.push(item);
    else completed ??= item;
  }
  for (const job of jobs) {
    if (consumed.has(job)) continue;
    active.push({ id: job.id, title: t(kinds[job.kind].title), icon: kinds[job.kind].icon,
      state: "running", phase: t(phaseLabel(job)), progress: job.progress,
      cancel: job.kind === "separation" && cancelSeparation?.id === job.id ? cancelSeparation.cancel : undefined });
  }
  return completed ? [...active, completed] : active;
}
