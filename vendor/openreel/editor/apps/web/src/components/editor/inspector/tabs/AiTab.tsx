import React from "react";
import { isPiEmbedded } from "../../../../pi/environment";
import { PiCaptionAnalysis } from "../../../../pi/PiCaptionAnalysis";
import { usePiEditorCopy } from "../../../../pi/editor-copy";
import { Zap, Loader2, Upload } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftCard as Card } from "@openreel/ui";
import { ToolcraftFileDropControl as FileInput } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import { AutoReframeSection } from "../";
import { CaptionEditorPanel } from "../CaptionEditorPanel";
import { AutoEditPanel } from "../../panels/AutoEditPanel";
import { HighlightExtractorPanel } from "../../panels/HighlightExtractorPanel";
import { InspectorSection } from "../shell/InspectorSection";

export interface AiTabProps {
  clipId: string;
  clipType: string | null;
  showAudioEffects: boolean;
  showVideoEffects: boolean;
  handleSRTImport: (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => Promise<void>;
  srtInputRef: React.RefObject<HTMLInputElement | null>;
  handleEnhanceAudio: () => Promise<void>;
  handleAutoColor: () => Promise<void>;
  isEnhancingAudio: boolean;
  audioEnhanced: boolean;
  isApplyingSelectedClipEffect: boolean;
  captionWordsPerLine: number;
  onCaptionWordsPerLineChange: (value: number) => void;
}

export const AiTab: React.FC<AiTabProps> = ({
  clipId,
  clipType,
  showAudioEffects,
  showVideoEffects,
  handleSRTImport,
  srtInputRef,
  handleEnhanceAudio,
  handleAutoColor,
  isEnhancingAudio,
  audioEnhanced,
  isApplyingSelectedClipEffect,
  captionWordsPerLine,
  onCaptionWordsPerLineChange,
}) => {
  const t = usePiEditorCopy();
  const canAnalyzeDialogue =
    showAudioEffects && (clipType === "audio" || clipType === "video");
  const showCaptions = clipType === "video" || canAnalyzeDialogue;

  return (
    <>
      {showCaptions && (
        <>
          <InspectorSection
            title={t("Cloud Auto-Captions")}
            sectionId="auto-captions"
            defaultOpen={false}
          >
            <div className="space-y-3">
              {canAnalyzeDialogue && <PiCaptionAnalysis key={clipId} clipId={clipId} />}
              <FileInput
                ref={srtInputRef}
                label="Import SRT or VTT file"
                isLabelHidden
                value={null}
                accept=".srt,.vtt,text/srt,text/vtt,text/plain"
                onChange={(files) => {
                  const file = Array.isArray(files) ? files[0] : files;
                  if (!file) return;
                  void handleSRTImport({
                    target: { files: [file] },
                  } as unknown as React.ChangeEvent<HTMLInputElement>);
                }}
                className="hidden"
              />
              <Button
                label="Import SRT / VTT as Text"
                onClick={() => srtInputRef.current?.click()}
                variant="secondary"
                size="sm"
                icon={<Upload size={13} aria-hidden />}
                className="w-full justify-center"
              />
            </div>
          </InspectorSection>
        </>
      )}

      {showCaptions && (
        <InspectorSection
          title="Editable Captions"
          sectionId="editable-captions"
          defaultOpen={false}
        >
          <CaptionEditorPanel
            maxWordsPerLine={captionWordsPerLine}
            onMaxWordsPerLineChange={onCaptionWordsPerLineChange}
          />
        </InspectorSection>
      )}

      {!isPiEmbedded && clipType === "video" && (
        <InspectorSection
          title="Auto Reframe"
          sectionId="auto-reframe"
          defaultOpen={false}
        >
          <AutoReframeSection clipId={clipId} />
        </InspectorSection>
      )}

      {!isPiEmbedded && showAudioEffects && (
        <InspectorSection
          title="Beat-Synced Auto-Edit"
          sectionId="auto-edit"
          defaultOpen={false}
        >
          <AutoEditPanel onClose={() => {}} />
        </InspectorSection>
      )}

      {!isPiEmbedded && showAudioEffects && (
        <InspectorSection
          title="Local Highlights"
          sectionId="ai-highlights"
          defaultOpen={false}
        >
          <HighlightExtractorPanel clipId={clipId} />
        </InspectorSection>
      )}

      {(showAudioEffects || showVideoEffects) && (
        <Card
          variant="green"
          padding={4}
          className="relative overflow-hidden border border-primary/30 bg-primary/5"
        >
          <div className="flex items-center gap-2 text-primary mb-3">
            <Zap size={14} />
            <Text type="supporting" color="active" className="text-xs font-bold">
              Quick Actions
            </Text>
          </div>
          <div className="space-y-2">
            {showAudioEffects && (
              <Button
                label={
                  isEnhancingAudio
                    ? "Cleaning up..."
                    : audioEnhanced
                      ? "Noise Reduced"
                      : "Quick Dialogue Cleanup"
                }
                onClick={handleEnhanceAudio}
                isDisabled={isEnhancingAudio || isApplyingSelectedClipEffect}
                variant="secondary"
                size="sm"
                icon={isEnhancingAudio ? <Loader2 size={12} className="animate-spin" aria-hidden /> : undefined}
                className={`w-full justify-center ${
                  audioEnhanced
                    ? "bg-green-500/20 border-green-500 text-green-400"
                    : isEnhancingAudio || isApplyingSelectedClipEffect
                      ? "bg-bg-2 border-border text-fg-3"
                      : "bg-bg-2 hover:bg-primary hover:text-white border-border hover:border-primary"
                }`}
              />
            )}
            {showVideoEffects && (
              <Button
                label={isApplyingSelectedClipEffect ? "Applying..." : "Auto-Color"}
                onClick={handleAutoColor}
                isDisabled={isApplyingSelectedClipEffect}
                variant="secondary"
                size="sm"
                className={`w-full justify-center ${
                  isApplyingSelectedClipEffect
                    ? "bg-bg-2 border-border text-fg-3"
                    : "bg-bg-2 hover:bg-primary hover:text-white border-border hover:border-primary"
                }`}
              />
            )}
          </div>
        </Card>
      )}
    </>
  );
};
