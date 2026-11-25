const { execFile } = require("node:child_process");
const { mkdtemp, rename, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const architectures = new Set(["arm64", "x86_64"]);
const helperName = "pi-session-media-video";

async function afterPack({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== "darwin") return;

  const bin = join(packager.getResourcesDir(appOutDir), "bin");
  const { stdout } = await run("/usr/bin/lipo", ["-archs", join(bin, "pi-desktop-host-core")]);
  const targets = stdout.trim().split(/\s+/);
  if (!targets.every((arch) => architectures.has(arch))) {
    throw new Error("Unsupported packaged macOS architecture for the session video helper.");
  }

  const stage = await mkdtemp(join(bin, ".session-video-"));
  try {
    const source = join(__dirname, "..", "native", "session-media-video.swift");
    const slices = [];
    for (const arch of targets) {
      const slice = join(stage, arch);
      await run("/usr/bin/xcrun", [
        "--sdk", "macosx", "swiftc", "-O", "-parse-as-library",
        "-target", `${arch}-apple-macos12.0`, "-module-cache-path", join(stage, "modules"),
        source, "-o", slice,
      ], { timeout: 120_000 });
      slices.push(slice);
    }
    const output = join(bin, helperName);
    if (slices.length === 1) {
      await rename(slices[0], output);
    } else {
      await run("/usr/bin/lipo", ["-create", ...slices, "-output", output]);
    }
    const actual = (await run("/usr/bin/lipo", ["-archs", output])).stdout.trim().split(/\s+/);
    if (actual.length !== targets.length || !targets.every((arch) => actual.includes(arch))) {
      throw new Error("Packaged session video helper does not match the desktop architecture.");
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

module.exports = { afterPack };
