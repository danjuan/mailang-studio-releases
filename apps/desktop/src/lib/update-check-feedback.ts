import type { UpdateState } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { useAppStore } from "../stores/app-store";
import { api } from "./api";

export function numberedUpdateError(state: UpdateState, t: TFunction): string {
  switch (state.numberedCheckError) {
    case "rate-limit": return t("updates.numberedRateLimit");
    case "invalid-release": return t("updates.numberedInvalid");
    default: return t("updates.numberedNetwork");
  }
}

export async function checkForUpdatesFromShell(t: TFunction): Promise<void> {
  const showToast = useAppStore.getState().showToast;
  try {
    const result = await api.updatesCheck();
    if (result.status === "up-to-date") showToast(t("updates.upToDate"), { variant: "success" });
    if (result.mode === "numbered-mac" && result.status === "error") {
      showToast(numberedUpdateError(result, t), { variant: "error" });
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }
}
