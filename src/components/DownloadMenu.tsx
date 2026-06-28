// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { useMenuOverlay } from "./menuOverlay";

interface DownloadMenuProps {
  /** Version whose export the menu offers ("what you see is what you save"). */
  version: number;
  /** Greyed out — the user is browsing files, not viewing a plan. */
  disabled?: boolean;
  /** Save the revision as a clean .md file. */
  onExportMarkdown: () => void;
  /** Save the revision as a Word .docx file. */
  onExportDocx: () => void;
}

const FORMATS = [
  { key: "md", label: "Markdown (.md)" },
  { key: "docx", label: "Word (.docx)" },
] as const;

// Compact caret dropdown matching ThemePicker: one Download trigger, a popover
// listing the export formats. Formats come from the adapter registry's two
// shipped adapters; extend FORMATS when a new adapter lands.
export function DownloadMenu({
  version,
  disabled = false,
  onExportMarkdown,
  onExportDocx,
}: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const pick = (key: (typeof FORMATS)[number]["key"]) => {
    setOpen(false);
    if (key === "md") onExportMarkdown();
    else onExportDocx();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={
          disabled
            ? "Switch to a plan session to download"
            : `Download v${version}`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-2.5 py-1 font-medium"
        style={{
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          color: "var(--color-ink)",
          fontSize: "12px",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        Download
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Download format"
          className="absolute right-0 z-50 rounded-md overflow-hidden"
          style={{
            top: "calc(100% + 6px)",
            width: "170px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {FORMATS.map((f, idx) => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              onClick={() => pick(f.key)}
              title={`Download v${version} as ${f.label}`}
              className="rl-menu-item w-full text-left px-3 py-2 font-sans"
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--color-ink)",
                cursor: "pointer",
                borderBottom:
                  idx < FORMATS.length - 1
                    ? "1px solid var(--color-rule)"
                    : "none",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
