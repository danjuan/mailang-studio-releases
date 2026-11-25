import { isNetUrlAllowed, type PluginActiveSession } from "@pi-desktop/plugin-sdk";
import type { PluginFetchTransport } from "./plugin-net-fetch";
import type { SessionMediaSurface } from "./plugin-session-media-protocol";
import { PluginSessionMediaStore } from "./plugin-session-media-store";
import { bundledSessionVideoTools, type SessionVideoTools } from "./plugin-session-video-tools";

type MediaOwner = { manifest: { id: string }; permissions: ReadonlySet<string>; disposing: boolean };
type SessionContext = { active: boolean; projectPath: string | null };

type Options = {
  dataDir: string;
  getActive: () => PluginActiveSession | null;
  getSession: (id: string) => Promise<SessionContext>;
  isCurrentOwner: (owner: MediaOwner) => boolean;
  isInScope: (pluginId: string, projectPath: string | null) => boolean;
  videoTools?: SessionVideoTools;
};

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export class PluginSessionMedia {
  private readonly store: PluginSessionMediaStore;
  private readonly lifetimes = new WeakMap<MediaOwner, AbortController>();
  private readonly canStitch: boolean;

  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    const videoTools = options.videoTools ?? bundledSessionVideoTools();
    this.canStitch = videoTools !== undefined;
    this.store = new PluginSessionMediaStore(options.dataDir, videoTools);
  }

  dispose(owner: MediaOwner): void {
    this.lifetimes.get(owner)?.abort();
    this.lifetimes.delete(owner);
  }

  private assertOwner(owner: MediaOwner): void {
    if (!owner.permissions.has("session.media")) {
      throw failure("PERMISSION_DENIED", "Plugin needs the session.media permission.");
    }
    if (owner.disposing || !this.options.isCurrentOwner(owner)) {
      throw failure("UNAVAILABLE", "The plugin is no longer running.");
    }
  }

  private assertSelected(owner: MediaOwner, sessionId: unknown): asserts sessionId is string {
    this.assertOwner(owner);
    const active = this.options.getActive();
    if (typeof sessionId !== "string" || !active || active.sessionId !== sessionId ||
        !this.options.isInScope(owner.manifest.id, active.projectPath)) {
      throw failure("WORKSPACE_CHANGED", "Select the originating session to use its media.");
    }
  }

  private async assertDurable(owner: MediaOwner, sessionId: string): Promise<void> {
    this.assertOwner(owner);
    if (sessionId.startsWith("native-pi:") || sessionId.startsWith("remote:")) {
      throw failure("UNSUPPORTED", "Media generation requires a local Desktop session.");
    }
    const session = await this.options.getSession(sessionId);
    this.assertOwner(owner);
    if (!session.active || session.projectPath?.startsWith("remote-project:") ||
        !this.options.isInScope(owner.manifest.id, session.projectPath)) {
      throw failure("NOT_FOUND", "The originating local session is unavailable.");
    }
  }

  async fromPlugin(
    owner: MediaOwner, method: string, input: unknown, domains: readonly string[], transport?: PluginFetchTransport,
  ): Promise<unknown> {
    this.assertOwner(owner);
    const id = owner.manifest.id;
    const authorize = (sessionId: string) => this.assertDurable(owner, sessionId);
    const assertMediaUrl = (url: string) => {
      // External media downloads use only declared domains and never inherit provider credentials.
      if (!owner.permissions.has("net.fetch") || !isNetUrlAllowed(url, domains)) {
        throw failure("PERMISSION_DENIED", "The media download host is outside the plugin's allowlist.");
      }
    };
    switch (method) {
      case "sessionMedia.capabilities":
      case "sessionMedia.supportsReferenceFrames":
      case "sessionMedia.supportsImageWorkflows":
      case "sessionMedia.supportsVideoWorkflows":
        return true;
      case "sessionMedia.supportsVideoStitching":
        return this.canStitch;
      case "sessionMedia.reserve":
        return this.store.reserve(id, input, async (sessionId) => {
          this.assertSelected(owner, sessionId);
          await authorize(sessionId);
          this.assertSelected(owner, sessionId);
        });
      case "sessionMedia.update":
        return this.store.update(id, input, authorize);
      case "sessionMedia.archive":
      case "sessionMedia.stageVideo":
      case "sessionMedia.finishVideo": {
        let lifetime = this.lifetimes.get(owner);
        if (!lifetime) {
          lifetime = new AbortController();
          this.lifetimes.set(owner, lifetime);
        }
        if (method === "sessionMedia.finishVideo") {
          return this.store.finishVideo(id, input, authorize, lifetime.signal);
        }
        return method === "sessionMedia.stageVideo"
          ? this.store.stageVideo(id, input, authorize, assertMediaUrl, transport, lifetime.signal)
          : this.store.archive(id, input, authorize, assertMediaUrl, transport, lifetime.signal);
      }
      case "sessionMedia.recoverable": {
        const items = await this.store.recoverable(id);
        const allowed = new Set<string>();
        for (const sessionId of new Set(items.map((item) => item.sessionId))) {
          try {
            await authorize(sessionId);
            allowed.add(sessionId);
          } catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) ||
                (error.code !== "NOT_FOUND" && error.code !== "UNSUPPORTED")) throw error;
          }
        }
        return items.filter((item) => allowed.has(item.sessionId));
      }
      default:
        throw failure("UNSUPPORTED", "Unknown plugin session media operation.");
    }
  }

  async fromPanel(
    owner: MediaOwner, surface: SessionMediaSurface | undefined, method: string, input?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertOwner(owner);
    if (!surface) throw failure("PERMISSION_DENIED", "Session media requires a docked plugin view.");
    if (method === "sessionMedia.capabilities") return true;
    const sessionId = input?.sessionId;
    this.assertSelected(owner, sessionId);
    await this.assertDurable(owner, sessionId);
    const authorize = () => this.assertSelected(owner, sessionId);
    authorize();
    if (method === "sessionMedia.list") {
      const page = await this.store.list(owner.manifest.id, input);
      authorize();
      return page;
    }
    if ((method === "sessionMedia.source" || method === "sessionMedia.export") && typeof input?.id === "string") {
      const item = await this.store.resolve(owner.manifest.id, sessionId, input.id);
      return method === "sessionMedia.source"
        ? surface.source(sessionId, input.id, item, authorize)
        : surface.export(input.id, item, authorize);
    }
    throw failure("INVALID_ARGUMENT", "Invalid session media request.");
  }
}
/** Broker errors cross process boundaries. Send a stable code, not local paths
 * or transport diagnostics that might contain a signed result URL. */
export function publicSessionMediaError(error: unknown): Error {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const messages: Record<string, string> = {
    BUSY: "Media is busy.",
    INVALID_ARGUMENT: "The session media request is invalid.",
    NOT_FOUND: "The session media record is unavailable.",
    PERMISSION_DENIED: "This session media operation is not allowed.",
    TIMEOUT: "The media download timed out.",
    UNAVAILABLE: "The session media operation could not be completed.",
    UNSUPPORTED: "Session media requires a compatible Desktop build and local session.",
    WORKSPACE_CHANGED: "Select the originating session to use its media.",
  };
  if (typeof code === "string" && Object.hasOwn(messages, code)) return failure(code, messages[code]);
  return failure("UNAVAILABLE", messages.UNAVAILABLE);
}
