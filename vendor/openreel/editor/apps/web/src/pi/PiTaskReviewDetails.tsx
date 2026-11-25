import { usePiEditorCopy } from "./editor-copy";
import type { PiEditReviewAction, PiEditReviewImpact, PiEditReviewSnapshot } from "./PiEditReview";

export const reviewTitles = {
  delete_objects: "Delete timeline items",
  ripple_delete_ranges: "Ripple delete",
  apply_timeline_template: "Replace timeline",
} satisfies Record<PiEditReviewAction, string>;

export const reviewStateLabels = {
  pending: "Awaiting confirmation",
  confirming: "Processing decision…",
  applied: "Completed",
  cancelled: "Cancelled",
  expired: "Preview expired",
  failed: "Failed",
} satisfies Record<PiEditReviewSnapshot["state"], string>;

const confirmLabels = {
  delete_objects: "Confirm deletion",
  ripple_delete_ranges: "Confirm ripple deletion",
  apply_timeline_template: "Confirm replacement",
} satisfies Record<PiEditReviewAction, string>;

type ReviewImpactRows = NonNullable<PiEditReviewImpact["targets"]>;
type FormatTimecode = (seconds: number) => string;

function ImpactRows({ title, rows, timecode }: {
  title?: string;
  rows: ReviewImpactRows | undefined;
  timecode: FormatTimecode;
}) {
  if (!rows?.length) return null;
  return (
    <div className="pi-task-review-group">
      {title && <h3>{title}</h3>}
      <ul className="pi-task-center-results">
        {rows.map(({ id, label, text, display }) => (
          <li key={id}>
            {text !== undefined && typeof display?.start === "number" && typeof display.end === "number" && (
              <p className="pi-task-center-timecode">{timecode(display.start)}–{timecode(display.end)}</p>
            )}
            <p className="pi-task-center-cue">{text ?? label}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PiTaskReviewDetails({ review, timecode }: { review: PiEditReviewSnapshot; timecode: FormatTimecode }) {
  const t = usePiEditorCopy();
  const { impact, notice, onCancel, onConfirm, revision, stale, state } = review;
  const pending = state === "pending";
  const awaitingDecision = pending || state === "confirming";
  const targetCount = impact.targets?.length;
  const metadata = typeof targetCount === "number"
    ? t(targetCount === 1 ? "Draft version {revision} · {count} item" : "Draft version {revision} · {count} items")
      .replace("{revision}", String(revision)).replace("{count}", String(targetCount))
    : t("Saved draft version {revision}").replace("{revision}", String(revision));
  const duration = typeof impact.duration === "number" ? impact.duration.toFixed(3) : null;
  const previousDuration = typeof impact.previousDuration === "number" ? impact.previousDuration.toFixed(3) : null;
  const durationLabel = duration === null ? null : previousDuration !== null && previousDuration !== duration
    ? t("Timeline duration: {before} s → {after} s").replace("{before}", previousDuration).replace("{after}", duration)
    : t("Timeline duration {duration} seconds").replace("{duration}", duration);

  return (
    <>
      <div className="pi-task-review-content" role="region" aria-label={t("Edit details")} tabIndex={0}>
        <p className="pi-task-center-secondary">{metadata}</p>
        {awaitingDecision && (
          <>
            <ImpactRows rows={impact.targets} timecode={timecode} />
            <ImpactRows title={t("Transitions to remove")} rows={impact.removedTransitions} timecode={timecode} />
            <ImpactRows title={t("Captions to keep and unlink")} rows={impact.retainedCaptions} timecode={timecode} />
            <ImpactRows title={t("Keyframes to remove")} rows={impact.removedKeyframes} timecode={timecode} />
            {impact.ranges?.length ? (
              <ul className="pi-task-center-results">
                {impact.ranges.map(({ start, end }) => (
                  <li key={start} className="pi-task-center-timecode">{timecode(start)}–{timecode(end)}</li>
                ))}
              </ul>
            ) : null}
            {impact.impact && (
              <p className="pi-task-center-secondary">{t("{captions} captions, {music} music clips and {overlays} overlays affected")
                .replace("{captions}", String(impact.impact.captionCount))
                .replace("{music}", String(impact.impact.musicClipCount))
                .replace("{overlays}", String(impact.impact.overlayCount))}</p>
            )}
            {impact.name && <p className="pi-task-center-cue">{impact.name}</p>}
            {durationLabel && <p className="pi-task-review-duration pi-task-center-secondary">{durationLabel}</p>}
            {stale && pending && <p className="pi-task-review-notice" role="status">{t("Save or reload the draft, then request a new edit preview.")}</p>}
          </>
        )}
        {notice && <p className="pi-task-review-notice" role={state === "failed" ? "alert" : "status"}>{t(notice)}</p>}
      </div>
      {awaitingDecision && (
        <footer className="pi-task-review-actions">
          <button type="button" className="pi-task-review-cancel" disabled={!pending || !onCancel} onClick={onCancel}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="pi-task-review-confirm"
            disabled={!pending || stale || !onConfirm}
            data-pi-openreel-confirm={pending && !stale && onConfirm ? review.id : undefined}
            onClick={event => { if (event.isTrusted) onConfirm?.(); }}
          >
            {t(state === "confirming" ? reviewStateLabels.confirming : confirmLabels[review.action])}
          </button>
        </footer>
      )}
    </>
  );
}
