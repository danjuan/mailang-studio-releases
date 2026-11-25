import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat, mkdir, open, realpath, rename, unlink, type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  PluginProjectMediaAsset,
  PluginProjectMediaIndex,
  PluginProjectMediaMime,
  PluginProjectMediaSubject,
} from "@pi-desktop/plugin-sdk";

const IMAGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_LIMIT = 128 * 1024 * 1024;
const FRAME_LIMIT = 5 * 1024 * 1024;
const VIDEO_REFERENCE_LIMIT = 24 * 1024 * 1024;
const INDEX_LIMIT = 8 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const ID = /^[\da-f]{8}-[\da-f]{4}-[47][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const PROJECT_KEY = /^[\da-f]{64}$/;

const formats = {
  "image/jpeg": { kind: "image", extension: "jpg", label: "JPEG", limit: IMAGE_LIMIT },
  "image/png": { kind: "image", extension: "png", label: "PNG", limit: IMAGE_LIMIT },
  "image/webp": { kind: "image", extension: "webp", label: "WebP", limit: IMAGE_LIMIT },
  "video/mp4": { kind: "video", extension: "mp4", label: "MP4", limit: VIDEO_LIMIT },
} as const;

type StoredAsset = PluginProjectMediaAsset & { sourceRecordId?: string };
type Index = { schemaVersion: 1; assets: StoredAsset[]; subjects: PluginProjectMediaSubject[] };
type Scope = { projectKey: string; pluginId: string };
type Access = { assertCurrent: () => void; revalidate: () => Promise<void> };
type ImportFile = { path: string; name?: string; sourceRecordId?: string };

export function projectMediaError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function invalid(message: string) {
  return projectMediaError("INVALID_ARGUMENT", message);
}

function missing() {
  return projectMediaError("NOT_FOUND", "The project media item is unavailable.");
}

function unreadable() {
  return projectMediaError("UNAVAILABLE", "The project media catalog is unavailable.");
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid media fields.");
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalid("Invalid media identifier.");
  return value;
}

function itemName(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || Array.from(value.trim()).length > 100 ||
      !value.trim() || /[\\/\x00-\x1f\x7f]/u.test(value)) {
    throw invalid("Use a valid media name between 1 and 100 characters.");
  }
  return value.trim();
}

function inputName(path: string): string {
  const filename = basename(path)
    .replace(/\.(?:jpe?g|png|webp|mp4)$/iu, "")
    .replace(/[\\/\x00-\x1f\x7f]/gu, " ")
    .trim();
  return Array.from(filename).slice(0, 100).join("") || "Imported media";
}

function mimeFromHeader(bytes: Buffer): PluginProjectMediaMime | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.readUInt32BE(0) >= 12 &&
      bytes.toString("ascii", 4, 8) === "ftyp" && bytes.toString("ascii", 8, 12) !== "qt  ") {
    return "video/mp4";
  }
  return null;
}

function mimeAndSize(value: unknown, size: unknown): value is PluginProjectMediaMime {
  if (typeof value !== "string" || !Object.hasOwn(formats, value)) return false;
  return typeof size === "number" && Number.isSafeInteger(size) && size > 0 &&
    size <= formats[value as PluginProjectMediaMime].limit;
}

function parseAsset(value: unknown): StoredAsset {
  const { id, name, kind, mime, size, createdAt, sourceRecordId } = fields(value);
  if (!mimeAndSize(mime, size) || kind !== formats[mime].kind || typeof size !== "number" ||
      typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) throw unreadable();
  return {
    id: identifier(id), name: itemName(name), kind: formats[mime].kind, mime, size, createdAt,
    ...(sourceRecordId === undefined ? {} : { sourceRecordId: identifier(sourceRecordId) }),
  };
}

function imageIdentifiers(assets: readonly StoredAsset[]) {
  return new Set(assets.filter(({ kind }) => kind === "image").map(({ id }) => id));
}

function isExtendedSubjectKind(kind: unknown): kind is "product" | "style" | "other" {
  return kind === "product" || kind === "style" || kind === "other";
}

function parseSubject(
  value: unknown, imageIds: ReadonlySet<string>, id: string, createdAt?: number,
): PluginProjectMediaSubject {
  const { name, kind, assetIds: rawAssetIds, coverId: rawCoverId } = fields(value);
  if ((kind !== "character" && kind !== "scene" && kind !== "prop" && !isExtendedSubjectKind(kind)) ||
      !Array.isArray(rawAssetIds) || rawAssetIds.length === 0 || rawAssetIds.length > imageIds.size) {
    throw invalid("A subject needs a category and at least one project image.");
  }
  const assetIds = rawAssetIds.map(identifier);
  const coverId = identifier(rawCoverId);
  if (new Set(assetIds).size !== assetIds.length || !assetIds.includes(coverId) ||
      !assetIds.every((assetId) => imageIds.has(assetId))) {
    throw invalid("The subject and cover must use images in this project.");
  }
  return {
    id, name: itemName(name), kind, assetIds, coverId,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function parseStoredSubject(value: unknown, imageIds: ReadonlySet<string>) {
  const subject = fields(value);
  const { id, kind, category, createdAt } = subject;
  if (createdAt !== undefined &&
      (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0)) throw unreadable();
  if (category !== undefined && (kind !== "prop" || !isExtendedSubjectKind(category))) throw unreadable();
  return parseSubject(category === undefined ? subject : { ...subject, kind: category }, imageIds, identifier(id), createdAt);
}

function storedSubject(subject: PluginProjectMediaSubject) {
  // Retain a kind older readers accept so the same library remains readable after rollback.
  return isExtendedSubjectKind(subject.kind) ? { ...subject, kind: "prop", category: subject.kind } : subject;
}

function parseIndex(bytes: Buffer): Index {
  try {
    const { schemaVersion, assets: rawAssets, subjects: rawSubjects } = fields(JSON.parse(bytes.toString("utf8")));
    if (schemaVersion !== 1 || !Array.isArray(rawAssets) || !Array.isArray(rawSubjects)) throw unreadable();
    const assets = rawAssets.map(parseAsset);
    const imageIds = imageIdentifiers(assets);
    const subjects = rawSubjects.map((subject) => parseStoredSubject(subject, imageIds));
    if (new Set(assets.map(({ id }) => id)).size !== assets.length ||
        new Set(subjects.map(({ id }) => id)).size !== subjects.length) throw unreadable();
    return { schemaVersion, assets, subjects };
  } catch {
    throw unreadable();
  }
}

async function inspectDirectory(path: string, create: boolean): Promise<boolean> {
  const stat = () => lstat(path).catch((error: unknown) => {
    if (!absent(error)) throw error;
    return null;
  });
  let item = await stat();
  if (!item && create) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
    });
    item = await stat();
  }
  if (!item) return false;
  if (!item.isDirectory() || await realpath(path) !== path) {
    throw projectMediaError("PERMISSION_DENIED", "A project media directory was redirected.");
  }
  return true;
}

async function readBounded(file: FileHandle, limit: number, allowReplaced = false): Promise<Buffer> {
  const info = await file.stat();
  if (!info.isFile() || (info.nlink !== 1 && !(allowReplaced && info.nlink === 0)) ||
      info.size <= 0 || info.size > limit) throw unreadable();
  const bytes = Buffer.alloc(info.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== info.size) throw unreadable();
  return bytes.subarray(0, offset);
}

async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => { if (!absent(error)) throw error; });
}

async function copyMedia(from: string, stage: string, assertCurrent: Access["assertCurrent"], kind?: "image") {
  const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw projectMediaError("INVALID_MEDIA", "Choose an ordinary image or MP4 file.");
    }
    const header = Buffer.alloc(16);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    const mime = mimeFromHeader(header.subarray(0, bytesRead));
    if (!mime || !mimeAndSize(mime, info.size)) {
      throw projectMediaError("INVALID_MEDIA", "Choose a supported image or MP4 within its size limit.");
    }
    if (kind === "image" && formats[mime].kind !== "image") {
      throw projectMediaError("INVALID_MEDIA", "Choose a supported image.");
    }
    assertCurrent();
    const output = await open(stage, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(CHUNK_SIZE);
      for (let offset = 0; offset < info.size;) {
        assertCurrent();
        const { bytesRead: count } = await input.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
        if (!count) throw unreadable();
        for (let written = 0; written < count;) {
          const { bytesWritten } = await output.write(buffer, written, count - written, offset + written);
          if (!bytesWritten) throw unreadable();
          written += bytesWritten;
        }
        offset += count;
      }
      const current = await input.stat();
      if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
        throw unreadable();
      }
      await output.sync();
    } finally {
      await output.close();
    }
    return { mime, size: info.size };
  } finally {
    await input.close();
  }
}

function publicAsset({ sourceRecordId: _origin, ...asset }: StoredAsset) {
  return asset;
}

export class PluginProjectMediaStore {
  private readonly writes = new Map<string, Promise<unknown>>();

  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private async directory({ projectKey, pluginId }: Scope, create: boolean) {
    if (!PROJECT_KEY.test(projectKey)) throw invalid("Invalid project identity.");
    const root = await realpath(this.dataDir);
    const base = join(root, "project-media");
    const project = join(base, projectKey);
    const folder = join(project, createHash("sha256").update(pluginId).digest("hex"));
    for (const path of [base, project, folder]) if (!await inspectDirectory(path, create)) return null;
    return folder;
  }

  private async load(folder: string | null): Promise<Index> {
    const empty = (): Index => ({ schemaVersion: 1, assets: [], subjects: [] });
    if (!folder) return empty();
    const file = await open(join(folder, "index.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: unknown) => { if (!absent(error)) throw error; return null; });
    if (!file) return empty();
    try {
      return parseIndex(await readBounded(file, INDEX_LIMIT, true));
    } finally {
      await file.close();
    }
  }

  private async save(folder: string, index: Index, access: Access): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ ...index, subjects: index.subjects.map(storedSubject) }) + "\n");
    if (bytes.length > INDEX_LIMIT) throw invalid("The project media catalog is full.");
    const stage = join(folder, randomUUID() + ".catalog-tmp");
    const file = await open(stage, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await access.revalidate();
      await rename(stage, join(folder, "index.json"));
    } finally {
      await removeFile(stage);
    }
  }

  private write<T>(scope: Scope, access: Access, create: boolean, update: (folder: string, index: Index) => Promise<T>) {
    const key = scope.projectKey + "/" + scope.pluginId;
    const operation = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await access.revalidate();
      const folder = await this.directory(scope, create);
      if (!folder) throw missing();
      return update(folder, await this.load(folder));
    });
    this.writes.set(key, operation);
    return operation.finally(() => { if (this.writes.get(key) === operation) this.writes.delete(key); });
  }

  async list(scope: Scope): Promise<PluginProjectMediaIndex> {
    const { assets, subjects } = await this.load(await this.directory(scope, false));
    return { assets: assets.map(publicAsset), subjects };
  }

  add(scope: Scope, files: ImportFile[], access: Access, kind?: "image") {
    if (!files.length) return Promise.resolve([]);
    return this.write(scope, access, true, async (folder, index) => {
      const written: string[] = [];
      const imported: StoredAsset[] = [];
      let committed = false;
      try {
        for (const file of files) {
          const existing = file.sourceRecordId && index.assets.find(({ sourceRecordId }) => sourceRecordId === file.sourceRecordId);
          if (existing) {
            imported.push(existing);
            continue;
          }
          const id = randomUUID();
          const stage = join(folder, id + ".media-tmp");
          written.push(stage);
          const { mime, size } = await copyMedia(file.path, stage, access.assertCurrent, kind);
          const path = join(folder, id + "." + formats[mime].extension);
          await rename(stage, path);
          written.push(path);
          const asset: StoredAsset = {
            id, name: file.name ?? inputName(file.path), kind: formats[mime].kind, mime, size, createdAt: Date.now(),
            ...(file.sourceRecordId ? { sourceRecordId: identifier(file.sourceRecordId) } : {}),
          };
          imported.push(asset);
          index.assets.unshift(asset);
        }
        if (written.length) await this.save(folder, index, access);
        else await access.revalidate();
        committed = true;
        return imported.map(publicAsset);
      } finally {
        if (!committed) await Promise.all(written.map(removeFile));
      }
    });
  }

  rename(scope: Scope, rawId: unknown, rawName: unknown, access: Access) {
    const id = identifier(rawId);
    const name = itemName(rawName);
    return this.write(scope, access, false, async (folder, index) => {
      const asset = index.assets.find((entry) => entry.id === id);
      if (!asset) throw missing();
      asset.name = name;
      await this.save(folder, index, access);
      return publicAsset(asset);
    });
  }

  deleteAsset(scope: Scope, rawId: unknown, access: Access) {
    const id = identifier(rawId);
    return this.write(scope, access, false, async (folder, index) => {
      const asset = index.assets.find((entry) => entry.id === id);
      if (!asset) throw missing();
      if (index.subjects.some(({ assetIds }) => assetIds.includes(id))) {
        throw projectMediaError("ASSET_REFERENCED", "Remove the image from its subjects before deleting it.");
      }
      index.assets = index.assets.filter((entry) => entry.id !== id);
      await this.save(folder, index, access);
      await removeFile(join(folder, id + "." + formats[asset.mime].extension));
      return true;
    });
  }

  saveSubject(scope: Scope, payload: Record<string, unknown>, access: Access) {
    const id = payload.id === undefined ? randomUUID() : identifier(payload.id);
    return this.write(scope, access, false, async (folder, index) => {
      const previous = index.subjects.findIndex((entry) => entry.id === id);
      if (payload.id !== undefined && previous === -1) throw missing();
      const createdAt = previous === -1 ? Date.now() : index.subjects[previous]?.createdAt;
      const subject = parseSubject(payload, imageIdentifiers(index.assets), id, createdAt);
      if (previous === -1) index.subjects.unshift(subject);
      else index.subjects[previous] = subject;
      await this.save(folder, index, access);
      return subject;
    });
  }

  deleteSubject(scope: Scope, rawId: unknown, access: Access) {
    const id = identifier(rawId);
    return this.write(scope, access, false, async (folder, index) => {
      if (!index.subjects.some((entry) => entry.id === id)) throw missing();
      index.subjects = index.subjects.filter((entry) => entry.id !== id);
      await this.save(folder, index, access);
      return true;
    });
  }

  async resolve(scope: Scope, rawId: unknown) {
    const id = identifier(rawId);
    const folder = await this.directory(scope, false);
    const entry = (await this.load(folder)).assets.find((asset) => asset.id === id);
    if (!entry || !folder) throw missing();
    const format = formats[entry.mime];
    const path = join(folder, id + "." + format.extension);
    const info = await lstat(path).catch((error: unknown) => { if (absent(error)) throw missing(); throw error; });
    if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size || await realpath(path) !== path) throw missing();
    return { path, ...format, asset: publicAsset(entry), mime: entry.mime };
  }

  async readFrame(scope: Scope, id: unknown) {
    const { asset, path } = await this.resolve(scope, id);
    if (asset.kind !== "image") throw projectMediaError("INVALID_MEDIA", "A reference frame must be an image.");
    if (asset.size > FRAME_LIMIT) throw projectMediaError("FRAME_TOO_LARGE", "A reference frame can be up to 5 MiB.");
    return this.readReferenceBytes(asset, path, FRAME_LIMIT);
  }

  async readReference(scope: Scope, id: unknown) {
    const { asset, path } = await this.resolve(scope, id);
    const limit = asset.kind === "image" ? FRAME_LIMIT : VIDEO_REFERENCE_LIMIT;
    if (asset.size > limit) throw projectMediaError("REFERENCE_TOO_LARGE", "This project asset exceeds the reference size limit.");
    return { kind: asset.kind, name: asset.name, url: await this.readReferenceBytes(asset, path, limit) };
  }

  private async readReferenceBytes(asset: ReturnType<typeof publicAsset>, path: string, limit: number) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = await readBounded(file, limit);
      if (bytes.length !== asset.size || mimeFromHeader(bytes) !== asset.mime) throw missing();
      return "data:" + asset.mime + ";base64," + bytes.toString("base64");
    } finally {
      await file.close();
    }
  }
}
