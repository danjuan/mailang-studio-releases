import { useTranslation } from "react-i18next";
import { OPENREEL_EXPERT_PLUGIN_ID, OPENREEL_EXPERT_WRITE_TOOL, type UiMessage } from "@pi-desktop/shared";
import { pluginToolName } from "@pi-desktop/plugin-sdk";
import { Button } from "../../../components/ui";
import { useChatNativeFilesAllowed } from "../../../hooks/use-chat-session-capability";
import { api } from "../../../lib/api";
import { openReelExportResult } from "../../../lib/openreel-export-result";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";

const openReelToolName = pluginToolName(OPENREEL_EXPERT_PLUGIN_ID, OPENREEL_EXPERT_WRITE_TOOL);

export function OpenReelExportResult({ message }: { message: UiMessage }) {
  return message.toolName === openReelToolName && message.toolStatus === "success"
    ? <OpenReelExportButton payload={toolResultPayload(message)} />
    : null;
}

function OpenReelExportButton({ payload }: { payload: unknown }) {
  const { t, i18n } = useTranslation();
  const nativeFiles = useChatNativeFilesAllowed();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore(state => paneSessionId || state.activeSessionId);
  const showToast = useAppStore(state => state.showToast);
  const artifact = sessionId && nativeFiles ? openReelExportResult(payload, sessionId) : null;
  if (!sessionId || !artifact) return null;
  const duration = new Intl.NumberFormat(i18n.language, {
    style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 2,
  }).format(artifact.duration);
  const summary = [artifact.format.toUpperCase(), duration,
    artifact.dimensions && `${artifact.dimensions.width} × ${artifact.dimensions.height}`].filter(Boolean).join(" · ");
  return (
    <Button type="button" variant="ghost" size="sm" title={`${t("chat.openFile")} · ${artifact.label}`}
      onClick={() => {
        void api.fsOpen(artifact.path, artifact.mimeType, sessionId).catch(() =>
          showToast(t("panel.files.openFailed"), { variant: "error" })
        );
      }}>
      {summary}
    </Button>
  );
}
