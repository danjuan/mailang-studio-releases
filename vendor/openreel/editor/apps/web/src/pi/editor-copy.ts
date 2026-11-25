import { useSyncExternalStore } from "react";
import { piEditorLabel, piEditorLocale, subscribePiEditorLocale, usesChinesePiEditorCopy } from "./editor-copy-runtime";

export { piEditorLabel, usesChinesePiEditorCopy };
export type PiEditorTranslator = (text: string) => string;

/** Subscribe without remounting the editor, including active draft operations. */
export function usePiEditorLocale() {
  return useSyncExternalStore(subscribePiEditorLocale, piEditorLocale, piEditorLocale);
}

const identity: PiEditorTranslator = text => text;

export function usePiEditorCopy(): PiEditorTranslator {
  const locale = usePiEditorLocale();
  return locale === "zh-CN" ? piEditorLabel : identity;
}

export function piEditorError(text: string, fallback: string): string {
  const translated = piEditorLabel(text);
  if (!usesChinesePiEditorCopy()) return translated || fallback;
  return translated !== text || /\p{Script=Han}/u.test(translated) ? translated : fallback;
}

const typeLabels: Readonly<Record<string, string>> = {
  audio: "Audio", clip: "Clip", image: "Image", shape: "Shape",
  sticker: "Sticker", svg: "SVG", text: "Text", video: "Video",
};

export function piEditorClipType(type: string, capitalize = false): string {
  if (usesChinesePiEditorCopy() && Object.hasOwn(typeLabels, type)) return piEditorLabel(typeLabels[type]);
  return capitalize ? type.charAt(0).toUpperCase() + type.slice(1) : type;
}
