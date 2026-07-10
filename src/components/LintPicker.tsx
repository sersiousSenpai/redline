// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { LINTS } from "../theme/lint";
import type { LintName } from "../theme/lint";
import { useMenuOverlay } from "./menuOverlay";

interface LintPickerProps {
  lint: LintName;
  onLintChange: (name: LintName) => void;
}

// A row of neon swatches previewing a lint theme's token palette (or a muted
// "Aa" for Off), so the look reads at a glance — matching the FontPicker's
// preview-in-place style.
function Swatches({ colors }: { colors?: string[] }) {
  if (!colors || colors.length === 0) {
    return (
      <span
        aria-hidden
        style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
      >
        Aa
      </span>
    );
  }
  return (
    <span aria-hidden className="flex items-center gap-0.5">
      {colors.map((c) => (
        <span
          key={c}
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "9999px",
            background: c,
            boxShadow: `0 0 4px ${c}`,
          }}
        />
      ))}
    </span>
  );
}

// Compact dropdown matching FontPicker/ThemePicker: a trigger showing the
// current lint theme (with its swatches) and a popover listing each option with
// its palette preview + description.
export function LintPicker({ lint, onLintChange }: LintPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = LINTS.find((l) => l.name === lint) ?? LINTS[0];

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

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
    <div ref={rootRef} data-tour="lint" className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Plaintext linting — IDE-style token coloring"
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
        <Swatches colors={current.swatches} />
        {current.label}
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Plaintext linting"
          className="absolute right-0 z-50 rounded-md overflow-y-auto"
          style={{
            top: "calc(100% + 6px)",
            width: "240px",
            maxHeight: "320px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {LINTS.map((l) => {
            const selected = l.name === lint;
            return (
              <button
                key={l.name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  if (!selected) onLintChange(l.name);
                  setOpen(false);
                }}
                className="rl-menu-item w-full text-left px-3 py-2 flex items-start gap-2"
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid var(--color-rule)",
                }}
              >
                <span className="pt-0.5">
                  <Swatches colors={l.swatches} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    className="font-sans"
                    style={{
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "var(--color-ink)",
                      display: "block",
                    }}
                  >
                    {l.label}
                  </span>
                  <span
                    className="font-sans"
                    style={{
                      fontSize: "10px",
                      color: "var(--color-ink-muted)",
                      display: "block",
                      lineHeight: 1.3,
                    }}
                  >
                    {l.description}
                  </span>
                </span>
                {selected && (
                  <span style={{ color: "var(--color-info)", fontSize: "11px" }}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
