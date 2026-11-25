import { useLayoutEffect, useRef } from "react";
import { sameContext, type DraftState, type PiContext } from "./pi-draft";
import { piPanelErrorFrom, withOpenReelPanelResults } from "./pi-panel-copy";

export type PiEditReviewImpactRow = { id: string; label: string; text?: string; display?: { name?: string; start?: number; end?: number } };
export type PiEditReviewImpact = {
  targets?: PiEditReviewImpactRow[]; removedTransitions?: PiEditReviewImpactRow[];
  retainedCaptions?: PiEditReviewImpactRow[]; removedKeyframes?: PiEditReviewImpactRow[];
  ranges?: Array<{ start: number; end: number }>;
  impact?: { captionCount: number; musicClipCount: number; overlayCount: number };
  name?: string; duration?: number; previousDuration?: number;
};

const actions = ["delete_objects", "ripple_delete_ranges", "apply_timeline_template"] as const;
export type PiEditReviewAction = (typeof actions)[number];
type Review = {
  id: string; action: PiEditReviewAction; revision: number; impact: PiEditReviewImpact;
  state: "pending" | "confirming";
};
type VisibleReview = Omit<Review, "state"> & {
  state: Review["state"] | "applied" | "cancelled" | "expired" | "failed";
  notice?: string;
};
export type PiEditReviewSnapshot = VisibleReview & {
  context: PiContext;
  stale: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
};

const previewEnded = "The edit preview ended. Ask the editing expert for a new preview.";
const failed = "Could not apply the reviewed edit. Request a new preview.";

function parseReview(value: unknown): Review | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Review>;
  return typeof item.id === "string" && actions.some(action => action === item.action) &&
    typeof item.revision === "number" && Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    item.impact && typeof item.impact === "object" && (item.state === "pending" || item.state === "confirming")
    ? item as Review : null;
}

function isOpen(review: VisibleReview) {
  return review.state === "pending" || review.state === "confirming";
}

function staleDraft(draft: DraftState, scope: PiContext, revision: number) {
  return !sameContext(draft.context, scope) || !draft.ready || draft.dirty || draft.busy ||
    draft.revision !== revision || draft.newerRevision !== null;
}

export function PiEditReview({ context, draft, onReviewChange }: {
  context: PiContext;
  draft: DraftState;
  onReviewChange: (snapshot: PiEditReviewSnapshot | null) => void;
}) {
  const observer = useRef(onReviewChange);
  const latestDraft = useRef(draft);
  const reportCurrent = useRef<(() => void) | null>(null);
  const { sessionId, projectPath } = context;

  useLayoutEffect(() => {
    observer.current = onReviewChange;
    latestDraft.current = draft;
    reportCurrent.current?.();
  }, [draft, onReviewChange]);

  useLayoutEffect(() => {
    const native = window.pluginBridge;
    if (!native) return;
    const bridge = withOpenReelPanelResults(native);
    const scope = { sessionId, projectPath };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: VisibleReview | null = null;
    let reported: PiEditReviewSnapshot | null = null;
    let inFlight = false;
    let decisionGeneration = 0;

    function report() {
      if (disposed || !current) return;
      const review = current;
      const pending = review.state === "pending";
      const stale = pending && staleDraft(latestDraft.current, scope, review.revision);
      if (reported?.id === review.id && reported.state === review.state &&
          reported.stale === stale && reported.notice === review.notice &&
          reported.action === review.action && reported.revision === review.revision) return;
      reported = {
        ...review, context: scope, stale,
        ...(pending && !stale ? { onConfirm: () => { void decide(review.id, true); } } : {}),
        ...(pending ? { onCancel: () => { void decide(review.id, false); } } : {}),
      };
      observer.current(reported);
    }

    async function decide(id: string, approved: boolean) {
      const review = current;
      if (disposed || inFlight || review?.id !== id || review.state !== "pending" ||
          (approved && staleDraft(latestDraft.current, scope, review.revision))) return;

      inFlight = true;
      decisionGeneration++;
      current = { ...review, state: "confirming" };
      report();
      try {
        const response = await bridge.invoke(approved ? "openreel.review.confirm" : "openreel.review.cancel", {
          ...scope, id,
        }) as { state?: string } | null;
        if (disposed) return;
        if (response?.state === "applied") {
          current = { ...review, state: "applied",
            notice: "The edit was saved. The previous draft is available in project history." };
        } else if (response?.state === "expired") {
          current = { ...review, state: "expired", notice: previewEnded };
        } else if (response?.state === "cancelled" || response?.state === "stopped") {
          current = { ...review, state: "cancelled", notice: "The edit was not applied." };
        } else {
          current = { ...review, state: "failed", notice: failed };
        }
      } catch (error) {
        if (!disposed) current = { ...review, state: "failed", notice: piPanelErrorFrom(error, failed) };
      } finally {
        inFlight = false;
        report();
      }
    }

    function accept(next: Review | null) {
      if (next) {
        if (current?.id === next.id && !isOpen(current)) return;
        current = next;
      } else if (current && isOpen(current)) {
        current = { ...current, state: "expired", notice: previewEnded };
      }
      report();
    }

    async function poll() {
      if (disposed) return;
      if (!inFlight) {
        const generation = decisionGeneration;
        let next: Review | null;
        try {
          next = parseReview(await bridge.invoke("openreel.review.get", scope));
        } catch {
          next = null;
        }
        if (!disposed && generation === decisionGeneration && !inFlight) accept(next);
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }

    reportCurrent.current = report;
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (reportCurrent.current === report) reportCurrent.current = null;
      if (reported) observer.current(null);
    };
  }, [sessionId, projectPath]);

  return null;
}
