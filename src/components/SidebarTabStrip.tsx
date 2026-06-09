// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
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

// The strip pinned above the left sidebar body. "Sessions" is always first and
// can't be closed; each opened project folder follows as a closable tab. When
// no folders are open the strip collapses to nothing — the sidebar reads as a
// plain Sessions list, exactly as before this feature existed.
export function SidebarTabStrip({
  openFolders,
  sidebarTab,
  linkNav,
  onSelectSessions,
  onSelectFolder,
  onCloseFolder,
  onToggleLink,
}: SidebarTabStripProps) {
  if (openFolders.length === 0) return null;

  const sessionsActive = sidebarTab.kind === "sessions";

  return (
    <div
      className="rl-thin-scroll-x flex items-stretch border-b overflow-x-auto"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-paper)",
      }}
    >
      <TabButton active={sessionsActive} onSelect={onSelectSessions}>
        Sessions
      </TabButton>
      {openFolders.map((folder) => {
        const active = sidebarTab.kind === "folder" && sidebarTab.id === folder.id;
        return (
          <TabButton
            key={folder.id}
            active={active}
            onSelect={() => onSelectFolder(folder.id)}
            onClose={() => onCloseFolder(folder.id)}
            title={folder.path}
          >
            {folder.name}
          </TabButton>
        );
      })}
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
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
  title?: string;
  children: React.ReactNode;
}

function TabButton({ active, onSelect, onClose, title, children }: TabButtonProps) {
  return (
    <div
      className="rl-chrome-label shrink-0 flex items-center gap-1 px-3 py-2 border-r"
      style={{
        borderColor: "var(--color-rule)",
        background: active ? "var(--color-bg-elevated)" : "transparent",
        color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
        cursor: "pointer",
        maxWidth: "140px",
      }}
      onClick={onSelect}
      title={title}
    >
      <span className="truncate">{children}</span>
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            // Don't let the close click also select the tab underneath it.
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close folder"
          className="flex items-center justify-center rounded"
          style={{
            width: "14px",
            height: "14px",
            fontSize: "11px",
            lineHeight: 1,
            color: "var(--color-ink-muted)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
