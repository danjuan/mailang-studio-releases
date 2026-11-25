export interface PiDraftJob {
  id: string;
  kind: "caption" | "export" | "silence" | "separation";
  phase: string;
  progress?: number;
}

export function updatePiDraftJobs(
  jobs: readonly PiDraftJob[],
  sessionId: string | undefined,
  payload: unknown,
): readonly PiDraftJob[] {
  if (!sessionId || !payload || typeof payload !== "object") return jobs;
  const update = payload as Record<string, unknown>;
  const { jobId, kind, phase, progress } = update;
  if (update.sessionId !== sessionId || typeof jobId !== "string" || !jobId || jobId.length > 128 ||
      (kind !== "caption" && kind !== "export" && kind !== "silence" && kind !== "separation") || typeof phase !== "string" || !phase || phase.length > 48) return jobs;

  const existing = jobs.find(job => job.id === jobId);
  if (update.done === true) return existing ? jobs.filter(job => job.id !== jobId) : jobs;

  const fraction = typeof progress === "number" && progress >= 0 && progress <= 1 ? progress : undefined;
  const next: PiDraftJob = { id: jobId, kind, phase, ...(fraction === undefined ? {} : { progress: fraction }) };
  if (!existing) return [...jobs, next];
  if (existing.phase === phase && existing.progress === fraction && existing.kind === kind) return jobs;
  return jobs.map(job => job === existing ? next : job);
}

export function mergePiDraftJobSnapshot(
  jobs: readonly PiDraftJob[],
  sessionId: string,
  payload: unknown,
  changedJobs: ReadonlySet<string>,
): readonly PiDraftJob[] {
  if (!Array.isArray(payload)) return jobs;
  return payload.reduce<readonly PiDraftJob[]>((current, job: unknown) => {
    if (job && typeof job === "object" && "jobId" in job
      && typeof job.jobId === "string" && !changedJobs.has(job.jobId)) {
      return updatePiDraftJobs(current, sessionId, job);
    }
    return current;
  }, jobs);
}
