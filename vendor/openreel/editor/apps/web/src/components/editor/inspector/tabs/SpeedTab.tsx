import React from "react";
import { isPiEmbedded } from "../../../../pi/environment";
import type { Clip } from "@openreel/core";
import { ToolcraftButton as Button } from "@openreel/ui";
import { piEditorLabel } from "../../../../pi/editor-copy";
import { requiresLegacyStabilization } from "../../../../pi/pi-legacy-visuals";
import { useProjectStore } from "../../../../stores/project-store";
import { SpeedSection, SpeedRampSection } from "../";
import { InspectorSection } from "../shell/InspectorSection";

interface SpeedTabClip {
  id: string;
  mediaId: string;
}

export interface SpeedTabProps {
  showVideoControls: boolean;
  selectedClip: SpeedTabClip | null;
}

export const SpeedTab: React.FC<SpeedTabProps> = ({
  showVideoControls,
  selectedClip,
}) => {
  const clip = useProjectStore((state) => state.getClip(selectedClip?.id ?? ""));
  return (
    <>
      {showVideoControls &&
        selectedClip &&
        !selectedClip.mediaId.startsWith("text-") &&
        !selectedClip.mediaId.startsWith("shape-") &&
        !selectedClip.mediaId.startsWith("svg-") &&
        !selectedClip.mediaId.startsWith("sticker-") && (
          <>
            <InspectorSection
              title="Speed & Direction"
              sectionId="speed"
              defaultOpen={false}
            >
              <SpeedSection clip={selectedClip as Clip} />
            </InspectorSection>
          </>
        )}
      {isPiEmbedded && clip?.stabilization && requiresLegacyStabilization(clip) && (
        <Button label={piEditorLabel("Remove legacy stabilization")} variant="secondary" size="sm"
          onClick={() => {
            void useProjectStore.getState().executeAction({
              type: "clip/setStabilization",
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              params: { clipId: clip.id, stabilization: { ...clip.stabilization, enabled: false } },
            });
          }} />
      )}
      {showVideoControls &&
        selectedClip &&
        !selectedClip.mediaId.startsWith("text-") &&
        !selectedClip.mediaId.startsWith("shape-") &&
        !selectedClip.mediaId.startsWith("svg-") &&
        !selectedClip.mediaId.startsWith("sticker-") && (
          <InspectorSection
            title="Speed Curves"
            sectionId="speed-curves"
            defaultOpen={false}
          >
            <SpeedRampSection clip={selectedClip as Clip} />
          </InspectorSection>
        )}
    </>
  );
};
