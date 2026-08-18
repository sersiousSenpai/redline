// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useEffect, useState } from "react";

import type { RevisionSummary, SessionSummary } from "../types";
import type { JoinedSessionInfo } from "../collab/useJoinedSession";
import {
  computeRevisionDisplay,
  latestDisplayVersion,
} from "../lib/revisionVersions";
import { isLiveRunState } from "../lib/orchestration";

interface SessionSidebarProps {
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
  /** Open the RunReport container for an orchestrated run (chip click). */
  onOpenRunReport?: (sessionId: string) => void;
  /** Deselect every session so the document plate shows the front door.
   *  This is the ONLY way back to it: boot auto-selects the most recent plan
   *  and nothing else ever clears the selection, so without this row the
   *  front door is unreachable for anyone who has ever reviewed a plan. */
  onNewPlan?: () => void;
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
  onExport,
  onSelectRevision,
  viewedVersionNumber,
  unseenIds,
  onOpenRunReport,
  onNewPlan,
}: SessionSidebarProps) {
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

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        className="rl-chrome-label px-3 py-2 border-b"
        style={{ borderColor: "var(--color-rule)" }}
      >
        Sessions
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
          {sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === activeId}
              expanded={expanded.has(s.sessionId)}
              pending={pendingCounts[s.sessionId] ?? 0}
              unseen={unseenIds?.has(s.sessionId) ?? false}
              viewedVersionNumber={
                s.sessionId === activeId ? viewedVersionNumber : null
              }
              onClick={() => onSelect(s.sessionId)}
              onToggleExpand={() => toggleExpand(s.sessionId)}
              onDelete={() => onDelete(s.sessionId)}
              onExport={onExport}
              onSelectRevision={onSelectRevision}
              onOpenRunReport={onOpenRunReport}
            />
          ))}
        </ul>
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

function SessionRow({
  session,
  active,
  expanded,
  pending,
  unseen = false,
  viewedVersionNumber,
  onClick,
  onToggleExpand,
  onDelete,
  onExport,
  onSelectRevision,
  onOpenRunReport,
}: {
  session: SessionSummary;
  active: boolean;
  expanded: boolean;
  pending: number;
  /** A plan arrived for this session but the reviewer was never taken to it. */
  unseen?: boolean;
  /** Which revision the active pane is viewing — only relevant on the active
   *  session row, used to highlight the corresponding RevisionRow. */
  viewedVersionNumber: number | null;
  onClick: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  onExport: (sessionId: string, versionNumber: number) => void;
  onSelectRevision: (sessionId: string, versionNumber: number | null) => void;
  onOpenRunReport?: (sessionId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const display = computeRevisionDisplay(session.revisions);
  const badgeVersion = latestDisplayVersion(
    session.revisions,
    session.latestVersion,
  );
  // Only multi-revision sessions get a disclosure affordance — a single
  // revision has no tree to reveal, so the row stays flat.
  const expandable = session.revisions.length > 1;

  return (
    <li className="relative group">
      {/* Disclosure chevron — toggles the revision tree without selecting. */}
      {expandable && (
        <button
          type="button"
          aria-label={expanded ? "Collapse revisions" : "Expand revisions"}
          title={expanded ? "Hide revisions" : "Show revisions"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
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
      {confirming ? (
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
              onDelete();
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
      ) : (
        <button
          type="button"
          aria-label="Delete session"
          title={
            session.held
              ? "Delete this session (will release Claude Code's blocked terminal)"
              : "Delete this session"
          }
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
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
      )}
      <button
        type="button"
        onClick={onClick}
        className="hover-elevated w-full text-left pl-7 pr-3 py-2 border-b"
        style={{
          borderColor: "var(--color-rule)",
          background: active ? "var(--color-bg-elevated)" : "transparent",
          // Inset stripe, not a border: the 2px accent must not shift the
          // row's text alignment against its neighbours.
          boxShadow: active
            ? "inset 2px 0 0 var(--color-accent)"
            : undefined,
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
            {session.planTitle ||
              session.projectName ||
              session.projectPath ||
              session.sessionId}
          </span>
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
        </div>
        {/* When the plan title leads, keep the project visible underneath —
            two sessions in one project stay tellable apart by title, and one
            title across two projects by this line. */}
        {session.planTitle && session.projectName && (
          <div
            className="truncate mb-1"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {session.projectName}
          </div>
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
            {STATUS_LABELS[session.status]}
          </span>
          {/* Claude is no longer holding this review — comments and
              discussions still save, but sending needs a restore first.
              Surfaced here so the reviewer sees it BEFORE interacting. */}
          {session.attachState === "detached" && (
            <span
              title="Claude Code is no longer waiting on this plan — open the session and use “Restore plan session” before sending."
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
          {/* Orchestrated-run lifecycle chip — the Runs monitor's one entry
              point (deliberately contextual: it exists only while a session
              has a run). Clicking a live run opens the live monitor; a
              finished run reopens its report. An abandoned/needs-follow-up
              run keeps its last state visible — only a Resolved mark walks
              it to `landed`. */}
          {session.runState && (
            <button
              type="button"
              title={`Orchestrated run: ${session.runState.replace(/_/g, " ")} — click to ${
                isLiveRunState(session.runState) ? "watch it live" : "open the run report"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenRunReport?.(session.sessionId);
              }}
              style={{
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
            </button>
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
    <li>
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

/** Memoized: the sidebar reconciles the whole session list, and a sidebar
 *  drag changes only its width. */
export const SessionSidebar = memo(SessionSidebarBase);
