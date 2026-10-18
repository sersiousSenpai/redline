// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { setTransparencyPreference, transparencyPreference } from "../lib/transparency";

/** Settings → Transparency. Auto follows macOS's Reduce Transparency and
 *  Increase Contrast; Always solid turns every glass tier opaque regardless. */
export function TransparencySettings() {
  const [value, setValue] = useState(transparencyPreference);
  return (
    <select
      aria-label="Transparency"
      value={value}
      onChange={(e) => {
        const next = e.target.value === "solid" ? "solid" : "auto";
        setValue(next);
        setTransparencyPreference(next);
      }}
      style={{
        height: 24,
        padding: "0 6px",
        borderRadius: "var(--rl-radius-chip)",
        border: "1px solid var(--color-rule)",
        background: "var(--color-fill-1)",
        color: "var(--color-ink)",
        fontSize: "var(--rl-text-xs)",
      }}
    >
      <option value="auto">Auto</option>
      <option value="solid">Always solid</option>
    </select>
  );
}
