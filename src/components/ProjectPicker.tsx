// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMenuOverlay } from "./menuOverlay";

export interface ProjectOption {
  /** Absolute directory path. */
  path: string;
  /** Display label (basename / project name). */
  name: string;
  /** Where it came from, for the muted source hint. */
  source: "session" | "folder";
}

interface ProjectPickerProps {
  options: ProjectOption[];
  /** Selected project dir, or null for "Home (~)". */
  value: string | null;
  onChange: (path: string | null) => void;
  /** Re-focus the editor after the native folder dialog steals focus. */
  onAfterPick?: () => void;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return trimmed.slice(idx + 1) || path;
}

// A small DOM dropdown of candidate project directories: review sessions and
// open folder workspaces (deduped by path), a Home fallback, plus a native
// "Browse…" folder picker. Gated through `useMenuOverlay` so the native browser
// webview hides while the menu is open (same as the header dropdowns).
export function ProjectPicker({
  options,
  value,
  onChange,
  onAfterPick,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMenuOverlay(open);

  // Dedupe by normalized path; sessions win over folders on a tie.
  const merged = useMemo(() => {
    const seen = new Map<string, ProjectOption>();
    for (const opt of options) {
      const key = opt.path.replace(/\/+$/, "") || "/";
      if (!seen.has(key)) seen.set(key, opt);
    }
    return [...seen.values()];
  }, [options]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const label =
    value === null ? "Home (~)" : basename(value);

  const browse = async () => {
    setOpen(false);
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") onChange(picked);
    } catch {
      /* user cancelled or dialog unavailable */
    } finally {
      onAfterPick?.();
    }
  };

  return (
    <div ref={rootRef} data-no-drag="true" style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Choose the project to launch the plan in"
        className="flex items-center gap-1 rounded-sm px-2"
        style={{
          height: "30px",
          maxWidth: "220px",
          fontSize: "12px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        <span style={{ opacity: 0.7 }}>📁</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span style={{ opacity: 0.6, fontSize: "10px" }}>▾</span>
      </button>
      {open && (
        <div
          className="rl-thin-scroll-y"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            minWidth: "240px",
            maxHeight: "320px",
            overflowY: "auto",
            zIndex: 50,
            border: "1px solid var(--color-rule)",
            borderRadius: "6px",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 6px 24px rgba(0,0,0,0.3)",
            padding: "4px",
          }}
        >
          <MenuRow
            label="Home (~)"
            selected={value === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          />
          {merged.length > 0 && <RowDivider />}
          {merged.map((opt) => (
            <MenuRow
              key={opt.path}
              label={opt.name}
              hint={opt.source === "session" ? "session" : "open folder"}
              selected={
                (value?.replace(/\/+$/, "") || "") ===
                (opt.path.replace(/\/+$/, "") || "")
              }
              onClick={() => {
                onChange(opt.path);
                setOpen(false);
              }}
            />
          ))}
          <RowDivider />
          <MenuRow label="📁 Browse…" onClick={browse} />
        </div>
      )}
    </div>
  );
}

function RowDivider() {
  return (
    <div
      aria-hidden
      style={{ height: "1px", background: "var(--color-rule)", margin: "4px 0" }}
    />
  );
}

function MenuRow({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover-elevated"
      style={{
        fontSize: "12px",
        background: selected ? "var(--color-anchor-bg)" : "transparent",
        color: selected ? "var(--color-anchor-text)" : "var(--color-ink)",
        cursor: "pointer",
        border: "none",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {hint && (
        <span style={{ opacity: 0.5, fontSize: "10px", flexShrink: 0 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
