// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";
import { ChevronDown, Folder, X } from "lucide-react";
import { Panel, useClickPopover } from "./popover";
import type { FolderTab } from "../types";
import type { SidebarTab } from "../hooks/useFolderWorkspaces";

interface SidebarTabStripProps {
  openFolders: FolderTab[];
  sidebarTab: SidebarTab;
  /** Linked navigation: focusing a terminal brings its folder tab forward.
   *  The toggle here lets the user disengage that focus-follow. */
  linkNav: boolean;
  onSelectSessions: () => void;
  onSelectFolder: (id: string) => void;
  onCloseFolder: (id: string) => void;
  onToggleLink: () => void;
}

// One picker chooses which sidebar body is visible. Folder lifetimes and
// linked navigation stay owned by the existing workspace controller.
export function SidebarTabStrip({ openFolders, sidebarTab, linkNav,
  onSelectSessions, onSelectFolder, onCloseFolder, onToggleLink,
}: SidebarTabStripProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useClickPopover(triggerRef, "left", "below");
  useEffect(() => { if (!openFolders.length) menu.close(); }, [openFolders.length, menu.close]);
  if (!openFolders.length) return null;
  const active = sidebarTab.kind === "folder" ? openFolders.find(f => f.id === sidebarTab.id) : null;
  const choose = (action: () => void) => { action(); menu.close(); triggerRef.current?.focus(); };
  return (
    <div className="flex items-stretch border-b" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <button ref={triggerRef} type="button" className="rl-chrome-label flex min-w-0 flex-1 items-center gap-2 px-3 py-2"
        aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle} title={active?.path ?? "Sessions"}>
        {active && <Folder size={13} />}<span className="min-w-0 flex-1 truncate text-left">{active?.name ?? "Sessions"}</span><ChevronDown size={12} />
      </button>
      <button
        type="button"
        onClick={onToggleLink}
        title={
          linkNav
            ? "Linked navigation on — focusing a terminal follows to its folder. Click to disengage."
            : "Linked navigation off — terminal focus won't change the folder. Click to engage."
        }
        aria-pressed={linkNav}
        className="shrink-0 px-2 flex items-center"
        style={{
          fontSize: "12px",
          lineHeight: 1,
          color: linkNav ? "var(--color-info)" : "var(--color-ink-muted)",
          background: "transparent",
          border: "none",
          borderLeft: "1px solid var(--color-rule)",
          cursor: "pointer",
        }}
      >
        {linkNav ? "🔗" : "⛓️‍💥"}
      </button>
      {menu.open && <Panel label="Sidebar view" {...menu.panelProps}>
        <div className="min-h-0 overflow-y-auto py-1">
          <button type="button" role="menuitem" aria-selected={!active} className="rl-menu-item w-full px-3 py-2 text-left"
            onClick={() => choose(onSelectSessions)}>Sessions</button>
          <div className="px-3 py-1 font-mono text-[10px] uppercase" style={{ color: "var(--color-ink-muted)" }}>Code</div>
          {openFolders.map(folder => <div key={folder.id} className="flex items-center">
            <button type="button" role="menuitem" aria-selected={active?.id === folder.id}
              className="rl-menu-item min-w-0 flex-1 px-3 py-2 text-left" title={folder.path}
              onClick={() => choose(() => onSelectFolder(folder.id))}>
              <span className="block truncate">{folder.name}</span>
              <span className="block truncate text-[10px]" style={{ direction: "rtl", textAlign: "left", color: "var(--color-ink-muted)" }}><bdi>{folder.path}</bdi></span>
            </button>
            <button type="button" className="rl-menu-item mr-1 shrink-0 rounded p-2" aria-label={`Close ${folder.name}`}
              onClick={event => { event.stopPropagation(); onCloseFolder(folder.id); }}><X size={12} /></button>
          </div>)}
        </div>
      </Panel>}
    </div>
  );
}
