import type { InterceptionMode, ReviewSession } from "../types";
import type { ThemeName } from "../theme/themes";
import { ThemePicker } from "./ThemePicker";
import { ModeToggle } from "./ModeToggle";
import redlineLogo from "../assets/redline-logo.png";

interface HeaderProps {
  session: ReviewSession | null;
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
  mode: InterceptionMode;
  onModeChange: (mode: InterceptionMode) => void;
}

export function Header({
  session,
  theme,
  onThemeChange,
  mode,
  onModeChange,
}: HeaderProps) {
  const latest = session?.revisions[session.revisions.length - 1];
  return (
    <header
      className="flex items-center justify-between gap-4 px-6 py-3 border-b"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <div className="flex items-baseline gap-3">
        <img
          src={redlineLogo}
          alt="Redline"
          style={{ height: "26px", width: "auto", display: "block" }}
        />
        {session && (
          <>
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
      <div className="flex items-center gap-3">
        <ModeToggle mode={mode} onChange={onModeChange} />
        <ThemePicker theme={theme} onThemeChange={onThemeChange} />
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
      </div>
    </header>
  );
}
