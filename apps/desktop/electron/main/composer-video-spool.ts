import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { openReelMediaKind, type ComposerPastedFile } from "@pi-desktop/shared";
import { composerAttachmentName, mimeTypeForPath } from "./composer-paste.ts";

const CHUNK_SIZE = 1024 * 1024;
const STALL_MS = 60_000;
const MAX_PENDING = 20;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Spool = {
  senderId: number;
  path: string;
  destination: string;
  directory: string;
  file: FileHandle;
  identity: string;
  name: string;
  size: number;
  written: number;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

function nodeIdentity(info: { dev: bigint; ino: bigint }): string {
  return `${info.dev}:${info.ino}`;
}

async function pasteDirectory(dataDir: string, sessionId: string): Promise<string> {
  let directory = await realpath(dataDir);
  for (const name of ["scratch", sessionId, "pasted"]) {
    directory = join(directory, name);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
      throw new Error("video attachment directory was redirected");
    }
  }
  return directory;
}

/** Spool one selected browser video in bounded IPC chunks without exposing a write path. */
export class ComposerVideoSpools {
  private readonly entries = new Map<string, Spool>();
  private readonly dataDir: string;

  constructor(dataDir: string) { this.dataDir = dataDir; }

  private stopTimer(spool: Spool): void {
    if (spool.timer) clearTimeout(spool.timer);
    spool.timer = undefined;
  }

  private expire(ticket: string, spool: Spool): void {
    this.stopTimer(spool);
    spool.timer = setTimeout(() => {
      if (this.entries.get(ticket) !== spool) return;
      this.entries.delete(ticket);
      void this.cleanup(spool).catch(() => undefined);
    }, STALL_MS).unref();
  }

  private async assertOwnFile(spool: Spool): Promise<void> {
    const current = await lstat(spool.path, { bigint: true });
    if (!current.isFile() || nodeIdentity(current) !== spool.identity
      || await realpath(spool.directory) !== spool.directory) {
      throw new Error("video attachment staging changed");
    }
  }

  private async cleanup(spool: Spool): Promise<void> {
    this.stopTimer(spool);
    try {
      await spool.file.close();
    } finally {
      try {
        await this.assertOwnFile(spool);
        await unlink(spool.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async begin(senderId: number, sessionId: string, rawName: unknown, mime: unknown, size: unknown): Promise<string> {
    if (!SESSION_ID.test(sessionId) || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error("invalid video attachment");
    }
    const mimeType = typeof mime === "string" ? mime.trim().toLowerCase() : "";
    const name = composerAttachmentName(rawName, mimeType, 0);
    if (openReelMediaKind(name) !== "video" || Buffer.byteLength(name) > 180) {
      throw new Error("choose an MP4, MOV, WebM or MKV video");
    }
    if (this.entries.size >= MAX_PENDING) throw new Error("too many video attachments in progress");
    const directory = await pasteDirectory(this.dataDir, sessionId);
    const ticket = randomUUID();
    const path = join(directory, `.pi-video-${ticket}.tmp`);
    const destination = join(directory, `pasted-${ticket}-${name}`);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const identity = nodeIdentity(await file.stat({ bigint: true }));
    const spool: Spool = { senderId, path, destination, directory, file, identity, name, size, written: 0, active: false };
    try {
      await this.assertOwnFile(spool);
      if (this.entries.size >= MAX_PENDING) throw new Error("too many video attachments in progress");
      this.entries.set(ticket, spool);
      this.expire(ticket, spool);
      return ticket;
    } catch (error) {
      await this.cleanup(spool).catch(() => undefined);
      throw error;
    }
  }

  private take(senderId: number, ticket: unknown): { key: string; spool: Spool } {
    const spool = typeof ticket === "string" ? this.entries.get(ticket) : undefined;
    if (typeof ticket !== "string" || !spool || spool.senderId !== senderId || spool.active) {
      throw new Error("video attachment transfer is no longer available");
    }
    spool.active = true;
    this.stopTimer(spool);
    return { key: ticket, spool };
  }

  async append(senderId: number, ticket: unknown, offset: unknown, value: unknown): Promise<number> {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > CHUNK_SIZE) {
      throw new Error("invalid video attachment chunk");
    }
    const { key, spool } = this.take(senderId, ticket);
    try {
      if (offset !== spool.written || bytes.byteLength > spool.size - spool.written) {
        throw new Error("video attachment chunk is out of order");
      }
      await this.assertOwnFile(spool);
      await spool.file.writeFile(bytes);
      await this.assertOwnFile(spool);
      spool.written += bytes.byteLength;
      spool.active = false;
      this.expire(key, spool);
      return spool.written;
    } catch (error) {
      this.entries.delete(key);
      await this.cleanup(spool).catch(() => undefined);
      throw error;
    }
  }

  async finish(senderId: number, ticket: unknown): Promise<ComposerPastedFile> {
    const { key, spool } = this.take(senderId, ticket);
    this.entries.delete(key);
    try {
      if (spool.size !== spool.written) throw new Error("video attachment transfer is incomplete");
      const info = await spool.file.stat({ bigint: true });
      if (info.size !== BigInt(spool.size)) throw new Error("video attachment size changed");
      await spool.file.sync();
      await this.assertOwnFile(spool);
      await link(spool.path, spool.destination);
      return {
        path: spool.destination,
        name: basename(spool.name),
        mimeType: mimeTypeForPath(spool.name),
        kind: "file",
        size: spool.size,
      };
    } finally {
      await this.cleanup(spool).catch(() => undefined);
    }
  }

  async abort(senderId: number, ticket: unknown): Promise<void> {
    const { key, spool } = this.take(senderId, ticket);
    this.entries.delete(key);
    await this.cleanup(spool);
  }
}
