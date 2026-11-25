import { failure, validRevision } from "./drafts.mjs";

const formats = new Map([["export_video", "mp4"], ["export_audio", "wav"]]);
export const exportFormat = name => formats.get(name);
export const exportCapabilities = [...formats].map(([name, format]) => ({
  name,
  domain: "export",
  description: `Render the current saved draft revision through OpenReel to a new project-relative ${format.toUpperCase()} file.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      format: { type: "string", enum: [format] },
      ...(format === "mp4" ? { preset: { enum: ["draft", "landscape1080p", "portrait1080p", "square1080p"] } } : {}),
    },
  },
  readOnly: false,
  destructive: false,
  expensive: true,
  available: true,
}));

export async function exportSavedMedia(api, store, context, expectedRevision, format, args) {
  if (args.format !== undefined && args.format !== format) {
    throw failure("INVALID_ARGUMENT", `This OpenReel exporter supports ${format.toUpperCase()}.`);
  }
  if (args.preset !== undefined && (format !== "mp4" ||
      !["draft", "landscape1080p", "portrait1080p", "square1080p"].includes(args.preset))) {
    throw failure("INVALID_ARGUMENT", "Choose a supported video export preset.");
  }
  if (!validRevision(expectedRevision) || expectedRevision === 0) {
    throw failure("INVALID_ARGUMENT", "Read the current saved draft revision before exporting.");
  }
  const draft = await store.load(context);
  if (draft.revision !== expectedRevision) {
    throw failure("REVISION_CONFLICT", `Draft changed from revision ${expectedRevision} to ${draft.revision}. Read the current draft before exporting.`);
  }
  if (!draft.project || draft.project.timeline.duration <= 0) {
    throw failure("INVALID_DRAFT", "Add a clip and save the timeline before exporting.");
  }
  context.signal?.throwIfAborted();
  const result = await api.openReel.export({ workspacePath: context.projectPath, expectedRevision, format, ...(args.preset ? { preset: args.preset } : {}) });
  if (!result || result.format !== format || result.revision !== expectedRevision ||
      typeof result.path !== "string" || typeof result.bytes !== "number" ||
      !Number.isSafeInteger(result.bytes) || result.bytes <= 0) {
    throw failure("TOOL_FAILED", "OpenReel did not return a verified exported artifact.");
  }
  return result;
}
