import { dropPiDraftMedia } from "../../../pi/environment";
import { useProjectStore } from "../../../stores/project-store";

export async function placeLocalFileDrop(files: readonly File[], trackId: string | undefined, time: number): Promise<void> {
  const { project, placeMediaClip } = useProjectStore.getState();
  const imported = await dropPiDraftMedia(files);
  for (const item of imported) {
    if (useProjectStore.getState().project.id !== project.id) return;
    const placement = await placeMediaClip(item.id, trackId, time);
    if (!placement.success) return;
  }
}
