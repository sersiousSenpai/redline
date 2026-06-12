// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ReactNode } from "react";
import type { HookStatus, SkillStatus } from "../types";

interface HookSetupModalProps {
  /** "setup" = the mandatory install screen; "done" = the post-install
   *  what-now explainer, shown once right after an in-app install. */
  phase: "setup" | "done";
  hookStatus: HookStatus;
  skillStatus: SkillStatus;
  /** Installs both the hook and the skill. */
  onInstall: () => void;
  /** Dismisses the post-install explainer. */
  onDismiss: () => void;
  /** Install failure detail, rendered inline above the button. */
  error?: string | null;
}

const codeChip = {
  background: "var(--color-anchor-bg)",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "11px",
} as const;

/** One piece of the integration, as a plain list line — deliberately not a
 *  separate card with a status circle, which read as a radio choice between
 *  two alternatives. A check appears only on a piece that's already present
 *  (partial-install case). */
function PieceLine({
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
    <div className="flex flex-col gap-1 min-w-0">
      <div style={{ fontSize: "13px", color: "var(--color-ink)" }}>
        <span className="font-medium">{label}</span>
        {installed && (
          <span
            style={{
              fontSize: "11px",
              color: "var(--color-info)",
              marginLeft: 6,
            }}
          >
            ✓ already installed
          </span>
        )}
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
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className="shrink-0 font-mono"
        style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
      >
        {n}.
      </div>
      <div
        style={{ fontSize: "13px", lineHeight: 1.55, color: "var(--color-ink)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function HookSetupModal({
  phase,
  hookStatus,
  skillStatus,
  onInstall,
  onDismiss,
  error,
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
        {phase === "setup" ? (
          <>
            <h2
              className="font-serif font-semibold mb-3"
              style={{ fontSize: "20px", color: "var(--color-ink)" }}
            >
              Set up Redline
            </h2>
            <p
              style={{
                fontSize: "13px",
                lineHeight: 1.55,
                color: "var(--color-ink)",
                marginBottom: 14,
              }}
            >
              Redline works by plugging into Claude Code — a <strong>hook</strong>{" "}
              that routes every plan here for review, and a <strong>skill</strong>{" "}
              that teaches Claude the review format. Until they're installed,
              plans never leave the terminal and Redline has nothing to show.
              Installing is one click; each piece is a plain file edit you can
              inspect or undo.
            </p>
            <div
              className="flex flex-col gap-3 rounded-md border p-3"
              style={{
                borderColor: "var(--color-rule)",
                background: "var(--color-paper)",
                marginBottom: 16,
              }}
            >
              <PieceLine
                label="Plan-intercept hook"
                description="Routes every Claude Code plan-mode plan into Redline for review."
                path={hookStatus.settingsPath}
                installed={hookStatus.installed}
                note={hookNote}
              />
              <PieceLine
                label="Review-protocol skill"
                description="Teaches Claude presentation-aware plan markdown and the revision contract."
                path={skillStatus.skillPath}
                installed={skillStatus.installed && !skillStatus.outdated}
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
            {error && (
              <p
                role="alert"
                style={{
                  fontSize: "12px",
                  lineHeight: 1.5,
                  color: "var(--color-warning)",
                  marginBottom: 14,
                }}
              >
                {error}
              </p>
            )}
            <div className="flex items-center justify-end">
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
          </>
        ) : (
          <>
            <h2
              className="font-serif font-semibold mb-3"
              style={{ fontSize: "20px", color: "var(--color-ink)" }}
            >
              You're set — here's the loop
            </h2>
            <div className="flex flex-col gap-3" style={{ marginBottom: 16 }}>
              <Step n={1}>
                In any project, run{" "}
                <code className="font-mono" style={codeChip}>
                  claude
                </code>{" "}
                in a terminal — Redline's built-in terminal or your own — and
                press{" "}
                <code className="font-mono" style={codeChip}>
                  shift+tab
                </code>{" "}
                to switch into <strong>plan mode</strong>.
              </Step>
              <Step n={2}>
                Work with Claude exactly as you would in the terminal —
                everything is the same until Claude finishes a plan.
              </Step>
              <Step n={3}>
                Instead of a wall of text in the terminal, the plan opens{" "}
                <strong>here</strong> — mark it up, ask questions, and approve
                it when it's right.
              </Step>
            </div>
            <p
              style={{
                fontSize: "12px",
                lineHeight: 1.5,
                color: "var(--color-ink-muted)",
                marginBottom: 18,
              }}
            >
              One more thing: run{" "}
              <code className="font-mono" style={codeChip}>
                /hooks
              </code>{" "}
              inside Claude Code once to approve the hook (a one-time security
              check).
            </p>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded px-3 py-1.5 font-medium"
                style={{
                  background: "var(--color-info)",
                  color: "var(--color-on-accent)",
                  fontSize: "12px",
                }}
              >
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
