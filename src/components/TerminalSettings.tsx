// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTerminalPrefs, writeTerminalPrefs, type TerminalPrefs } from "../lib/terminalPrefs";

interface KeepSettings {
  helper: boolean;
  helperActive: boolean;
  keepOnQuit: boolean;
  askOnQuit: boolean;
}

// "" = the app's own mono font; the rest are faces macOS ships or a developer
// is likely to have. A family that is not installed falls back to the next.
const FAMILIES: { label: string; value: string }[] = [
  { label: "App font", value: "" },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, Menlo, monospace' },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Monaco", value: "Monaco, monospace" },
  { label: "JetBrains Mono", value: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", ui-monospace, Menlo, monospace' },
];
const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5];

const control = {
  height: 24,
  padding: "0 6px",
  borderRadius: "var(--rl-radius-chip)",
  border: "1px solid var(--color-rule)",
  background: "var(--color-fill-1)",
  color: "var(--color-ink)",
  fontSize: "var(--rl-text-xs)",
} as const;

/** Settings → Terminal: family, size and line height, applied live to every
 *  open terminal (TerminalView listens for the prefs event); and whether
 *  terminals keep running after Redline quits (the terminal helper). */
export function TerminalSettings() {
  const [prefs, setPrefs] = useState(readTerminalPrefs);
  const [keep, setKeep] = useState<KeepSettings | null>(null);
  useEffect(() => {
    let gone = false;
    void invoke<KeepSettings>("terminal_settings").then((s) => { if (!gone && s) setKeep(s); }).catch(() => {});
    return () => { gone = true; };
  }, []);
  const toggleKeep = (on: boolean) => {
    setKeep((k) => (k ? { ...k, keepOnQuit: on } : k));
    void invoke("set_terminal_setting", { key: "keepOnQuit", on }).catch(() => {});
  };
  const change = (patch: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeTerminalPrefs(next);
  };
  const known = FAMILIES.some((f) => f.value === prefs.family);
  return (
    <div className="flex flex-col gap-1.5">
    <div className="flex items-center gap-1.5">
      <select
        aria-label="Terminal font"
        value={prefs.family}
        onChange={(e) => change({ family: e.target.value })}
        style={{ ...control, maxWidth: 112 }}
      >
        {!known && <option value={prefs.family}>{prefs.family}</option>}
        {FAMILIES.map((f) => (
          <option key={f.label} value={f.value}>{f.label}</option>
        ))}
      </select>
      <input
        aria-label="Terminal font size"
        type="number"
        min={10}
        max={28}
        value={prefs.size}
        onChange={(e) => {
          const size = Number(e.target.value);
          if (Number.isFinite(size) && size >= 10 && size <= 28) change({ size });
        }}
        style={{ ...control, width: 44 }}
      />
      <select
        aria-label="Terminal line height"
        value={String(prefs.lineHeight)}
        onChange={(e) => change({ lineHeight: Number(e.target.value) })}
        style={{ ...control, width: 52 }}
      >
        {!LINE_HEIGHTS.includes(prefs.lineHeight) && (
          <option value={String(prefs.lineHeight)}>{prefs.lineHeight}</option>
        )}
        {LINE_HEIGHTS.map((h) => (
          <option key={h} value={String(h)}>{h.toFixed(1)}</option>
        ))}
      </select>
    </div>
    {keep && keep.helper && (
      <label
        className="flex items-center gap-1.5"
        style={{ fontSize: "var(--rl-text-xs)", color: "var(--color-ink)" }}
        title={keep.helperActive ? "Quit keeps terminals running; Quit and Stop Terminals (⌥⌘Q) ends them. Off: quitting ends every terminal." : "The terminal helper could not start this time, so terminals close with Redline until it relaunches."}
      >
        <input type="checkbox" checked={keep.keepOnQuit} onChange={(e) => toggleKeep(e.target.checked)} />
        Keep terminals running after Redline quits
      </label>
    )}
    </div>
  );
}
