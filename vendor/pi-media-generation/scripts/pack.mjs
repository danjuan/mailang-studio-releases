import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

const sourceDir = fileURLToPath(new URL("..", import.meta.url));
const bundledDir = fileURLToPath(new URL(
  "../../../apps/desktop/resources/plugins/local.media-generation",
  import.meta.url,
));
const pluginId = "local.media-generation";
const source = "vendor/pi-media-generation";
const lockFile = "BUNDLE.json";
const versionPattern = /^(\d+\.\d+\.\d+)(?:-([\w-]+(?:\.[\w-]+)*))?$/;

// The explicit, sorted package inputs keep tests, local credentials and
// generated files outside the installable artifact.
const inputs = [
  "README.md", "image-workflows.js", "long-video-plan.js", "main.js", "manifest.json", "minimax.js",
  "package.json", "reference-frames.js", "reference-mentions.js",
  "video-workflows.js", "video-workflow-runner.js",
  "views/creative-starter-lighthouse.js", "views/creative-starters.js",
  "views/index.html", "views/keyframe-reorder.js", "views/library-catalog.js", "views/library.js", "views/local-media-drop.js", "views/media-preview.js", "views/media-ui.js",
  "views/panel.css", "views/panel.js", "views/prompt-references.js", "views/strings.js",
  "views/references-ui.js", "views/video-edit-region.js", "views/video-remake-ui.js", "views/video-workflow-ui.js",
].sort();

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

// Store-only ZIP32 with a fixed timestamp, matching the original .piplug.
function zip(files) {
  const entries = [];
  const directory = [];
  let offset = 0;
  for (const [input, data] of files) {
    const name = Buffer.from(input, "utf8");
    const crc = crc32(data);

    const file = Buffer.alloc(30);
    file.writeUInt32LE(0x04034b50, 0);
    file.writeUInt16LE(20, 4);
    file.writeUInt16LE(0x800, 6);
    file.writeUInt16LE(33, 12); // 1980-01-01
    file.writeUInt32LE(crc, 14);
    file.writeUInt32LE(data.length, 18);
    file.writeUInt32LE(data.length, 22);
    file.writeUInt16LE(name.length, 26);
    entries.push(file, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    directory.push(record, name);

    offset += file.length + name.length + data.length;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...entries, central, end]);
}

/** Build both delivery forms from one read-only snapshot of the plugin inputs. */
export async function buildMediaPackage(directory = sourceDir) {
  const root = await realpath(directory);
  const files = new Map();
  for (const input of inputs) {
    const path = join(root, input);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024 || await realpath(path) !== path) {
      throw new Error(`Invalid package input: ${input}`);
    }
    files.set(input, await readFile(path));
  }
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const metadata = JSON.parse(files.get("package.json").toString("utf8"));
  const version = manifest.version;
  if (manifest.id !== pluginId || typeof version !== "string" ||
      !versionPattern.test(version) || version !== metadata.version ||
      manifest.main !== "main.js" || manifest.contributes?.views?.[0]?.id !== "media-generation" ||
      manifest.contributes?.views?.[0]?.entry !== "views/index.html") {
    throw new Error("The package metadata does not match the runtime and panel entries.");
  }

  const archive = zip(files);
  return {
    archive,
    files,
    lock: {
      schemaVersion: 1,
      id: pluginId,
      version,
      source,
      package: { name: `${pluginId}-${version}.piplug`, sha256: digest(archive), bytes: archive.length },
      files: Object.fromEntries([...files].map(([entry, data]) => [entry, digest(data)])),
    },
  };
}

async function writeArchive({ archive, lock }) {
  const dist = join(sourceDir, "dist");
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, ".pack-"));
  const output = join(dist, lock.package.name);
  try {
    const stagedArchive = join(staging, lock.package.name);
    await writeFile(stagedArchive, archive, { flag: "wx" });
    await rename(stagedArchive, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return output;
}

function compareVersionIdentifiers(left, right) {
  if (left === right) return 0;
  const a = /^\d+$/.test(left);
  const b = /^\d+$/.test(right);
  if (a && b) {
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  }
  if (a !== b) return a ? -1 : 1;
  return left < right ? -1 : 1;
}

function isVersionBump(version, previousVersion) {
  const [, core, prerelease] = versionPattern.exec(version);
  const [, previousCore, previousPrerelease] = versionPattern.exec(previousVersion);
  const previousParts = previousCore.split(".");
  for (const [index, part] of core.split(".").entries()) {
    const order = compareVersionIdentifiers(part, previousParts[index]);
    if (order) return order > 0;
  }
  if (!prerelease || !previousPrerelease) return !prerelease && !!previousPrerelease;
  const parts = prerelease.split(".");
  const previousPrereleaseParts = previousPrerelease.split(".");
  for (const [index, part] of parts.entries()) {
    if (index >= previousPrereleaseParts.length) return true;
    const order = compareVersionIdentifiers(part, previousPrereleaseParts[index]);
    if (order) return order > 0;
  }
  return false;
}

async function checkPreviousBundle(lock) {
  const info = await lstat(bundledDir).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  const previousPath = join(bundledDir, lockFile);
  if (!info.isDirectory() || !(await lstat(previousPath)).isFile()) {
    throw new Error("The existing bundled plugin or its provenance file is not a regular entry.");
  }
  const previous = JSON.parse(await readFile(previousPath, "utf8"));
  if (previous.id !== lock.id || typeof previous.version !== "string" || !versionPattern.test(previous.version) ||
      !/^[0-9a-f]{64}$/.test(previous.package?.sha256)) {
    throw new Error("The existing bundled plugin provenance is invalid.");
  }
  if (previous.package.sha256 !== lock.package.sha256 && !isVersionBump(lock.version, previous.version)) {
    throw new Error("The package changed without a version bump. Update manifest.json and package.json to a new version before syncing.");
  }
  return true;
}

async function syncBundled(generated) {
  const { verifyBundleFiles } = await import("../../../apps/desktop/build/verify-bundled-media.cjs");
  const { files, lock } = generated;
  // A fixed staging directory serializes updates and sits outside the
  // desktop's built-in plugin discovery directory.
  const staging = join(dirname(dirname(bundledDir)), ".media-generation-sync");
  try {
    await mkdir(staging);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`An existing media bundle sync is using ${staging}.`);
    throw error;
  }
  const candidate = join(staging, basename(bundledDir));
  const backup = join(staging, "previous");
  let preserveBackup = false;
  try {
    const hasPrevious = await checkPreviousBundle(lock);
    for (const [file, data] of files) {
      const destination = join(candidate, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data, { flag: "wx" });
    }
    await writeFile(join(candidate, lockFile), JSON.stringify(lock, null, 2) + "\n", { flag: "wx" });
    verifyBundleFiles(candidate, lock);
    const output = await writeArchive(generated);

    if (hasPrevious) await rename(bundledDir, backup);
    try {
      await rename(candidate, bundledDir);
    } catch (error) {
      if (hasPrevious) {
        try {
          await rename(backup, bundledDir);
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError([error, restoreError], `Unable to restore the bundle. Previous files are at ${backup}.`);
        }
      }
      throw error;
    }
    return output;
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true });
  }
}

async function main(args) {
  const sync = args.length === 1 && args[0] === "--sync-bundled";
  if (args.length > 0 && !sync) throw new Error("Usage: node scripts/pack.mjs [--sync-bundled]");
  const generated = await buildMediaPackage();
  const output = await (sync ? syncBundled(generated) : writeArchive(generated));
  console.log(output);
  console.log(`SHA-256 ${generated.lock.package.sha256}`);
  if (sync) console.log(`Refreshed ${bundledDir}.`);
}

// Node canonicalizes the module URL even when it was invoked via a directory
// alias such as /tmp on macOS.
const entryPath = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined);
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
