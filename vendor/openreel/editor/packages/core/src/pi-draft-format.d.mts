import type { Project } from "./types/project";
export const OPENREEL_DRAFT_VERSION: 2;
export const OPENREEL_MEDIA_LIMIT: number;
export const OPENREEL_HISTORY_LIMIT: 10;
export type MediaKind = "video" | "audio" | "image";
export interface DraftRecord {
  formatVersion: typeof OPENREEL_DRAFT_VERSION;
  revision: number;
  project: Project | null;
  mediaPaths: Record<string, string>;
}
export function failure(code: string, message: string): Error & { code: string };
export function mediaFormat(path: unknown): { kind: MediaKind; mime: string } | undefined;
export function mediaPath(value: unknown): string;
export function validRevision(value: unknown): value is number;
export function validateDraft(value: unknown, allowEmpty?: boolean): DraftRecord;
