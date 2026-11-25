import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { listSwitcherProjects, normalizeProjectPath } from "../lib/sidebar-preferences";
import { useAppStore } from "../stores/app-store";
import { AnchoredMenu } from "./settings/AnchoredMenu";
import { IconChat, IconCheck, IconFolder } from "./icons";
import { cx } from "./ui";

type Target = { key: string; name: string; path: string | null };

const TEMPORARY_KEY = "temporary";

/**
 * The topbar's project crumb. For an idle local conversation it opens a menu
 * that moves the conversation into another open project or out of any
 * project (#2455); the transcript stays with the session. Running, remote,
 * native, and isolated-worktree sessions keep the static crumb.
 */
export function ConversationProjectMenu({
  session,
  project,
  openReelProjectNotice,
}: {
  session: SessionSummary;
  /** Display name of the session's project, or null for a temporary one. */
  project: string | null;
  openReelProjectNotice: boolean;
}) {
  const { t } = useTranslation();
  const openProjectPaths = useAppStore((state) => state.openProjectPaths);
  const openProjects = useAppStore((state) => state.openProjects);
  const workspace = useAppStore((state) => state.workspace);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const projectSort = useAppStore((state) => state.projectSort);
  const running = useAppStore((state) => state.runningSessions[session.id] === true);
  const moveSessionProject = useAppStore((state) => state.moveSessionProject);
  const openProject = useAppStore((state) => state.openProject);
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectHintId = useId();

  const currentKey = normalizeProjectPath(session.projectPath) ?? TEMPORARY_KEY;
  const targets = useMemo((): Target[] => [
    { key: TEMPORARY_KEY, name: t("project.noProject"), path: null },
    ...listSwitcherProjects({ openProjectPaths, openProjects, workspace, projectMeta, projectSort })
      .map((entry) => ({ key: entry.key, name: entry.name, path: entry.path })),
  ], [openProjectPaths, openProjects, workspace, projectMeta, projectSort, t]);

  const canMoveSession = !session.worktree && session.source !== "pi-native";
  const requiresProject = openReelProjectNotice && currentKey === TEMPORARY_KEY && canMoveSession;
  const moveLabel = t("nav.moveToProject");
  const label = requiresProject ? moveLabel : project ?? t("project.noProject");
  const projectHint = t("nav.openReelProjectRequired");
  const movable = !running && canMoveSession;
  // The bundled editor can bind only an absolute local workspace path.
  const availableTargets = requiresProject ? targets.filter((target) => target.path?.startsWith("/")) : targets;

  const separator = <span className="ct-sep" aria-hidden>/</span>;
  if (!movable && !requiresProject) {
    return project ? (
      <>
        <span className="ct-project">
          <IconFolder size={12} aria-hidden />
          <span className="ct-project-name">{project}</span>
        </span>
        {separator}
      </>
    ) : null;
  }

  const move = async (target: Target) => {
    setOpen(false);
    if (busy || !movable || target.key === currentKey) return;
    setBusy(true);
    try {
      const moved = await moveSessionProject(session.id, target.path);
      showToast(
        !moved
          ? t("nav.moveSessionUnavailable")
          : target.path === null
            ? t("nav.sessionMovedToTemporary")
            : t("nav.sessionMoved", { name: target.name }),
        { variant: moved ? "success" : "warning" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    {requiresProject && (
      <span id={projectHintId} className="sr-only" role="status">{projectHint}</span>
    )}
    <AnchoredMenu
      className={cx("ct-project-menu", requiresProject && "ct-project-menu-required")}
      open={open && movable}
      onClose={() => setOpen(false)}
      menuClassName="home-project-switcher-menu"
      label={moveLabel}
      role="menu"
      align="start"
      side="bottom"
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className={cx("ct-project", "ct-project-trigger", !project && "is-temporary", requiresProject && "ct-project-required")}
          data-action="conversation-project"
          aria-haspopup="menu"
          aria-expanded={open && movable}
          aria-label={requiresProject ? moveLabel : `${moveLabel}: ${label}`}
          aria-describedby={requiresProject ? projectHintId : undefined}
          title={requiresProject ? projectHint : undefined}
          disabled={busy || !movable}
          onClick={() => setOpen((value) => !value)}
        >
          {project ? <IconFolder size={12} aria-hidden /> : <IconChat size={12} aria-hidden />}
          <span className="ct-project-name">{label}</span>
        </button>
      )}
    >
      <div className="home-project-switcher-list" role="none">
        {requiresProject && <p className="ct-project-requirement">{projectHint}</p>}
        {availableTargets.map((target) => {
          const current = target.key === currentKey;
          return (
            <button
              key={target.key}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              title={target.path ?? t("project.noProjectHint")}
              className={cx("home-project-switcher-item", current && "is-current")}
              data-move-target={target.key}
              disabled={busy}
              onClick={() => void move(target)}
            >
              {target.path === null ? <IconChat size={14} aria-hidden /> : <IconFolder size={14} aria-hidden />}
              <span className="home-project-switcher-item-name">{target.name}</span>
              {current ? <IconCheck size={14} className="home-project-switcher-check" aria-hidden /> : null}
            </button>
          );
        })}
        {requiresProject && availableTargets.length === 0 && (
          <button
            type="button"
            role="menuitem"
            className="home-project-switcher-item"
            onClick={() => {
              setOpen(false);
              void openProject();
            }}
          >
            <IconFolder size={14} aria-hidden />
            {t("nav.newProject")}
          </button>
        )}
      </div>
    </AnchoredMenu>
    {separator}
    </>
  );
}
