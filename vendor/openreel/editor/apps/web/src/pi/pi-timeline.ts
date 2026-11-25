import { useTimelineStore } from "../stores/timeline-store";

export function syncPiTimeline(duration: number, switched: boolean): void {
  if (!switched) {
    const timeline = useTimelineStore.getState();
    if (timeline.playheadPosition > duration) timeline.seekTo(duration);
    return;
  }
  useTimelineStore.setState({
    playheadPosition: 0,
    playbackState: "stopped",
    playbackLockedReason: null,
    isScrubbing: false,
    scrubPosition: null,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
    scrollX: 0,
  });
}
