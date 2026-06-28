// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { FONTS } from "../theme/fonts";
import type { FontName } from "../theme/fonts";
import { useMenuOverlay } from "./menuOverlay";

interface FontPickerProps {
  font: FontName;
  onFontChange: (name: FontName) => void;
}

// Compact dropdown matching ThemePicker: a trigger showing the current font
// (rendered in that font) and a popover that previews each option in its own
// typeface, so the look reads at a glance.
export function FontPicker({ font, onFontChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = FONTS.find((f) => f.name === font) ?? FONTS[0];

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

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
    <div ref={rootRef} data-tour="font" className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Font"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-sm px-2 py-0.5"
        style={{
          fontSize: "11px",
          fontFamily: current.stack,
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        <span aria-hidden style={{ fontSize: "12px", lineHeight: 1 }}>
          Aa
        </span>
        {current.label}
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Font"
          className="absolute right-0 z-50 rounded-md overflow-y-auto"
          style={{
            top: "calc(100% + 6px)",
            width: "220px",
            maxHeight: "320px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {FONTS.map((f) => {
            const selected = f.name === font;
            return (
              <button
                key={f.name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  if (!selected) onFontChange(f.name);
                  setOpen(false);
                }}
                className="rl-menu-item w-full text-left px-3 py-2 flex items-center gap-2"
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid var(--color-rule)",
                }}
              >
                <span
                  style={{
                    // Preview each option in its own face.
                    fontFamily: f.stack,
                    fontSize: "14px",
                    color: "var(--color-ink)",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {f.label}
                </span>
                {selected && (
                  <span
                    style={{ color: "var(--color-info)", fontSize: "11px" }}
                  >
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
