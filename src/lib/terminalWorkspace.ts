// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { AttentionAck } from "./termState";

/** The terminals are worth restoring only while their shells live. A webview
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
  /** A name the user gave the terminal. */
  title?: string;
}

/** The terminals that outlive a reload, and what was read in them. Which
 *  wall shows which terminal is the workbench's (a terminals pane's data),
 *  not this file's. */
export interface TerminalWorkspace {
  tabs: TerminalTabState[];
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
  /** Held by the terminal helper: it outlived the last launch, or will. */
  kept?: boolean;
  /** Kept running after Redline quits (the close dialog's checkbox). */
  persist?: boolean;
  /** Where it belongs, as this app stored it (`pty_set_meta`). */
  meta?: KeptMeta;
  /** Unix ms its shell started (helper terminals). */
  startedAt?: number;
  /** A tombstone: the wait status of a shell that exited while nobody
   *  watched. */
  exit?: number;
}

/** What the app stores with a kept terminal so a relaunch can put it back:
 *  its owner (a workbench session key), name, session and harness. Untrusted
 *  on the way back in, like everything persisted. */
export interface KeptMeta {
  owner?: string;
  title?: string;
  sessionId?: string;
  harness?: "claude" | "codex";
}

export function parseKeptMeta(value: unknown): KeptMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => (typeof x === "string" && x ? x.slice(0, max) : undefined);
  const meta: KeptMeta = {};
  const owner = text(v.owner, 300);
  const title = text(v.title, 80);
  const sessionId = text(v.sessionId, 200);
  if (owner) meta.owner = owner;
  if (title) meta.title = title;
  if (sessionId) meta.sessionId = sessionId;
  if (v.harness === "claude" || v.harness === "codex") meta.harness = v.harness;
  return Object.keys(meta).length ? meta : null;
}

/** A launch with nothing to restore from sessionStorage (a quit, not a
 *  reload): the terminals the helper kept become the tabs again, in the
 *  order they started, named as they were. Tombstones and in-process
 *  terminals are not adopted (an in-process one outliving its page is a
 *  reload's business and keeps the Reattach banner). */
export function adoptKept(list: readonly LivePty[], owned: ReadonlySet<string>): TerminalTabState[] {
  return list
    .filter((pty) => pty.kept && pty.alive && !owned.has(pty.id))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((pty) => {
      const title = parseKeptMeta(pty.meta)?.title;
      return { id: pty.id, cwd: pty.cwd, ...(title ? { title } : {}) };
    });
}

/** Treat persisted state as untrusted: a malformed tab must never send an
 *  undefined id to App. A layout saved by an older build (tiles, focus,
 *  zoom, pins) is read past: walls live in the workbench now. */
export function parseTerminalWorkspace(value: unknown): TerminalWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<TerminalWorkspace>;
  if (!Array.isArray(saved.tabs)) return null;
  const ids = new Set<string>();
  const tabs: TerminalTabState[] = [];
  for (const tab of saved.tabs) {
    if (!tab || typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) continue;
    if (tab.cwd !== null && typeof tab.cwd !== "string") continue;
    ids.add(tab.id);
    tabs.push({
      id: tab.id,
      cwd: tab.cwd,
      ...(tab.placeholder === true ? { placeholder: true } : {}),
      ...(typeof tab.title === "string" && tab.title ? { title: tab.title.slice(0, 80) } : {}),
    });
  }
  if (!tabs.length) return null;
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
    ...(Object.keys(acks).length ? { acks } : {}),
  };
}

export function readTerminalWorkspace(): TerminalWorkspace | null {
  try {
    // Builds before the sessionStorage move left a layout here that outlives
    // its shells. Nothing reads it any more; drop it so it can't linger.
    localStorage.removeItem(TERMINAL_WORKSPACE_KEY);
  } catch {
    // Storage unavailable: there is nothing stale to clear either.
  }
  try {
    return parseTerminalWorkspace(JSON.parse(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY) ?? "null"));
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
