import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const [editorArg, mainArg] = process.argv.slice(2);
if (!editorArg || !mainArg) {
  throw new Error("Usage: node report-capabilities.mjs <private OpenReel editor> <built plugin main.js>");
}
const editor = resolve(editorArg);
const main = resolve(mainArg);
const metadata = JSON.parse(await readFile(join(dirname(main), "manifest.json"), "utf8"));
const vite = await realpath(join(editor, "apps/web/node_modules/vite/package.json"));
const { build } = createRequire(vite)("esbuild");
const registry = await build({
  stdin: { contents: 'export { listTools } from "@openreel/agent/registry";', resolveDir: editor },
  alias: {
    "@openreel/agent": join(editor, "packages/agent/src"),
    "@openreel/core": join(editor, "packages/core/src"),
  },
  bundle: true, write: false, platform: "node", format: "esm", target: "node22",
});
const engineTools = (await import(`data:text/javascript;base64,${Buffer.from(registry.outputFiles[0].contents).toString("base64")}`)).listTools();
const engine = new Map(engineTools.map(tool => [tool.name, tool]));
assert.equal(engine.size, engineTools.length, "The private editor must have unique tool names");

// This stub makes the host broker visible for declaration discovery only.
// It never invokes a device, model, file broker, or editor.
function discoveryOnly() { throw new Error("Capability inventory does not execute jobs."); }
globalThis.pi = { openReel: { transcribe: discoveryOnly, export: discoveryOnly } };
const { onMcpMessage: exchange } = await import(pathToFileURL(main).href);
let id = 0;
async function request(method, params, scope) {
  const message = { jsonrpc: "2.0", id: ++id, method, params };
  const response = await exchange(message, scope);
  assert.equal(response?.jsonrpc, "2.0");
  assert.equal(response.id, id);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}
const hello = await request("initialize", {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenReel capability inventory", version: "1" },
});
assert.equal(hello.protocolVersion, "2025-06-18");
await exchange({ jsonrpc: "2.0", method: "notifications/initialized" });

const exposed = new Map();
let cursor;
do {
  const page = await request("tools/list", { cursor });
  for (const tool of page.tools) {
    assert(!exposed.has(tool.name), `MCP duplicated ${tool.name}`);
    exposed.set(tool.name, tool);
  }
  assert(page.nextCursor === undefined || Number(page.nextCursor) > Number(cursor ?? 0));
  cursor = page.nextCursor;
} while (cursor !== undefined);

const catalogue = new Map();
let offset = 0;
do {
  const page = await request("tools/call", {
    name: "read_draft", arguments: { query: "*", offset },
  }, { sessionId: "capability-inventory" });
  assert.equal(page.isError, undefined, JSON.stringify(page.structuredContent));
  const result = page.structuredContent;
  for (const tool of result.capabilities) {
    assert(!catalogue.has(tool.name), `Capability discovery duplicated ${tool.name}`);
    catalogue.set(tool.name, tool);
  }
  assert(result.nextOffset === null || result.nextOffset > offset);
  offset = result.nextOffset;
  if (offset === null) assert.equal(catalogue.size, result.total);
} while (offset !== null);

for (const name of engine.keys()) assert(catalogue.has(name), `Missing private engine capability: ${name}`);
for (const name of catalogue.keys()) {
  assert(!/(?:creation|3d|rigging|gltf|^execute_action$)/i.test(name), `Retired short-drama capability: ${name}`);
}
const aliasNames = metadata.contributes.agentTools.map(tool => tool.name);
assert.deepEqual(aliasNames, [
  "open_editor", "read_draft", "prepare_edit", "start_analysis_job", "analysis_job_status", "cancel_analysis_job",
  "start_media_job", "media_job_status", "cancel_media_job", "apply_edits",
]);
for (const alias of metadata.contributes.agentTools) assert.deepEqual(exposed.get(alias.name)?.inputSchema, alias.schema);
const reviewedActions = new Set(["delete_objects", "ripple_delete_ranges"]);
assert.deepEqual([...exposed.keys()].sort(), [...aliasNames,
  ...[...catalogue.values()].filter(tool => tool.available && !reviewedActions.has(tool.name)).map(tool => tool.name)].sort());

const capabilities = [...catalogue.values()].sort((a, b) => a.name.localeCompare(b.name)).map(tool => {
  const reference = engine.get(tool.name);
  const declared = exposed.get(tool.name);
  const schemaMatches = reference &&
    isDeepStrictEqual({ ...reference.inputSchema, additionalProperties: false }, tool.inputSchema);
  if (declared) {
    assert.equal(declared.annotations.readOnlyHint, tool.readOnly);
    assert.deepEqual(declared.inputSchema, tool.readOnly ? tool.inputSchema : {
      type: "object", additionalProperties: false,
      properties: { expectedRevision: { type: "integer", minimum: 0 }, arguments: tool.inputSchema },
      required: ["expectedRevision", "arguments"],
    });
  } else if (!reviewedActions.has(tool.name)) {
    assert.equal(typeof tool.unavailableReason, "string", `Explain unavailable capability: ${tool.name}`);
  }
  return {
    name: tool.name,
    domain: tool.domain,
    source: reference ? "editor" : "adapter",
    readOnly: tool.readOnly,
    schema: schemaMatches ? "editor-with-closed-arguments" : reference ? "adapted" : "adapter",
    exposedByMcp: Boolean(declared),
    ...(reviewedActions.has(tool.name) ? { reviewTool: "prepare_edit" } : {}),
    ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {}),
    ...(tool.name === "auto_caption" ? { dependencies: ["configured caption service", "FFmpeg"] } : {}),
    ...(tool.name === "export_video" ? { dependencies: ["host export broker", "local WebCodecs MP4 encoding"] } : {}),
    ...(tool.name === "export_audio" ? { dependencies: ["host export broker", "local OpenReel audio mixer and WAV encoder"] } : {}),
  };
});
const domains = {};
for (const tool of capabilities) {
  const totals = domains[tool.domain] ??= { known: 0, exposed: 0 };
  totals.known++;
  if (tool.exposedByMcp) totals.exposed++;
}
console.log(JSON.stringify({
  pluginVersion: metadata.version,
  pluginMainSha256: createHash("sha256").update(await readFile(main)).digest("hex"),
  engineCount: engine.size,
  aliases: aliasNames,
  knownCount: capabilities.length,
  exposedCount: capabilities.filter(tool => tool.exposedByMcp).length,
  evidence: "Private short-drama registry, built plugin manifest, and MCP discovery. Execution and output require runtime tests.",
  domains,
  capabilities,
}, null, 2));
