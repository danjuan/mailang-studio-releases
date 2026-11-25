import type { ActionResult, MediaItem } from "@openreel/core";
import type { PiAnalysisTarget } from "./pi-analysis";

export const isPiEmbedded = true;

type ImportMedia = (file: File) => Promise<ActionResult>;
type RunForDraft = (apply: () => void) => Promise<boolean>;

interface PiDraftActions {
  save: () => Promise<void>;
  reload: () => Promise<void>;
  pickFiles: () => Promise<void>;
  dropFiles: (files: readonly File[]) => Promise<MediaItem[]>;
  replaceMedia: (mediaId: string) => Promise<void>;
  importFile: (file: File, performImport: ImportMedia) => Promise<ActionResult>;
  captureTarget: () => RunForDraft | null;
  captureAnalysisTarget: () => PiAnalysisTarget | null;
  separateAudio: (clipId: string) => Promise<void>;
  cancelAudioSeparation: (jobId: string) => Promise<void>;
}

let draftActions: PiDraftActions | null = null;

export function registerPiDraftActions(actions: PiDraftActions): () => void {
  draftActions = actions;
  return () => {
    if (draftActions === actions) draftActions = null;
  };
}

function getDraftActions(): PiDraftActions {
  if (!draftActions) throw new Error("The session draft is not ready");
  return draftActions;
}

export async function savePiDraft(): Promise<void> {
  await getDraftActions().save();
}

export async function reloadPiDraft(): Promise<void> {
  await getDraftActions().reload();
}

export async function pickPiDraftMedia(): Promise<void> {
  await getDraftActions().pickFiles();
}

export function dropPiDraftMedia(files: readonly File[]): Promise<MediaItem[]> {
  return getDraftActions().dropFiles(files);
}

export function replacePiDraftMedia(mediaId: string): Promise<void> {
  return getDraftActions().replaceMedia(mediaId);
}

export async function importPiDraftMedia(file: File, performImport: ImportMedia): Promise<ActionResult> {
  return getDraftActions().importFile(file, performImport);
}

export function capturePiDraftTarget(): RunForDraft | null {
  return draftActions?.captureTarget() ?? null;
}

export function capturePiAnalysisTarget(): PiAnalysisTarget | null {
  return draftActions?.captureAnalysisTarget() ?? null;
}

export function separatePiDraftAudio(clipId: string): Promise<void> {
  return getDraftActions().separateAudio(clipId);
}

export function cancelPiDraftAudioSeparation(jobId: string): Promise<void> {
  return getDraftActions().cancelAudioSeparation(jobId);
}
