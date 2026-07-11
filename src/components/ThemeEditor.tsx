// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenuOverlay } from "./menuOverlay";
import { deriveTokens } from "../theme/derive";
import type { ThemeBase } from "../theme/derive";
import { applyTheme } from "../theme/applyTheme";
import { getTheme } from "../theme/themes";
import type { ThemeName } from "../theme/themes";

// The live theme editor — GUI–file duality for colors. Tweak the active
// theme's six base colors with instant whole-app preview (the same
// deriveTokens pipeline applyTheme uses, applied inline without touching the
// pre-paint cache), then "Save as my theme" writes a plain JSON file to
// ~/.redline/themes/<slug>.json — the exact format a hand-authored theme
// uses, so the saved file doubles as a worked example of the schema. Closing
// without saving reverts to the active theme.

const BASE_FIELDS: { key: keyof ThemeBase; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "blue", label: "Blue — info / edit" },
  { key: "yellow", label: "Yellow — warning" },
  { key: "green", label: "Green — success" },
  { key: "selection", label: "Accent — the redline" },
];

/** `<input type="color">` accepts only #rrggbb — normalize the 3/4/8-digit
 *  forms a hand-written theme may carry. */
function toHex6(hex: string): string {
  const h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3,4}$/.test(h)) {
    return (
      "#" +
      h
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  }
  if (/^[0-9a-fA-F]{6,8}$/.test(h)) return "#" + h.slice(0, 6);
  return "#000000";
}

/** Preview-apply a base without persisting anything: same derived tokens as
 *  applyTheme, but no localStorage write and no data-theme change, so the
 *  pre-paint cache still replays the real theme if the app relaunches
 *  mid-edit. */
function previewBase(base: ThemeBase): void {
  const tokens = deriveTokens(base);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${key}`, value);
  }
}

export function ThemeEditor({
  theme,
  onSaved,
}: {
  /** The active theme — the editing baseline. */
  theme: ThemeName;
  /** A user theme file was written; the app refreshes the registry and
   *  switches to the new theme. */
  onSaved: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState<ThemeBase | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // True while a save is switching themes — skip the revert-on-close.
  const savedRef = useRef(false);

  useMenuOverlay(open);

  // Opening seeds the working copy from the active theme; closing without a
  // save reverts the preview to it.
  useEffect(() => {
    if (!open) return;
    savedRef.current = false;
    const entry = getTheme(theme);
    setBase({ ...entry.base });
    setName(entry.user ? entry.label : `My ${entry.label}`);
    setError(null);
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
      if (!savedRef.current) applyTheme(theme);
    };
  }, [open, theme]);

  const edit = (key: keyof ThemeBase, value: string) => {
    setBase((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      previewBase(next);
      return next;
    });
  };

  const save = async () => {
    if (!base) return;
    setSaving(true);
    setError(null);
    try {
      const json = JSON.stringify(
        { label: name.trim() || "My theme", base },
        null,
        2,
      );
      const slug = await invoke<string>("save_user_theme", {
        name: name.trim() || "my-theme",
        json,
      });
      savedRef.current = true;
      setOpen(false);
      onSaved(slug);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Edit the active theme's colors"
        aria-label="Edit the active theme's colors"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="font-sans rounded-sm px-1.5 py-0.5"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        ✎
      </button>
      {open && base && (
        <div
          role="dialog"
          aria-label="Theme editor"
          className="absolute right-0 z-50 rounded-md"
          style={{
            top: "calc(100% + 6px)",
            width: "250px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {BASE_FIELDS.map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center justify-between gap-2 px-3 py-1.5 font-sans"
              style={{
                fontSize: "11px",
                color: "var(--color-ink)",
                borderBottom: "1px solid var(--color-rule)",
                cursor: "pointer",
              }}
            >
              <span>{label}</span>
              <span className="flex items-center gap-1.5">
                <span
                  className="font-mono"
                  style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
                >
                  {base[key]}
                </span>
                <input
                  type="color"
                  aria-label={label}
                  value={toHex6(base[key])}
                  onChange={(e) => edit(key, e.target.value)}
                  style={{
                    width: "24px",
                    height: "18px",
                    padding: 0,
                    border: "1px solid var(--color-rule)",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                />
              </span>
            </label>
          ))}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: "1px solid var(--color-rule)" }}
          >
            <input
              type="text"
              aria-label="Theme name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key !== "Escape") e.stopPropagation();
              }}
              placeholder="Theme name"
              className="font-sans flex-1 min-w-0 rounded-sm px-1.5 py-0.5"
              style={{
                fontSize: "11px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
              }}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="font-sans rounded-sm px-2 py-0.5"
              style={{
                fontSize: "11px",
                fontWeight: 600,
                border: "1px solid var(--color-rule)",
                background: "var(--color-anchor-bg)",
                color: "var(--color-anchor-text)",
                cursor: saving ? "default" : "pointer",
              }}
            >
              Save as my theme
            </button>
          </div>
          <div
            className="px-3 py-2 font-sans"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {error ??
              "Writes ~/.redline/themes/<name>.json — same format as a hand-authored theme."}
          </div>
        </div>
      )}
    </div>
  );
}
