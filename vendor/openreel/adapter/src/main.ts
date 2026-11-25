import { editDraft, editOpenReelTools, openReelToolCatalog, readOpenReelTool } from "./engine";
import { createOpenReelPlugin } from "./plugin.mjs";
import { HeadlessHost } from "@openreel/agent/headless-host";
import { applyAnalyzedCaptions, previewAnalyzedCaptions } from "./mcp-editing-native";
import { analyzeSilence } from "./silence-analysis";
import { probeMedia } from "./media-probe";
import { checkAudioSeparation, editSeparatedAudio } from "./mcp-separate-audio";

const plugin = createOpenReelPlugin(globalThis.pi, editDraft, {
  catalog: openReelToolCatalog,
  read: readOpenReelTool,
  edit: editOpenReelTools,
  probeMedia,
  analyzeSilence,
  checkAudioSeparation,
  editSeparatedAudio,
  previewCaptions: previewAnalyzedCaptions,
  applyCaptions: (project, clipId, cues, replaceCaptionIds, signal) =>
    applyAnalyzedCaptions(new HeadlessHost(structuredClone(project)), clipId, cues, replaceCaptionIds, signal),
});

export async function onLoad() {
  for (const tool of plugin.tools) await globalThis.pi.agent.registerTool(tool);
  globalThis.pi.events?.on("session:activated", plugin.scopeChanged);
  globalThis.pi.events?.on("session:turnEnded", plugin.turnEnded);
}

export function onUnload() {
  globalThis.pi.events?.off("session:activated", plugin.scopeChanged);
  globalThis.pi.events?.off("session:turnEnded", plugin.turnEnded);
  plugin.scopeChanged(null);
}

export const onPanelInvoke = plugin.invokePanel;
export const onMcpMessage = plugin.invokeMcp;
