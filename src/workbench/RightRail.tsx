// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The right rail's chrome (W4): the 34px tab strip over whichever tab body
// App hands it, and — collapsed — the 40px edge strip of the same tabs as
// icons, so every one of them (the mic included) stays one click away. Pure
// and presentational: App decides the tabs (`rail.ts`), the active one, the
// counts, and what each body is; only the active tab's body is ever mounted,
// so a tab that is not shown cannot poll.
//
// Lazy, with its stylesheet: nothing here is on the boot path.

import { memo, type ReactNode } from "react";
import {
  FolderTree,
  GitCompare,
  Maximize2,
  MessagesSquare,
  Mic,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react";

import { RAIL_TAB_LABEL, type RailTab } from "./rail";
import "./rail.css";

const RAIL_ICON: Record<RailTab, LucideIcon> = {
  discussion: MessagesSquare,
  talk: Mic,
  files: FolderTree,
  changes: GitCompare,
};

export interface RailBadges {
  /** A number beside the tab's name. */
  counts?: Partial<Record<RailTab, number>>;
  /** Tabs with something waiting on the user: the count wears amber. */
  attention?: Partial<Record<RailTab, boolean>>;
}

export interface RightRailProps extends RailBadges {
  tabs: readonly RailTab[];
  active: RailTab;
  onSelect: (tab: RailTab) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** ◨: fold the rail to its edge strip (⌘⌥B). */
  onCollapse: () => void;
  /** The active tab's body. */
  children: ReactNode;
}

function Count({ tab, counts, attention }: { tab: RailTab } & RailBadges) {
  const n = counts?.[tab];
  if (!n) return null;
  return (
    <span className="rl-rail-count" data-attention={attention?.[tab] ? "" : undefined}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

function RightRailBase({ tabs, active, onSelect, counts, attention, fullscreen, onToggleFullscreen, onCollapse, children }: RightRailProps) {
  return (
    <div className="rl-rail" data-rail-tab={active}>
      <div className="rl-rail-strip" role="tablist" aria-label="Rail">
        {tabs.map((tab) => {
          const Icon = RAIL_ICON[tab];
          const on = tab === active;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={on}
              data-rail-tab={tab}
              className="rl-rail-tab"
              title={tab === "talk" ? "Talk (⌘J)" : RAIL_TAB_LABEL[tab]}
              onClick={() => onSelect(tab)}
            >
              <Icon size={16} aria-hidden />
              <span className="rl-rail-tab-label">{RAIL_TAB_LABEL[tab]}</span>
              <Count tab={tab} counts={counts} attention={attention} />
            </button>
          );
        })}
        <span className="rl-rail-spacer" />
        <button
          type="button"
          className="rl-rail-icon"
          title={fullscreen ? "Restore the rail" : "Fill the window with the rail"}
          aria-label={fullscreen ? "Restore the rail" : "Fill the window with the rail"}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
        </button>
        <button type="button" className="rl-rail-icon" title="Hide the rail (⌘⌥B)" aria-label="Hide the rail" onClick={onCollapse}>
          <PanelRightClose size={16} aria-hidden />
        </button>
      </div>
      <div className="rl-rail-body" role="tabpanel" aria-label={RAIL_TAB_LABEL[active]}>
        {children}
      </div>
    </div>
  );
}

export const RightRail = memo(RightRailBase);

export interface RailEdgeProps extends RailBadges {
  tabs: readonly RailTab[];
  /** Open the rail on this tab. */
  onOpen: (tab: RailTab) => void;
  /** ◨: open the rail on the tab it remembers (⌘⌥B). */
  onExpand: () => void;
}

/** The collapsed rail: the tabs as 16px icons down a 40px strip, the
 *  attention count riding the icon, and the way back open at the foot. */
function RailEdgeBase({ tabs, onOpen, onExpand, counts, attention }: RailEdgeProps) {
  return (
    <div className="rl-rail-edge" aria-label="Rail">
      {tabs.map((tab) => {
        const Icon = RAIL_ICON[tab];
        const n = counts?.[tab];
        return (
          <button
            key={tab}
            type="button"
            className="rl-rail-edge-btn"
            data-rail-tab={tab}
            title={n ? `${RAIL_TAB_LABEL[tab]} · ${n}` : tab === "talk" ? "Talk (⌘J)" : RAIL_TAB_LABEL[tab]}
            aria-label={RAIL_TAB_LABEL[tab]}
            onClick={() => onOpen(tab)}
          >
            <Icon size={16} aria-hidden />
            {!!n && (
              <span className="rl-rail-edge-count" data-attention={attention?.[tab] ? "" : undefined}>
                {n > 9 ? "9+" : n}
              </span>
            )}
          </button>
        );
      })}
      <span className="rl-rail-spacer" />
      <button type="button" className="rl-rail-edge-btn" title="Show the rail (⌘⌥B)" aria-label="Show the rail" onClick={onExpand}>
        <PanelRightOpen size={16} aria-hidden />
      </button>
    </div>
  );
}

export const RailEdge = memo(RailEdgeBase);
