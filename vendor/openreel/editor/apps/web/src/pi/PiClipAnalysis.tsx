import { useEffect, useRef, useState } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { piEditorLabel, usePiEditorCopy } from "./editor-copy";
import { piPanelErrorFrom } from "./pi-panel-copy";
import { capturePiAnalysisTarget } from "./environment";
import { createPiAnalysisJob, type SilenceRange } from "./pi-analysis";

type PiAnalysisJob = ReturnType<typeof createPiAnalysisJob>;
type RipplePreview = Awaited<ReturnType<PiAnalysisJob["previewSilence"]>>;

const EMPTY_SILENCE: Readonly<Record<string, string>> = {
  ALL_QUIET: "The entire selection is quiet. No cut was proposed.",
  DIALOGUE_OVERLAP: "Other dialogue overlaps this selection. No cut was proposed.",
  NO_SILENCE: "No silence was detected on this clip.",
};

function seconds(time: number): string {
  const value = time.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value + piEditorLabel(" sec");
}

export function PiClipAnalysis({ clipId }: { clipId: string }) {
  const label = usePiEditorCopy();
  const job = useRef<PiAnalysisJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [ranges, setRanges] = useState<SilenceRange[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [preview, setPreview] = useState<RipplePreview | null>(null);
  const selected = ranges.filter((_range, index) => !excluded.has(index));

  function releaseJob() {
    const previous = job.current;
    job.current = null;
    if (previous) {
      void previous.cancel().catch((reason: unknown) => {
        console.warn("[PiDraft] Could not cancel OpenReel analysis", reason);
      });
    }
  }

  useEffect(() => releaseJob, []);

  async function perform(task: PiAnalysisJob, operation: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await operation();
    } catch (reason) {
      if (job.current !== task) return;
      setError(reason instanceof Error ? reason : new Error("Local analysis failed. Check the saved clip and try again."));
      setStatus("");
      setPreview(null);
    } finally {
      if (job.current === task) setBusy(false);
    }
  }

  function start() {
    releaseJob();
    setStatus("");
    setError(null);
    setRanges([]);
    setExcluded(new Set());
    setPreview(null);
    const target = capturePiAnalysisTarget();
    if (!target) {
      setError(new Error("Save the current draft before analyzing this clip."));
      return;
    }
    const task = createPiAnalysisJob(target, crypto.randomUUID());
    job.current = task;
    void perform(task, async () => {
      const result = await task.silence(clipId);
      if (job.current !== task) return;
      setRanges(result.ranges);
      if (!result.ranges.length) setStatus(EMPTY_SILENCE[result.reason ?? "NO_SILENCE"] ?? EMPTY_SILENCE.NO_SILENCE);
    });
  }

  function previewSelected() {
    const task = job.current;
    if (!task || !selected.length) return;
    void perform(task, async () => {
      const result = await task.previewSilence(selected);
      if (job.current === task) setPreview(result);
    });
  }

  function commit() {
    const task = job.current;
    if (!task || !preview) return;
    void perform(task, async () => {
      await task.applySilence(selected);
      if (job.current !== task) return;
      setRanges([]);
      setPreview(null);
      setStatus("Silence cuts saved.");
    });
  }

  return (
    <div className="space-y-2 text-xs text-fg-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          label={label("Detect silence")}
          size="sm" onClick={start} isDisabled={busy}
        />
        {busy && <Button label={label("Cancel analysis")} size="sm" variant="secondary" onClick={() => {
          releaseJob();
          setBusy(false);
          setStatus("Analysis stopped.");
          setRanges([]);
          setPreview(null);
        }} />}
      </div>
      {status && <p role="status">{label(status)}</p>}
      {error && <p role="alert">{piPanelErrorFrom(error, "Local analysis failed. Check the saved clip and try again.")}</p>}
      {ranges.length > 0 && <>
        <fieldset disabled={busy} className="max-h-40 overflow-y-auto">
          <legend>{label("Silence ranges to remove")}</legend>
          {ranges.map(({ start, end }, index) => <label className="flex items-center gap-2" key={index}>
            <input type="checkbox" checked={!excluded.has(index)} onChange={(event) => {
              const checked = event.target.checked;
              setExcluded(current => {
                const next = new Set(current);
                if (checked) next.delete(index);
                else next.add(index);
                return next;
              });
              setPreview(null);
            }} />
            {seconds(start)} – {seconds(end)}
          </label>)}
        </fieldset>
        {!preview && <Button label={label("Preview timeline cut")} size="sm" onClick={previewSelected} isDisabled={busy || !selected.length} />}
        {preview && <>
          <p role="status">{label("Remove")} {seconds(preview.removedDuration)} · {label("New duration")} {seconds(preview.duration)} · {label("Affected tracks")} {preview.affectedTrackIds.length}</p>
          <Button label={label("Confirm and save timeline cut")} size="sm" onClick={commit} isDisabled={busy} />
        </>}
      </>}
    </div>
  );
}
