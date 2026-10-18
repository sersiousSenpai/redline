// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PlanStateMenu, type ManualPlanState } from "./PlanStateMenu";
import { planRowActions, RowMenu, RowRename } from "./RowMenu";
import { NESTED_CONTROL_STYLE, nestedControl } from "./ui/nestedControl";

import type { RevisionSummary, SessionSummary } from "../types";
import type { JoinedSessionInfo } from "../collab/useJoinedSession";
import type { FlowChat, FlowLaunch, NeedReason } from "../lib/sessionGroups";
import { isFlowShell } from "../lib/shellFlag";
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

// The flow shell's sidebar is its own lazy chunk: the classic shell never
// loads it. Under the flow shell it is fetched as this module evaluates, so
// it lands alongside this chunk rather than one round trip behind it.
const loadFlowSidebar = () => import("../shell/FlowSidebar");
const FlowSidebar = lazy(loadFlowSidebar);
if (isFlowShell()) void loadFlowSidebar().catch(() => {});

export interface SessionSidebarProps {
  /** `classic` (the default) is the sessions list below; `flow` is the flow
   *  shell's sidebar (shell/FlowSidebar.tsx), which reads the props marked
   *  "Flow" and ignores the classic-only ones (Combine, joined session, the
   *  run chips, export). */
  layout?: "classic" | "flow";
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
   *  "＋ Plan a build" already does — clears the selection — and seeds the
   *  pills; the composer there becomes the place to add an instruction.
   *  Absent when the host has no Front Door to hand them to. */
  onCombine?: (sessionIds: string[]) => void;
  /** Deselect every session so the document plate shows the front door.
   *  This is the ONLY way back to it: boot auto-selects the most recent plan
   *  and nothing else ever clears the selection, so without this row the
   *  front door is unreachable for anyone who has ever reviewed a plan. */
  onNewPlan?: () => void;
  /** Flow: "+ New session ⌘N", the start screen. */
  onNewSession?: () => void;
  /** Flow: a project group's "+", a new session in that folder. */
  onNewSessionIn?: (projectPath: string) => void;
  /** Flow: the start screen is on the stage, so "+ New session" reads as
   *  selected and no row does. Defaults to nothing being open. */
  startActive?: boolean;
  /** Flow: chats (companion conversations), rows among the plans. */
  chats?: readonly FlowChat[];
  activeChatId?: string | null;
  onSelectChat?: (companionId: string) => void;
  onRenameChat?: (companionId: string, title: string) => void;
  onArchiveChat?: (companionId: string, archived: boolean) => void;
  onDeleteChat?: (companionId: string) => void;
  /** Flow: sessions launched into a terminal whose plan has not arrived
   *  (the BRIEF's "Session identity in flow"). */
  launches?: readonly FlowLaunch[];
  activeLaunchId?: string | null;
  onSelectLaunch?: (terminalId: string) => void;
  /** Flow: why a row needs you, by row key (`plan:<id>`, `chat:<id>`,
   *  `launch:<terminalId>`), from the engine's open asks. A held plan's
   *  Review is read off the session without it. */
  needs?: Readonly<Record<string, NeedReason>>;
  /** Flow: row keys whose Claude is mid-turn (a spinner). */
  working?: ReadonlySet<string>;
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

/** Compact HH:MM for a revision's received-at epoch-millis. */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SessionSidebarBase({
  sessions,
  activeId,
  pendingCounts,
  joined,
  onSelectJoined,
  onLeaveJoined,
  onSelect,
  onDelete,
  onRename, onArchive,
  onSetPlanState, onMoveProject,
  onExport,
  onSelectRevision,
  viewedVersionNumber,
  unseenIds,
  arrivalGlow,
  onOpenRunReport,
  onCombine,
  onNewPlan,
}: SessionSidebarProps) {
  // Which sessions are expanded to show their revision tree. The active
  // session auto-expands so its history is visible the moment it's selected.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(activeId ? [activeId] : []),
  );
  const [showArchived, setShowArchived] = useState(false);
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

  // The list renders in the backend's `updated_at DESC` order, full stop.
  // It used to hoist the open plan to index 0, which meant clicking a row
  // teleported it out from under the cursor in the same frame (stable keys, so
  // React performs a real DOM move with no transition) while the auto-expand
  // effect grew a revision tree at the new top and shoved everything else
  // down. Selection is already legible from the row itself — the inset accent
  // stripe, the bolder title, the expanded tree — so moving it as well bought
  // nothing and cost the one thing a list owes you: staying put.
  return (
    <div
      className="flex-1 overflow-y-auto rl-thin-scroll-y"
      style={{ background: "var(--color-paper)" }}
    >
      {/* The front door's entry point. It sits above the list rather than in
          it because it isn't a session — it is where new ones come from. A
          contextual row here, not a header button (the header is a closed set
          of surfaces). Reads as selected when nothing else is, so "where am
          I" stays answerable. */}
      {onNewPlan && (
        <button
          type="button"
          onClick={onNewPlan}
          // "I am on the front door" was communicated by background colour
          // alone — invisible to a screen reader and to anyone who can't tell
          // --color-anchor-bg from the paper. `aria-current` says it.
          aria-current={activeId === null ? "page" : undefined}
          title="Plan a build — the front door (⌘⇧N)"
          className="flex w-full items-center gap-2 px-3 py-2.5 border-b text-left"
          style={{
            borderColor: "var(--color-rule)",
            background:
              activeId === null ? "var(--color-anchor-bg)" : "transparent",
            color:
              activeId === null
                ? "var(--color-anchor-text)"
                : "var(--color-ink)",
            fontSize: "12.5px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <span aria-hidden style={{ opacity: 0.7 }}>
            ＋
          </span>
          Plan a build
        </button>
      )}
      {joined && (
        <>
          <div
            className="rl-chrome-label px-3 py-2 border-b"
            style={{ borderColor: "var(--color-rule)" }}
          >
            Joined session
          </div>
          <JoinedRow
            joined={joined}
            active={activeId === joined.key}
            onClick={() => onSelectJoined?.()}
            onLeave={() => onLeaveJoined?.()}
          />
        </>
      )}
      <div
        className="rl-chrome-label px-3 py-2 border-b flex items-center gap-2"
        style={{ borderColor: "var(--color-rule)" }}
      >
        <span>Sessions</span>
        <div className="flex-1" />
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
      {sessions.length === 0 ? (
        <div
          className="px-3 py-4 italic"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
        >
          No plans yet.
        </div>
      ) : (
        <ul>
          {sessions.filter(s => !s.archivedAt || showArchived).map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === activeId}
              expanded={expanded.has(s.sessionId)}
              pending={pendingCounts[s.sessionId] ?? 0}
              unseen={unseenIds?.has(s.sessionId) ?? false}
              glowNonce={arrivalGlow?.sessionId === s.sessionId ? arrivalGlow.nonce : undefined}
              viewedVersionNumber={
                s.sessionId === activeId ? viewedVersionNumber : null
              }
              combining={combining}
              pickedAt={picked.indexOf(s.sessionId)}
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
            />
          ))}
        </ul>
      )}
      {sessions.some(s => s.archivedAt) && <button type="button" className="rl-menu-item px-3 py-2 text-left" aria-expanded={showArchived} onClick={() => setShowArchived(v => !v)}>{showArchived ? "▾" : "▸"} Archived · {sessions.filter(s => s.archivedAt).length}</button>}
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
    </div>
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
  onClick,
  onToggleExpand,
  onDelete,
  onRename, onArchive,
  onSetPlanState, onMoveProject,
  onExport,
  onSelectRevision,
  onOpenRunReport,
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

  return (
    <li className="rl-session-row relative group" onContextMenu={e => { if (!combining) { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); setMenuOpen(true); } }} onKeyDown={e => {
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
          className="absolute right-3 top-2 z-10 flex items-center gap-1"
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
            className="rounded px-1.5"
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
            className="rounded px-1.5"
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

/** One shell for the life of the page (`isFlowShell` is read once), so a
 *  mounted sidebar never switches layout under its own state. */
function SessionSidebarLayout(props: SessionSidebarProps) {
  if (props.layout !== "flow") return <SessionSidebarBase {...props} />;
  // Null while the chunk lands: the house rule is a quietly blank plate.
  return (
    <Suspense fallback={null}>
      <FlowSidebar {...props} />
    </Suspense>
  );
}

/** Memoized: the sidebar reconciles the whole session list, and a sidebar
 *  drag changes only its width. */
export const SessionSidebar = memo(SessionSidebarLayout);
