// FLOW PLACEHOLDER — owned by convo-ui
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Stand-in for convo-ui's composer (named export), which the stage uses as
//! the full pose's Feedback composer. The integrator keeps convo-ui's file;
//! the one call site in shell/FlowStage.tsx adapts to its real props.

export interface SessionComposerProps {
  terminalId: string | null;
  sessionId: string | null;
  harness: "claude" | "codex";
  placeholder?: string;
}

export function SessionComposer({ placeholder }: SessionComposerProps) {
  return (
    <div style={{ padding: "12px 14px 14px", borderTop: "1px solid var(--color-rule)" }}>
      <div
        className="rl-composer-placeholder"
        role="textbox"
        aria-readonly
        aria-label={placeholder}
        style={{ display: "flex", alignItems: "center", height: 40, padding: "0 14px", borderRadius: 11, border: "1px solid var(--color-rule-strong)", color: "var(--color-ink-4)", fontSize: 13.5 }}
      >
        {placeholder}
      </div>
    </div>
  );
}
