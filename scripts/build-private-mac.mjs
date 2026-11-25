import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageOpenReelMac } from "./package-openreel-macos.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const [serial, ...extra] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(serial ?? "") || !Number.isSafeInteger(Number(serial)) || extra.length) {
  throw new Error("Usage: pnpm run dist:private:mac <positive release number>");
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The private DMG requires an Apple Silicon Mac and native arm64 Node.js.");
}

const cache = join(repo, ".cache", "private-mac");
await mkdir(cache, { recursive: true });
const stage = await mkdtemp(join(cache, "build-"));
const archiveName = "ffmpeg-7.1.5.tar.xz";
const archive = join(cache, archiveName);
const decoder = join(stage, "decoder");
const output = join(repo, "apps/desktop/release", `openreel-mac-${serial}-arm64.dmg`);
const run = (command, args) => execFileSync(command, args, { cwd: repo, stdio: "inherit" });
try {
  // The existing decoder build verifies the pinned archive digest before extraction.
  const cached = await stat(archive).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const source = cached ? archive : join(stage, archiveName);
  if (!cached) {
    run("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--output", source, `https://ffmpeg.org/releases/${archiveName}`]);
  }
  run("sh", ["scripts/build-openreel-decoder.sh", source, decoder]);
  if (!cached) await rename(source, archive);

  run("pnpm", ["--filter", "@pi-desktop/desktop", "run", "build:deps"]);
  const artifacts = execFileSync("cargo", [
    "build", "--release", "--locked", "-p", "host-core", "--bin", "pi-desktop-host-core",
    "--message-format=json-render-diagnostics",
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024 });
  const binary = artifacts.trim().split("\n").map(line => JSON.parse(line)).find(message =>
    message.reason === "compiler-artifact" && message.target.name === "pi-desktop-host-core" && message.executable);
  if (!binary) throw new Error("Cargo did not report a host-core executable.");
  run("lipo", [binary.executable, "-verify_arch", "arm64"]);
  run("pnpm", ["--filter", "@pi-desktop/desktop", "run", "bundle:runtime"]);
  run("pnpm", ["--filter", "@pi-desktop/desktop", "run", "build"]);
  await packageOpenReelMac({ stage, decoder, hostBinary: binary.executable, privateReleaseNumber: Number(serial) });
  await mkdir(dirname(output), { recursive: true });
  await rename(join(stage, "packages", basename(output)), output);
  console.log(`Private macOS release: ${output}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
