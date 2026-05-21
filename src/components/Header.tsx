// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
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
  /** Download the currently-displayed revision as a clean .md file. */
  onExport: (sessionId: string, versionNumber: number) => void;
}

export function Header({
  session,
  theme,
  onThemeChange,
  mode,
  onModeChange,
  onExport,
}: HeaderProps) {
  const latest = session?.revisions[session.revisions.length - 1];
  return (
    <header
      className="flex items-center justify-between gap-4 pl-3 pr-6 py-3 border-b"
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
        {session && latest && (
          <button
            type="button"
            onClick={() => onExport(session.sessionId, latest.versionNumber)}
            title={`Download v${latest.versionNumber} as a Markdown file`}
            className="rounded px-2.5 py-1 font-medium"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            Download .md
          </button>
        )}
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
