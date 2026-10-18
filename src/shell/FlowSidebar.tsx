// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's sessions sidebar (boards 4a, 4b, 4d and 5a):
//! "+ New session ⌘N", then plans, chats and launched sessions in one list,
//! sorted by what they need from you (lib/sessionGroups.ts) and grouped by
//! project, each project with a "+" that starts a session in that folder.
//! The open session's versions nest under it; archived rows wait in a fold
//! at the end.
//!
//! `SessionSidebar` renders this for `layout="flow"`, lazily, so the classic
//! shell never loads it. Every row has a ⋯ (also right-click, and ⌫ to
//! delete), always visible: faint at rest, full under the pointer.

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FilePenLine, FileText, Loader, MessageSquare, Plus } from "lucide-react";
import type { SessionSidebarProps } from "../components/SessionSidebar";
import { chatRowActions, planRowActions, RowMenu, RowRename, type RowAction } from "../components/RowMenu";
import {
  buildSidebar,
  itemKey,
  versionRows,
  type SidebarItem,
  type SidebarSection,
} from "../lib/sessionGroups";
import { isBuildingRunState, type ModeKind } from "../lib/sessionMode";
import "./FlowSidebar.css";

/** The open row's icon wears its mode (4b's blue spinner, 4d's amber pen,
 *  5a's green loader). A chat has no mode colour. */
const MODE_FG: Record<ModeKind, string> = {
  plan: "var(--color-mode-plan-fg)",
  redline: "var(--color-mode-redline-fg)",
  build: "var(--color-mode-build-fg)",
  chat: "var(--color-ink)",
};

/** What the row does, by kind; id-based so a memoized row keeps them. */
interface RowHandlers {
  pick: (item: SidebarItem) => void;
  rename: (item: SidebarItem, title: string) => void;
  archive: (item: SidebarItem) => void;
  remove: (item: SidebarItem) => void;
  selectRevision: (sessionId: string, versionNumber: number | null) => void;
}

export default function FlowSidebar(props: SessionSidebarProps) {
  const {
    sessions, activeId, chats, activeChatId, launches, activeLaunchId, needs, working,
    viewedVersionNumber, onNewSession, onNewSessionIn,
    onSelect, onSelectChat, onSelectLaunch, onRename, onRenameChat, onArchive, onArchiveChat,
    onDelete, onDeleteChat, onSelectRevision,
  } = props;
  // The start screen owns the stage when nothing is open; while it shows, no
  // row reads as open even if a plan is still selected underneath.
  const startActive = props.startActive ?? (activeId === null && !activeChatId && !activeLaunchId);
  // A launch whose plan has arrived is that plan's row now (sessionGroups),
  // so the open launch is the open plan until the host catches up.
  const landed = activeLaunchId ? sessions.find((s) => s.heldTerminalId === activeLaunchId) : undefined;
  const activeKey = (() => {
    if (startActive) return null;
    if (landed) return itemKey("plan", landed.sessionId);
    if (activeLaunchId) return itemKey("launch", activeLaunchId);
    if (activeChatId) return itemKey("chat", activeChatId);
    return activeId ? itemKey("plan", activeId) : null;
  })();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const model = useMemo(
    () => buildSidebar({ sessions, chats, launches, needs, working, activeKey, expanded }),
    [sessions, chats, launches, needs, working, activeKey, expanded],
  );
  const toggleSection = useCallback((id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  const handlers = useMemo<RowHandlers>(() => ({
    pick: (item) => {
      if (item.kind === "plan") onSelect(item.id);
      else if (item.kind === "chat") onSelectChat?.(item.id);
      else onSelectLaunch?.(item.id);
    },
    rename: (item, title) => {
      if (item.kind === "plan") onRename?.(item.id, title);
      // A chat must keep a name: an emptied field is a cancel.
      else if (item.kind === "chat" && title) onRenameChat?.(item.id, title);
    },
    archive: (item) => {
      if (item.kind === "plan") onArchive?.(item.id, item.archivedAt === null);
      else if (item.kind === "chat") onArchiveChat?.(item.id, item.archivedAt === null);
    },
    remove: (item) => {
      if (item.kind === "plan") onDelete(item.id);
      else if (item.kind === "chat") onDeleteChat?.(item.id);
    },
    selectRevision: onSelectRevision,
  }), [onSelect, onSelectChat, onSelectLaunch, onRename, onRenameChat, onArchive, onArchiveChat, onDelete, onDeleteChat, onSelectRevision]);
  const can = useMemo(() => ({
    renamePlan: !!onRename, renameChat: !!onRenameChat, archivePlan: !!onArchive, archiveChat: !!onArchiveChat, deleteChat: !!onDeleteChat,
  }), [onRename, onRenameChat, onArchive, onArchiveChat, onDeleteChat]);
  const archivedShown = archivedOpen || model.archived.some((item) => item.key === activeKey);

  const row = (item: SidebarItem) => (
    <FlowRow
      key={item.key}
      item={item}
      active={item.key === activeKey}
      viewedVersionNumber={item.key === activeKey ? viewedVersionNumber : null}
      handlers={handlers}
      can={can}
    />
  );
  return (
    <nav className="rl-sb" aria-label="Sessions">
      <div className="rl-sb-head">
        {/* The start screen's way in. Filled while the start screen is up,
            outlined otherwise (4a vs 4b). */}
        <button
          type="button"
          className="rl-sb-new"
          data-filled={startActive || undefined}
          aria-current={startActive ? "page" : undefined}
          aria-keyshortcuts="Meta+N"
          onClick={() => onNewSession?.()}
        >
          <Plus size={14} aria-hidden />
          New session
          <kbd aria-hidden>⌘N</kbd>
        </button>
      </div>
      <div className="rl-sb-scroll rl-thin-scroll-y">
        {model.sections.map((section) => (
          <Section key={section.id} section={section} open={expanded.has(section.id)} onToggle={toggleSection}
            onAdd={section.projectPath && onNewSessionIn ? onNewSessionIn : undefined}>
            {section.rows.map(row)}
          </Section>
        ))}
        {model.archived.length > 0 && (
          <section className="rl-sb-section">
            <button type="button" className="rl-sb-fold" aria-expanded={archivedShown} onClick={() => setArchivedOpen((v) => !v)}>
              Archived · {model.archived.length}
              <ChevronDown size={12} aria-hidden data-open={archivedShown || undefined} />
            </button>
            {archivedShown && <ul className="rl-sb-rows">{model.archived.map(row)}</ul>}
          </section>
        )}
      </div>
    </nav>
  );
}

function Section({ section, open, onToggle, onAdd, children }: {
  section: SidebarSection;
  open: boolean;
  onToggle: (id: string) => void;
  onAdd?: (projectPath: string) => void;
  children: ReactNode;
}) {
  const labelId = useId();
  const folder = section.projectPath;
  return (
    <section className="rl-sb-section" aria-labelledby={labelId}>
      <div className="rl-sb-label">
        <span id={labelId}>{section.label}</span>
        {/* A project's own "+": the start screen, pointed at this folder.
            Always there, as faint as the label it sits on. */}
        {onAdd && folder && (
          <button type="button" className="rl-sb-add" aria-label={`New session in ${section.label}`} title={`New session in ${folder}`}
            onClick={() => onAdd(folder)}>
            <Plus size={12} aria-hidden />
          </button>
        )}
      </div>
      <ul className="rl-sb-rows">{children}</ul>
      {(section.hidden > 0 || (open && section.foldable)) && (
        <button type="button" className="rl-sb-fold" aria-expanded={open} onClick={() => onToggle(section.id)}>
          {open ? "Show less" : `Show ${section.hidden} more`}
        </button>
      )}
    </section>
  );
}

function RowIcon({ item, active }: { item: SidebarItem; active: boolean }) {
  // Needs you trades the icon for an amber dot (5a).
  if (item.need) return <i className="rl-sb-dot" aria-hidden />;
  const color = active ? MODE_FG[item.mode] : undefined;
  if (item.working || isBuildingRunState(item.session?.runState)) return <Loader size={13} aria-hidden className="rl-sb-spin" style={{ color }} />;
  if (item.kind === "chat") return <MessageSquare size={13} aria-hidden style={{ color }} />;
  if (item.mode === "redline") return <FilePenLine size={13} aria-hidden style={{ color }} />;
  return <FileText size={13} aria-hidden style={{ color }} />;
}

function FlowRowBase({ item, active, viewedVersionNumber, handlers, can }: {
  item: SidebarItem;
  active: boolean;
  viewedVersionNumber: number | null;
  handlers: RowHandlers;
  can: { renamePlan: boolean; renameChat: boolean; archivePlan: boolean; archiveChat: boolean; deleteChat: boolean };
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rowButton = useRef<HTMLButtonElement>(null);
  const deletable = item.kind === "plan" || (item.kind === "chat" && can.deleteChat);
  const held = item.session?.held ?? false;
  const acts = {
    open: () => handlers.pick(item),
    rename: (item.kind === "plan" ? can.renamePlan : item.kind === "chat" && can.renameChat) ? () => setRenaming(true) : undefined,
    archive: (item.kind === "plan" ? can.archivePlan : item.kind === "chat" && can.archiveChat) ? () => handlers.archive(item) : undefined,
    remove: deletable ? () => setConfirming(true) : undefined,
  };
  // A launch has no plan or chat record yet, so nothing to rename, archive
  // or delete: its menu only opens it.
  const actions: RowAction[] = item.kind === "plan" && item.session
    ? planRowActions(item.session, acts)
    : item.kind === "chat"
      ? chatRowActions(item, acts)
      : [{ label: "Open session", icon: <FileText size={14} aria-hidden />, onSelect: acts.open }];
  // The open plan's versions nest under it in a grouped container (5a).
  const versions = active && item.session && item.session.revisions.length > 1
    ? versionRows(item.session, viewedVersionNumber)
    : null;
  const openMenu = (at: { x: number; y: number } | null) => {
    setMenuAt(at);
    setMenuOpen(true);
  };
  // Rename and the delete ask both stand in for the row button, so focus
  // can only go back to it once it is mounted again.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (refocus.current && rowButton.current) {
      refocus.current = false;
      rowButton.current.focus();
    }
  });
  const back = (focus: boolean) => {
    refocus.current = focus;
    setRenaming(false);
    setConfirming(false);
  };
  const icon = <span className="rl-sb-icon"><RowIcon item={item} active={active} /></span>;
  return (
    <li
      className="rl-sb-item"
      data-active={active || undefined}
      data-nest={versions ? "" : undefined}
      data-menu={menuOpen || undefined}
      data-need={item.need ? "" : undefined}
      // The row's keys, from the row or its ⋯ (the menu, the rename field and
      // the delete ask keep their own).
      onKeyDown={(e) => {
        const from = e.target as HTMLElement;
        if (from !== rowButton.current && !from.classList.contains("rl-sb-dots")) return;
        if ((e.key === "Backspace" || e.key === "Delete") && deletable) {
          e.preventDefault();
          setConfirming(true);
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          openMenu(null);
        }
      }}
      onContextMenu={(e) => {
        // The rename field keeps the system's own menu (paste).
        if (renaming || confirming) return;
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {renaming ? (
        <div className="rl-sb-row" data-editing="">
          {icon}
          <RowRename className="rl-sb-rename" label={item.kind === "chat" ? "Chat title" : "Session title"} value={item.title} onDone={(title, how) => {
            back(how !== "blur");
            if (title !== null) handlers.rename(item, title);
          }} />
        </div>
      ) : confirming ? (
        <div className="rl-sb-row" data-confirming="">
          {icon}
          <span className="rl-sb-title">{item.title}</span>
          <ConfirmDelete
            what={item.kind === "chat" ? "chat" : "plan"}
            held={held}
            onConfirm={() => { back(false); handlers.remove(item); }}
            onCancel={() => back(true)}
          />
        </div>
      ) : (
        <>
          <button
            ref={rowButton}
            type="button"
            className="rl-sb-row"
            aria-current={active ? "page" : undefined}
            title={item.title}
            onClick={() => handlers.pick(item)}
          >
            {icon}
            <span className="rl-sb-title">{item.title}</span>
            {item.need && <span className="rl-sb-tag">{item.need}</span>}
          </button>
          <RowMenu
            open={menuOpen}
            onOpenChange={(open) => { setMenuOpen(open); if (!open) setMenuAt(null); }}
            at={menuAt}
            label={item.title}
            actions={actions}
            triggerClassName="rl-sb-dots"
          />
        </>
      )}
      {versions && (
        <ul className="rl-sb-versions" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.versionNumber}>
              <button
                type="button"
                className="rl-sb-version"
                data-latest={v.latest || undefined}
                aria-current={v.viewed ? "true" : undefined}
                onClick={() => handlers.selectRevision(item.id, v.latest ? null : v.versionNumber)}
              >
                {v.label}
                <span>{v.date}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Rows re-render only when something they show changed: a summaries read
 *  rebuilds every item object, but an unchanged session keeps its own
 *  identity (App's `refreshSummaries`), so comparing the fields is enough. */
const FlowRow = memo(FlowRowBase, (a, b) =>
  a.active === b.active &&
  a.viewedVersionNumber === b.viewedVersionNumber &&
  a.handlers === b.handlers &&
  a.can === b.can &&
  a.item.key === b.item.key &&
  a.item.title === b.item.title &&
  a.item.mode === b.item.mode &&
  a.item.need === b.item.need &&
  a.item.working === b.item.working &&
  a.item.archivedAt === b.item.archivedAt &&
  a.item.session === b.item.session,
);

/** The existing two-step delete, inline in the row: ⌫ or the menu asks,
 *  Delete confirms, Escape or Cancel backs out. A held plan's delete also
 *  releases the Claude waiting on it, and says so. */
function ConfirmDelete({ what, held, onConfirm, onCancel }: {
  what: "plan" | "chat";
  held: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rl-sb-confirm"
      role="group"
      aria-label={`Delete this ${what}?`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <button
        type="button"
        className="rl-sb-confirm-yes"
        autoFocus
        title={held ? "Delete this session and release Claude Code's blocked terminal (cannot be undone)" : "Delete (cannot be undone)"}
        onClick={onConfirm}
      >
        {held ? "Release & delete" : "Delete"}
      </button>
      <button type="button" className="rl-sb-confirm-no" onClick={onCancel}>Cancel</button>
    </div>
  );
}
