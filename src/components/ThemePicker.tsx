// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { THEMES } from "../theme/themes";
import type { ThemeName } from "../theme/themes";

interface ThemePickerProps {
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
}

// A small two-tone chip previewing a theme: the paper (bg) fill with an ink (fg)
// ring, so light/dark and contrast read at a glance. Mirrors the mode picker's
// status dot.
function Swatch({ bg, fg }: { bg: string; fg: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: "11px",
        height: "11px",
        borderRadius: "50%",
        background: bg,
        boxShadow: `inset 0 0 0 2px ${fg}`,
        border: "1px solid var(--color-rule)",
        flexShrink: 0,
      }}
    />
  );
}

// Compact dropdown matching ModeToggle: a trigger showing the current theme and
// a popover that previews each theme with a color swatch.
export function ThemePicker({ theme, onThemeChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = THEMES.find((t) => t.name === theme) ?? THEMES[0];

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
        title="Theme"
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
        <Swatch bg={current.base.bg} fg={current.base.fg} />
        {current.label}
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Theme"
          className="absolute right-0 z-50 rounded-md overflow-y-auto"
          style={{
            top: "calc(100% + 6px)",
            width: "200px",
            maxHeight: "300px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {THEMES.map((t) => {
            const selected = t.name === theme;
            return (
              <button
                key={t.name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  if (!selected) onThemeChange(t.name);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 flex items-center gap-2"
                style={{
                  background: selected
                    ? "var(--color-anchor-bg)"
                    : "transparent",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--color-rule)",
                }}
              >
                <Swatch bg={t.base.bg} fg={t.base.fg} />
                <span
                  className="font-sans"
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--color-ink)",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {t.label}
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
