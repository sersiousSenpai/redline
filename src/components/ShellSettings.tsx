// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import { shellFlag, switchShell, type Shell } from "../lib/shellFlag";

/** Settings → Shell. Classic is the surface-first app as it has always been;
 *  Flow (beta) is the session-first one. The choice is read once per page
 *  load, so picking the other reloads the window into it — the terminals
 *  survive the reload (the dock re-adopts its live PTYs).
 *
 *  The flow shell's ⌘N and ⌘1–⌘4 live in the native menu, which outlives a
 *  reload: it is told before the page goes, so the classic shell never wakes
 *  up to accelerators it has no use for. */
export function ShellSettings() {
  const current = shellFlag();
  const choose = (next: Shell) => {
    if (next === current) return;
    void invoke("set_flow_menu", { enabled: next === "flow" })
      .catch(() => {
        /* No native menu here (a web preview): the reload is all there is. */
      })
      .finally(() => switchShell(next));
  };
  return (
    <select
      aria-label="Shell"
      title="Switching reloads the window"
      value={current}
      onChange={(e) => choose(e.target.value === "flow" ? "flow" : "classic")}
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
      <option value="classic">Classic</option>
      <option value="flow">Flow (beta)</option>
    </select>
  );
}
