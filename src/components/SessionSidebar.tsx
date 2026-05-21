// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

import type { RevisionSummary, SessionSummary } from "../types";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  onSelect: (id: string) => void;
  /** Delete a finished session. Only offered when its terminal is inactive
   *  (`!session.held`); the backend rejects held sessions defensively. */
  onDelete: (id: string) => void;
  /** Download a specific revision as a clean .md file. */
  onExport: (sessionId: string, versionNumber: number) => void;
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
    <aside
      className="border-r overflow-y-auto shrink-0"
      style={{
        width: "240px",
        borderColor: "var(--color-rule)",
        background: "var(--color-paper)",
      }}
    >
      <div
        className="px-3 py-2 border-b"
        style={{
          borderColor: "var(--color-rule)",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--color-ink-muted)",
        }}
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
              onClick={() => onSelect(s.sessionId)}
              onToggleExpand={() => toggleExpand(s.sessionId)}
              onDelete={() => onDelete(s.sessionId)}
              onExport={onExport}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function SessionRow({
  session,
  active,
  expanded,
  pending,
  onClick,
  onToggleExpand,
  onDelete,
  onExport,
}: {
  session: SessionSummary;
  active: boolean;
  expanded: boolean;
  pending: number;
  onClick: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  onExport: (sessionId: string, versionNumber: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);

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
      {!session.held &&
        (confirming ? (
          <div
            className="absolute right-2 top-2 z-10 flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="Confirm delete (cannot be undone)"
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
              Delete
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
            title="Delete this session"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className="absolute right-2 top-2 z-10 rounded px-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{
              color: "var(--color-ink-muted)",
              background: "var(--color-anchor-bg)",
              fontSize: "12px",
              lineHeight: 1.4,
            }}
          >
            ✕
          </button>
        ))}
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
            {session.projectName || session.projectPath || session.sessionId}
          </span>
          <span
            className="font-mono shrink-0 rounded-sm px-1.5 py-0.5"
            style={{
              background: "var(--color-anchor-bg)",
              color: "var(--color-anchor-text)",
              fontSize: "10px",
            }}
          >
            v{session.latestVersion}
          </span>
        </div>
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
          {session.revisions.map((r, idx) => (
            <RevisionRow
              key={r.versionNumber}
              revision={r}
              current={active && r.versionNumber === session.latestVersion}
              threadBoundary={r.threadStart && idx > 0}
              onExport={() => onExport(session.sessionId, r.versionNumber)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One revision under an expanded session. The whole row is a download
 *  affordance — clicking it exports that revision as clean markdown. */
function RevisionRow({
  revision,
  current,
  threadBoundary,
  onExport,
}: {
  revision: RevisionSummary;
  current: boolean;
  threadBoundary: boolean;
  onExport: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onExport}
        title={`Download v${revision.versionNumber} as a Markdown file`}
        className="hover-elevated w-full text-left flex items-center justify-between gap-2 pl-8 pr-3 py-1"
        style={{
          background: current ? "var(--color-bg-elevated)" : "transparent",
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
              fontWeight: current ? 600 : 400,
              color: current ? "var(--color-ink)" : "var(--color-ink-muted)",
            }}
          >
            v{revision.versionNumber}
          </span>
          {threadBoundary && (
            <span
              style={{
                fontSize: "9px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-ink-muted)",
              }}
            >
              new thread
            </span>
          )}
        </span>
        <span
          className="shrink-0"
          style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
        >
          {formatTime(revision.receivedAt)}
        </span>
      </button>
    </li>
  );
}
