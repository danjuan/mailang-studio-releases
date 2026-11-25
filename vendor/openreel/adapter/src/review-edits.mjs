import { failure, validRevision } from "./drafts.mjs";
import { checkArguments } from "./mcp-server.mjs";

export const reviewedActions = ["delete_objects", "ripple_delete_ranges", "apply_timeline_template"];
const REVIEW_TIMEOUT_MS = 90_000;
const PANEL_CHANNELS = new Set([
  "openreel.review.get", "openreel.review.confirm", "openreel.review.cancel", "openreel.review.release",
]);

export const isReviewChannel = channel => PANEL_CHANNELS.has(channel);

function matchesOrigin(active, origin) {
  return active?.sessionId === origin.sessionId && active.projectPath === origin.projectPath &&
    active.activeTurn?.turnId === origin.turnId;
}

const outcome = (state, revision) => ({ state, revision });

export function createEditReview(api, store, preview, commit) {
  const pending = new Map();

  function settle(proposal, state) {
    if (proposal.state !== "pending") return false;
    proposal.state = state;
    proposal.choice.resolve(state);
    return true;
  }

  async function prepare(args, toolContext) {
    const expiresAt = Date.now() + REVIEW_TIMEOUT_MS;
    checkArguments(args);
    if (Object.keys(args).length !== 3 || !reviewedActions.includes(args.action) ||
        !validRevision(args.expectedRevision)) {
      throw failure("INVALID_ARGUMENT", "Choose an exact reviewable edit and its saved draft revision.");
    }
    checkArguments(args.arguments);
    const { sessionId, turnId, signal } = toolContext ?? {};
    if (typeof turnId !== "string" || !turnId || !signal ||
      (toolContext.mode !== undefined && toolContext.mode !== "agent")) {
      throw failure("PERMISSION_DENIED", "OpenReel review requires a current tool invocation.");
    }
    const context = await store.agentContext(toolContext);
    const origin = { sessionId, projectPath: context.projectPath, turnId };
    async function verifyActive() {
      signal.throwIfAborted();
      if (!matchesOrigin(await api.session.getActive(), origin)) {
        throw failure("WORKSPACE_CHANGED", "The OpenReel review belongs to another conversation or turn.");
      }
      signal.throwIfAborted();
    }
    const scoped = { ...context, verifyActive };
    const edit = structuredClone(args);
    await verifyActive();
    const saved = await store.load(scoped);
    if (saved.revision !== edit.expectedRevision) {
      throw failure("REVISION_CONFLICT", "Read the latest saved draft before requesting another preview.");
    }
    const impact = await preview(scoped, saved, edit);
    await verifyActive();
    if ((await store.load(scoped)).revision !== edit.expectedRevision) {
      throw failure("REVISION_CONFLICT", "The saved draft changed while its edit was being previewed.");
    }
    if (impact === null) return outcome("blank_draft", edit.expectedRevision);
    if (Buffer.byteLength(JSON.stringify(impact), "utf8") > 256 * 1024) {
      throw failure("INVALID_ARGUMENT", "Choose fewer objects so the panel can show the entire preview.");
    }
    if (pending.has(sessionId)) throw failure("BUSY", "Review the pending OpenReel edit before preparing another.");
    if (Date.now() >= expiresAt) return outcome("expired", edit.expectedRevision);

    const proposal = {
      id: globalThis.crypto.randomUUID(), origin, edit, impact, expiresAt, state: "pending",
      choice: Promise.withResolvers(), receipt: Promise.withResolvers(), signal,
    };
    pending.set(sessionId, proposal);
    const onAbort = () => settle(proposal, "stopped");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => settle(proposal, "expired"), expiresAt - Date.now());
    try {
      await verifyActive();
      await api.ui.revealView({ viewId: "editor", sessionId });
      const decision = await proposal.choice.promise;
      if (decision !== "confirming") {
        const result = outcome(decision, edit.expectedRevision);
        proposal.receipt.resolve({ result });
        return result;
      }
      const revision = await commit(scoped, edit, proposal.impact);
      const result = outcome("applied", revision);
      proposal.receipt.resolve({ result });
      return result;
    } catch (error) {
      proposal.receipt.resolve({ error });
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (pending.get(sessionId) === proposal) pending.delete(sessionId);
    }
  }

  async function fromPanel(channel, payload) {
    if (typeof payload?.ownerId !== "string" || !payload.ownerId) {
      throw failure("PERMISSION_DENIED", "Open the review in the current OpenReel panel.");
    }
    const proposal = pending.get(payload.sessionId);
    if (channel === "openreel.review.release") {
      if (proposal?.ownerId === payload.ownerId && proposal.origin.projectPath === payload.projectPath) {
        settle(proposal, "stopped");
      }
      return null;
    }
    const context = await store.panelContext(payload);
    if (!proposal || context.projectPath !== proposal.origin.projectPath ||
        !matchesOrigin(await api.session.getActive(), proposal.origin) ||
        pending.get(payload.sessionId) !== proposal || proposal.signal.aborted) {
      if (channel === "openreel.review.get") return null;
      throw failure("APPROVAL_REQUIRED", "No current OpenReel preview matches this confirmation.");
    }
    if (Date.now() >= proposal.expiresAt && settle(proposal, "expired")) {
      if (channel === "openreel.review.get") return null;
      throw failure("APPROVAL_REQUIRED", "The OpenReel preview expired. Request a new preview.");
    }
    if (channel === "openreel.review.get") {
      if ((proposal.ownerId && proposal.ownerId !== payload.ownerId) ||
        (proposal.state !== "pending" && proposal.state !== "confirming")) return null;
      proposal.ownerId = payload.ownerId;
      return {
        id: proposal.id, action: proposal.edit.action, revision: proposal.edit.expectedRevision,
        impact: proposal.impact, state: proposal.state,
      };
    }
    if (payload.ownerId !== proposal.ownerId || payload.id !== proposal.id ||
        !settle(proposal, channel === "openreel.review.confirm" ? "confirming" : "cancelled")) {
      throw failure("APPROVAL_REQUIRED", "No current OpenReel preview matches this confirmation.");
    }
    const { result, error } = await proposal.receipt.promise;
    if (error) throw error;
    return result;
  }

  function scopeChanged(active) {
    for (const proposal of pending.values()) {
      if (!matchesOrigin(active, proposal.origin)) settle(proposal, "stopped");
    }
  }

  return { prepare, fromPanel, scopeChanged };
}
