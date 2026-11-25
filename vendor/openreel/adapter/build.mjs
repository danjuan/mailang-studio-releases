import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenReelPlugin } from "./src/plugin.mjs";
import { assertOpenReelLocalArtifact, assertShortDramaBundle } from "../assert-short-drama-bundle.mjs";

const source = fileURLToPath(new URL(".", import.meta.url));
const [editorArg, outputArg, webDistArg] = process.argv.slice(2);
if (!editorArg || !outputArg) {
  throw new Error("Usage: node build.mjs <editor source> <new package directory> [web dist]");
}
const editor = resolve(editorArg);
const output = resolve(outputArg);
const web = join(editor, "apps/web");
const webDist = webDistArg ? resolve(webDistArg) : join(web, "dist");
const core = join(editor, "packages/core");
const vitePath = await realpath(join(web, "node_modules/vite/package.json"));
const { build } = createRequire(vitePath)("esbuild");

await mkdir(output, { recursive: false });
const result = await build({
  entryPoints: [join(source, "src/main.ts")],
  alias: {
    "@openreel/agent": join(editor, "packages/agent/src"),
    "@openreel/core": join(core, "src"),
    "@openreel/pi-template-project": join(web, "src/pi/template-project.ts"),
    mediabunny: await realpath(join(core, "node_modules/mediabunny")),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  outfile: join(output, "main.js"),
});
const moduleIds = Object.values(result.metafile.outputs).flatMap(file =>
  Object.entries(file.inputs).filter(([, details]) => details.bytesInOutput > 0).map(([id]) => id),
);
assertShortDramaBundle("adapter", moduleIds);
const modules = [...new Set(moduleIds)].sort();
await writeFile(join(dirname(output), `${basename(output)}-modules.json`), JSON.stringify(modules, null, 2) + "\n");
assertOpenReelLocalArtifact("main.js", await readFile(join(output, "main.js"), "utf8"));
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
manifest.contributes.agentTools = createOpenReelPlugin({}).tools.map(({ name, description, risk, schema }) => ({
  name, description, risk, schema,
}));
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await cp(join(source, "templates"), join(output, "templates"), { recursive: true });
await cp(join(editor, "LICENSE"), join(output, "LICENSE"));
await cp(join(core, "node_modules/mediabunny/LICENSE"), join(output, "LICENSE-mediabunny"));
for (const file of await readdir(webDist, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const path = join(file.parentPath, file.name);
  const sourceCode = /\.(?:[cm]?js|html|css)$/i.test(file.name) ? await readFile(path, "utf8") : "";
  assertOpenReelLocalArtifact(path, sourceCode);
}
await cp(webDist, join(output, "views"), {
  recursive: true,
  filter: path => !path.endsWith("/.gitkeep") && !path.endsWith(".typeface.json"),
});
console.log(output);
