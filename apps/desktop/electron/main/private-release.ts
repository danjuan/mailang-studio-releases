import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The private packager alone ships this resource; the Preview has its own marker. */
export function getPrivateReleaseNumber(resourcesPath = process.resourcesPath): number | undefined {
  if (!resourcesPath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(resourcesPath, "openreel-private-release"), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const number = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(number)) {
    throw new Error("Invalid private release number in the application bundle.");
  }
  return number;
}
