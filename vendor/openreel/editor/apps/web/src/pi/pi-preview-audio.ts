import { getAudioEngine, trackHasAudioItems, type Project } from "@openreel/core";
import type { AudioClipSchedule } from "@openreel/core/audio/realtime-audio-graph";

const windowSeconds = 5;

/** Keep only the current and upcoming mixed output windows in the editor. */
export class PiPreviewAudio {
  private readonly trackId: string | undefined;
  private readonly ready = new Map<number, AudioClipSchedule | null>();
  private rendering: { start: number; promise: Promise<void> } | undefined;
  private generation = 0;

  constructor(private readonly project: Project) {
    const tracks = project.timeline.tracks.filter(track => trackHasAudioItems(project, track.id));
    const solo = tracks.some(track => track.solo);
    this.trackId = tracks.find(track => !track.muted && (!solo || track.solo))?.id;
  }

  private start(time: number): number {
    return Math.max(0, Math.floor(time / windowSeconds) * windowSeconds);
  }

  private load(start: number): Promise<void> {
    const trackId = this.trackId;
    const duration = Math.min(windowSeconds, this.project.timeline.duration - start);
    if (!trackId || duration <= 0 || this.ready.has(start)) return Promise.resolve();
    if (this.rendering) return this.rendering.promise;
    const generation = this.generation;
    const promise = (async () => {
      const engine = getAudioEngine();
      if (!engine.isInitialized()) await engine.initialize();
      const { buffer } = await engine.renderAudio(this.project, start, duration);
      if (this.generation !== generation) return;
      this.ready.set(start, {
        clipId: `pi-mix:${this.project.id}:${start}`, trackId, audioBuffer: buffer,
        startTime: start, endTime: start + duration, mediaOffset: 0,
        volume: 1, volumeAutomation: [], pan: 0, effects: [], speed: 1,
      });
    })().catch((error: unknown) => {
      if (this.generation !== generation) return;
      this.ready.set(start, null);
      console.warn("[PiPreviewAudio] Could not mix a preview audio window:", error);
    }).finally(() => {
      if (this.rendering?.promise === promise) this.rendering = undefined;
    });
    this.rendering = { start, promise };
    return promise;
  }

  async prime(time: number): Promise<void> {
    const start = this.start(time);
    this.prune(start);
    // A seek can arrive while the previous window is being decoded.
    if (this.rendering && this.rendering.start !== start) await this.rendering.promise;
    await this.load(start);
  }

  private prune(start: number): void {
    for (const window of this.ready.keys()) {
      if (window !== start && window !== start + windowSeconds) this.ready.delete(window);
    }
  }

  schedules(time: number): AudioClipSchedule[] {
    const start = this.start(time);
    this.prune(start);
    const next = start + windowSeconds;
    void this.load(this.ready.has(start) ? next : start);
    return [this.ready.get(start), this.ready.get(next)]
      .filter((item): item is AudioClipSchedule => Boolean(item));
  }

  dispose(): void {
    this.generation++;
    this.ready.clear();
  }
}
