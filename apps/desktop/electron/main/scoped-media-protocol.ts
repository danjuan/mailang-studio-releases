import { randomBytes } from "node:crypto";
import { setMaxListeners } from "node:events";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CHUNK_BYTES = 256 * 1024;
const MAX_ACTIVE_READS = 32;

type FileIdentity = { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number };
type Authorize = () => void | Promise<void>;
type Source = { file: string; mime: string; identity: FileIdentity; authorize: Authorize; signal: AbortSignal };

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function parseMediaByteRange(value: string | null, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (value === null) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const from = match[1] ? Number(match[1]) : undefined;
  const to = match[2] ? Number(match[2]) : undefined;
  if ((from !== undefined && !Number.isSafeInteger(from)) ||
      (to !== undefined && !Number.isSafeInteger(to))) return null;
  const start = from ?? Math.max(0, size - (to ?? 0));
  const end = from === undefined ? size - 1 : Math.min(to ?? size - 1, size - 1);
  return start <= end ? { start, end } : null;
}

const baseHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range",
  "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function tokenFrom(raw: string, scheme: string): string | undefined {
  try {
    const url = new URL(raw);
    const token = url.pathname.slice(1);
    if (url.protocol === `${scheme}:` && url.host === "asset" &&
        !url.username && !url.password && !url.search && !url.hash && /^[0-9a-f]{48}$/.test(token)) return token;
  } catch {
    return undefined;
  }
}

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers: { ...baseHeaders, ...headers } });
}

export class ScopedMediaRegistry {
  private assets = new Map<string, Source>();
  private activeReads = 0;

  private readonly scheme: string;

  constructor(scheme: string) {
    this.scheme = scheme;
  }

  async grant(file: string, authorize: Authorize, signal: AbortSignal, mime = "video/mp4") {
    await authorize();
    signal.throwIfAborted();
    const stat = await lstat(file);
    await authorize();
    signal.throwIfAborted();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
      throw Object.assign(new Error("The source is not a readable media file."), { code: "INVALID_MEDIA" });
    }
    const token = randomBytes(24).toString("hex");
    const identity = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
    this.assets.set(token, { file, mime, identity, authorize, signal });
    const discard = () => this.assets.delete(token);
    signal.addEventListener("abort", discard, { once: true });
    return {
      matches: (path: string, current: FileIdentity) => path === file && sameFile(current, identity),
      revoke: () => { signal.removeEventListener("abort", discard); discard(); },
      result: { url: `${this.scheme}://asset/${token}`, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  }

  async respond(request: Request): Promise<Response> {
    const token = tokenFrom(request.url, this.scheme);
    const source = token && this.assets.get(token);
    if (!source || source.signal.aborted) return response(404);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return response(405, { allow: "GET, HEAD, OPTIONS" });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let held = false;
    let handedOff = false;
    const release = () => {
      if (!held) return;
      held = false;
      this.activeReads--;
    };
    try {
      await source.authorize();
      source.signal.throwIfAborted();
      if (request.method === "OPTIONS") return response(204);
      if (this.activeReads >= MAX_ACTIVE_READS) return response(503);
      this.activeReads++;
      held = true;
      handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      await source.authorize();
      source.signal.throwIfAborted();
      if (!info.isFile() || !sameFile(info, source.identity)) return response(409);
      const requestedRange = request.headers.get("range");
      const range = parseMediaByteRange(requestedRange, info.size);
      if (!range) return response(416, { "content-range": `bytes */${info.size}` });
      const headers = {
        ...baseHeaders,
        "content-type": source.mime,
        "content-length": String(range.end - range.start + 1),
        "accept-ranges": "bytes",
        ...(requestedRange === null ? {} : { "content-range": `bytes ${range.start}-${range.end}/${info.size}` }),
      };
      const status = requestedRange === null ? 200 : 206;
      if (request.method === "HEAD") return new Response(null, { status, headers });
      const stream = handle.createReadStream({
        start: range.start,
        end: range.end,
        autoClose: true,
        highWaterMark: CHUNK_BYTES,
        signal: AbortSignal.any([request.signal, source.signal]),
      });
      handle = undefined;
      stream.once("close", release);
      handedOff = true;
      // The stream remains governed by the session/job which issued the grant.
      // Rechecking between bounded chunks stops a read started before a switch.
      const guarded = Readable.from((async function* () {
        try {
          for await (const chunk of stream) {
            await source.authorize();
            source.signal.throwIfAborted();
            yield chunk;
          }
        } finally { stream.destroy(); }
      })(), { objectMode: false, highWaterMark: CHUNK_BYTES });
      guarded.once("close", () => stream.destroy());
      return new Response(Readable.toWeb(guarded, { strategy: { highWaterMark: CHUNK_BYTES, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>, { status, headers });
    } catch {
      return response(403);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!handedOff) release();
    }
  }
}

export class ScopedMediaScope {
  private controller = new AbortController();
  private requests = new Map<string, ReturnType<ScopedMediaRegistry["grant"]>>();
  private readonly registry: ScopedMediaRegistry;

  private readonly maxAssets: number;

  constructor(registry: ScopedMediaRegistry, maxAssets: number) {
    this.maxAssets = maxAssets;
    this.registry = registry;
    setMaxListeners(this.maxAssets + 8, this.controller.signal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async source(key: string, file: string, authorize: Authorize, mime?: string) {
    const signal = this.controller.signal;
    await authorize();
    signal.throwIfAborted();
    const existing = this.requests.get(key);
    if (existing) {
      const supplied = await existing;
      const stat = await lstat(file);
      await authorize();
      signal.throwIfAborted();
      if (stat.isFile() && supplied.matches(file, stat)) return supplied.result;
      supplied.revoke();
      this.requests.delete(key);
    }
    if (this.requests.size >= this.maxAssets) {
      const oldest = this.requests.keys().next().value;
      if (oldest !== undefined) {
        const retired = this.requests.get(oldest);
        this.requests.delete(oldest);
        void retired?.then(result => result.revoke(), () => {});
      }
    }
    const pending = this.registry.grant(file, authorize, signal, mime);
    this.requests.set(key, pending);
    try {
      return (await pending).result;
    } catch (error) {
      if (this.requests.get(key) === pending) this.requests.delete(key);
      throw error;
    }
  }

  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    setMaxListeners(this.maxAssets + 8, this.controller.signal);
    this.requests.clear();
  }
}

/** Copy a vetted asset to a destination picked by the user, publishing only complete bytes. */
export async function exportScopedMedia(file: string, destination: string, authorize: Authorize): Promise<void> {
  await authorize();
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1) throw new Error("Media source is unavailable.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let stage: string | undefined;
  try {
    if (!sameFile(info, await handle.stat())) throw new Error("Media source changed.");
    await authorize();
    stage = await mkdtemp(join(dirname(destination), ".pi-media-"));
    const stagedFile = join(stage, "output");
    await pipeline(
      handle.createReadStream({ autoClose: false, highWaterMark: CHUNK_BYTES }),
      async function* (chunks) {
        for await (const chunk of chunks) {
          await authorize();
          yield chunk;
        }
      },
      createWriteStream(stagedFile, { flags: "wx", mode: 0o600 }),
    );
    await authorize();
    if (!sameFile(info, await handle.stat())) throw new Error("Media source changed.");
    await rename(stagedFile, destination);
  } finally {
    await handle.close();
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
