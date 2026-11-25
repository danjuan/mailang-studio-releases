import type { PiBridge } from "./pi-draft";
import { piEditorError, piEditorLabel } from "./editor-copy";

export function withOpenReelPanelResults(bridge: PiBridge): PiBridge {
  return {
    ...bridge,
    async invoke(channel, payload) {
      if (!channel.startsWith("openreel.") || !bridge.invokeOpenReel) return bridge.invoke(channel, payload);
      const result = await bridge.invokeOpenReel(channel, payload);
      if (!result || typeof result !== "object" || !("ok" in result)) throw new Error("OpenReel request failed.");
      if (result.ok === true && "value" in result) return result.value;
      const failure = "error" in result && result.error && typeof result.error === "object" ? result.error : undefined;
      throw Object.assign(new Error(failure && "message" in failure && typeof failure.message === "string"
        ? failure.message : "OpenReel request failed."), {
        code: failure && "code" in failure && typeof failure.code === "string" ? failure.code : "TOOL_FAILED",
      });
    },
  };
}

const messagesByCode: Readonly<Record<string, string>> = {
  WORKSPACE_CHANGED: "The selected conversation or project changed. Reopen the editor for that conversation.",
  REVISION_CONFLICT: "A newer draft is available. Your unsaved changes are kept.",
  PERMISSION_DENIED: "OpenReel does not have permission for this operation in the current conversation.",
  OPENREEL_DEPENDENCY_UNAVAILABLE: "This installation is missing a local OpenReel media dependency.",
  OPENREEL_CONVERSION_UNAVAILABLE: "This installation is missing the local OpenReel video converter.",
  OPENREEL_CONVERSION_FAILED: "Could not convert the selected video. Check that it plays and try again.",
  OPENREEL_MEDIA_STALLED: "OpenReel stopped making progress reading the media. Check the source and try again.",
  OPENREEL_MEDIA_NO_SPACE: "There is not enough free space in the project. Free up space and try again.",
  OPENREEL_AUDIO_DECODE_FAILED: "Could not decode the selected audio. Try a different clip.",
  OPENREEL_TRANSCRIPTION_BUSY: "Speech recognition is already running. Try again after it finishes.",
  OPENREEL_CAPTION_NOT_CONFIGURED: "Open caption service settings and enable a service before generating subtitles.",
  OPENREEL_CAPTION_NETWORK_POLICY: "This address is blocked by the app network policy. Check the caption service address and network settings.",
  OPENREEL_CAPTION_LOCAL_NETWORK_DENIED: "Allow local network access for 麦浪 studio in macOS System Settings.",
  OPENREEL_CAPTION_UNREACHABLE: "Could not reach the caption service. Check the address and your local network or VPN.",
  OPENREEL_CAPTION_HTTP_400: "The caption service did not accept the upload. Check the service API configuration.",
  OPENREEL_CAPTION_HTTP_422: "The caption service rejected the audio or language. Check the clip and language, then try again.",
  OPENREEL_CAPTION_HTTP_500: "The caption service could not process the audio. Try again when the service is available.",
  OPENREEL_CAPTION_HTTP_OTHER: "The caption service returned an unexpected status. Check the service address and try again.",
  OPENREEL_CAPTION_REDIRECT: "The caption service redirected the request. Configure the direct service address.",
  OPENREEL_CAPTION_INVALID_SRT: "The caption service returned invalid subtitles. Check the service output and try again.",
  OPENREEL_CAPTION_EMPTY_SRT: "No usable subtitles were returned. Existing captions are kept.",
  OPENREEL_CAPTION_SETTINGS_CHANGED: "Caption service settings changed. Generate a new preview.",
  OPENREEL_CAPTION_SOURCE_CHANGED: "The saved draft changed. Generate a new caption preview.",
  OPENREEL_SILENCE_UNAVAILABLE: "This installation is missing the local audio decoder for silence detection.",
  OPENREEL_NO_SPEECH: "No spoken dialogue was detected.",
  NO_AUDIO_TRACK: "The selected clip has no usable audio track.",
  TOO_MANY_RANGES: "Too many silence ranges were found. Choose a shorter clip or raise the minimum silence duration.",
  AUDIO_ALREADY_SEPARATED: "This clip's audio has already been separated.",
  APPROVAL_REQUIRED: "Review and confirm the selected changes before applying them.",
  RENDER_FAILED: "OpenReel could not render this draft. Check the media and try again.",
  TIMEOUT: "The OpenReel operation timed out. Try a shorter clip.",
  OPENREEL_JOB_TIMEOUT: "The OpenReel operation timed out. Try a shorter clip.",
  TOOL_ABORTED: "The OpenReel operation was stopped.",
  PLUGIN_TOOL_ABORTED: "The OpenReel operation was stopped.",
  REMOTE_MEDIA_UNAVAILABLE: "This draft references online media. Import the original file from your computer.",
  INVALID_DRAFT: "OpenReel could not read this draft. Reload the saved draft and try again.",
  HOST_VERSION_MISMATCH: "Update 麦浪 studio to use this OpenReel plugin.",
  NOT_FOUND: "OpenReel could not find the required file or draft. Check the media and try again.",
  BUSY: "OpenReel is already working on an operation. Try again after it finishes.",
  UNSUPPORTED_FORMAT: "Choose a supported local video, audio or image file.",
  LOCAL_PROJECT_REQUIRED: "Select a conversation in a local project to edit video.",
};

export function piPanelError(
  message: string,
  code: unknown,
  fallback: string,
): string {
  if (typeof code === "string" && Object.hasOwn(messagesByCode, code)) return piEditorLabel(messagesByCode[code]);
  return piEditorError(message, piEditorLabel(fallback));
}

export function piPanelErrorFrom(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return piPanelError(error instanceof Error ? error.message : "", code, fallback);
}
