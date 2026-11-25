import { draftPath, failure } from "./drafts.mjs";
import { checkArguments } from "./mcp-server.mjs";

const localProjectRequired = () =>
  failure("LOCAL_PROJECT_REQUIRED", "Use Move to project to move this conversation to a local project, then send the request again.");

const workspaceChanged = () =>
  failure("WORKSPACE_CHANGED", "Return to the original project conversation and send the request again.");

export function createOpenEditorTool(api) {
  return {
    name: "open_editor",
    description: "Open or focus the OpenReel editor for the current local project conversation. Call before editing video. If the conversation has no local project, direct the user to Move to project.",
    risk: "low",
    schema: { type: "object", additionalProperties: false, properties: {} },
    async execute(args, toolContext) {
      checkArguments(args);
      if (Object.keys(args).length > 0) {
        throw failure("INVALID_ARGUMENT", "Open the editor without arguments.");
      }
      const { sessionId, turnId, signal, mode, projectPath } = toolContext ?? {};
      if (!sessionId || !turnId || !signal || (mode !== undefined && mode !== "agent")) {
        throw failure("PERMISSION_DENIED", "Opening the editor requires an active agent tool call.");
      }
      signal.throwIfAborted();
      const active = await api.session.getActive();
      signal.throwIfAborted();
      if (typeof active?.projectPath !== "string" || !active.projectPath.startsWith("/")) {
        throw localProjectRequired();
      }
      if (active.sessionId !== sessionId || active.activeTurn?.turnId !== turnId) {
        throw workspaceChanged();
      }
      const workspace = await api.workspace.get();
      signal.throwIfAborted();
      if (!workspace || workspace.remote) throw localProjectRequired();
      if (workspace.path !== active.projectPath || (projectPath !== undefined && projectPath !== workspace.path)) {
        throw workspaceChanged();
      }
      draftPath(sessionId);
      const current = await api.session.getActive();
      signal.throwIfAborted();
      if (current?.sessionId !== sessionId || current.projectPath !== workspace.path || current.activeTurn?.turnId !== turnId) {
        throw workspaceChanged();
      }
      await api.ui.revealView({ viewId: "editor", sessionId });
      return { opened: true };
    },
  };
}
