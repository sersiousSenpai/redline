// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";

interface MissionStartDialogProps {
  onStart: (title: string, goal: string) => void;
  onCancel: () => void;
}

/** "What are we trying to accomplish?" — captures a mission's goal up front so
 *  the orchestrator starts grounded instead of spending a round-trip asking.
 *  Title is optional (the backend falls back to the goal's first line). */
export function MissionStartDialog({ onStart, onCancel }: MissionStartDialogProps) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const canStart = goal.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg flex flex-col gap-3 p-5"
        style={{
          width: "min(28rem, 92vw)",
          background: "var(--color-paper)",
          border: "1px solid var(--color-rule)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: "16px" }}>🎯</span>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)" }}>
            Start a mission
          </span>
        </div>
        <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
          Set one goal for your research. As you browse and discuss pages, an
          orchestrator watches every tab, gathers what you pin, and helps you
          synthesize it all toward this goal.
        </p>
        <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
          Title <span style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Data-breach practice page"
          className="rounded px-2 py-1.5"
          style={{
            fontSize: "13px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
          }}
        />
        <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
          What are we trying to accomplish?
        </label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus
          placeholder="e.g. Draft a data-breach practice-area page for my law firm — study how other firms present theirs (structure, tone, imagery) and pull together what works."
          rows={4}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canStart) {
              onStart(title, goal);
            }
          }}
          className="rounded px-2 py-1.5"
          style={{
            fontSize: "13px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-paper)",
            color: "var(--color-ink)",
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onStart(title, goal)}
            disabled={!canStart}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              opacity: canStart ? 1 : 0.5,
              cursor: canStart ? "pointer" : "default",
            }}
          >
            Start mission 🎯
          </button>
        </div>
      </div>
    </div>
  );
}
