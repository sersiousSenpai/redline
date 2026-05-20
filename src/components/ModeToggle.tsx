// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { InterceptionMode } from "../types";

interface ModeToggleProps {
  mode: InterceptionMode;
  onChange: (mode: InterceptionMode) => void;
}

const OPTIONS: {
  value: InterceptionMode;
  label: string;
  title: string;
}[] = [
  {
    value: "active",
    label: "Active",
    title: "Hold every plan for full review (blocks Claude until you decide).",
  },
  {
    value: "ambient",
    label: "Ambient",
    title:
      "Surface plans but auto-approve after a short window unless you open one for review.",
  },
  {
    value: "paused",
    label: "Paused",
    title: "Killswitch — pass every plan straight through, capture nothing.",
  },
];

// Segmented control mirroring the daemon's interception mode. The tray menu
// drives the same state; both stay in sync via the `mode-changed` event.
export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div
      className="flex rounded-sm overflow-hidden"
      style={{ border: "1px solid var(--color-rule)" }}
      role="radiogroup"
      aria-label="Interception mode"
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === mode;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={opt.title}
            onClick={() => !selected && onChange(opt.value)}
            className="px-2 py-0.5 font-sans"
            style={{
              fontSize: "11px",
              cursor: selected ? "default" : "pointer",
              background: selected
                ? "var(--color-info)"
                : "var(--color-bg-elevated)",
              color: selected ? "#fff" : "var(--color-ink-muted)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
