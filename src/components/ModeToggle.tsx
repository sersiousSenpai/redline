// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import type { InterceptionMode } from "../types";

interface ModeToggleProps {
  mode: InterceptionMode;
  onChange: (mode: InterceptionMode) => void;
}

const OPTIONS: {
  value: InterceptionMode;
  label: string;
  /** Short subtitle shown in the dropdown so the mode is self-explanatory. */
  desc: string;
  /** Status-dot color, also shown on the trigger for the active mode. */
  color: string;
}[] = [
  {
    value: "active",
    label: "Active",
    desc: "Hold every plan for review.",
    color: "var(--color-info)",
  },
  {
    value: "ambient",
    label: "Ambient",
    desc: "Auto-approve unless you open it.",
    color: "var(--color-warning)",
  },
  {
    value: "paused",
    label: "Paused",
    desc: "Pass every plan straight through.",
    color: "var(--color-ink-muted)",
  },
];

// Compact dropdown mirroring the daemon's interception mode — a trigger that
// shows the current mode and a popover that explains each one. The tray menu
// drives the same state; both stay in sync via the `mode-changed` event.
export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = OPTIONS.find((o) => o.value === mode) ?? OPTIONS[0];

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Interception mode"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: current.color,
            flexShrink: 0,
          }}
        />
        {current.label}
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Interception mode"
          className="absolute left-0 z-50 rounded-md overflow-hidden"
          style={{
            top: "calc(100% + 6px)",
            width: "224px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {OPTIONS.map((opt) => {
            const selected = opt.value === mode;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  if (!selected) onChange(opt.value);
                  setOpen(false);
                }}
                className="rl-menu-item w-full text-left px-3 py-2 flex items-start gap-2"
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid var(--color-rule)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: "7px",
                    height: "7px",
                    borderRadius: "50%",
                    background: opt.color,
                    marginTop: "4px",
                    flexShrink: 0,
                  }}
                />
                <span className="flex flex-col" style={{ minWidth: 0 }}>
                  <span
                    className="font-sans"
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--color-ink)",
                    }}
                  >
                    {opt.label}
                    {selected && (
                      <span
                        style={{
                          color: "var(--color-info)",
                          marginLeft: "6px",
                          fontSize: "11px",
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: "10.5px",
                      color: "var(--color-ink-muted)",
                      lineHeight: 1.35,
                    }}
                  >
                    {opt.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
