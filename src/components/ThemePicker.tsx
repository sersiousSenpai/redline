// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { THEMES } from "../theme/themes";
import type { ThemeName } from "../theme/themes";

interface ThemePickerProps {
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
}

export function ThemePicker({ theme, onThemeChange }: ThemePickerProps) {
  return (
    <label
      className="flex items-center gap-1.5"
      style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Theme
      </span>
      <select
        value={theme}
        onChange={(e) => onThemeChange(e.target.value as ThemeName)}
        className="rounded-sm px-1.5 py-0.5"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          border: "1px solid var(--color-rule)",
        }}
        title="Terminal color theme"
      >
        {THEMES.map((t) => (
          <option key={t.name} value={t.name}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
