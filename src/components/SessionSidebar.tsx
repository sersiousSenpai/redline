// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The one sessions sidebar (Workbench W1). Top to bottom: the Places (Home,
//! Runs, Localhost), a "Sessions" label with Combine, the joined-session
//! shadow, then project groups from lib/sessionGroups — Needs you first while
//! something does — each holding the rich plan rows (status colour, v{n},
//! pending count, unseen pulse, run chips, detached/codex chips, the revision
//! tree and a ⋯ menu), chat rows, and the launches whose plan has not arrived.
//! Under each plan row sit its terminals in the shared status vocabulary
//! (workbench/status.ts): needs you is an amber opacity pulse, working is the
//! shared Spinner, idle is nothing, exited is muted. A "New tab" row closes it.
//!
//! Rows are memoized with id-based handlers: a summaries read rebuilds every
//! item, but an unchanged session keeps its object (App's `refreshSummaries`),
//! so only the rows that changed render.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileText, Globe, House, MessageSquare, Plus, Terminal, TriangleAlert, Workflow } from "lucide-react";
import { PlanStateMenu, type ManualPlanState } from "./PlanStateMenu";
import { chatRowActions, planRowActions, RowMenu, RowRename, type RowAction } from "./RowMenu";
import { Spinner } from "./Spinner";
import { NESTED_CONTROL_STYLE, nestedControl } from "./ui/nestedControl";

import type { RevisionSummary, SessionSummary } from "../types";
import type { JoinedSessionInfo } from "../collab/useJoinedSession";
import type { PaneStatus } from "../workbench/status";
import {
  buildSidebar,
  itemKey,
  rowAge,
  rowStatus,
  type FlowChat,
  type FlowLaunch,
  type NeedReason,
  type SidebarItem,
  type SidebarSection,
  type StatusIcon,
  type StatusTone,
} from "../lib/sessionGroups";
import { MIN_COMBINE } from "../lib/launch";
import {
  computeRevisionDisplay,
  latestDisplayVersion,
} from "../lib/revisionVersions";
import {
  isLiveRunState,
  isSequentialFallback,
  SEQUENTIAL_FALLBACK_NOTE,
} from "../lib/orchestration";
import { detachedPillTitle } from "../lib/restoreHarness";
import "./SessionSidebar.css";

/** The sidebar's Places: Home (the door and its tabs), the Runs monitor and
 *  the Localhost dashboard. */
export type SidebarPlace = "home" | "runs" | "servers";

/** A terminal under its plan row, in the shared status vocabulary. */
export interface SidebarTerminal {
  id: string;
  title: string;
  status: PaneStatus;
  /** Kept running after its wall closed: on no wall, a click puts it back. */
  kept?: boolean;
}

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  /** Live room this instance is currently a guest in — the joined-session
   *  shadow (Phase 1c). Synthesized from Yjs, not from the backend; rendered
   *  pinned above local sessions with a "joined" badge. */
  joined?: JoinedSessionInfo | null;
  onSelectJoined?: () => void;
  onLeaveJoined?: () => void;
  onSelect: (id: string) => void;
  /** Delete a session. Held sessions are deleted with force=true, which
   *  drains the orphaned hook response so Claude Code's terminal unblocks
   *  before the row disappears. */
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onSetPlanState?: (id: string, state: ManualPlanState) => void;
  onMoveProject?: (id: string) => void;
  /** Download a specific revision as a clean .md file. Kept as a separate
   *  affordance (header button) — sidebar row clicks no longer download. */
  onExport: (sessionId: string, versionNumber: number) => void;
  /** Load a specific revision into the document pane for in-place viewing.
   *  `null` means "back to the latest revision". */
  onSelectRevision: (sessionId: string, versionNumber: number | null) => void;
  /** Which revision is currently displayed in the pane for the active
   *  session. `null` means the latest. Used to highlight the row. */
  viewedVersionNumber: number | null;
  /** Sessions whose newly-intercepted plan the reviewer hasn't looked at yet.
   *  An intercept normally pulls the plan straight into the foreground; when a
   *  live discussion suppresses that (see App's `plan-received` handler), this
   *  pulsing dot is what keeps the arrival discoverable. Cleared on select. */
  unseenIds?: ReadonlySet<string>;
  /** A plan that just arrived while another was being read: its row glows
   *  once. Nonce'd so a second arrival glows again. */
  arrivalGlow?: { sessionId: string; nonce: number } | null;
  /** Open the RunReport container for an orchestrated run (chip click). */
  onOpenRunReport?: (sessionId: string) => void;
  /** Hand N selected plans to the Front Door as combine pills. Does what
   *  Home already does — clears the selection — and seeds the pills; the
   *  composer there becomes the place to add an instruction. Absent when
   *  the host has no Front Door to hand them to. */
  onCombine?: (sessionIds: string[]) => void;
  /** Home, when the host has no `onSelectPlace`: deselect every session so
   *  the document plate shows the front door. Boot auto-selects the most
   *  recent plan and nothing else ever clears the selection, so without this
   *  row the front door is unreachable for anyone who has reviewed a plan. */
  onNewPlan?: () => void;
  /** Home's fallback when `onNewPlan` is absent: the start screen. */
  onNewSession?: () => void;
  /** A project group's "+", a new session in that folder. */
  onNewSessionIn?: (projectPath: string) => void;
  /** The start screen is on the stage, so Home reads as selected and no row
   *  does. Only read when `place` is not given. */
  startActive?: boolean;
  /** Chats (companion conversations), rows among the plans. */
  chats?: readonly FlowChat[];
  activeChatId?: string | null;
  onSelectChat?: (companionId: string) => void;
  onRenameChat?: (companionId: string, title: string) => void;
  onArchiveChat?: (companionId: string, archived: boolean) => void;
  onDeleteChat?: (companionId: string) => void;
  /** Sessions launched into a terminal whose plan has not arrived, rendered
   *  in their project's section. */
  launches?: readonly FlowLaunch[];
  activeLaunchId?: string | null;
  onSelectLaunch?: (terminalId: string) => void;
  /** Why a row needs you, by row key (`plan:<id>`, `chat:<id>`,
   *  `launch:<terminalId>`), from the engine's open asks. A run waiting on
   *  its code review (Review) or stalled is read off the session without it. */
  needs?: Readonly<Record<string, NeedReason>>;
  /** Row keys whose Claude is mid-turn (a spinner). */
  working?: ReadonlySet<string>;
  /** Which Place reads selected. `null` means none; absent means the host
   *  has no Places and Home is "nothing open" (`startActive`/no active id). */
  place?: SidebarPlace | null;
  /** Given, all three Places render and Home goes here; absent, only Home
   *  renders and it calls `onNewPlan`/`onNewSession`. */
  onSelectPlace?: (place: SidebarPlace) => void;
  /** Runs in flight, on the Runs place when > 0. */
  runsLive?: number;
  /** Local dev servers' ports (":5173"), summarized on the Localhost place. */
  localhostPorts?: readonly string[];
  /** Each plan's terminals, by session id; always shown under the row. */
  terminals?: Readonly<Record<string, readonly SidebarTerminal[]>>;
  /** Home's terminals (shells opened in Home, orphans), under Home. */
  homeTerminals?: readonly SidebarTerminal[];
  onSelectTerminal?: (sessionId: string, terminalId: string) => void;
  /** The footer's "＋ New tab ⌘T"; the row renders only when given. */
  onNewTab?: () => void;
}

/** Chip palette for the orchestrated-run lifecycle. `stalled` warns; `landed`
 *  closes green; the in-flight states read as info. */
const RUN_STATE_COLORS: Record<string, string> = {
  orchestrating: "var(--color-info)",
  running: "var(--color-info)",
  in_code_review: "var(--color-warning)",
  // The overnight queue's parked run: committed to its branch, the review
  // waits on YOUR morning verdict — the same deliberate needs-you hue as an
  // in-flight code review, never the muted fallback.
  awaiting_review: "var(--color-warning)",
  landed: "var(--color-success)",
  stalled: "var(--color-warning, #b45309)",
  // A stand-down: deliberate and terminal — muted, not alarming.
  abandoned: "var(--color-ink-muted)",
  // A single agent building an approved plan in its terminal. Not a "live
  // run" (`isLiveRunState`): there is no run graph to watch, and the plan can
  // still be reopened.
  building: "var(--color-info)",
};

const STATUS_COLORS: Record<SessionSummary["status"], string> = {
  in_review: "var(--color-warning)",
  approved: "var(--color-success)",
  aborted: "var(--color-ink-muted)",
};

const STATUS_LABELS: Record<SessionSummary["status"], string> = {
  in_review: "in review",
  approved: "approved",
  aborted: "aborted",
};

/** A chat or launch status's colour: the top bar's mode inks. */
const TONE: Record<StatusTone, string> = {
  plan: "var(--color-mode-plan-fg)",
  redline: "var(--color-mode-redline-fg)",
  build: "var(--color-mode-build-fg)",
  quiet: "var(--color-ink-4)",
};

/** Compact HH:MM for a revision's received-at epoch-millis. */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What a chat or launch row does; id-based so a memoized row keeps them. */
interface LightHandlers {
  pick: (item: SidebarItem) => void;
  rename: (item: SidebarItem, title: string) => void;
  archive: (item: SidebarItem) => void;
  remove: (item: SidebarItem) => void;
}

interface LightCan {
  renameChat: boolean;
  archiveChat: boolean;
  deleteChat: boolean;
}

const PLACE_TITLES: Record<SidebarPlace, string> = {
  home: "Home — the front door and its tabs",
  runs: "Runs — the orchestration monitor",
  servers: "Localhost — your local dev servers",
};

function SessionSidebarBase(props: SessionSidebarProps) {
  const {
    sessions, activeId, pendingCounts, joined, onSelectJoined, onLeaveJoined,
    onSelect, onDelete, onRename, onArchive, onSetPlanState, onMoveProject, onExport,
    onSelectRevision, viewedVersionNumber, unseenIds, arrivalGlow, onOpenRunReport,
    onCombine, onNewPlan, onNewSession, onNewSessionIn, chats, activeChatId,
    onSelectChat, onRenameChat, onArchiveChat, onDeleteChat, launches, activeLaunchId,
    onSelectLaunch, needs, working, place, onSelectPlace, runsLive, localhostPorts,
    terminals, homeTerminals, onSelectTerminal, onNewTab,
  } = props;

  // Home reads selected when it is the Place, or — with no Places — when
  // nothing is open (the start screen, or no session selected).
  const nothingOpen = props.startActive ?? (activeId === null && !activeChatId && !activeLaunchId);
  const homeCurrent = place !== undefined ? place === "home" : nothingOpen;
  // No row reads as open while another Place or the start screen owns the
  // stage, even if a plan is still selected underneath.
  const rowsQuiet = place !== undefined ? place !== null && place !== "home" : nothingOpen;
  // A launch whose plan has arrived is that plan's row now (sessionGroups),
  // so the open launch is the open plan until the host catches up.
  const landed = activeLaunchId ? sessions.find((s) => s.heldTerminalId === activeLaunchId) : undefined;
  const activeKey = rowsQuiet
    ? null
    : landed
      ? itemKey("plan", landed.sessionId)
      : activeLaunchId
        ? itemKey("launch", activeLaunchId)
        : activeChatId
          ? itemKey("chat", activeChatId)
          : activeId
            ? itemKey("plan", activeId)
            : null;

  // Which sessions are expanded to show their revision tree. The active
  // session auto-expands so its history is visible the moment it's selected.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(activeId ? [activeId] : []),
  );
  useEffect(() => {
    if (!activeId) return;
    setExpanded((prev) => {
      if (prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
  }, [activeId]);
  const toggleExpand = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Section ids opened past their "Show N more", and the archived fold.
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const toggleSection = useCallback((id: string) => setOpenSections((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);

  const model = useMemo(
    () => buildSidebar({ sessions, chats, launches, needs, working, activeKey, expanded: openSections }),
    [sessions, chats, launches, needs, working, activeKey, openSections],
  );

  // Combine selection. Local because nothing outside the sidebar watches it —
  // the moment it matters, it leaves as an argument to `onCombine`.
  //
  // An ORDERED list rather than a `Set`, which is what lets each picked row
  // wear its position. That number is not decoration: it is the order the
  // sources are laid out in the brief (`## Source 1`, `## Source 2`, …), so
  // picking auth before billing is how you say which one leads without
  // typing a sentence about it.
  const [combining, setCombining] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // A row click picks while combining and opens the plan otherwise. Id-based
  // and stable between those modes, so a memoized row only renders when its
  // own session, selection or pick changes.
  const clickRow = useCallback(
    (id: string) => {
      if (!combining) return onSelect(id);
      setPicked((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    },
    [combining, onSelect],
  );
  const cancelCombining = () => {
    setCombining(false);
    setPicked([]);
  };
  useEffect(() => {
    if (!combining) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelCombining();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [combining]);
  // A session deleted while the picker is open must not stay picked — the
  // launch would then fail on an id that no longer resolves.
  useEffect(() => {
    if (!combining) return;
    setPicked((prev) => {
      const live = prev.filter((id) => sessions.some((s) => s.sessionId === id));
      return live.length === prev.length ? prev : live;
    });
  }, [combining, sessions]);

  const lightHandlers = useMemo<LightHandlers>(() => ({
    pick: (item) => {
      if (item.kind === "chat") onSelectChat?.(item.id);
      else if (item.kind === "launch") onSelectLaunch?.(item.id);
    },
    // A chat must keep a name: an emptied field is a cancel.
    rename: (item, title) => { if (item.kind === "chat" && title) onRenameChat?.(item.id, title); },
    archive: (item) => { if (item.kind === "chat") onArchiveChat?.(item.id, item.archivedAt === null); },
    remove: (item) => { if (item.kind === "chat") onDeleteChat?.(item.id); },
  }), [onSelectChat, onSelectLaunch, onRenameChat, onArchiveChat, onDeleteChat]);
  const can = useMemo<LightCan>(() => ({
    renameChat: !!onRenameChat, archiveChat: !!onArchiveChat, deleteChat: !!onDeleteChat,
  }), [onRenameChat, onArchiveChat, onDeleteChat]);

  const selectPlace = useCallback((p: SidebarPlace) => {
    if (onSelectPlace) return onSelectPlace(p);
    // Home IS the door: with no Places to go to, it is where new plans
    // come from.
    (onNewPlan ?? onNewSession)?.();
  }, [onSelectPlace, onNewPlan, onNewSession]);

  const archivedShown = archivedOpen || model.archived.some((item) => item.key === activeKey);

  const row = (item: SidebarItem) => {
    if (item.kind === "plan" && item.session) {
      const s = item.session;
      const active = item.key === activeKey;
      return (
        <SessionRow
          key={item.key}
          session={s}
          active={active}
          expanded={expanded.has(s.sessionId)}
          pending={pendingCounts[s.sessionId] ?? 0}
          unseen={unseenIds?.has(s.sessionId) ?? false}
          glowNonce={arrivalGlow?.sessionId === s.sessionId ? arrivalGlow.nonce : undefined}
          viewedVersionNumber={active ? viewedVersionNumber : null}
          combining={combining}
          pickedAt={picked.indexOf(s.sessionId)}
          need={item.need}
          working={item.working}
          terminals={terminals?.[s.sessionId]}
          onClick={clickRow}
          onToggleExpand={toggleExpand}
          onDelete={onDelete}
          onRename={onRename}
          onArchive={onArchive}
          onSetPlanState={onSetPlanState}
          onMoveProject={onMoveProject}
          onExport={onExport}
          onSelectRevision={onSelectRevision}
          onOpenRunReport={onOpenRunReport}
          onSelectTerminal={onSelectTerminal}
        />
      );
    }
    return (
      <LightRow
        key={item.key}
        item={item}
        active={item.key === activeKey}
        handlers={lightHandlers}
        can={can}
      />
    );
  };

  const empty = model.sections.length === 0 && model.archived.length === 0 && !joined;
  const ports = localhostPorts ?? [];
  const portsSummary = ports.length === 0
    ? null
    : ports.slice(0, 3).join(" · ") + (ports.length > 3 ? ` +${ports.length - 3}` : "");

  return (
    <nav className="rl-sb" aria-label="Sessions">
      {/* The Places. Home is the door and its tabs; Runs and Localhost are
          full views. Without `onSelectPlace` there is nowhere but Home. */}
      <div className="rl-sb-places">
        <PlaceRow id="home" icon={House} label="Home" current={homeCurrent} onSelect={selectPlace} />
        {homeTerminals && homeTerminals.length > 0 && (
          <ul className="rl-sb-terms" aria-label="Home's terminals">
            {homeTerminals.map((t) => (
              <TerminalRow key={t.id} sessionId="" terminal={t} onSelect={onSelectTerminal} />
            ))}
          </ul>
        )}
        {onSelectPlace && (
          <PlaceRow id="runs" icon={Workflow} label="Runs" current={place === "runs"} onSelect={selectPlace}
            end={runsLive ? <span className="rl-sb-place-live">{runsLive} live</span> : null} />
        )}
        {onSelectPlace && (
          <PlaceRow id="servers" icon={Globe} label="Localhost" current={place === "servers"} onSelect={selectPlace}
            end={portsSummary ? <span className="rl-sb-place-ports" title={ports.join(" · ")}>{portsSummary}</span> : null} />
        )}
      </div>
      <div className="rl-sb-head">
        <span>Sessions</span>
        {/* A text button on the label row, not a header control: the header is
            a closed set of surfaces, and this is an action on the list under
            it. Hidden below MIN_COMBINE, where it could only ever refuse. */}
        {onCombine && !combining && sessions.length >= MIN_COMBINE && (
          <button
            type="button"
            onClick={() => setCombining(true)}
            title="Combine several plans into one new plan session"
            className="rl-cmb-enter"
          >
            Combine
          </button>
        )}
      </div>
      <div className="rl-sb-scroll rl-thin-scroll-y">
        {joined && (
          <section className="rl-sb-section" aria-label="Joined session">
            <div className="rl-sb-label"><span>Joined session</span></div>
            <JoinedRow
              joined={joined}
              active={activeId === joined.key}
              onClick={() => onSelectJoined?.()}
              onLeave={() => onLeaveJoined?.()}
            />
          </section>
        )}
        {model.sections.map((section) => (
          <Section key={section.id} section={section} open={openSections.has(section.id)} onToggle={toggleSection}
            onAdd={section.projectPath && onNewSessionIn ? onNewSessionIn : undefined}>
            {section.rows.map(row)}
          </Section>
        ))}
        {empty && (
          <p className="rl-sb-empty">
            No sessions yet. Start one from <b>Home</b>.
          </p>
        )}
        {model.archived.length > 0 && (
          <section className="rl-sb-section">
            <button type="button" className="rl-sb-fold" aria-expanded={archivedShown} onClick={() => setArchivedOpen((v) => !v)}>
              Archived · {model.archived.length}
              <ChevronDown size={12} aria-hidden data-open={archivedShown || undefined} />
            </button>
            {archivedShown && <ul className="rl-sb-rows" data-archived="">{model.archived.map(row)}</ul>}
          </section>
        )}
      </div>
      {combining && (
        <div className="rl-cmb-bar">
          {/* States the operation, not the mechanic: "3 plans → 1 plan" is
              what is about to happen; "3 selected" is only what you clicked. */}
          <span className="rl-cmb-readout">
            {picked.length < MIN_COMBINE ? (
              <>
                <span className="rl-cmb-n">{picked.length}</span> / {MIN_COMBINE}{" "}
                minimum
              </>
            ) : (
              <>
                <span className="rl-cmb-n">{picked.length}</span> plans → 1 plan
              </>
            )}
          </span>
          <button
            type="button"
            disabled={picked.length < MIN_COMBINE}
            onClick={() => {
              // PICK order, not list order: the numbers on the rows promised
              // a sequence, and this is the promise being kept — it becomes
              // the `## Source N` order the combining session reads.
              onCombine?.(picked);
              cancelCombining();
            }}
            className={`rl-cmb-go${picked.length >= MIN_COMBINE ? " is-armed" : ""}`}
          >
            Combine
          </button>
          <button type="button" onClick={cancelCombining} className="rl-cmb-cancel">
            Cancel
          </button>
        </div>
      )}
      {onNewTab && (
        <button type="button" className="rl-sb-newtab" aria-keyshortcuts="Meta+T" title="New tab (⌘T)" onClick={() => onNewTab()}>
          <Plus size={14} aria-hidden />
          <span>New tab</span>
          <kbd aria-hidden>⌘T</kbd>
        </button>
      )}
    </nav>
  );
}

function PlaceRow({ id, icon: Icon, label, current, end, onSelect }: {
  id: SidebarPlace;
  icon: typeof House;
  label: string;
  current: boolean;
  end?: ReactNode;
  onSelect: (place: SidebarPlace) => void;
}) {
  return (
    <button
      type="button"
      className="rl-sb-place"
      data-place={id}
      // Background colour alone is invisible to a screen reader and to
      // anyone who can't tell the fills apart. `aria-current` says it.
      aria-current={current ? "page" : undefined}
      title={PLACE_TITLES[id]}
      onClick={() => onSelect(id)}
    >
      <Icon size={16} aria-hidden />
      <span className="rl-sb-place-label">{label}</span>
      {end}
    </button>
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
    <section className="rl-sb-section" aria-labelledby={labelId} data-kind={section.kind}>
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

/** The joined-session shadow row: no revisions tree, no delete — the plan
 *  lives on the owner's machine; this instance is a guest. The live dot +
 *  "joined" badge tell it apart from local sessions at a glance. */
function JoinedRow({
  joined,
  active,
  onClick,
  onLeave,
}: {
  joined: JoinedSessionInfo;
  active: boolean;
  onClick: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        aria-label="Leave joined session"
        title="Leave this live session"
        onClick={(e) => {
          e.stopPropagation();
          onLeave();
        }}
        className="absolute right-3 top-2 z-10 rounded px-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          color: "var(--color-ink-muted)",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          fontSize: "12px",
          lineHeight: 1.4,
        }}
      >
        ✕
      </button>
      <button
        type="button"
        onClick={onClick}
        className="hover-elevated w-full text-left pl-3 pr-3 py-2 border-b"
        style={{
          borderColor: "var(--color-rule)",
          background: active ? "var(--color-bg-elevated)" : "transparent",
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <span
            className="truncate flex items-center gap-1.5"
            style={{
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              color: "var(--color-ink)",
            }}
            title={
              joined.ownerName
                ? `Live session shared by ${joined.ownerName}`
                : "Live session"
            }
          >
            <span className="rl-live-dot" aria-hidden />
            {joined.title}
          </span>
          <span
            className="font-mono shrink-0 rounded-sm px-1.5 py-0.5 transition-opacity group-hover:opacity-0"
            style={{
              background: "var(--color-anchor-bg)",
              color: "var(--color-anchor-text)",
              fontSize: "10px",
            }}
          >
            v{joined.version}
          </span>
        </div>
        <div
          className="flex items-center gap-2"
          style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
        >
          <span
            title="You're a guest in this session — the owner controls approval and access."
            style={{
              color: "var(--color-accent)",
              border: "1px solid var(--color-accent)",
              borderRadius: "9999px",
              padding: "0 6px",
              fontSize: "9px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            joined
          </span>
          {joined.ownerName && <span>{joined.ownerName}</span>}
          {joined.status && (
            <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {joined.status.replace(/_/g, " ")}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

/** A terminal under its plan: the shared vocabulary, 28px. */
function TerminalRowBase({ sessionId, terminal, onSelect }: {
  sessionId: string;
  terminal: SidebarTerminal;
  onSelect?: (sessionId: string, terminalId: string) => void;
}) {
  const { id, title, status, kept } = terminal;
  return (
    <li className="rl-sb-term" data-status={status} data-kept={kept ? "" : undefined}>
      <button
        type="button"
        className="rl-sb-term-row"
        title={`${title} — ${status === "needs" ? "needs you" : status}${kept ? " · kept running, on no wall: click to bring it back" : ""}`}
        onClick={() => onSelect?.(sessionId, id)}
      >
        <Terminal size={13} aria-hidden />
        <span className="rl-sb-term-title">{title}</span>
        {status === "needs" && (
          <>
            <i className="rl-sb-dot rl-sb-need" aria-hidden />
            <span className="rl-sb-term-state">needs you</span>
          </>
        )}
        {status === "working" && (
          <>
            <Spinner size={10} className="rl-sb-spin" />
            <span className="rl-sb-term-state">working</span>
          </>
        )}
        {status === "exited" && <span className="rl-sb-term-state">exited</span>}
        {kept && status === "idle" && <span className="rl-sb-term-state">kept</span>}
      </button>
    </li>
  );
}
const TerminalRow = memo(TerminalRowBase);

function SessionRowBase({
  session,
  active,
  expanded,
  pending,
  unseen = false,
  glowNonce,
  viewedVersionNumber,
  combining = false,
  pickedAt = -1,
  need = null,
  working = false,
  terminals,
  onClick,
  onToggleExpand,
  onDelete,
  onRename, onArchive,
  onSetPlanState, onMoveProject,
  onExport,
  onSelectRevision,
  onOpenRunReport,
  onSelectTerminal,
}: {
  session: SessionSummary;
  active: boolean;
  expanded: boolean;
  pending: number;
  /** The sidebar is picking plans to combine: the row is a pick, not a
   *  destination. */
  combining?: boolean;
  /** Zero-based position in the pick order, or -1 when unpicked. Position
   *  rather than a boolean because the row wears its number. */
  pickedAt?: number;
  /** A plan arrived for this session but the reviewer was never taken to it. */
  unseen?: boolean;
  /** Set (and changed) to glow the row once. */
  glowNonce?: number;
  /** Which revision the active pane is viewing — only relevant on the active
   *  session row, used to highlight the corresponding RevisionRow. */
  viewedVersionNumber: number | null;
  /** Why the row sits in Needs you, from the engine's open asks. */
  need?: NeedReason | null;
  /** Claude is mid-turn in this plan's terminal. */
  working?: boolean;
  /** The plan's terminals, always listed under the row. */
  terminals?: readonly SidebarTerminal[];
  onClick: (sessionId: string) => void;
  onToggleExpand: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename?: (id: string, title: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onSetPlanState?: (id: string, state: ManualPlanState) => void;
  onMoveProject?: (id: string) => void;
  onExport: (sessionId: string, versionNumber: number) => void;
  onSelectRevision: (sessionId: string, versionNumber: number | null) => void;
  onOpenRunReport?: (sessionId: string) => void;
  onSelectTerminal?: (sessionId: string, terminalId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const rowButton = useRef<HTMLButtonElement>(null);
  const display = computeRevisionDisplay(session.revisions);
  const badgeVersion = latestDisplayVersion(
    session.revisions,
    session.latestVersion,
  );
  // Only multi-revision sessions get a disclosure affordance — a single
  // revision has no tree to reveal, so the row stays flat.
  const expandable = session.revisions.length > 1;
  const picked = pickedAt >= 0;
  const rowName =
    session.titleOverride || session.planTitle || session.projectName || session.projectPath || session.sessionId;
  // The row wears the needs dot for its own ask and for any terminal of its
  // that is blocked on you — even outside the Needs you section.
  const termNeeds = terminals?.some((t) => t.status === "needs") ?? false;
  const needWord = need ? rowStatus({ kind: "plan", need, working: false, session }).word : null;

  return (
    <li className="rl-session-row relative group" data-need={need || termNeeds ? "" : undefined} onContextMenu={e => { if (!combining) { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); setMenuOpen(true); } }} onKeyDown={e => {
      if (!combining && (e.key === "Backspace" || e.key === "Delete") && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); setConfirming(true); }
    }}>
      {renaming && <RowRename className="rl-row-rename" label="Session title" value={rowName} onDone={(title, how) => {
        setRenaming(false);
        if (title !== null) onRename?.(session.sessionId, title);
        if (how !== "blur") rowButton.current?.focus();
      }} />}
      {/* One-shot arrival glow — an overlay, like the tile hail, so it paints
          above the row's own background. Keyed on the nonce: a new arrival is
          a new element, so the animation genuinely restarts. */}
      {glowNonce !== undefined && <span key={glowNonce} className="rl-row-arrival" aria-hidden />}
      {/* Disclosure chevron — toggles the revision tree without selecting. */}
      {expandable && (
        <button
          type="button"
          aria-label={expanded ? "Collapse revisions" : "Expand revisions"}
          title={expanded ? "Hide revisions" : "Show revisions"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(session.sessionId);
          }}
          className="absolute left-1 top-2 z-10 px-1"
          style={{
            color: "var(--color-ink-muted)",
            fontSize: "10px",
            lineHeight: 1.6,
            cursor: "pointer",
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      )}
      {/* How many plan versions live under the caret — the same number as the
          v{n} pill (restores don't advance it), so the two can never disagree.
          Single-revision rows show nothing: no tree to reveal, and a
          universal "1" is noise. */}
      {expandable && (
        <span
          aria-hidden="true"
          className="absolute left-1 top-6 z-10 px-1 font-mono"
          style={{
            color: "var(--color-ink-muted)",
            fontSize: "8px",
            pointerEvents: "none",
          }}
        >
          {badgeVersion}
        </span>
      )}
      {confirming && !combining ? (
        <div
          className="rl-session-confirm absolute right-3 top-2 z-10 flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            borderRadius: "6px",
            padding: "2px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          }}
        >
          <button
            type="button"
            title={
              session.held
                ? "Delete this session and release Claude Code's blocked terminal (cannot be undone)"
                : "Confirm delete (cannot be undone)"
            }
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
              onDelete(session.sessionId);
            }}
            className="rl-session-confirm-yes rounded px-1.5"
            style={{
              color: "var(--color-on-accent)",
              background: "var(--color-warning)",
              fontSize: "11px",
              lineHeight: 1.5,
              fontWeight: 600,
            }}
          >
            {session.held ? "Delete (release Claude)" : "Delete"}
          </button>
          <button
            type="button"
            title="Cancel"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
            className="rl-session-confirm-no rounded px-1.5"
            style={{
              color: "var(--color-ink-muted)",
              background: "var(--color-anchor-bg)",
              fontSize: "11px",
              lineHeight: 1.5,
            }}
          >
            Cancel
          </button>
        </div>
      ) : combining ? null : (
        <RowMenu open={menuOpen} onOpenChange={open => { setMenuOpen(open); if (!open) setMenuAt(null); }} at={menuAt} label={rowName}
          actions={planRowActions(session, {
            open: () => onClick(session.sessionId),
            rename: onRename ? () => setRenaming(true) : undefined,
            archive: onArchive ? () => onArchive(session.sessionId, !session.archivedAt) : undefined,
            remove: () => setConfirming(true),
          })} />
      )}
      <button
        ref={rowButton}
        type="button"
        onClick={() => onClick(session.sessionId)}
        aria-pressed={combining ? picked : undefined}
        aria-current={!combining && active ? "page" : undefined}
        aria-label={
          combining
            ? picked
              ? `${rowName}, source ${pickedAt + 1} of the combination`
              : `${rowName}, not in the combination`
            : undefined
        }
        className={`hover-elevated w-full text-left pl-7 pr-10 py-2 border-b${
          combining ? " rl-cmb-row" : ""
        }${combining && picked ? " is-on" : ""}`}
        style={{
          borderColor: "var(--color-rule)",
          // While combining, the picked look is the stylesheet's (`.is-on`);
          // outside it, the active row keeps its own inset accent stripe.
          background: !combining && active ? "var(--color-bg-elevated)" : undefined,
          boxShadow:
            !combining && active ? "inset 2px 0 0 var(--color-accent)" : undefined,
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <span
            className="truncate"
            style={{
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              color: "var(--color-ink)",
            }}
            title={session.projectPath}
          >
            {session.titleOverride || session.planTitle ||
              session.projectName ||
              session.projectPath ||
              session.sessionId}
          </span>
          {/* One slot, two occupants that never coexist: the version badge
              normally, the pick marker while combining (the version is
              carried by the Front Door pill then). Being a flex sibling of
              the truncating title is what keeps a long plan name's ellipsis
              from running underneath the marker.

              `aria-hidden` on the marker because the row button around it
              already carries the state for assistive tech — this is the
              visual half of one control, not a second one. */}
          {combining ? (
            <span aria-hidden="true" className={`rl-cmb-node${picked ? " is-on" : ""}`}>
              {picked ? pickedAt + 1 : ""}
            </span>
          ) : (
            <span
              className="font-mono shrink-0 rounded-sm px-1.5 py-0.5 transition-opacity group-hover:opacity-0"
              style={{
                background: "var(--color-anchor-bg)",
                color: "var(--color-anchor-text)",
                fontSize: "10px",
              }}
            >
              v{badgeVersion}
            </span>
          )}
        </div>
        {/* When the plan title leads, keep the project visible underneath —
            two sessions in one project stay tellable apart by title, and one
            title across two projects by this line. */}
        {session.planTitle && session.projectName && (
          <span className="truncate mb-1" title={session.projectPath} aria-label="Move to repo…"
            {...nestedControl(() => onMoveProject?.(session.sessionId))}
            // `clip`, not the class's `hidden`: an inline-block that scrolls
            // sits on its bottom edge, where the button this was sat on its
            // text. Clipping still ellipsizes.
            style={{ ...NESTED_CONTROL_STYLE, overflow: "clip", fontSize: "10px", color: "var(--color-ink-muted)" }}>
            {session.projectName}
          </span>
        )}
        <div
          className="flex items-center gap-2"
          style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
        >
          {/* A plan landed here while the reviewer was mid-discussion
              elsewhere, so nothing pulled them over. Reuses the app's existing
              pulse keyframes (reduced-motion aware). */}
          {unseen && (
            <span
              className="rl-pulse rounded-full shrink-0"
              title="A new plan was intercepted for this session"
              aria-label="New plan intercepted"
              style={{
                width: "6px",
                height: "6px",
                background: "var(--color-info)",
              }}
            />
          )}
          {/* Needs you: the amber pulse, and the reason when the engine named
              one. Working: the shared ring. The one status vocabulary. */}
          {(need || termNeeds) && !combining && (
            <i className="rl-sb-dot rl-sb-need" title={needWord ?? "A terminal of this plan needs you"} aria-label="Needs you" />
          )}
          {needWord && !combining && <span className="rl-sb-needword">{needWord}</span>}
          {working && !combining && <Spinner size={10} className="rl-sb-spin" />}
          <span
            style={{
              color: STATUS_COLORS[session.status],
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {/* Approved with nothing building is its own state — it waits on
                you (Build or Reopen), so it says so rather than reading as
                done. NULL run_state is exactly that state. */}
            {onSetPlanState ? <PlanStateMenu nested session={session} onState={state => onSetPlanState(session.sessionId, state)}
              onMove={onMoveProject ? () => onMoveProject(session.sessionId) : undefined}>
              {session.status === "approved" && !session.runState ? "approved · not built" : STATUS_LABELS[session.status]}
            </PlanStateMenu> : STATUS_LABELS[session.status]}
          </span>
          {/* The harness is no longer holding this review — comments and
              discussions still save, but sending needs a restore first.
              Surfaced here so the reviewer sees it BEFORE interacting, and
              named for the harness that actually left (a legacy row with no
              stored provenance claims neither). */}
          {session.attachState === "detached" && (
            <span
              title={detachedPillTitle(session.backend)}
              style={{
                color: "var(--color-warning, #b45309)",
                border: "1px solid var(--color-warning, #b45309)",
                borderRadius: "9999px",
                padding: "0 6px",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              detached
            </span>
          )}
          {/* Which harness authored this plan. Shown ONLY for a non-Claude
              session: a Claude-only user's list must look exactly as it does
              today, and the badge exists to answer "why does this one restore
              differently", not to label every row with the obvious. */}
          {session.backend === "codex" && (
            <span
              title={
                session.model
                  ? `Planned by Codex · ${session.model}`
                  : "Planned by Codex"
              }
              style={{
                color: "var(--color-ink-muted)",
                border: "1px solid var(--color-rule)",
                borderRadius: "9999px",
                padding: "0 6px",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              codex
            </span>
          )}
          {/* Orchestrated-run lifecycle chip — the Runs monitor's one entry
              point (deliberately contextual: it exists only while a session
              has a run). Clicking a live run opens the live monitor; a
              finished run reopens its report. An abandoned/needs-follow-up
              run keeps its last state visible — only a Resolved mark walks
              it to `landed`. */}
          {session.runState === "building" && !combining && (
            <span
              title="An agent is building this approved plan in its terminal"
              style={{
                color: RUN_STATE_COLORS.building,
                border: `1px solid ${RUN_STATE_COLORS.building}`,
                borderRadius: "9999px",
                padding: "0 6px",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              building
            </span>
          )}
          {session.runState && session.runState !== "building" && !combining && (
            <span
              title={`Orchestrated run: ${session.runState.replace(/_/g, " ")} — click to ${
                isLiveRunState(session.runState) ? "watch it live" : "open the run report"
              }`}
              {...nestedControl(() => onOpenRunReport?.(session.sessionId))}
              style={{
                ...NESTED_CONTROL_STYLE,
                color: RUN_STATE_COLORS[session.runState] ?? "var(--color-ink-muted)",
                border: `1px solid ${RUN_STATE_COLORS[session.runState] ?? "var(--color-ink-muted)"}`,
                borderRadius: "9999px",
                padding: "0 6px",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                cursor: "pointer",
              }}
            >
              {session.runState.replace(/_/g, " ")}
            </span>
          )}
          {/* The run degraded to the sequential fallback. Deliberately its
              own chip rather than a tint on the state chip: the state is
              still true, and this is a second, independent fact about the
              run — one that is otherwise only visible after navigating to
              the Runs surface and reading a neutral-styled word. */}
          {session.runState && !combining && isSequentialFallback(session.runMode) && (
            <span
              title={SEQUENTIAL_FALLBACK_NOTE}
              style={{
                color: "var(--color-warning)",
                border: "1px solid var(--color-warning)",
                borderRadius: "9999px",
                padding: "0 6px",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              seq
            </span>
          )}
          {pending > 0 && (
            <span
              className="rounded-full px-1.5"
              style={{
                background: "var(--color-warning)",
                color: "var(--color-on-accent)",
                fontSize: "9px",
                fontWeight: 600,
              }}
            >
              {pending}
            </span>
          )}
        </div>
      </button>
      {/* The plan's terminals, always: a terminal blocked on you is news
          whether or not the revision tree is open. */}
      {terminals && terminals.length > 0 && (
        <ul className="rl-sb-terms" aria-label="Terminals">
          {terminals.map((t) => (
            <TerminalRow key={t.id} sessionId={session.sessionId} terminal={t} onSelect={onSelectTerminal} />
          ))}
        </ul>
      )}
      {expandable && expanded && (
        <ul className="border-b" style={{ borderColor: "var(--color-rule)" }}>
          {session.revisions.map((r, idx) => {
            const info = display.get(r.versionNumber);
            const isLatest = info?.isLatest ?? false;
            const displayVersion = info?.displayVersion ?? r.versionNumber;
            // Highlight the row currently displayed in the document pane:
            // either the explicitly-viewed historical revision, or the latest
            // when no historical view is selected.
            const viewed =
              active &&
              (viewedVersionNumber === null
                ? isLatest
                : r.versionNumber === viewedVersionNumber);
            return (
              <RevisionRow
                key={r.versionNumber}
                revision={r}
                displayVersion={displayVersion}
                viewed={viewed}
                isLatest={isLatest}
                // A restore is labeled "restored", not a thread boundary, even
                // when it lands as thread_start (same body, clean render).
                threadBoundary={r.threadStart && !r.restored && idx > 0}
                onSelect={() =>
                  onSelectRevision(
                    session.sessionId,
                    isLatest ? null : r.versionNumber,
                  )
                }
                onExport={() => onExport(session.sessionId, r.versionNumber)}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** Memoized: a summaries read re-renders the list, and with every handler
 *  id-based and stable and an unchanged session keeping its object (App's
 *  `refreshSummaries`), only the rows that changed render. */
const SessionRow = memo(SessionRowBase);

/** One revision under an expanded session. Row click loads that revision
 *  into the document pane for read-only viewing/compare. A small download
 *  icon on the right exports the same revision as clean markdown. */
function RevisionRow({
  revision,
  displayVersion,
  viewed,
  isLatest,
  threadBoundary,
  onSelect,
  onExport,
}: {
  revision: RevisionSummary;
  /** Substantive version shown to the reviewer — restores re-use the version
   *  they restore rather than advancing the count. */
  displayVersion: number;
  /** This row is the one currently shown in the document pane. */
  viewed: boolean;
  /** Convenience: the latest revision of the session. Affects the title. */
  isLatest: boolean;
  threadBoundary: boolean;
  onSelect: () => void;
  onExport: () => void;
}) {
  const title = revision.restored
    ? `View v${displayVersion} (restored) in the document pane`
    : isLatest
      ? `View v${displayVersion} (latest)`
      : `View v${displayVersion} in the document pane`;
  return (
    <li className="rl-revision-row">
      <button
        type="button"
        onClick={onSelect}
        title={title}
        aria-current={viewed ? "true" : undefined}
        className="hover-elevated w-full text-left flex items-center justify-between gap-2 pl-8 pr-2 py-1"
        style={{
          background: viewed ? "var(--color-bg-elevated)" : "transparent",
          borderTop: threadBoundary
            ? "1px solid var(--color-rule)"
            : undefined,
          cursor: "pointer",
        }}
      >
        <span className="flex items-baseline gap-1.5">
          <span
            className="font-mono"
            style={{
              fontSize: "11px",
              fontWeight: viewed ? 600 : 400,
              color: viewed ? "var(--color-ink)" : "var(--color-ink-muted)",
            }}
          >
            v{displayVersion}
          </span>
          {(threadBoundary || revision.restored) && (
            <span
              style={{
                fontSize: "9px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-ink-muted)",
              }}
            >
              {revision.restored ? "restored" : "new thread"}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>
            {formatTime(revision.receivedAt)}
          </span>
          {/* Download stays available per-row — separate affordance from
              row click, since clicking the row now loads into the pane. */}
          <span
            role="button"
            tabIndex={0}
            aria-label={`Download v${displayVersion} as a Markdown file`}
            title={`Download v${displayVersion} as a Markdown file`}
            onClick={(e) => {
              e.stopPropagation();
              onExport();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onExport();
              }
            }}
            className="rounded px-1 opacity-60 hover:opacity-100"
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            ↓
          </span>
        </span>
      </button>
    </li>
  );
}

// ── Chat and launch rows ────────────────────────────────────────────────────

function StatusGlyph({ icon, tone, need }: { icon: StatusIcon; tone: StatusTone; need: boolean }) {
  // Needs you is the amber pulse, in the one vocabulary.
  if (icon === "dot") return <i className={`rl-sb-dot${need ? " rl-sb-need" : ""}`} aria-hidden style={need ? undefined : { background: TONE[tone] }} />;
  // Working turns the shared ring: an HTML element the compositor spins. A
  // rotating <svg> is repainted on the main thread every frame.
  if (icon === "spin") return <Spinner size={12} className="rl-sb-spin" style={{ color: TONE[tone] }} />;
  if (icon === "alert") return <TriangleAlert size={14} aria-hidden style={{ color: TONE[tone] }} />;
  if (icon === "chat") return <MessageSquare size={14} aria-hidden style={{ color: TONE[tone] }} />;
  return <FileText size={14} aria-hidden style={{ color: TONE[tone] }} />;
}

/** A chat, or a launch whose plan has not arrived: a light two-line row
 *  (a launch is one line, italic, tagged "launching"). Every row has a ⋯
 *  (also right-click, and ⌫ to delete a chat). */
function LightRowBase({ item, active, handlers, can }: {
  item: SidebarItem;
  active: boolean;
  handlers: LightHandlers;
  can: LightCan;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rowButton = useRef<HTMLButtonElement>(null);
  const chat = item.kind === "chat";
  const deletable = chat && can.deleteChat;
  const acts = {
    open: () => handlers.pick(item),
    rename: chat && can.renameChat ? () => setRenaming(true) : undefined,
    archive: chat && can.archiveChat ? () => handlers.archive(item) : undefined,
    remove: deletable ? () => setConfirming(true) : undefined,
  };
  // A launch has no record yet, so nothing to rename, archive or delete: its
  // menu only opens it.
  const actions: RowAction[] = chat
    ? chatRowActions(item, acts)
    : [{ label: "Open session", icon: <FileText size={14} aria-hidden />, onSelect: acts.open }];
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
  const icon = <span className="rl-sb-icon"><StatusGlyph icon={status.icon} tone={status.tone} need={item.need !== null} /></span>;
  const tooltip = [item.title, item.projectPath, status.detail].filter(Boolean).join("\n");
  return (
    <li
      className="rl-sb-item"
      data-kind={item.kind}
      data-active={active || undefined}
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
          <RowRename className="rl-sb-rename" label="Chat title" value={item.title} onDone={(title, how) => {
            back(how !== "blur");
            if (title !== null) handlers.rename(item, title);
          }} />
        </div>
      ) : confirming ? (
        <div className="rl-sb-row" data-confirming="">
          {icon}
          <span className="rl-sb-title">{item.title}</span>
          <ConfirmDelete
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
            {icon}
            {chat ? (
              <span className="rl-sb-text">
                <span className="rl-sb-line">
                  <span className="rl-sb-title">{item.title}</span>
                </span>
                <span className="rl-sb-meta">
                  <span className="rl-sb-status" style={{ color: TONE[status.tone] }}>{status.word}</span>
                  <span className="rl-sb-age">· {rowAge(item.at)}</span>
                </span>
              </span>
            ) : (
              <>
                <span className="rl-sb-title">{item.title}</span>
                <span className="rl-sb-tag">{item.need ? status.word : "launching"}</span>
              </>
            )}
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
    </li>
  );
}

/** Rows re-render only when something they show changed: a summaries read
 *  rebuilds every item object, so comparing the fields is enough. */
const LightRow = memo(LightRowBase, (a, b) =>
  a.active === b.active &&
  a.handlers === b.handlers &&
  a.can === b.can &&
  a.item.key === b.item.key &&
  a.item.title === b.item.title &&
  a.item.at === b.item.at &&
  a.item.mode === b.item.mode &&
  a.item.need === b.item.need &&
  a.item.working === b.item.working &&
  a.item.archivedAt === b.item.archivedAt,
);

/** The two-step delete, inline in the row: ⌫ or the menu asks, Delete
 *  confirms, Escape or Cancel backs out. */
function ConfirmDelete({ onConfirm, onCancel }: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rl-sb-confirm"
      role="group"
      aria-label="Delete this chat?"
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
        title="Delete (cannot be undone)"
        onClick={onConfirm}
      >
        Delete
      </button>
      <button type="button" className="rl-sb-confirm-no" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Memoized: the sidebar reconciles the whole session list, and a sidebar
 *  drag changes only its width. */
export const SessionSidebar = memo(SessionSidebarBase);
