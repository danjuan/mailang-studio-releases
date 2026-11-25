import { PluginProjectMediaStore, projectMediaError } from "./plugin-project-media-store";
import { PluginSessionMediaStore } from "./plugin-session-media-store";
import type { SessionMediaSurface } from "./plugin-session-media-protocol";

type Owner = { manifest: { id: string }; permissions: ReadonlySet<string>; disposing: boolean };
type Selection = { sessionId: string; projectPath: string | null; signal: AbortSignal };
type MediaContext = {
  active: boolean;
  projectPath: string | null;
  projectId?: number | null;
  projectMediaKey?: string | null;
};
type Options = {
  dataDir: string;
  captureSelection: () => Selection | null;
  getSession: (id: string) => Promise<MediaContext>;
  isCurrentOwner: (owner: Owner) => boolean;
  isInScope: (pluginId: string, projectPath: string | null) => boolean;
};

function unsupported() {
  return projectMediaError("UNSUPPORTED", "Project media requires a registered local Desktop project.");
}

function changed() {
  return projectMediaError("WORKSPACE_CHANGED", "The active project selection changed.");
}

function local(path: string | null): path is string {
  return !!path && !path.startsWith("remote-project:");
}

export class PluginProjectMedia {
  private readonly store: PluginProjectMediaStore;
  private readonly sessionMedia: PluginSessionMediaStore;

  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.store = new PluginProjectMediaStore(options.dataDir);
    this.sessionMedia = new PluginSessionMediaStore(options.dataDir);
  }

  private authorized(owner: Owner): boolean {
    return !owner.disposing && owner.permissions.has("project.media") && this.options.isCurrentOwner(owner);
  }

  private async access(owner: Owner, sessionId: unknown, surface: SessionMediaSurface) {
    const pluginId = owner.manifest.id;
    const selection = this.options.captureSelection();
    if (typeof sessionId !== "string" || sessionId !== selection?.sessionId) throw changed();
    if (!local(selection.projectPath) || /^(?:native-pi:|remote:)/.test(sessionId)) throw unsupported();
    const assertCurrent = () => {
      surface.assertEntry();
      if (selection.signal.aborted || !this.options.isInScope(pluginId, selection.projectPath)) throw changed();
      if (!this.authorized(owner)) throw projectMediaError("PERMISSION_DENIED", "Project media permission is required.");
    };
    assertCurrent();
    const context = await this.options.getSession(sessionId);
    assertCurrent();
    const { projectMediaKey, projectId, projectPath } = context;
    if (!context.active || !local(projectPath) || typeof projectId !== "number" ||
        !Number.isSafeInteger(projectId) || projectId <= 0 ||
        typeof projectMediaKey !== "string" || !/^[\da-f]{64}$/.test(projectMediaKey) ||
        !this.options.isInScope(pluginId, projectPath)) {
      throw unsupported();
    }
    if (projectPath !== selection.projectPath) throw changed();
    const revalidate = async () => {
      assertCurrent();
      const current = await this.options.getSession(sessionId);
      assertCurrent();
      if (!current.active || current.projectMediaKey !== projectMediaKey ||
          current.projectPath !== projectPath || current.projectId !== projectId ||
          !this.options.isInScope(pluginId, current.projectPath)) throw changed();
    };
    return { assertCurrent, revalidate, scope: { projectKey: projectMediaKey, pluginId }, sessionId };
  }

  async fromPanel(owner: Owner, surface: SessionMediaSurface | undefined, method: string, input?: Record<string, unknown>) {
    if (!surface || !this.authorized(owner)) {
      if (method === "projectMedia.capabilities") return { available: false };
      throw projectMediaError("PERMISSION_DENIED", "Project media requires its grant and an active docked view.");
    }
    if (method === "projectMedia.capabilities") {
      try {
        await this.access(owner, input?.sessionId, surface);
        return {
          available: true,
          ...(input?.imageImport === true ? { imageImport: true } : {}),
          ...(input?.subjectCategories === true ? { subjectCategories: true } : {}),
        };
      } catch {
        return { available: false };
      }
    }
    const access = await this.access(owner, input?.sessionId, surface);
    const { assertCurrent, scope, sessionId } = access;
    switch (method) {
      case "projectMedia.list": {
        const index = await this.store.list(scope);
        await access.revalidate();
        return index;
      }
      case "projectMedia.import": {
        const { kind } = input ?? {};
        if (kind !== undefined && kind !== "image") {
          throw projectMediaError("INVALID_ARGUMENT", "Project import supports an optional image filter.");
        }
        const files = await surface.pickProjectFiles(kind);
        assertCurrent();
        return this.store.add(scope, files.map((path) => ({ path })), access, kind);
      }
      case "projectMedia.addFromSession": {
        if (!owner.permissions.has("session.media")) {
          throw projectMediaError("PERMISSION_DENIED", "Session media permission is required to collect a work.");
        }
        const id = input?.id;
        if (typeof id !== "string") throw projectMediaError("INVALID_ARGUMENT", "Expected a session work identifier.");
        const media = await this.sessionMedia.resolve(scope.pluginId, sessionId, id);
        assertCurrent();
        const [asset] = await this.store.add(scope, [{
          path: media.path, sourceRecordId: id, name: media.kind === "image" ? "Generated image" : "Generated video",
        }], access);
        return asset;
      }
      case "projectMedia.source":
      case "projectMedia.export": {
        const media = await this.store.resolve(scope, input?.id);
        assertCurrent();
        return method === "projectMedia.source"
          ? surface.source(sessionId, "project:" + media.asset.id, media, assertCurrent)
          : surface.export(media.asset.id, { ...media, name: media.asset.name }, assertCurrent, access.revalidate);
      }
      case "projectMedia.readFrame": {
        const result = await this.store.readFrame(scope, input?.id);
        await access.revalidate();
        return result;
      }
      case "projectMedia.readReference": {
        const result = await this.store.readReference(scope, input?.id);
        await access.revalidate();
        return result;
      }
      case "projectMedia.renameAsset":
        return this.store.rename(scope, input?.id, input?.name, access);
      case "projectMedia.deleteAsset":
        return this.store.deleteAsset(scope, input?.id, access);
      case "projectMedia.saveSubject":
        return this.store.saveSubject(scope, input ?? {}, access);
      case "projectMedia.deleteSubject":
        return this.store.deleteSubject(scope, input?.id, access);
      default:
        throw projectMediaError("INVALID_ARGUMENT", "Invalid project media request.");
    }
  }
}

const publicMessages: Record<string, string> = {
  ASSET_REFERENCED: "Remove the image from the subjects that use it before deleting it.",
  BUSY: "A project media picker is already open.",
  FRAME_TOO_LARGE: "A reference frame can be up to 5 MiB.",
  REFERENCE_TOO_LARGE: "Project references can be up to 5 MiB per image or 24 MiB per video.",
  INVALID_ARGUMENT: "Check the project media name or selection.",
  INVALID_MEDIA: "Choose a supported image or MP4 within its size limit.",
  NOT_FOUND: "The project media item is unavailable.",
  PERMISSION_DENIED: "This project media operation is not allowed.",
  UNAVAILABLE: "The project media operation could not be completed.",
  UNSUPPORTED: "Project media requires a registered local Desktop project.",
  WORKSPACE_CHANGED: "The active project selection changed.",
};

/** Do not forward native paths, provider data, or system diagnostics to the panel. */
export function publicProjectMediaError(error: unknown): Error {
  const tag = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof tag === "string" && Object.hasOwn(publicMessages, tag) ? tag : "UNAVAILABLE";
  return projectMediaError(code, code + ": " + publicMessages[code]);
}
