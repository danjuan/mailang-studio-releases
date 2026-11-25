export type OpenReelJobProgress = {
  sessionId: string;
  jobId: string;
  kind: "export" | "caption" | "silence" | "separation";
  phase: string;
  progress?: number;
  done?: true;
};

export class OpenReelJobProgressTracker {
  private readonly active = new Map<string, OpenReelJobProgress & { projectPath: string }>();

  record(projectPath: string, progress: OpenReelJobProgress) {
    const event = { ...progress, projectPath };
    if (progress.done) this.active.delete(progress.jobId);
    else this.active.set(progress.jobId, event);
    return event;
  }

  list(sessionId: string, projectPath: string) {
    return Array.from(this.active.values()).filter(event =>
      event.sessionId === sessionId && event.projectPath === projectPath
    );
  }
}
