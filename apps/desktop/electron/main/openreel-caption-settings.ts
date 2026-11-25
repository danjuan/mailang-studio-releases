import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePluginTextAtomic } from "./plugin-fs-operation";
import { normalizeOpenReelCaptionEndpoint, parseOpenReelCaptionEndpoint } from "./openreel-caption-network";

export type OpenReelCaptionBinding = { endpoint: string; signal: AbortSignal; assertCurrent(): void };

const settingsChanged = () => Object.assign(new Error("The caption service settings changed."), {
  code: "OPENREEL_CAPTION_SETTINGS_CHANGED",
});

function readSuggestedEndpoint(resourcesDir: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(resourcesDir, "openreel-caption-default.json"), "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[OpenReel] The optional caption service preset could not be read.");
    }
    return null;
  }
  if (!value || typeof value !== "object" || !("endpoint" in value)) return null;
  try { return parseOpenReelCaptionEndpoint(value.endpoint).origin; } catch { return null; }
}

/** This configuration belongs to the host, outside the plugin's writable settings. */
export class OpenReelCaptionSettings {
  private current: { path: string; endpoint: string | null; controller: AbortController } | undefined;
  private saving = false;

  read(dataDir: string) {
    const path = join(dataDir, "openreel-caption-service.json");
    if (this.current?.path === path) return this.current;
    let endpoint: string | null = null;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (value && typeof value === "object" && "endpoint" in value && typeof value.endpoint === "string") {
        endpoint = value.endpoint;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.current?.controller.abort(settingsChanged());
    return this.current = { path, endpoint, controller: new AbortController() };
  }

  view(dataDir: string, resourcesDir = process.resourcesPath) {
    const { endpoint } = this.read(dataDir);
    const suggestedEndpoint = endpoint === null ? readSuggestedEndpoint(resourcesDir) : null;
    return { endpoint, suggestedEndpoint };
  }

  bind(dataDir: string): OpenReelCaptionBinding {
    const saved = this.read(dataDir);
    const endpoint = normalizeOpenReelCaptionEndpoint(saved.endpoint);
    const signal = saved.controller.signal;
    return { endpoint, signal, assertCurrent: () => signal.throwIfAborted() };
  }

  async save(dataDir: string, value: unknown, guard: () => void) {
    if (this.saving) throw Object.assign(new Error("Caption service settings are being saved."), { code: "BUSY" });
    const { path, endpoint: previous } = this.read(dataDir);
    const endpoint = value === null ? null : normalizeOpenReelCaptionEndpoint(value);
    guard();
    if (previous === endpoint) return { endpoint };
    this.saving = true;
    try {
      const result = await writePluginTextAtomic(path, JSON.stringify({ endpoint }), guard);
      this.current?.controller.abort(settingsChanged());
      this.current = { path, endpoint, controller: new AbortController() };
      if (result.durabilityError) console.warn("[OpenReel] Caption service settings could not be flushed to disk.");
      return { endpoint };
    } finally {
      this.saving = false;
    }
  }
}
