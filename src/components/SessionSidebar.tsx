import type { SessionSummary } from "../types";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  onSelect: (id: string) => void;
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

export function SessionSidebar({
  sessions,
  activeId,
  pendingCounts,
  onSelect,
}: SessionSidebarProps) {
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
              pending={pendingCounts[s.sessionId] ?? 0}
              onClick={() => onSelect(s.sessionId)}
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
  pending,
  onClick,
}: {
  session: SessionSummary;
  active: boolean;
  pending: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="hover-elevated w-full text-left px-3 py-2 border-b"
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
    </li>
  );
}
