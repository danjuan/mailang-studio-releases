import { BrowserWindow, dialog, type Protocol, type WebContents } from "electron";
import { pathToFileURL } from "node:url";
import { exportScopedMedia, ScopedMediaRegistry, ScopedMediaScope } from "./scoped-media-protocol";

export const SESSION_MEDIA_SCHEME = "pi-plugin-media";

export const SESSION_MEDIA_SCHEME_PRIVILEGES = {
  scheme: SESSION_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

const registries = new WeakMap<Protocol, ScopedMediaRegistry>();
const scopes = new WeakMap<WebContents, { sessionId: string; media: ScopedMediaScope }>();
const entries = new WeakMap<WebContents, string>();
const projectPickers = new WeakSet<WebContents>();

export function registerSessionMediaProtocol(protocol: Protocol): void {
  if (registries.has(protocol)) return;
  const registry = new ScopedMediaRegistry(SESSION_MEDIA_SCHEME);
  protocol.handle(SESSION_MEDIA_SCHEME, (request) => registry.respond(request));
  registries.set(protocol, registry);
}

/** Only the host's registered entry document may use the media bridge. */
export function registerSessionMediaSurface(contents: WebContents, entryPath: string): void {
  entries.set(contents, pathToFileURL(entryPath).href);
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) resetSessionMediaScope(contents);
  });
  contents.once("render-process-gone", () => resetSessionMediaScope(contents));
  contents.once("destroyed", () => resetSessionMediaScope(contents));
}

function isSessionMediaDocument(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  const url = URL.parse(contents.getURL());
  if (!url) return false;
  url.search = "";
  url.hash = "";
  return entries.get(contents) === url.href;
}

export function mayLoadSessionMedia(contents: WebContents | undefined): boolean {
  return contents !== undefined && scopes.has(contents) && isSessionMediaDocument(contents);
}

export function resetSessionMediaScope(contents: WebContents): void {
  const scope = scopes.get(contents);
  scope?.media.reset();
  scopes.delete(contents);
}

type MediaSource = {
  path: string;
  kind: "image" | "video";
  mime?: string;
  extension?: string;
  label?: string;
  name?: string;
};
type Authorize = () => void;

function fileType(kind: MediaSource["kind"]) {
  return kind === "image"
    ? { mime: "image/jpeg", name: "JPEG", extension: "jpg" }
    : { mime: "video/mp4", name: "MP4", extension: "mp4" };
}

export function sessionMediaSurface(contents: WebContents) {
  function assertEntry() {
    if (!isSessionMediaDocument(contents)) throw new Error("The media panel is no longer available.");
  }
  assertEntry();
  function dialogWindow() {
    assertEntry();
    const parent = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getFocusedWindow();
    if (!parent) throw new Error("The media panel is no longer available.");
    return parent;
  }
  return {
    assertEntry,
    async pickProjectFiles(kind?: "image") {
      if (projectPickers.has(contents)) {
        throw Object.assign(new Error("A project media picker is already open."), { code: "BUSY" });
      }
      projectPickers.add(contents);
      try {
        const result = await dialog.showOpenDialog(dialogWindow(), {
          properties: ["openFile", "multiSelections"],
          filters: kind === "image"
            ? [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }]
            : [{ name: "Images and MP4", extensions: ["jpg", "jpeg", "png", "webp", "mp4"] }],
        });
        assertEntry();
        return result.canceled ? [] : result.filePaths;
      } finally {
        projectPickers.delete(contents);
      }
    },
    async source(sessionId: string, id: string, asset: MediaSource, authorize: Authorize) {
      assertEntry();
      authorize();
      const registry = registries.get(contents.session.protocol);
      if (!registry || contents.isDestroyed()) throw new Error("The media panel is no longer available.");
      let scope = scopes.get(contents);
      if (scope?.sessionId !== sessionId) {
        resetSessionMediaScope(contents);
        scope = { sessionId, media: new ScopedMediaScope(registry, 12) };
        scopes.set(contents, scope);
      }
      const result = await scope.media.source(id, asset.path, () => {
        assertEntry();
        authorize();
      }, asset.mime ?? fileType(asset.kind).mime);
      return result.url;
    },
    async export(id: string, asset: MediaSource, authorize: Authorize, revalidate?: () => Promise<void>) {
      authorize();
      const type = fileType(asset.kind);
      const extension = asset.extension ?? type.extension;
      const options = {
        defaultPath: `${asset.name ?? `media-${id}`}.${extension}`,
        filters: [{ name: asset.label ?? type.name, extensions: [extension] }],
      };
      const result = await dialog.showSaveDialog(dialogWindow(), options);
      if (result.canceled || !result.filePath) return false;
      authorize();
      await revalidate?.();
      try {
        await exportScopedMedia(asset.path, result.filePath, () => {
          assertEntry();
          authorize();
        });
      } catch {
        throw new Error("The selected media could not be exported.");
      }
      return true;
    },
  };
}

export type SessionMediaSurface = ReturnType<typeof sessionMediaSurface>;
