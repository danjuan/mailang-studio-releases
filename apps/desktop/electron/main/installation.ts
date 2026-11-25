import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import {
  applyInstallationUserData,
  DEVELOPMENT_INSTALLATION_NAME,
  desktopDataDir,
  LEGACY_INSTALLATION_NAME,
  LEGACY_PREVIEW_INSTALLATION_NAME,
  OPENREEL_PREVIEW_INSTALLATION_NAME,
} from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
const isOpenReelPreview = app.isPackaged && typeof process.resourcesPath === "string" &&
  existsSync(join(process.resourcesPath, "openreel-preview"));
// Electron 43 chooses its macOS/Linux encryption key by app name before ready.
// Keep that name and the lock/profile path stable for existing installations.
const storageIdentity = isOpenReelPreview ? LEGACY_PREVIEW_INSTALLATION_NAME : LEGACY_INSTALLATION_NAME;
app.setName(storageIdentity);
app.once("ready", () => {
  app.setName(isOpenReelPreview ? OPENREEL_PREVIEW_INSTALLATION_NAME : APP_NAME);
});
applyInstallationUserData(app, isDevelopmentBuild && !isOpenReelPreview ? DEVELOPMENT_INSTALLATION_NAME : storageIdentity);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
export const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild, isOpenReelPreview);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
