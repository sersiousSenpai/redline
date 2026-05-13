import type { ReviewSession } from "../types";

interface HeaderProps {
  session: ReviewSession | null;
}

export function Header({ session }: HeaderProps) {
  const latest = session?.revisions[session.revisions.length - 1];
  return (
    <header
      className="font-sans flex items-center justify-between gap-4 px-6 py-3 border-b"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <div className="flex items-baseline gap-3">
        <span className="font-semibold tracking-tight" style={{ fontSize: "14px" }}>
          Redline
        </span>
        {session && (
          <>
            <span style={{ color: "var(--color-ink-muted)" }}>·</span>
            <span style={{ color: "var(--color-ink-muted)" }}>
              {session.projectName}
            </span>
            <span style={{ color: "var(--color-ink-muted)" }}>·</span>
            <span
              className="font-mono"
              style={{
                color: "var(--color-ink-muted)",
                fontSize: "11px",
              }}
              title={session.sessionId}
            >
              {session.sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>
      {latest && (
        <span
          className="font-mono rounded-sm px-2 py-0.5"
          style={{
            background: "var(--color-anchor-bg)",
            color: "var(--color-anchor-text)",
            fontSize: "11px",
          }}
        >
          v{latest.versionNumber}
        </span>
      )}
    </header>
  );
}
