// FLOW PLACEHOLDER — owned by convo-ui
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Stand-in for convo-ui's mirrored conversation, so the stage lane builds
//! and its fixture renders against the agreed seam (BRIEF, "Component
//! seams"). The integrator keeps convo-ui's file. It renders the props it was
//! handed and the plan cards the stage supplies, nothing more.

import type { CSSProperties } from "react";

import { PlanReadyCard } from "./PlanReadyCard";

export interface SessionConversationProps {
  terminalId: string | null;
  sessionId: string | null;
  harness: "claude" | "codex";
  layout: "stage" | "column" | "panel";
  planTitle?: string | null;
  planMarks?: number;
  planOpen: boolean;
  onOpenPlan: () => void;
  onShowTerminal: () => void;
}

const COLUMN: Record<SessionConversationProps["layout"], CSSProperties> = {
  stage: { width: 720, maxWidth: "100%", margin: "0 auto", padding: "36px 0 0" },
  column: { padding: "28px 26px 0" },
  panel: { padding: "14px" },
};

export default function SessionConversation(p: SessionConversationProps) {
  return (
    <div
      className="rl-convo-placeholder"
      data-layout={p.layout}
      data-terminal={p.terminalId ?? ""}
      style={{ flex: 1, minHeight: 0, overflow: "auto", color: "var(--color-ink-2)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18, ...COLUMN[p.layout] }}>
        {p.planTitle && (
          <PlanReadyCard
            variant={p.planOpen ? "ready" : "inline"}
            title={p.planTitle}
            marks={p.planMarks ?? 0}
            summary={null}
            onOpen={p.onOpenPlan}
          />
        )}
      </div>
    </div>
  );
}
