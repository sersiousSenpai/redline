// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { AUTO_SAVE_MODES, useAutoSaveMode, type AutoSaveMode } from "../lib/autoSave";

const control = {
  height: 24,
  padding: "0 6px",
  borderRadius: "var(--rl-radius-chip)",
  border: "1px solid var(--color-rule)",
  background: "var(--color-fill-1)",
  color: "var(--color-ink)",
  fontSize: "var(--rl-text-xs)",
} as const;

/** Settings → Auto-save: when the file pane's editor writes on its own.
 *  Applied live to every open editor (lib/autoSave's mode event). */
export function AutoSaveSetting() {
  const [mode, setMode] = useAutoSaveMode();
  return (
    <select
      aria-label="Auto-save"
      title="When an edited file saves itself. A file that changed on disk always waits for ⌘S."
      value={mode}
      onChange={(e) => setMode(e.target.value as AutoSaveMode)}
      style={control}
    >
      {AUTO_SAVE_MODES.map((m) => (
        <option key={m.mode} value={m.mode}>{m.label}</option>
      ))}
    </select>
  );
}
