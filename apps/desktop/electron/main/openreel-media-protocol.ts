import type { Protocol, WebContents } from "electron";
import { ScopedMediaRegistry, ScopedMediaScope } from "./scoped-media-protocol";

export const OPENREEL_MEDIA_SCHEME = "openreel-media";
export const OPENREEL_MEDIA_SCHEME_PRIVILEGES = {
  scheme: OPENREEL_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

const MAX_SCOPE_ASSETS = 512;

export { parseMediaByteRange as parseOpenReelByteRange } from "./scoped-media-protocol";

export class OpenReelMediaRegistry extends ScopedMediaRegistry {
  constructor() {
    super(OPENREEL_MEDIA_SCHEME);
  }
}

const registries = new WeakMap<Protocol, OpenReelMediaRegistry>();

export class OpenReelMediaScope extends ScopedMediaScope {
  constructor(registry: OpenReelMediaRegistry) {
    super(registry, MAX_SCOPE_ASSETS);
  }
}

export function registerOpenReelMediaProtocol(protocol: Protocol): OpenReelMediaRegistry {
  const existing = registries.get(protocol);
  if (existing) return existing;
  const registry = new OpenReelMediaRegistry();
  protocol.handle(OPENREEL_MEDIA_SCHEME, request => registry.respond(request));
  registries.set(protocol, registry);
  return registry;
}

export function createOpenReelMediaScope(protocol: Protocol): OpenReelMediaScope {
  return new OpenReelMediaScope(registerOpenReelMediaProtocol(protocol));
}

const contentsScopes = new WeakMap<WebContents, OpenReelMediaScope>();

export function openReelMediaScopeForContents(contents: WebContents): OpenReelMediaScope {
  const existing = contentsScopes.get(contents);
  if (existing) return existing;
  const scope = createOpenReelMediaScope(contents.session.protocol);
  contentsScopes.set(contents, scope);
  contents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) scope.reset();
  });
  contents.once("render-process-gone", () => scope.reset());
  contents.once("destroyed", () => scope.reset());
  return scope;
}
