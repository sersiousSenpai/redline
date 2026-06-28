// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import type { SoundConfig } from "../audio/beep";
import { SoundPicker } from "./SoundPicker";
import { useMenuOverlay } from "./menuOverlay";

interface AlertSettingsProps {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  color: string;
  onColorChange: (next: string) => void;
  sound: boolean;
  onSoundChange: (next: boolean) => void;
  soundConfig: SoundConfig;
  onSoundConfigChange: (next: SoundConfig) => void;
  /** Preview a specific sound voice (used by the synth picker on release). */
  onSoundPreview: (config: SoundConfig) => void;
  /** Preview the flash + (if enabled) sound without waiting for an intercept. */
  onTest: () => void;
}

// Header control: a small bell button that toggles a popover for the
// flash-on-intercept alert preferences. Closes on outside-click / Escape.
export function AlertSettings({
  enabled,
  onEnabledChange,
  color,
  onColorChange,
  sound,
  onSoundChange,
  soundConfig,
  onSoundConfigChange,
  onSoundPreview,
  onTest,
}: AlertSettingsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div ref={rootRef} className="relative" data-no-drag="true">
      <button
        type="button"
        aria-label="Intercept alert settings"
        aria-expanded={open}
        title="Flash / sound when a plan is intercepted"
        onClick={() => setOpen((v) => !v)}
        className="rounded-sm px-2 py-0.5 font-sans"
        style={{
          fontSize: "13px",
          lineHeight: "16px",
          cursor: "pointer",
          background: enabled ? "var(--color-info)" : "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          color: enabled ? "#fff" : "var(--color-ink-muted)",
        }}
      >
        {/* bell glyph */}
        🔔
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 rounded-sm p-3 flex flex-col gap-2.5"
          style={{
            zIndex: 50,
            width: "220px",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            boxShadow: "0 6px 24px var(--color-overlay)",
            fontSize: "12px",
          }}
        >
          <label className="rl-hover-wash rounded-sm px-1 -mx-1 flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
            />
            <span>Flash on intercept</span>
          </label>

          {enabled && (
            <label className="rl-hover-wash rounded-sm px-1 -mx-1 flex items-center justify-between gap-2 cursor-pointer">
              <span style={{ color: "var(--color-ink-muted)" }}>Color</span>
              <input
                type="color"
                value={color}
                onChange={(e) => onColorChange(e.target.value)}
                style={{
                  width: "32px",
                  height: "20px",
                  padding: 0,
                  border: "1px solid var(--color-rule)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              />
            </label>
          )}

          <label className="rl-hover-wash rounded-sm px-1 -mx-1 flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => onSoundChange(e.target.checked)}
            />
            <span>Play sound</span>
          </label>

          {sound && (
            <SoundPicker
              config={soundConfig}
              onChange={onSoundConfigChange}
              onPreview={onSoundPreview}
            />
          )}

          <button
            type="button"
            onClick={onTest}
            className="rl-btn-anchor rounded-sm px-2 py-1 font-medium self-start"
            style={{
              color: "var(--color-anchor-text)",
              border: "1px solid var(--color-rule)",
              cursor: "pointer",
              fontSize: "11px",
            }}
          >
            Test
          </button>
        </div>
      )}
    </div>
  );
}
