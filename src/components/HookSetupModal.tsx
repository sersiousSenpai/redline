// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { HookStatus, SkillStatus } from "../types";

interface HookSetupModalProps {
  hookStatus: HookStatus;
  skillStatus: SkillStatus;
  /** Installs both the hook and the skill. */
  onInstall: () => void;
  onSkip: () => void;
}

const codeChip = {
  background: "var(--color-anchor-bg)",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "11px",
} as const;

/** One piece of the Redline integration — a status glyph, label, what it does,
 *  its on-disk path, and an optional warning note. */
function IntegrationRow({
  label,
  description,
  path,
  installed,
  note,
}: {
  label: string;
  description: string;
  path: string;
  installed: boolean;
  note?: string;
}) {
  return (
    <div
      className="flex gap-3 rounded-md border p-3"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-paper)",
      }}
    >
      <div
        className="shrink-0 font-mono"
        style={{
          fontSize: "13px",
          lineHeight: 1.5,
          color: installed ? "var(--color-info)" : "var(--color-ink-muted)",
        }}
      >
        {installed ? "✓" : "○"}
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <div style={{ fontSize: "13px", color: "var(--color-ink)" }}>
          <span className="font-medium">{label}</span>
          <span
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              marginLeft: 6,
            }}
          >
            {installed ? "installed" : "not installed"}
          </span>
        </div>
        <div
          style={{
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
          }}
        >
          {description}
        </div>
        <code
          className="font-mono"
          style={{ ...codeChip, alignSelf: "flex-start", wordBreak: "break-all" }}
        >
          {path}
        </code>
        {note && (
          <div
            style={{
              fontSize: "11px",
              lineHeight: 1.5,
              color: "var(--color-warning)",
            }}
          >
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

export function HookSetupModal({
  hookStatus,
  skillStatus,
  onInstall,
  onSkip,
}: HookSetupModalProps) {
  const hookNote =
    hookStatus.matcherFound && hookStatus.conflictingUrl
      ? `A different ExitPlanMode hook is configured (${hookStatus.conflictingUrl}). Installing replaces it with the Redline URL.`
      : undefined;
  const skillNote = skillStatus.outdated
    ? "An older version of the skill is present. Installing updates it."
    : undefined;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          maxWidth: "520px",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Install Redline integration
        </h2>
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink)",
            marginBottom: 14,
          }}
        >
          Redline plugs into Claude Code through two pieces — a global{" "}
          <strong>hook</strong> that surfaces every plan here for review, and a{" "}
          <strong>skill</strong> that teaches Claude the Redline review format so
          plans render richly and revisions round-trip cleanly.
        </p>
        <div className="flex flex-col gap-2" style={{ marginBottom: 16 }}>
          <IntegrationRow
            label="Plan-intercept hook"
            description="Routes every Claude Code plan-mode plan into Redline for review."
            path={hookStatus.settingsPath}
            installed={hookStatus.installed}
            note={hookNote}
          />
          <IntegrationRow
            label="Review-protocol skill"
            description="Teaches Claude presentation-aware plan markdown and the revision contract."
            path={skillStatus.skillPath}
            installed={skillStatus.installed}
            note={skillNote}
          />
        </div>
        <p
          style={{
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
            marginBottom: 18,
          }}
        >
          After install, run{" "}
          <code className="font-mono" style={codeChip}>
            /hooks
          </code>{" "}
          inside Claude Code once to approve the hook (a one-time security
          check).
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={onInstall}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            Install integration
          </button>
        </div>
      </div>
    </div>
  );
}
