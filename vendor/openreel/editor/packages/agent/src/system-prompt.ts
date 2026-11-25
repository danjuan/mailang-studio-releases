import type { EditingHost } from "./host";
import { serializeEditorState } from "./serialize";
import { toCapabilityDoc } from "./registry";

/**
 * Builds the agent system prompt: tool-usage guidance + the current editor state
 * + the capability reference, so the model can plan edits with valid values.
 */
export function buildSystemPrompt(
  host: EditingHost,
  selectedToolNames?: Iterable<string>,
): string {
  let state = "(no project open)";
  try {
    state = JSON.stringify(serializeEditorState(host.getProject()));
  } catch {
    // no project open
  }
  return [
    "You are OpenReel's video-editing agent. You edit the user's open project by calling tools.",
    "",
    "Guidelines:",
    "- Use the available tools to inspect the project and ground clip, track, and composition IDs before editing.",
    "- Use seconds for timeline positions. For 2D Motion, use canvas pixels for position and degrees for rotation.",
    "- Use create_motion_composition and add_motion_layer for editable 2D motion. Use add_motion_keyframe for animation.",
    "- Insert a composition on the video timeline only when the user asks to use it in their edit.",
    "- Summarize completed edits, saved results, and any errors in plain language.",
    "",
    `Current editor state: ${state}`,
    "",
    toCapabilityDoc(selectedToolNames),
  ].join("\n");
}
