import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export type SessionVideoTools = {
  tail: (input: string, output: string, signal?: AbortSignal) => Promise<void>;
  stitch: (inputs: readonly string[], output: string, signal?: AbortSignal) => Promise<void>;
};

const run = promisify(execFile);

export function createSessionVideoTools(executable: string): SessionVideoTools {
  async function invoke(operation: "tail" | "stitch", inputs: readonly string[], output: string, signal?: AbortSignal) {
    if (signal?.aborted) signal.throwIfAborted();
    try {
      await run(executable, [operation, output, ...inputs], {
        signal,
        timeout: operation === "tail" ? 30_000 : 240_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Could not process session video locally."), { code: "UNAVAILABLE" });
    }
  }
  return {
    tail: (input, output, signal) => invoke("tail", [input], output, signal),
    stitch: (inputs, output, signal) => invoke("stitch", inputs, output, signal),
  };
}

/** The application owns the executable and argument schema. Do not consult PATH or plugin settings. */
export function bundledSessionVideoTools(): SessionVideoTools | undefined {
  if (process.platform !== "darwin" || !process.resourcesPath) return undefined;
  const executable = join(process.resourcesPath, "bin", "pi-session-media-video");
  if (existsSync(executable)) return createSessionVideoTools(executable);
  return undefined;
}
