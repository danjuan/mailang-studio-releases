import catalog from "../../vite-plugins/pi-editor-zh-CN.json";
import presetCatalog from "../../vite-plugins/pi-editor-presets-zh-CN.json";
import { isPiEmbedded } from "./environment";

type Locale = "zh-CN" | "en";
type AppearanceBridge = {
  invoke(channel: string): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
};

const translations: Readonly<Record<string, string>> = { ...catalog, ...presetCatalog };
let locale: Locale = isPiEmbedded ? "zh-CN" : "en";
const listeners = new Set<() => void>();

export const piEditorLocale = () => locale;
export const usesChinesePiEditorCopy = () => locale === "zh-CN" && isPiEmbedded;

export function subscribePiEditorLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPiEditorLocale(value: unknown): void {
  if (!isPiEmbedded || typeof value !== "string" || !value.trim()) return;
  const next = /^zh(?:[-_]|$)/i.test(value) ? "zh-CN" : "en";
  if (next === locale) return;
  locale = next;
  listeners.forEach(listener => listener());
}

export function followPiEditorAppearance(
  bridge: AppearanceBridge,
  onPalette?: (palette: "light" | "dark" | undefined) => void,
): () => void {
  let active = true;
  let eventReceived = false;
  const apply = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("locale" in value) setPiEditorLocale(value.locale);
    if ("base" in value) onPalette?.(value.base === "light" || value.base === "dark" ? value.base : undefined);
  };
  const unsubscribe = bridge.on("appearance:changed", value => {
    eventReceived = true;
    if (active) apply(value);
  });
  void bridge.invoke("app.getAppearance").then(value => {
    if (active && !eventReceived) apply(value);
  }).catch((error: unknown) => console.warn("[PiEditor] Could not read host appearance", error));
  return () => {
    active = false;
    unsubscribe();
  };
}

export function piEditorLabel(text: string): string {
  return usesChinesePiEditorCopy() && Object.hasOwn(translations, text) ? translations[text] : text;
}
