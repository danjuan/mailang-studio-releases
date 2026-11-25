import {
  formatPrivateReleaseTag,
  PUBLIC_MAC_DMG_NAME,
  PUBLIC_MAC_LATEST_API,
  type NumberedMacCheckError,
  type UpdateState,
} from "@pi-desktop/shared";

type CheckResult = { number: number } | { error: NumberedMacCheckError };

export function parseNumberedMacTag(tag: unknown): number | undefined {
  if (typeof tag !== "string") return;
  const match = /^openreel-mac-([1-9]\d*)$/.exec(tag);
  if (!match) return;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

function releaseNumber(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return;
  if (!("draft" in value) || value.draft !== false ||
      !("prerelease" in value) || value.prerelease !== false ||
      !("tag_name" in value) ||
      !("assets" in value) || !Array.isArray(value.assets)) return;

  if (!value.assets.some((asset: unknown) =>
    typeof asset === "object" && asset !== null &&
    "name" in asset && asset.name === PUBLIC_MAC_DMG_NAME &&
    "state" in asset && asset.state === "uploaded")) return;
  return parseNumberedMacTag(value.tag_name);
}

async function latestRelease(signal: AbortSignal): Promise<CheckResult> {
  try {
    const response = await fetch(PUBLIC_MAC_LATEST_API, {
      signal,
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) return { error: "rate-limit" };
      return { error: response.status === 404 ? "invalid-release" : "network" };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return { error: error instanceof SyntaxError ? "invalid-release" : "network" };
    }
    const number = releaseNumber(body);
    return number === undefined ? { error: "invalid-release" } : { number };
  } catch {
    return { error: "network" };
  }
}

type Check = { abort: AbortController; manual: boolean; done: Promise<void> };

type UpdateHooks = {
  getState: () => UpdateState;
  publish: (patch: Partial<UpdateState>) => void;
  notice: (number: number, version: string, manual: boolean) => Pick<UpdateState, "dismissed" | "manualReminder">;
};

/** A numbered release only reads public metadata. Native installers have no role in this lane. */
export class NumberedMacUpdates {
  private active?: Check;

  private readonly installed: number;
  private readonly hooks: UpdateHooks;

  constructor(installed: number, hooks: UpdateHooks) {
    this.installed = installed;
    this.hooks = hooks;
  }

  check(manual: boolean, timeoutMs: number): Promise<void> {
    if (this.active) {
      if (manual && !this.active.manual) {
        this.active.manual = true;
        this.hooks.publish({ status: "checking", manual: true, numberedCheckError: undefined });
      }
      return this.active.done;
    }
    const abort = new AbortController();
    const request = { abort, manual, done: Promise.resolve() };
    this.active = request;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    const cancelled = new Promise<CheckResult>(resolve => {
      abort.signal.addEventListener("abort", () => resolve({ error: "network" }), { once: true });
    });
    request.done = Promise.race([latestRelease(abort.signal), cancelled]).then(result => {
      if (this.active !== request) return;
      const explicit = request.manual;
      if ("error" in result) {
        if (!explicit && result.error !== "invalid-release" && this.hooks.getState().status === "available") return;
        this.hooks.publish({
          status: explicit ? "error" : "idle", manual: explicit,
          numberedCheckError: explicit ? result.error : undefined,
          availableVersion: undefined, dismissed: false, manualReminder: false,
        });
      } else if (result.number > this.installed) {
        const version = formatPrivateReleaseTag(result.number);
        this.hooks.publish({
          status: "available", manual: explicit, numberedCheckError: undefined,
          availableVersion: version, ...this.hooks.notice(result.number, version, explicit),
        });
      } else {
        this.hooks.publish({
          status: "up-to-date", manual: explicit, numberedCheckError: undefined,
          availableVersion: undefined, dismissed: false, manualReminder: false,
        });
      }
    }).finally(() => {
      clearTimeout(timer);
      if (this.active === request) this.active = undefined;
    });
    // Keep an existing offer actionable during a background refresh.
    if (manual || this.hooks.getState().status !== "available") {
      this.hooks.publish({ status: "checking", manual, numberedCheckError: undefined });
    }
    return request.done;
  }

  dispose(): void {
    const request = this.active;
    this.active = undefined;
    request?.abort.abort();
  }
}
