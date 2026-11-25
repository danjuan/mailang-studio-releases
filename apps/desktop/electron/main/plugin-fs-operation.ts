import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PluginFsReadOptions, PluginFsWriteOptions } from "@pi-desktop/plugin-sdk";

const invalid = (message: string) => Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });

/** Expected identities constrain existing authority; they never select a root. */
export function pluginFsOperationOptions(value: unknown): PluginFsReadOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("workspacePath" in value) || typeof value.workspacePath !== "string" || !value.workspacePath.length) {
    throw invalid("workspacePath must be a non-empty string");
  }
  return { workspacePath: value.workspacePath };
}

export function pluginFsWriteOptions(value: unknown): PluginFsWriteOptions | undefined {
  const options = pluginFsOperationOptions(value);
  if (!options) return undefined;
  const atomic = (value as Record<string, unknown>).atomic;
  if (atomic !== undefined && typeof atomic !== "boolean") throw invalid("atomic must be a boolean");
  return { ...options, ...(atomic === undefined ? {} : { atomic }) };
}

/** Revalidate an already admitted canonical destination without another await. */
export function assertPluginFileDestination(full: string): void {
  const changed = () => Object.assign(new Error("The file destination changed during the request"), { code: "WORKSPACE_CHANGED" });
  let parent = dirname(full);
  while (!existsSync(parent)) {
    const ancestor = dirname(parent);
    if (ancestor === parent) throw changed();
    parent = ancestor;
  }
  if (realpathSync(parent) !== parent) throw changed();
  try {
    // existsSync follows links and reports false for a dangling target.
    if (lstatSync(full).isSymbolicLink() || realpathSync(full) !== full) throw changed();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

/** Stage and flush privately, then publish only while the caller's guard holds. */
export async function writePluginTextAtomic(full: string, content: string, beforeCommit: () => void): Promise<{ durabilityError?: Error }> {
  beforeCommit();
  assertPluginFileDestination(full);
  mkdirSync(dirname(full), { recursive: true });
  const temporary = join(dirname(full), `.pi-plugin-${randomUUID()}.tmp`);
  let published = false;
  try {
    const mode = existsSync(full) ? statSync(full).mode & 0o777 : 0o600;
    const file = await open(temporary, "wx", 0o600);
    try {
      beforeCommit();
      assertPluginFileDestination(full);
      await file.writeFile(content, "utf8");
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    beforeCommit();
    assertPluginFileDestination(full);
    renameSync(temporary, full);
    published = true;
    if (process.platform !== "win32") {
      try {
        const directory = openSync(dirname(full), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch (error) {
        // The rename already committed. Preserve success and report durability separately.
        return { durabilityError: error instanceof Error ? error : new Error(String(error)) };
      }
    }
    return {};
  } finally {
    if (!published) {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
