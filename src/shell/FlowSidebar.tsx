// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's sessions sidebar (boards 4a, 4b, 4d and 5a):
//! "+ New session ⌘N", then plans, chats and launched sessions in one list,
//! sorted by what they need from you (lib/sessionGroups.ts) and grouped by
//! project, each project with a "+" that starts a session in that folder.
//! The open session's versions nest under it; archived rows wait in a fold
//! at the end.
//!
//! Every row says where it is in its life on a second line, in its colour,
//! with how long ago (lib/sessionGroups `rowStatus`): Planning, In review,
//! Approved · not built, Built… and on the first line its unsent marks or
//! its version. A spinner means something is running right now.
//!
//! `SessionSidebar` renders this for `layout="flow"`, lazily, so the classic
//! shell never loads it. Every row has a ⋯ (also right-click, and ⌫ to
//! delete), shown under the pointer in place of the version.

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown, CircleCheck, CircleCheckBig, Download, Eye, FilePenLine, FileText, FolderInput, Hammer,
  MessageSquare, Play, Plus, TriangleAlert, X,
} from "lucide-react";
import type { SessionSidebarProps } from "../components/SessionSidebar";
import { chatRowActions, planRowActions, RowMenu, RowRename, type RowAction } from "../components/RowMenu";
import { Spinner } from "../components/Spinner";
import type { ManualPlanState } from "../components/PlanStateMenu";
import type { JoinedSessionInfo } from "../collab/useJoinedSession";
import {
  buildSidebar,
  itemKey,
  rowAge,
  rowStatus,
  versionRows,
  type SidebarItem,
  type SidebarSection,
  type StatusIcon,
  type StatusTone,
} from "../lib/sessionGroups";
import { isLiveRunState } from "../lib/orchestration";
import { latestDisplayVersion } from "../lib/revisionVersions";
import "./FlowSidebar.css";

/** A status's colour: the top bar's mode inks, contrast-safe in every theme. */
const TONE: Record<StatusTone, string> = {
  plan: "var(--color-mode-plan-fg)",
  redline: "var(--color-mode-redline-fg)",
  build: "var(--color-mode-build-fg)",
  quiet: "var(--color-ink-4)",
};

const ICON: Record<Exclude<StatusIcon, "dot" | "spin">, typeof FileText> = {
  alert: TriangleAlert,
  pen: FilePenLine,
  hammer: Hammer,
  check: CircleCheck,
  built: CircleCheckBig,
  run: Play,
  chat: MessageSquare,
  file: FileText,
};

/** What the row does, by kind; id-based so a memoized row keeps them. */
interface RowHandlers {
  pick: (item: SidebarItem) => void;
  rename: (item: SidebarItem, title: string) => void;
  archive: (item: SidebarItem) => void;
  remove: (item: SidebarItem) => void;
  selectRevision: (sessionId: string, versionNumber: number | null) => void;
  exportVersion: (sessionId: string, versionNumber: number) => void;
  setState?: (sessionId: string, state: ManualPlanState) => void;
  move?: (sessionId: string) => void;
  openRun?: (sessionId: string) => void;
}

/** What only the host knows about a row: unsent marks, an arrival it hasn't
 *  been looked at since, and whether its project needs naming (a Needs you
 *  row sits outside its project's group). */
interface RowExtra {
  pending: number;
  unseen: boolean;
  glow: number | null;
  showProject: boolean;
}

export default function FlowSidebar(props: SessionSidebarProps) {
  const {
    sessions, activeId, chats, activeChatId, launches, activeLaunchId, needs, working,
    viewedVersionNumber, onNewSession, onNewSessionIn,
    onSelect, onSelectChat, onSelectLaunch, onRename, onRenameChat, onArchive, onArchiveChat,
    onDelete, onDeleteChat, onSelectRevision, onExport, onSetPlanState, onMoveProject, onOpenRunReport,
    pendingCounts, unseenIds, arrivalGlow, joined, onSelectJoined, onLeaveJoined,
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
    exportVersion: onExport,
    setState: onSetPlanState,
    move: onMoveProject,
    openRun: onOpenRunReport,
  }), [onSelect, onSelectChat, onSelectLaunch, onRename, onRenameChat, onArchive, onArchiveChat, onDelete, onDeleteChat, onSelectRevision, onExport, onSetPlanState, onMoveProject, onOpenRunReport]);
  const can = useMemo(() => ({
    renamePlan: !!onRename, renameChat: !!onRenameChat, archivePlan: !!onArchive, archiveChat: !!onArchiveChat, deleteChat: !!onDeleteChat,
  }), [onRename, onRenameChat, onArchive, onArchiveChat, onDeleteChat]);
  const archivedShown = archivedOpen || model.archived.some((item) => item.key === activeKey);

  const row = (item: SidebarItem, inNeeds = false) => (
    <FlowRow
      key={item.key}
      item={item}
      active={item.key === activeKey}
      viewedVersionNumber={item.key === activeKey ? viewedVersionNumber : null}
      handlers={handlers}
      can={can}
      pending={item.kind === "plan" ? pendingCounts[item.id] ?? 0 : 0}
      unseen={item.kind === "plan" && !!unseenIds?.has(item.id)}
      glow={item.kind === "plan" && arrivalGlow?.sessionId === item.id ? arrivalGlow.nonce : null}
      showProject={inNeeds}
    />
  );
  const empty = model.sections.length === 0 && model.archived.length === 0 && !joined;
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
        {joined && (
          <section className="rl-sb-section" aria-label="Live session">
            <div className="rl-sb-label"><span>Live session</span></div>
            <ul className="rl-sb-rows">
              <JoinedRow joined={joined} active={activeId === joined.key} onSelect={onSelectJoined} onLeave={onLeaveJoined} />
            </ul>
          </section>
        )}
        {model.sections.map((section) => (
          <Section key={section.id} section={section} open={expanded.has(section.id)} onToggle={toggleSection}
            onAdd={section.projectPath && onNewSessionIn ? onNewSessionIn : undefined}>
            {section.rows.map((item) => row(item, section.kind === "needs"))}
          </Section>
        ))}
        {empty && (
          <p className="rl-sb-empty">
            No sessions yet. Start one with <b>New session</b> above, or ⌘N.
          </p>
        )}
        {model.archived.length > 0 && (
          <section className="rl-sb-section">
            <button type="button" className="rl-sb-fold" aria-expanded={archivedShown} onClick={() => setArchivedOpen((v) => !v)}>
              Archived · {model.archived.length}
              <ChevronDown size={12} aria-hidden data-open={archivedShown || undefined} />
            </button>
            {archivedShown && <ul className="rl-sb-rows" data-archived="">{model.archived.map((item) => row(item))}</ul>}
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

function StatusGlyph({ icon, tone }: { icon: StatusIcon; tone: StatusTone }) {
  // Needs you trades the icon for a dot in its colour (5a).
  if (icon === "dot") return <i className="rl-sb-dot" aria-hidden style={{ background: TONE[tone] }} />;
  // Working turns the shared ring: an HTML element the compositor spins. A
  // rotating <svg> is repainted on the main thread every frame.
  if (icon === "spin") return <Spinner size={12} className="rl-sb-spin" style={{ color: TONE[tone] }} />;
  const Icon = ICON[icon];
  return <Icon size={14} aria-hidden style={{ color: TONE[tone] }} />;
}

/** A live room this window is a guest in: its own green dot, who shares it,
 *  and a way to leave. */
function JoinedRow({ joined, active, onSelect, onLeave }: {
  joined: JoinedSessionInfo;
  active: boolean;
  onSelect?: () => void;
  onLeave?: () => void;
}) {
  return (
    <li className="rl-sb-item" data-active={active || undefined}>
      <button type="button" className="rl-sb-row" aria-current={active ? "page" : undefined} title={`Live session shared by ${joined.ownerName ?? "its owner"}`} onClick={onSelect}>
        <span className="rl-sb-icon"><i className="rl-sb-live" aria-hidden /></span>
        <span className="rl-sb-text">
          <span className="rl-sb-line"><span className="rl-sb-title">{joined.title}</span></span>
          <span className="rl-sb-meta">
            <span className="rl-sb-status" style={{ color: TONE.build }}>Live</span>
            {joined.ownerName && <span>· shared by {joined.ownerName}</span>}
          </span>
        </span>
        <span className="rl-sb-end"><span className="rl-sb-ver">v{joined.version}</span></span>
      </button>
      {onLeave && (
        <button type="button" className="rl-sb-dots" aria-label="Leave this live session" title="Leave this live session" onClick={onLeave}>
          <X size={13} aria-hidden />
        </button>
      )}
    </li>
  );
}

function FlowRowBase({ item, active, viewedVersionNumber, handlers, can, pending, unseen, glow, showProject }: RowExtra & {
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
    ? planActions(item.session, acts, handlers)
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
  const status = rowStatus(item);
  const icon = <span className="rl-sb-icon"><StatusGlyph icon={status.icon} tone={status.tone} /></span>;
  const s = item.session;
  const version = s && s.revisions.length > 0 ? latestDisplayVersion(s.revisions, s.revisions[s.revisions.length - 1].versionNumber) : null;
  const project = showProject ? (s?.projectName || (item.projectPath ? item.projectPath.split("/").filter(Boolean).pop() : null)) : null;
  const tooltip = [item.title, item.projectPath, status.detail].filter(Boolean).join("\n");
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
            title={tooltip}
            onClick={() => handlers.pick(item)}
          >
            {glow !== null && <span key={glow} className="rl-sb-arrival" aria-hidden />}
            {icon}
            <span className="rl-sb-text">
              <span className="rl-sb-line">
                <span className="rl-sb-title">{item.title}</span>
                {unseen && <i className="rl-sb-unseen" title="A new plan arrived" aria-label="New" />}
              </span>
              <span className="rl-sb-meta">
                {project && <span className="rl-sb-project">{project} ·</span>}
                <span className="rl-sb-status" style={{ color: TONE[status.tone] }}>{status.word}</span>
                {s?.attachState === "detached" && status.tone !== "quiet" && <span className="rl-sb-flag" title="Its CLI session ended; restore it from the plan">ended</span>}
                {s?.backend === "codex" && <span className="rl-sb-flag" title={`Planned by Codex${s.model ? ` · ${s.model}` : ""}`}>Codex</span>}
                {/* A Needs you row names its project instead: it is now. */}
                {!project && <span className="rl-sb-age">· {rowAge(item.at)}</span>}
              </span>
            </span>
            <span className="rl-sb-end">
              {pending > 0 ? (
                <span className="rl-sb-count" title={`${pending} unsent mark${pending === 1 ? "" : "s"}`}>{pending}</span>
              ) : version !== null ? (
                <span className="rl-sb-ver">v{version}</span>
              ) : null}
            </span>
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
              {v.threadStart && <span className="rl-sb-thread">New plan in this terminal</span>}
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
              <button
                type="button"
                className="rl-sb-version-dl"
                aria-label={`Download ${v.label.split(" ")[0]} as Markdown`}
                title={`Download ${v.label.split(" ")[0]} as Markdown`}
                onClick={() => handlers.exportVersion(item.id, v.versionNumber)}
              >
                <Download size={12} aria-hidden />
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
  a.pending === b.pending &&
  a.unseen === b.unseen &&
  a.glow === b.glow &&
  a.showProject === b.showProject &&
  a.item.at === b.item.at &&
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

/** A plan's menu: classic's row menu, plus what classic kept on the row's
 *  chips (its run, Move to repo, the manual state) and a download. */
function planActions(
  s: NonNullable<SidebarItem["session"]>,
  acts: { open: () => void; rename?: () => void; archive?: () => void; remove?: () => void },
  h: RowHandlers,
): RowAction[] {
  const base = planRowActions(s, acts);
  const removeAt = base.findIndex((a) => a.danger);
  const head = removeAt >= 0 ? base.slice(0, removeAt) : base;
  const tail = removeAt >= 0 ? base.slice(removeAt) : [];
  const live = isLiveRunState(s.runState);
  // Classic's PlanStateMenu rule: nothing to set while Claude waits on the
  // review or a run is live.
  const locked = s.held || live;
  const extra: RowAction[] = [];
  if (s.runState && h.openRun) extra.push({ label: live ? "Watch the run" : "Open the run report", icon: <Eye size={14} aria-hidden />, onSelect: () => h.openRun!(s.sessionId), divided: true });
  if (h.setState && s.status === "approved" && s.runState !== "landed") extra.push({ label: "Mark as built", icon: <CircleCheckBig size={14} aria-hidden />, disabled: locked, onSelect: () => h.setState!(s.sessionId, "completed"), divided: extra.length === 0 });
  if (h.setState && s.status !== "in_review") extra.push({ label: "Back to in review", icon: <FilePenLine size={14} aria-hidden />, disabled: locked, onSelect: () => h.setState!(s.sessionId, "in_review"), divided: extra.length === 0 });
  if (h.move) extra.push({ label: "Move to repo…", icon: <FolderInput size={14} aria-hidden />, onSelect: () => h.move!(s.sessionId), divided: extra.length === 0 });
  const last = s.revisions[s.revisions.length - 1];
  if (last) extra.push({ label: "Download as Markdown", icon: <Download size={14} aria-hidden />, onSelect: () => h.exportVersion(s.sessionId, last.versionNumber) });
  return [...head, ...extra, ...tail];
}

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
