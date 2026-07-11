// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { useMenuOverlay } from "./menuOverlay";
import {
  currentLanding,
  setLanding,
  setSurfaceEnabled,
  surfaceEnabled,
  MAIN_SURFACE_DESCRIPTORS,
  SURFACE_LABELS,
  TOGGLEABLE_SURFACES,
} from "../config/workspace";
import type { Landing, Workspace } from "../config/workspace";

// The Surfaces panel — the settings-menu lens on ~/.redline/workspace.json.
// Checkboxes enable/disable surfaces (same store the header's right-click
// "Hide" writes, so a hidden surface comes back here), and the landing picker
// chooses where the app opens. The file stays the single store: every change
// funnels through App's updateWorkspace, which rewrites the manifest.

export function SurfacesPanel({
  workspace,
  onUpdate,
}: {
  workspace: Workspace;
  onUpdate: (fn: (ws: Workspace) => Workspace) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="font-sans rounded-sm px-2 py-0.5"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        Configure ▾
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Surfaces"
          className="absolute right-0 z-50 rounded-md"
          style={{
            top: "calc(100% + 6px)",
            width: "240px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          <div
            className="px-3 py-2 font-sans"
            style={{
              fontSize: "10px",
              color: "var(--color-ink-muted)",
              borderBottom: "1px solid var(--color-rule)",
            }}
          >
            Which surfaces this Redline carries.
          </div>
          {TOGGLEABLE_SURFACES.map((id) => (
            <label
              key={id}
              className="flex items-center gap-2 px-3 py-1.5 font-sans"
              style={{
                fontSize: "11px",
                color: "var(--color-ink)",
                borderBottom: "1px solid var(--color-rule)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={surfaceEnabled(workspace, id)}
                onChange={(e) =>
                  onUpdate((ws) => setSurfaceEnabled(ws, id, e.target.checked))
                }
              />
              <span>{SURFACE_LABELS[id]}</span>
            </label>
          ))}
          <div
            className="flex items-center justify-between gap-2 px-3 py-2 font-sans"
            style={{
              fontSize: "11px",
              color: "var(--color-ink)",
              borderBottom: "1px solid var(--color-rule)",
            }}
          >
            <span style={{ color: "var(--color-ink-muted)", fontWeight: 600 }}>
              Open on launch
            </span>
            <select
              aria-label="Landing surface"
              value={currentLanding(workspace)}
              onChange={(e) =>
                onUpdate((ws) => setLanding(ws, e.target.value as Landing))
              }
              style={{
                fontSize: "11px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                borderRadius: "3px",
                padding: "2px 4px",
              }}
            >
              <option value="last">Where you left off</option>
              {MAIN_SURFACE_DESCRIPTORS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div
            className="px-3 py-2 font-sans"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            Saved to ~/.redline/workspace.json — the file is yours to edit or
            fork.
          </div>
        </div>
      )}
    </div>
  );
}
