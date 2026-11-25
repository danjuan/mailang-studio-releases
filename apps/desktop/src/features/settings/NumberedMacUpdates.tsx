import { formatPrivateReleaseTag, type UpdateState } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { numberedUpdateError } from "../../lib/update-check-feedback";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";

export function NumberedMacUpdates({ update }: { update: UpdateState }) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const failed = (error: unknown) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  const checking = update.status === "checking";
  const available = update.status === "available" && Boolean(update.availableVersion);
  let status = "";
  if (available) status = t("updates.available", { version: update.availableVersion });
  if (checking) status = t("updates.checking");
  if (update.status === "up-to-date") status = t("updates.upToDate");
  if (update.status === "error" && update.manual) status = numberedUpdateError(update, t);
  return (
    <SettingsCard>
      <SettingsRow title={t("updates.title")} detail={update.privateReleaseNumber !== undefined && formatPrivateReleaseTag(update.privateReleaseNumber)}>
        <Button variant="secondary" disabled={checking} onClick={() => void api.updatesCheck().catch(failed)}>
          {t("updates.check")}
        </Button>
        {available && <Button variant="primary" onClick={() => void api.updatesOpenReleases().catch(failed)}>
          {t("updates.downloadNew")}
        </Button>}
      </SettingsRow>
      {status && <div role="status" className="about-update-status">{status}</div>}
    </SettingsCard>
  );
}
