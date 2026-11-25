const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const pluginId = "local.media-generation";
const source = "vendor/pi-media-generation";
const sourceDir = join(__dirname, "../../..", source);
const bundleDir = join(__dirname, "..", "resources", "plugins", pluginId);
const lockFile = "BUNDLE.json";
const sha256 = /^[a-f\d]{64}$/;

function findFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = prefix + entry.name;
    if (entry.isDirectory()) return findFiles(join(directory, entry.name), `${file}/`);
    if (entry.isFile()) return [file];
    throw new Error(`Unsupported entry in bundled media plugin: ${file}`);
  });
}

function verifyBundleFiles(directory, expectedLock) {
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("Bundled media plugin must be a directory.");
  }
  const files = findFiles(directory);
  if (!files.includes(lockFile)) {
    throw new Error(`Bundled media plugin is missing ${lockFile}.`);
  }
  const lock = JSON.parse(readFileSync(join(directory, lockFile), "utf8"));
  if (lock?.schemaVersion !== 1 || lock.id !== pluginId || lock.source !== source ||
      typeof lock.version !== "string" || !lock.version ||
      lock.package?.name !== `${pluginId}-${lock.version}.piplug` ||
      typeof lock.package.sha256 !== "string" || !sha256.test(lock.package.sha256) ||
      !Number.isSafeInteger(lock.package.bytes) || lock.package.bytes <= 0 ||
      !lock.files || typeof lock.files !== "object" || Array.isArray(lock.files)) {
    throw new Error("Invalid bundled media plugin provenance.");
  }

  const runtimeFiles = files.filter((file) => file !== lockFile);
  if (runtimeFiles.length !== Object.keys(lock.files).length ||
      !runtimeFiles.every((file) => Object.hasOwn(lock.files, file))) {
    throw new Error("Bundled media plugin files differ from the recorded package.");
  }
  for (const file of runtimeFiles) {
    const digest = createHash("sha256").update(readFileSync(join(directory, file))).digest("hex");
    if (digest !== lock.files[file]) {
      throw new Error(`Bundled media plugin checksum mismatch: ${file}`);
    }
  }

  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest?.id !== pluginId || manifest.version !== lock.version) {
    throw new Error("Bundled media plugin manifest does not match the recorded package.");
  }
  if (!isDeepStrictEqual(lock, expectedLock)) {
    throw new Error("Bundled media plugin provenance differs from source.");
  }
  return lock;
}

async function verifyBundledMedia(directory = bundleDir, sourceDirectory = sourceDir) {
  try {
    const { buildMediaPackage } = await import("../../../vendor/pi-media-generation/scripts/pack.mjs");
    const { lock } = await buildMediaPackage(sourceDirectory);
    return verifyBundleFiles(directory, lock);
  } catch (error) {
    throw new Error(
      `${error.message} Run node vendor/pi-media-generation/scripts/pack.mjs --sync-bundled from the repository root.`,
      { cause: error },
    );
  }
}

async function beforePack() {
  await verifyBundledMedia();
}

module.exports = { beforePack, verifyBundledMedia, verifyBundleFiles };

if (require.main === module) {
  verifyBundledMedia().then((lock) => {
    console.log(`Verified bundled media plugin ${lock.version} (${lock.package.sha256}).`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
