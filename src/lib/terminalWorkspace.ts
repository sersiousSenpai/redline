// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { AttentionAck } from "./termState";

/** The dock layout is worth restoring only while its shells live. A webview
 *  reload (Cmd+R, HMR, the WebContent-crash reload) keeps the PTYs in the Rust
 *  process and must reattach them; a quit kills every PTY, so restoring the
 *  layout would respawn a fleet of blank shells. sessionStorage is exactly that
 *  discriminator — it survives a reload and dies with the process, the same
 *  signal `BOOT_PLAYED_KEY` uses to avoid replaying the boot. */
export const TERMINAL_WORKSPACE_KEY = "redline.terminalWorkspace.v1";

export interface TerminalTabState {
  id: string;
  cwd: string | null;
  placeholder?: boolean;
}

export interface TerminalWorkspace {
  tabs: TerminalTabState[];
  tiles: readonly string[];
  focusedTile: number;
  zoomedId: string | null;
  /** Terminals pinned to the wall: parking never takes their tile. Absent in
   *  layouts saved before pins existed, and when nothing is pinned. */
  pinned?: string[];
  /** Local acknowledgements of attention transitions (lib/termState), so a
   *  your-turn read before a reload doesn't light up again after it. */
  acks?: Record<string, AttentionAck>;
}

const ACK_KINDS = new Set<AttentionAck["as"]>(["working", "seen", "cleared"]);

export interface LivePty {
  id: string;
  cwd: string | null;
  pid: number | null;
  alive: boolean;
}

/** Treat persisted layout as untrusted: a stale tile must never strand a
 *  terminal behind an empty grid or send an undefined id to App. */
export function parseTerminalWorkspace(
  value: unknown,
  maxTiles: number,
): TerminalWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<TerminalWorkspace>;
  if (!Array.isArray(saved.tabs)) return null;
  const ids = new Set<string>();
  const tabs: TerminalTabState[] = [];
  for (const tab of saved.tabs) {
    if (!tab || typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) continue;
    if (tab.cwd !== null && typeof tab.cwd !== "string") continue;
    ids.add(tab.id);
    tabs.push({ id: tab.id, cwd: tab.cwd, ...(tab.placeholder === true ? { placeholder: true } : {}) });
  }
  if (!tabs.length) return null;
  const tiles = Array.isArray(saved.tiles)
    ? [...new Set(saved.tiles.filter((id) => typeof id === "string" && ids.has(id)))].slice(0, maxTiles)
    : [];
  if (!tiles.length) tiles.push(tabs[0].id);
  const focusedTile = typeof saved.focusedTile === "number" && Number.isInteger(saved.focusedTile)
    ? Math.max(0, Math.min(saved.focusedTile, tiles.length - 1))
    : 0;
  const pinned = Array.isArray(saved.pinned)
    ? [...new Set(saved.pinned.filter((id) => typeof id === "string" && ids.has(id)))]
    : [];
  const acks: Record<string, AttentionAck> = {};
  if (saved.acks && typeof saved.acks === "object") {
    for (const [id, ack] of Object.entries(saved.acks as Record<string, unknown>)) {
      const a = ack as Partial<AttentionAck> | null;
      if (!ids.has(id) || !a || typeof a.at !== "number" || !Number.isFinite(a.at)) continue;
      if (!a.as || !ACK_KINDS.has(a.as)) continue;
      acks[id] = { at: a.at, as: a.as };
    }
  }
  return {
    tabs,
    tiles,
    focusedTile,
    zoomedId: typeof saved.zoomedId === "string" && tiles.includes(saved.zoomedId) ? saved.zoomedId : null,
    ...(pinned.length ? { pinned } : {}),
    ...(Object.keys(acks).length ? { acks } : {}),
  };
}

export function readTerminalWorkspace(maxTiles: number): TerminalWorkspace | null {
  try {
    // Builds before the sessionStorage move left a layout here that outlives
    // its shells. Nothing reads it any more; drop it so it can't linger.
    localStorage.removeItem(TERMINAL_WORKSPACE_KEY);
  } catch {
    // Storage unavailable: there is nothing stale to clear either.
  }
  try {
    return parseTerminalWorkspace(JSON.parse(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY) ?? "null"), maxTiles);
  } catch {
    return null;
  }
}

export function saveTerminalWorkspace(workspace: TerminalWorkspace): void {
  try {
    sessionStorage.setItem(TERMINAL_WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    // Storage can be unavailable; the live terminals remain usable and the
    // backend inventory still offers them for recovery after a reload.
  }
}
