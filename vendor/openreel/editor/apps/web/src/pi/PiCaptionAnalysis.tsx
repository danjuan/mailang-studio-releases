import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { useTimelineStore } from "../stores/timeline-store";
import { usePiEditorCopy } from "./editor-copy";
import { capturePiAnalysisTarget } from "./environment";
import { createPiAnalysisJob, type CaptionCue, type CaptionPreview, type PiAnalysisTarget } from "./pi-analysis";
import { PiCaptionDraftContext } from "./pi-caption-draft";
import { piPanelErrorFrom, withOpenReelPanelResults } from "./pi-panel-copy";

type Pending = "configuring" | "generating" | "applying" | "exporting";
type Operation = { kind: Pending };
type Job = { id: string; target: PiAnalysisTarget; analysis: ReturnType<typeof createPiAnalysisJob> };

const phases: Readonly<Record<string, string>> = {
  extracting: "Extracting the audio track", uploading: "Uploading clip audio", waiting: "Waiting for subtitles",
};

function readCaptionSettings(reply: unknown) {
  if (!reply || typeof reply !== "object" || !("endpoint" in reply) ||
    (typeof reply.endpoint !== "string" && reply.endpoint !== null)) throw new Error("Invalid OpenReel analysis result.");
  const suggestedEndpoint = "suggestedEndpoint" in reply && typeof reply.suggestedEndpoint === "string" ? reply.suggestedEndpoint : "";
  return { endpoint: reply.endpoint, address: reply.endpoint ?? suggestedEndpoint };
}

export function PiCaptionAnalysis({ clipId }: { clipId: string }) {
  const t = usePiEditorCopy();
  const draft = useContext(PiCaptionDraftContext);
  const sessionId = draft?.context?.sessionId;
  const projectPath = draft?.context?.projectPath;
  const [endpoint, setEndpoint] = useState<string | null>();
  const [address, setAddress] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const [language, setLanguage] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState("Extracting the audio track");
  const [preview, setPreview] = useState<CaptionPreview | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>();
  const operation = useRef<Operation | null>(null);
  const job = useRef<Job | null>(null);
  const stopAudition = useRef<(() => void) | null>(null);
  const canGenerate = !!draft?.ready && !draft.dirty && !draft.busy && draft.revision > 0 && draft.newerRevision === null;

  const releaseJob = useCallback(() => {
    stopAudition.current?.();
    const previous = job.current;
    job.current = null;
    void previous?.analysis.cancel().catch(() => {
      console.warn("[OpenReel] Could not cancel the caption preview.");
    });
  }, []);

  const discard = useCallback((message: string) => {
    releaseJob();
    operation.current = null;
    setPending(null);
    setPreview(null);
    setStatus(message);
    setError(undefined);
  }, [releaseJob]);

  useEffect(() => {
    const native = window.pluginBridge;
    if (!native || !sessionId || !projectPath) return;
    const bridge = withOpenReelPanelResults(native);
    let active = true;
    setEndpoint(undefined);
    setShowSettings(false);
    void bridge.invoke("openreel.analysis.captionSettings", { sessionId, projectPath }).then(reply => {
      if (!active) return;
      const settings = readCaptionSettings(reply);
      setEndpoint(settings.endpoint);
      setAddress(settings.address);
    }).catch(reason => { if (active) setError(reason); });
    const stopProgress = bridge.on("openreel:jobProgress", payload => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as Record<string, unknown>;
      if (event.sessionId === sessionId && event.projectPath === projectPath && event.jobId === job.current?.id &&
        typeof event.phase === "string" && Object.hasOwn(phases, event.phase)) setPhase(phases[event.phase]);
    });
    const stopSettings = bridge.on("openreel:captionSettingsChanged", () => {
      if (operation.current?.kind === "configuring") return;
      discard("Caption service settings changed. Generate a new preview.");
      setSettingsAttempt(value => value + 1);
    });
    return () => {
      active = false;
      releaseJob();
      operation.current = null;
      stopProgress();
      stopSettings();
    };
  }, [sessionId, projectPath, settingsAttempt, discard, releaseJob]);

  useEffect(() => {
    if (job.current && operation.current?.kind !== "applying" && !job.current.target.isCurrent()) {
      discard("The saved draft changed. Generate a new caption preview.");
    }
  }, [draft, discard]);

  function begin(kind: Pending) {
    if (operation.current) return null;
    const ticket = { kind };
    operation.current = ticket;
    setPending(kind);
    setError(undefined);
    setStatus("");
    return ticket;
  }

  function finish(ticket: Operation) {
    if (operation.current === ticket) {
      operation.current = null;
      setPending(null);
    }
  }

  async function configure(value: string | null) {
    const native = window.pluginBridge;
    if (!native || !sessionId || !projectPath) return;
    const ticket = begin("configuring");
    if (!ticket) return;
    releaseJob();
    setPreview(null);
    try {
      const settings = readCaptionSettings(await withOpenReelPanelResults(native).invoke("openreel.analysis.configureCaptions", {
        sessionId, projectPath, endpoint: value,
      }));
      if (operation.current !== ticket) return;
      setEndpoint(settings.endpoint);
      setAddress(settings.address);
      setShowSettings(false);
    } catch (reason) {
      if (operation.current === ticket) setError(reason);
    } finally { finish(ticket); }
  }

  async function generate() {
    const target = capturePiAnalysisTarget();
    if (!target || !endpoint) return;
    const ticket = begin("generating");
    if (!ticket) return;
    releaseJob();
    setPreview(null);
    setPhase("Extracting the audio track");
    const id = crypto.randomUUID();
    const current = { id, target, analysis: createPiAnalysisJob(target, id) };
    job.current = current;
    try {
      const result = await current.analysis.caption(clipId, language);
      if (job.current === current) setPreview(result);
    } catch (reason) {
      if (job.current === current) { releaseJob(); setError(reason); }
    } finally {
      finish(ticket);
    }
  }

  async function save(action: "applying" | "exporting") {
    const current = job.current;
    if (!current || !preview) return;
    const ticket = begin(action);
    if (!ticket) return;
    stopAudition.current?.();
    try {
      if (action === "exporting") {
        const saved = await current.analysis.saveSrt();
        if (saved && job.current === current) setStatus("SRT saved.");
      } else {
        await current.analysis.applyCaption();
        if (job.current === current) {
          job.current = null;
          setPreview(null);
          setStatus("Captions saved. The previous draft is available in project history.");
        }
      }
    } catch (reason) {
      if (job.current === current) {
        if (action === "applying" || !current.target.isCurrent() ||
          (reason && typeof reason === "object" && "code" in reason &&
            ["REVISION_CONFLICT", "OPENREEL_CAPTION_SETTINGS_CHANGED"].includes(String(reason.code)))) {
          releaseJob();
          setPreview(null);
        }
        setError(reason);
      }
    } finally { finish(ticket); }
  }

  function audition(cue: CaptionCue) {
    stopAudition.current?.();
    const { pause, seekTo, play } = useTimelineStore.getState();
    pause();
    seekTo(cue.startTime);
    const stop = useTimelineStore.subscribe(({ playheadPosition, playbackState }) => {
      if (playbackState !== "playing" || playheadPosition >= cue.endTime) stopAudition.current?.();
    });
    stopAudition.current = () => { stopAudition.current = null; stop(); pause(); };
    play();
    if (useTimelineStore.getState().playbackState !== "playing") stopAudition.current?.();
  }

  return (
    <div className="space-y-3 text-xs text-fg-2">
      <Button label={t("Caption service settings")} size="sm" variant="secondary" isDisabled={pending !== null}
        onClick={() => {
          if (endpoint === undefined) { setError(undefined); setSettingsAttempt(value => value + 1); }
          else setShowSettings(!showSettings);
        }} />
      {endpoint === undefined && !error && <p role="status">{t("Checking caption service settings…")}</p>}
      {(endpoint === null || showSettings) && (
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void configure(address.trim()); }}>
          <label className="block">
            {t("Caption service address")}
            <input type="url" value={address} onChange={event => setAddress(event.currentTarget.value)} required
              className="block w-full min-w-0 rounded-md border border-border bg-bg-1 px-2 py-1.5 text-fg" disabled={pending !== null} />
          </label>
          <p>{t("Enabling the service lets this panel and the editing expert send selected clip audio to this address.")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" label={t("Save and enable caption service")} size="sm" isDisabled={!address.trim() || pending !== null} />
            {endpoint && <Button type="button" label={t("Disable caption service")} size="sm" variant="secondary"
              isDisabled={pending !== null} onClick={() => void configure(null)} />}
          </div>
        </form>
      )}
      {endpoint && !showSettings && (
        <>
          <p>{t("Only the selected clip audio is sent to the configured caption service.")}</p>
          <label className="block">
            {t("Spoken language")}
            <select className="block w-full min-w-0 rounded-md border border-border bg-bg-1 px-2 py-1.5 text-fg"
              value={language} disabled={pending !== null} onChange={event => {
                discard("");
                setLanguage(event.currentTarget.value);
              }}>
              <option value="">{t("Auto-detect")}</option>
              <option value="en">{t("English")}</option>
              <option value="zh">{t("Chinese")}</option>
            </select>
          </label>
          {!canGenerate && <p>{t("Save the current draft before analyzing this clip.")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button label={t("Generate cloud captions")} size="sm" onClick={() => void generate()}
              isDisabled={!canGenerate || pending !== null} />
            {pending === "generating" && <Button label={t("Cancel analysis")} size="sm" variant="secondary"
              onClick={() => discard("Caption analysis stopped on this Mac.")} />}
          </div>
        </>
      )}
      {pending === "generating" && <p role="status">{t(phase)}</p>}
      {pending === "applying" && <p role="status">{t("Saving captions")}</p>}
      {status && <p role="status">{t(status)}</p>}
      {error != null && <p role="alert">{piPanelErrorFrom(error, "Could not complete cloud captions. Try again.")}</p>}
      {preview && !showSettings && (
        <>
          <p>{t("{count} new captions").replace("{count}", String(preview.cues.length))}</p>
          {preview.unknownOverlapCount > 0 && <p>{t("{count} overlapping captions of unknown origin will be kept.")
            .replace("{count}", String(preview.unknownOverlapCount))}</p>}
          <ol aria-label={t("Caption preview")} className="max-h-48 space-y-2 overflow-y-auto">
            {preview.cues.map((cue, index) => (
              <li key={index} className="break-words">
                <span className="tabular-nums">{cue.startTime.toFixed(3)} – {cue.endTime.toFixed(3)} {t(" sec").trim()}</span>
                <p className="whitespace-pre-wrap">{cue.text}</p>
                <Button label={t("Listen to caption {number}").replace("{number}", String(index + 1))} size="sm"
                  variant="secondary" onClick={() => audition(cue)} isDisabled={pending !== null} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button label={t("Save clip SRT")} size="sm" variant="secondary" onClick={() => void save("exporting")}
              isDisabled={pending !== null} />
            <Button label={preview.replaceCount > 0 ? t("Replace {count} automatic captions").replace("{count}", String(preview.replaceCount))
              : t("Save editable captions")} size="sm" onClick={() => void save("applying")} isDisabled={pending !== null || !canGenerate} />
          </div>
          <p>{t("The saved SRT starts at the beginning of the uploaded audio.")}</p>
        </>
      )}
    </div>
  );
}
