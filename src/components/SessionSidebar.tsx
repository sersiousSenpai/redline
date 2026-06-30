// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

import type { RevisionSummary, SessionSummary } from "../types";
import {
  computeRevisionDisplay,
  latestDisplayVersion,
} from "../lib/revisionVersions";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
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
}

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

export function SessionSidebar({
  sessions,
  activeId,
  pendingCounts,
  onSelect,
  onDelete,
  onExport,
  onSelectRevision,
  viewedVersionNumber,
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

  return (
    <div
      className="flex-1 overflow-y-auto rl-thin-scroll-y"
      style={{ background: "var(--color-paper)" }}
    >
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
              viewedVersionNumber={
                s.sessionId === activeId ? viewedVersionNumber : null
              }
              onClick={() => onSelect(s.sessionId)}
              onToggleExpand={() => toggleExpand(s.sessionId)}
              onDelete={() => onDelete(s.sessionId)}
              onExport={onExport}
              onSelectRevision={onSelectRevision}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  expanded,
  pending,
  viewedVersionNumber,
  onClick,
  onToggleExpand,
  onDelete,
  onExport,
  onSelectRevision,
}: {
  session: SessionSummary;
  active: boolean;
  expanded: boolean;
  pending: number;
  /** Which revision the active pane is viewing — only relevant on the active
   *  session row, used to highlight the corresponding RevisionRow. */
  viewedVersionNumber: number | null;
  onClick: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  onExport: (sessionId: string, versionNumber: number) => void;
  onSelectRevision: (sessionId: string, versionNumber: number | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const display = computeRevisionDisplay(session.revisions);
  const badgeVersion = latestDisplayVersion(
    session.revisions,
    session.latestVersion,
  );

  return (
    <li className="relative group">
      {/* Disclosure chevron — toggles the revision tree without selecting. */}
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
      {expanded && (
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
