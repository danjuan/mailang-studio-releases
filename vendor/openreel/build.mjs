import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const stage = process.argv[2] && resolve(process.argv[2]);
if (!stage) throw new Error("Usage: node vendor/openreel/build.mjs <new build directory>");
const editor = join(root, "editor");
const web = join(editor, "apps/web");
const vite = join(web, "node_modules/vite/bin/vite.js");
await stat(vite);
await mkdir(stage);
const view = join(stage, "view");
const plugin = join(stage, "plugin");

function run(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(vite, ["build", "--outDir", view], {
  cwd: web,
  env: { ...process.env, OPENREEL_EDITOR_MODULE_INVENTORY: join(stage, "editor-modules.json") },
});
run(join(root, "adapter/build.mjs"), [editor, plugin, view], {
  cwd: resolve(root, "../.."),
});
