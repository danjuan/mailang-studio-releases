import { ArrowLeft, AudioLines, Captions, ClipboardList, ListTodo, Video, VolumeX } from "@/icons/lucide-compat";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { usePiEditorCopy } from "./editor-copy";
import type { CaptionCue, SilenceRange } from "./pi-analysis";
import type { PiEditReviewSnapshot } from "./PiEditReview";
import { PiTaskReviewDetails, reviewStateLabels, reviewTitles } from "./PiTaskReviewDetails";
import "./pi-task-center.css";

const taskIcons = { captions: Captions, video: Video, audio: AudioLines, silence: VolumeX };

export interface PiTaskCenterItem {
  id: string;
  title: string;
  icon?: keyof typeof taskIcons;
  state: "running" | "cancelling" | "done" | "cancelled" | "failed";
  phase?: string;
  progress?: number;
  cancel?: () => void;
  error?: string;
  details?:
    | { kind: "captions"; cues: readonly CaptionCue[] }
    | { kind: "silence"; ranges: readonly SilenceRange[] }
    | { kind: "export"; path: string }
    | { kind: "saved" }
    | { kind: "stale" };
}

const stateLabels = {
  running: "Running",
  cancelling: "Cancelling…",
  done: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
} satisfies Record<PiTaskCenterItem["state"], string>;

function timecode(seconds: number) {
  const total = Math.round(seconds * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const wholeSeconds = Math.floor(total / 1000) % 60;
  const pad = (value: number, digits = 2) => String(value).padStart(digits, "0");
  const clock = `${pad(minutes)}:${pad(wholeSeconds)}.${pad(total % 1000, 3)}`;
  return hours ? `${pad(hours)}:${clock}` : clock;
}

function determinateProgress(item: PiTaskCenterItem) {
  const { progress } = item;
  return item.state === "running" && typeof progress === "number" && progress >= 0 && progress <= 1 ? progress : undefined;
}

function TaskResult({ details }: { details: NonNullable<PiTaskCenterItem["details"]> }) {
  const t = usePiEditorCopy();
  switch (details.kind) {
    case "captions":
      return <>
        <p className="pi-task-center-secondary">{t(details.cues.length === 1 ? "{count} caption" : "{count} captions")
          .replace("{count}", String(details.cues.length))}</p>
        <ol className="pi-task-center-results">
          {details.cues.map(({ startTime, endTime, text }, index) => (
            <li key={index}>
              <p className="pi-task-center-timecode">{timecode(startTime)}–{timecode(endTime)}</p>
              <p className="pi-task-center-cue">{text}</p>
            </li>
          ))}
        </ol>
      </>;
    case "silence":
      return details.ranges.length ? <>
        <p className="pi-task-center-secondary">{t(details.ranges.length === 1 ? "{count} silence range" : "{count} silence ranges")
          .replace("{count}", String(details.ranges.length))}</p>
        <ol className="pi-task-center-results">
          {details.ranges.map(({ start, end }, index) => (
            <li key={index} className="pi-task-center-timecode">{timecode(start)}–{timecode(end)}</li>
          ))}
        </ol>
      </> : <p className="pi-task-center-secondary">{t("No silence ranges were found.")}</p>;
    case "export":
      return <dl className="pi-task-center-results">
        <dt className="pi-task-center-secondary">{t("Exported file")}</dt>
        <dd className="pi-task-center-file">{details.path}</dd>
      </dl>;
    case "saved":
      return <p className="pi-task-center-secondary">{t("Changes saved to the draft.")}</p>;
    case "stale":
      return <p className="pi-task-center-secondary">{t("The saved draft changed. Run analysis again.")}</p>;
  }
}

export function PiTaskCenter({ items, onReturn, review, openReviewId }: {
  items: readonly PiTaskCenterItem[];
  onReturn: () => void;
  review?: PiEditReviewSnapshot | null;
  openReviewId?: string | null;
}) {
  const t = usePiEditorCopy();
  const headerId = useId();
  const tasksId = useId();
  const detailId = useId();
  const [selection, setSelection] = useState<{ id: string; detailOpen: boolean } | null>(null);
  const reviewKey = review ? `review:${review.id}` : null;
  const requestedItem = items.find(item => item.id === selection?.id);
  const selectedReview = review && (reviewKey === selection?.id || !requestedItem) ? review : null;
  const selected = selectedReview ? undefined : (requestedItem ?? items[0]);
  const selectedKey = selectedReview ? reviewKey : selected?.id;
  const detailOpen = Boolean((requestedItem || (review && reviewKey === selection?.id)) && selection?.detailOpen);
  const lastOpenedReview = useRef<string | null>(null);
  const taskList = useRef<HTMLElement>(null);
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const backToEditing = useRef<HTMLButtonElement>(null);
  const backToList = useRef<HTMLButtonElement>(null);
  const nextFocus = useRef<"list" | "detail" | "review" | null>(null);
  const status = (item: PiTaskCenterItem) => item.state === "running" && item.phase ? item.phase : t(stateLabels[item.state]);

  useLayoutEffect(() => { backToEditing.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (!openReviewId || openReviewId !== review?.id || openReviewId === lastOpenedReview.current) return;
    lastOpenedReview.current = openReviewId;
    nextFocus.current = "review";
    setSelection({ id: `review:${openReviewId}`, detailOpen: true });
  }, [openReviewId, review?.id]);

  useLayoutEffect(() => {
    const target = nextFocus.current;
    if (target === "review" && (!detailOpen || selectedReview?.id !== openReviewId)) return;
    nextFocus.current = null;
    if (target === "list") taskList.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    if (target === "review" || (target === "detail" && taskList.current && getComputedStyle(taskList.current).display === "none")) {
      taskHeading.current?.focus();
    }
  }, [detailOpen, openReviewId, selectedReview?.id, selection]);

  function choose(id: string) {
    nextFocus.current = "detail";
    setSelection({ id, detailOpen: true });
  }

  function showList() {
    if (!selectedKey) return;
    nextFocus.current = "list";
    setSelection({ id: selectedKey, detailOpen: false });
  }

  const progress = selected && determinateProgress(selected);
  const empty = !review && items.length === 0;
  return (
    <section className="pi-task-center" aria-labelledby={headerId}>
      <header className="pi-task-center-header">
        <button ref={backToEditing} className="pi-task-center-back" type="button" onClick={onReturn}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t("Back to editing")}
        </button>
        <h1 id={headerId}>{t("Tasks")}</h1>
      </header>
      <div className="pi-task-center-body" data-detail-open={detailOpen} data-empty={empty}>
        <section aria-labelledby={tasksId} className="pi-task-center-list" ref={taskList}>
          <h2 id={tasksId}>{t("Current conversation")}</h2>
          {empty ? <p className="pi-task-center-secondary">{t("No tasks in this conversation.")}</p> : (
            <ul>
              {review && (
                <li>
                  <button type="button" className="pi-task-center-row" data-pi-review-row={review.action}
                    aria-pressed={Boolean(selectedReview)} onClick={() => choose(`review:${review.id}`)}>
                    <ClipboardList size={20} aria-hidden="true" />
                    <span className="pi-task-center-row-copy">
                      <span className="pi-task-center-row-title">{t(reviewTitles[review.action])}</span>
                      <span className="pi-task-center-row-status">{t(reviewStateLabels[review.state])}</span>
                    </span>
                  </button>
                </li>
              )}
              {items.map(item => {
                const fraction = determinateProgress(item);
                const icon = item.icon ?? (item.details?.kind === "captions" || item.details?.kind === "silence"
                  ? item.details.kind : item.details?.kind === "export" ? "video" : undefined);
                const Icon = icon ? taskIcons[icon] : ListTodo;
                return (
                  <li key={item.id}>
                    <button type="button" className="pi-task-center-row" aria-pressed={selected?.id === item.id} onClick={() => choose(item.id)}>
                      <Icon size={20} aria-hidden="true" />
                      <span className="pi-task-center-row-copy">
                        <span className="pi-task-center-row-title">{item.title}</span>
                        <span className="pi-task-center-row-status">
                          <span>{status(item)}</span>
                          {fraction !== undefined && <span>{Math.round(fraction * 100)}%</span>}
                        </span>
                        {fraction !== undefined && <progress aria-hidden="true" max={1} value={fraction} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {(selected || selectedReview) && (
          <section className="pi-task-center-details" aria-labelledby={detailId} tabIndex={selectedReview ? undefined : 0}
            data-pi-openreel-review={selectedReview?.action} onKeyDown={event => {
            if (event.key === "Escape" && backToList.current && getComputedStyle(backToList.current).display !== "none") {
              event.stopPropagation();
              showList();
            }
          }}>
            <button ref={backToList} className="pi-task-center-back pi-task-center-back-list" type="button" onClick={showList}>
              <ArrowLeft size={16} aria-hidden="true" />
              {t("Back to tasks")}
            </button>
            <header className="pi-task-center-detail-header">
              <h2 id={detailId} ref={taskHeading} tabIndex={-1}>{selectedReview ? t(reviewTitles[selectedReview.action]) : selected?.title}</h2>
              {selected?.state === "running" && selected.cancel && (
                <button className="pi-task-center-cancel" type="button" onClick={selected.cancel}>{t("Cancel")}</button>
              )}
            </header>
            {selectedReview && <PiTaskReviewDetails review={selectedReview} timecode={timecode} />}
            {selected && (selected.state === "done" && selected.details
              ? <TaskResult details={selected.details} />
              : <p className="pi-task-center-secondary" role="status">{status(selected)}</p>)}
            {selected?.state === "failed" && selected.error && <p className="pi-task-center-error" role="alert">{selected.error}</p>}
            {progress !== undefined && <div className="pi-task-center-detail-progress">
              <progress aria-label={t("Task progress")} max={1} value={progress} />
              <span aria-hidden="true">{Math.round(progress * 100)}%</span>
            </div>}
          </section>
        )}
      </div>
    </section>
  );
}
