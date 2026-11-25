import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function packageOpenReelMac({ stage, decoder, appOnly = false, privateReleaseNumber, hostBinary = join(repo, "target/release/pi-desktop-host-core") }) {
  const app = join(repo, "apps/desktop");
  const output = join(stage, "packages");
  const privateBuild = privateReleaseNumber !== undefined;

  const captionDefaultName = "openreel-caption-default.json";
  const captionDefault = join(stage, captionDefaultName);
  const pluginId = "local.openreel-proof";
  const bundled = join(app, "resources/plugins");
  const plugin = privateBuild ? join(bundled, pluginId) : join(stage, "plugin");
  const manifest = JSON.parse(await readFile(join(plugin, "manifest.json"), "utf8"));
  const { build: config, ...desktopMetadata } = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  if (manifest.id !== pluginId || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("The staged OpenReel identity is invalid.");
  }

  const captionDefaultBytes = privateBuild ? null : await readFile(captionDefault).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (captionDefaultBytes !== null) {
    try {
      const preset = JSON.parse(captionDefaultBytes.toString("utf8"));
      const endpoint = preset?.endpoint;
      if (typeof endpoint !== "string" || Object.keys(preset).length !== 1 || endpoint.length > 2048 ||
          /[\u0000-\u0020\u007f]/u.test(endpoint) || !/^https?:\/\/[^/?#@\\]+(?:\/(?:transcribe)?)?$/u.test(endpoint)) {
        throw new Error();
      }
      new URL(endpoint);
    } catch {
      throw new Error(`${captionDefaultName} must contain only an endpoint set to an HTTP(S) origin or its /transcribe URL.`);
    }
  }

  await Promise.all([
    stat(hostBinary),
    stat(join(app, "out/main/index.js")),
    stat(join(decoder, "ffmpeg")),
    stat(join(decoder, "ffprobe")),
  ]);
  const runtimeBundle = join(repo, "packages/agent-runtime/dist-bundle");
  const runtimeFiles = ["package.json", "sidecar.js", "chunks/image-resize-worker.js", "chunks/photon_rs_bg.wasm"];
  try {
    const files = await Promise.all(runtimeFiles.map(file => stat(join(runtimeBundle, file))));
    if (files.some(file => !file.isFile() || file.size === 0)) throw new Error("Missing or empty runtime file");
  } catch (error) {
    throw new Error("The bundled agent runtime is incomplete. Run the Desktop bundle:runtime build.", { cause: error });
  }
  for (const capability of ["encoders", "muxers"]) {
    const result = spawnSync(join(decoder, "ffmpeg"), ["-hide_banner", `-${capability}`], { encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    if (result.status !== 0 || !/^\s+[A-Z.]+\s+flac\s/m.test(result.stdout)) {
      throw new Error(`The packaged decoder must support FLAC ${capability}. Rebuild it with scripts/build-openreel-decoder.sh.`);
    }
  }
  const { verifyBundledOpenReel } = await import("../vendor/openreel/sync-bundled.mjs");
  const sourceManifest = JSON.parse(await readFile(join(repo, "vendor/openreel/adapter/manifest.json"), "utf8"));
  if (manifest.version !== sourceManifest.version) {
    throw new Error("The staged OpenReel version does not match the adapter source manifest.");
  }
  if (!privateBuild) await verifyBundledOpenReel(plugin, join(bundled, pluginId));

  const productName = privateBuild ? config.productName : `${config.productName} OpenReel Preview`;
  config.publish = null;
  if (!privateBuild) config.appId = "net.aiuo.pi-desktop.openreel-preview";
  config.productName = productName;
  const markerName = privateBuild ? "openreel-private-release" : "openreel-preview";
  const marker = join(stage, markerName);
  await writeFile(marker, privateBuild ? String(privateReleaseNumber) : "OpenReel preview distribution\n");
  const fromDesktop = path => resolve(app, path);
  const resolveResources = resources => resources.map(resource => ({ ...resource, from: fromDesktop(resource.from) }));
  config.beforePack = fromDesktop(config.beforePack);
  config.afterPack = fromDesktop(config.afterPack);
  config.extraResources = resolveResources(config.extraResources);
  config.extraResources.push(
    { from: decoder, to: "bin", filter: ["ffmpeg", "ffprobe", "FFmpeg-COPYING.LGPLv2.1"] },
    { from: marker, to: markerName },
  );
  if (captionDefaultBytes !== null) config.extraResources.push({ from: captionDefault, to: captionDefaultName });
  config.mac = { ...config.mac, identity: null, notarize: false };
  config.mac.extraResources = resolveResources(config.mac.extraResources.filter(resource => resource.to !== "app-update.yml"))
    .map(resource => resource.to === "bin/pi-desktop-host-core" ? { ...resource, from: hostBinary } : resource);
  for (const name of ["icon", "entitlements", "entitlementsInherit"]) config.mac[name] = fromDesktop(config.mac[name]);
  config.dmg = {
    ...config.dmg,
    icon: fromDesktop(config.dmg.icon),
    background: fromDesktop(config.dmg.background),
    artifactName: privateBuild ? `openreel-mac-${privateReleaseNumber}-arm64.dmg` : `mailang-studio-\${version}-OpenReel-${manifest.version}-preview-\${arch}.dmg`,
  };
  config.electronDist = await realpath(join(app, "node_modules/electron/dist"));
  const publicNotices = privateBuild ? [
    { from: join(repo, "LICENSE"), to: "licenses/LICENSE-LGPL-3.0.txt" },
    { from: join(decoder, "COPYING.GPLv3"), to: "licenses/LICENSE-GPL-3.0.txt" },
    { from: join(config.electronDist, "LICENSE"), to: "licenses/LICENSE-electron.txt" },
    { from: join(config.electronDist, "LICENSES.chromium.html"), to: "licenses/LICENSES.chromium.html" },
  ] : [];
  await Promise.all(publicNotices.map(notice => stat(notice.from)));
  config.extraResources.push(...publicNotices);
  config.npmRebuild = false;
  config.asar = { smartUnpack: false };
  config.asarUnpack = [...(config.asarUnpack ?? []), "node_modules/@koromix/**/*.node"];
  function run(command, args) {
    const result = spawnSync(command, args, {
      cwd: repo, stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with ${result.signal ?? `exit code ${result.status}`}.`);
  }

  // The workspace root lets electron-builder collect PNPM dependencies under
  // its normal path checks. Electron-builder requires a separate app manifest
  // without a build key in this two-package layout.
  const cache = join(repo, ".cache");
  await mkdir(cache, { recursive: true });
  const appStage = await mkdtemp(join(cache, "openreel-packaging-app-"));
  try {
    await writeFile(join(appStage, "package.json"), JSON.stringify(desktopMetadata, null, 2) + "\n");
    await cp(join(app, "out"), join(appStage, "out"), { recursive: true });
    config.directories = { ...config.directories, app: appStage, buildResources: fromDesktop("build"), output };
    const configFile = join(stage, "electron-builder.json");
    await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
    const builder = join(app, "node_modules/electron-builder/cli.js");
    const builderArgs = [builder, "--projectDir", repo, "--arm64", "--publish", "never", "--config", configFile];
    run(process.execPath, [...builderArgs, "--mac", "--dir"]);
    const bundle = join(output, "mac-arm64", `${productName}.app`);
    run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
    run("codesign", ["--verify", "--deep", "--strict", bundle]);
    if (privateBuild) {
      const resources = join(bundle, "Contents/Resources");
      for (const notice of publicNotices) {
        const packaged = await readFile(join(resources, notice.to));
        if (!packaged.equals(await readFile(notice.from))) {
          throw new Error(`Packaged license differs from its source: ${notice.to}`);
        }
      }
      if (await readFile(join(resources, markerName), "utf8") !== String(privateReleaseNumber)) {
        throw new Error("Private release number was not packaged.");
      }
      for (const name of ["app-update.yml", "openreel-preview"]) {
        if (existsSync(join(resources, name))) throw new Error(`Unexpected private release resource: ${name}`);
      }
    }
    if (!appOnly) {
      run(process.execPath, [...builderArgs, "--mac", "dmg", "--prepackaged", bundle]);
    }
  } finally {
    await rm(appStage, { recursive: true, force: true });
  }
}
