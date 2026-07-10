// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ReactNode } from "react";
import { CopyChip } from "./CopyChip";

// A one-screen "how Redline works" explainer. Answers the two questions new
// users ask most: (1) how does a plan get here, and (2) what are the slash
// commands — specifically the difference between plan review and code review.
// Opened from the empty state and the post-install screen; purely informational.

const chip = {
  background: "var(--color-anchor-bg)",
  padding: "1px 5px",
  borderRadius: "3px",
  fontSize: "11px",
} as const;

function Num({ n, children }: { n: number; children: ReactNode }) {
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

function CommandRow({
  cmd,
  what,
  how,
}: {
  cmd: string;
  what: string;
  how: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md border p-3"
      style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
    >
      <code className="font-mono" style={{ ...chip, alignSelf: "flex-start" }}>
        {cmd}
      </code>
      <div style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink)" }}>
        {what}
      </div>
      <div
        style={{ fontSize: "12px", lineHeight: 1.5, color: "var(--color-ink-muted)" }}
      >
        {how}
      </div>
    </div>
  );
}

export function HowItWorksCard({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6 overflow-y-auto"
        style={{
          maxWidth: "560px",
          maxHeight: "86vh",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          How Redline works
        </h2>

        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink)",
            marginBottom: 14,
          }}
        >
          You don't drive Redline with commands — it plugs into Claude Code and
          intercepts plans automatically. The loop:
        </p>

        <div className="flex flex-col gap-2.5" style={{ marginBottom: 18 }}>
          <Num n={1}>
            Run <code className="font-mono" style={chip}>claude</code> in any
            terminal and press{" "}
            <code className="font-mono" style={chip}>shift+tab</code> to enter{" "}
            <strong>plan mode</strong>.
          </Num>
          <Num n={2}>
            When Claude finishes planning, a hook <strong>pauses</strong> Claude
            and sends the plan to Redline instead of printing it in the terminal.
          </Num>
          <Num n={3}>
            The plan opens here to review — mark it up, ask questions, edit. When
            you <strong>approve</strong> or <strong>send revisions</strong>,
            Redline answers the paused request and Claude continues. No commands
            to remember.
          </Num>
        </div>

        <h3
          className="font-semibold"
          style={{ fontSize: "14px", color: "var(--color-ink)", marginBottom: 8 }}
        >
          The two slash commands, and how they differ
        </h3>
        <p
          style={{
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
            marginBottom: 12,
          }}
        >
          These are Claude Code <em>skills</em> Redline installs. Similar names,
          different jobs:
        </p>
        <div className="flex flex-col gap-2.5" style={{ marginBottom: 18 }}>
          <CommandRow
            cmd="redline-plan-review"
            what="Plan review — the loop above"
            how="Automatic. You never type this; the hook triggers it when Claude finishes a plan. It teaches Claude how to present a plan and fold your revisions back in."
          />
          <CommandRow
            cmd="/redline-code-review"
            what="Code review — a diff, after code is written"
            how="You (or Claude) run this after Claude writes code. It opens the diff of those changes in Redline for line-by-line review, and sends your comments back to the session to address."
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
          One-time setup: after installing the integration, run{" "}
          <CopyChip text="/hooks" title="Copy /hooks" /> inside Claude Code once
          to approve the hook — a Claude Code security check we can't skip for you.
        </p>

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
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
      </div>
    </div>
  );
}
