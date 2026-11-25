import React from "react";
import {
  ToolcraftDropdownMenu as DropdownMenu,
  ToolcraftIconButton as IconButton,
  ToolcraftTooltip as Tooltip,
} from "@openreel/ui";
import { Icon } from "@/icons/Icon";
import { ListTodo } from "lucide-react";
import { Sun, Moon, SunMoon, Play } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useThemeStore } from "../../stores/theme-store";
import { piEditorLabel } from "../../pi/editor-copy";
import { startTour, ONBOARDING_KEY } from "./tour";

const RailButton: React.FC<{
  label: string;
  icon: string;
  onClick: () => void;
  active?: boolean;
}> = ({ label, icon, onClick, active = false }) => (
  <Tooltip content={label} placement="end">
    <IconButton
      label={label}
      icon={<Icon name={icon} size={16} ariaHidden />}
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
    />
  </Tooltip>
);

export type EditorTaskAction = {
  ref: React.Ref<HTMLButtonElement>;
  activity: boolean;
  reviewPending?: boolean;
  open: () => void;
};

export const EditorActionRail: React.FC<{ taskAction?: EditorTaskAction }> = ({ taskAction }) => {
  const { undo, redo } = useProjectStore();
  const { openModal, toggleKeyframeEditor, keyframeEditorOpen, activeModal } = useUIStore();
  const { mode: themeMode, toggleTheme } = useThemeStore();

  const themeLabel =
    themeMode === "auto"
      ? "System"
      : themeMode.charAt(0).toUpperCase() + themeMode.slice(1);
  const nextThemeLabel =
    themeMode === "light" ? "Dark" : themeMode === "dark" ? "System" : "Light";
  const themeIcon =
    themeMode === "light" ? (
      <Sun size={16} aria-hidden />
    ) : themeMode === "dark" ? (
      <Moon size={16} aria-hidden />
    ) : (
      <SunMoon size={16} aria-hidden />
    );
  const themeActionLabel = `Theme: ${themeLabel}. Switch to ${nextThemeLabel}`;
  const tasksLabel = piEditorLabel("Tasks");
  const taskDescription = taskAction?.reviewPending ? piEditorLabel("Awaiting confirmation")
    : taskAction?.activity ? piEditorLabel("Task activity available") : undefined;

  return (
    <nav
      data-tour="toolbar"
      aria-label="Editor tools"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-1 py-3"
    >
      <RailButton
        label={piEditorLabel("Find editing tools")}
        icon="magnifyingglass"
        onClick={() => openModal("search")}
      />
      <RailButton
        label="Undo"
        icon="arrow.uturn.backward"
        onClick={() => void undo()}
      />
      <RailButton
        label="Redo"
        icon="arrow.uturn.forward"
        onClick={() => void redo()}
      />

      <div className="my-1.5 h-px w-6 bg-border" />

      <RailButton
        label="Action history"
        icon="clock"
        onClick={() => openModal("history")}
        active={activeModal === "history"}
      />
      {taskAction && (
        <Tooltip content={taskAction.reviewPending ? `${tasksLabel} · ${taskDescription}` : tasksLabel} placement="end">
          <IconButton
            ref={taskAction.ref}
            label={tasksLabel}
            aria-description={taskDescription}
            className="relative"
            icon={<>
              <ListTodo size={16} aria-hidden="true" />
              {taskAction.activity && <span className="pi-task-activity" data-pi-task-activity aria-hidden="true" />}
            </>}
            onClick={taskAction.open}
            data-pi-task-center-open
            data-pi-review-pending={taskAction.reviewPending || undefined}
          />
        </Tooltip>
      )}
      <RailButton
        label="Keyframe editor"
        icon="diamond"
        onClick={toggleKeyframeEditor}
        active={keyframeEditorOpen}
      />
      <div className="flex-1" />

      <Tooltip content={themeActionLabel} placement="end">
        <IconButton
          label={themeActionLabel}
          icon={themeIcon}
          size="sm"
          variant="secondary"
          onClick={toggleTheme}
        />
      </Tooltip>

      <DropdownMenu
        placement="end"
        button={{
          label: "More editor actions",
          icon: <Icon name="star" size={16} ariaHidden />,
          size: "sm",
          variant: "ghost",
          isIconOnly: true,
        }}
        hasChevron={false}
        menuWidth={224}
        items={[{
          label: piEditorLabel("Editor tour"),
          icon: <Play size={14} aria-hidden />,
          onClick: () => {
            localStorage.removeItem(ONBOARDING_KEY);
            startTour();
          },
        }]}
      />
    </nav>
  );
};
