import { useRef } from "react";
import {
  ToolcraftDropdownMenu as DropdownMenu,
  ToolcraftDropdownMenuItem as MenuItem,
} from "@openreel/ui";
import { Icon } from "@/icons/Icon";
import { piEditorLabel } from "./editor-copy";
import { useObservedWidth } from "./responsive-layout";

export type AssetsTab =
  | "media"
  | "text"
  | "graphics"
  | "effects"
  | "transitions"
  | "recipes"
  | "templates";

type Tab = { value: AssetsTab; label: string };

interface PiAssetsNavigationProps {
  tabs: readonly Tab[];
  activeTab: AssetsTab;
  onSelect: (tab: AssetsTab) => void;
}

const wideOverflow: readonly AssetsTab[] = ["recipes", "templates"];
const narrowOverflow: readonly AssetsTab[] = ["graphics", "transitions", ...wideOverflow];

export function PiAssetsNavigation({ tabs, activeTab, onSelect }: PiAssetsNavigationProps) {
  const ref = useRef<HTMLElement>(null);
  const compact = useObservedWidth(ref, true) < 300;
  const overflow = compact ? narrowOverflow : wideOverflow;
  const activeInMenu = overflow.includes(activeTab);

  return (
    <nav ref={ref} aria-label={piEditorLabel("Media categories")} data-pi-assets-nav data-compact={compact}>
      {tabs.filter((tab) => !overflow.includes(tab.value)).map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-pressed={tab.value === activeTab}
          data-pi-asset-tab={tab.value}
          onClick={() => onSelect(tab.value)}
        >
          {piEditorLabel(tab.value === "effects" ? "Visual effects" : tab.label)}
        </button>
      ))}
      <div className="pi-assets-more" data-current={activeInMenu}>
        <DropdownMenu
          alignment="end"
          className="pi-assets-menu"
          menuWidth="min(12rem, calc(100vw - 16px))"
          hasChevron
          button={{
            label: piEditorLabel("More"),
            "aria-label": piEditorLabel("More media categories"),
            variant: "ghost",
            size: "sm",
          }}
        >
          {overflow.map((value) => {
            const tab = tabs.find((entry) => entry.value === value);
            if (!tab) return null;
            const current = value === activeTab;
            return (
              <MenuItem
                key={value}
                data-pi-asset-menu-item={value}
                aria-current={current || undefined}
                label={piEditorLabel(tab.label)}
                endContent={current ? <Icon name="checkmark" size={14} ariaHidden /> : undefined}
                onSelect={() => onSelect(value)}
              />
            );
          })}
        </DropdownMenu>
      </div>
    </nav>
  );
}
