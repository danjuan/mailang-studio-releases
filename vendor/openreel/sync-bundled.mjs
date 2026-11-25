import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL(".", import.meta.url));
const bundled = resolve(source, "../../apps/desktop/resources/plugins/local.openreel-proof");
const notices = ["THIRD-PARTY-NOTICES.txt", "UPSTREAM.md"];
const requiredRuntime = ["LICENSE", "LICENSE-mediabunny", "main.js", "manifest.json", "templates/openreel.md", "views/index.html"];

async function fingerprint(directory, excludedDirectory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error("OpenReel bundle root must be a directory.");
  const files = new Map();
  async function visit(relativePath) {
    const entries = await readdir(join(directory, relativePath), { withFileTypes: true });
    for (const entry of entries) {
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (name !== excludedDirectory) await visit(name);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
        files.set(name, digest);
      } else {
        throw new Error(`Unsupported OpenReel bundle entry: ${name}`);
      }
    }
  }
  await visit("");
  return files;
}

async function expectedBundle(staged, destination) {
  // The DevKit archive is a separate delivery artifact.
  const runtime = await fingerprint(staged, "dist");
  for (const name of requiredRuntime) {
    if (!runtime.has(name)) throw new Error(`Staged OpenReel is missing ${name}.`);
  }
  const actual = await fingerprint(destination);
  for (const name of notices) {
    if (!actual.has(name)) throw new Error(`Bundled OpenReel is missing ${name}.`);
    if (runtime.has(name)) throw new Error(`OpenReel notice must come from the repository: ${name}`);
  }
  const expected = new Map([...runtime, ...notices.map(name => [name, actual.get(name)])]);
  return { runtime, actual, expected };
}

async function replaceRuntime(staged, destination, runtime) {
  const scratch = await mkdtemp(join(dirname(destination), `.${basename(destination)}-`));
  const next = join(scratch, "next");
  const previous = join(scratch, "previous");
  let preserveBackup = false;
  try {
    for (const [from, names] of [[staged, runtime.keys()], [destination, notices]]) {
      for (const name of names) {
        const file = join(next, name);
        await mkdir(dirname(file), { recursive: true });
        await cp(join(from, name), file, { errorOnExist: true, force: false });
      }
    }
    await rename(destination, previous);
    try {
      await rename(next, destination);
    } catch (error) {
      try {
        await rename(previous, destination);
      } catch (restoreError) {
        preserveBackup = true;
        throw new AggregateError([error, restoreError], `Previous OpenReel contents remain at ${previous}.`);
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyBundledOpenReel(staged, destination = bundled, { sync = false } = {}) {
  const { runtime, actual, expected } = await expectedBundle(staged, destination);
  const differences = [...new Set([...expected.keys(), ...actual.keys()])]
    .filter(name => expected.get(name) !== actual.get(name))
    .sort();
  if (!differences.length) return;
  if (!sync) {
    throw new Error(
      `Bundled OpenReel differs from the staged build: ${differences.join(", ")}. ` +
      "Run node vendor/openreel/sync-bundled.mjs --sync <build directory> and repeat the check.",
    );
  }
  await replaceRuntime(staged, destination, runtime);
  await verifyBundledOpenReel(staged, destination);
}

async function main() {
  const [mode, stage, ...rest] = process.argv.slice(2);
  if (!["--check", "--sync"].includes(mode) || !stage || rest.length) {
    throw new Error("Usage: node vendor/openreel/sync-bundled.mjs <--check|--sync> <build directory>");
  }
  const staged = join(resolve(stage), "plugin");
  const manifest = JSON.parse(await readFile(join(staged, "manifest.json"), "utf8"));
  const expected = JSON.parse(await readFile(join(source, "adapter/manifest.json"), "utf8"));
  if (manifest.id !== expected.id || manifest.version !== expected.version) {
    throw new Error("The staged OpenReel ID and version must match the adapter source manifest.");
  }
  await verifyBundledOpenReel(staged, bundled, { sync: mode === "--sync" });
  console.log(`Verified bundled OpenReel ${manifest.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
