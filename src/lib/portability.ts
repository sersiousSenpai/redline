// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure types + helpers for the Phase 4 portability surface (memory mirror,
// export bundle, MCP snippet). Kept free of React/Tauri so they unit-test
// cleanly; the modal (`PortabilitySettings.tsx`) owns the `invoke` calls.

/** Mirror status as returned by the `mirror_status` command (camelCase). */
export interface MirrorStatus {
  /** The chosen directory, or null when the mirror is off. */
  dir: string | null;
  enabled: boolean;
  /** Highest ledger seq mirrored so far. */
  lastSeq: number;
  /** Total ledger events (so we can show "N of M mirrored"). */
  totalEvents: number;
  /** Count of `.md` notes on disk under the managed subdirs. */
  noteCount: number;
}

/** The `mcp_config_snippet` command's shape. */
export interface McpConfig {
  binPath: string;
  snippet: string;
}

/** The scopes `export_context_bundle` accepts. */
export type BundleScope = "session" | "mission" | "class" | "full";

/** Human label for an export scope. */
export function scopeLabel(scope: BundleScope): string {
  switch (scope) {
    case "session":
      return "This plan";
    case "mission":
      return "This mission";
    case "class":
      return "This class";
    case "full":
      return "Everything";
  }
}

/**
 * A one-line status summary for the mirror. Off when no directory is chosen;
 * otherwise "N of M events mirrored" with a caught-up flag.
 */
export function mirrorSummary(status: MirrorStatus | null): string {
  if (!status || !status.enabled || !status.dir) {
    return "Off — choose a folder to start mirroring your memory as markdown.";
  }
  if (status.totalEvents === 0) {
    return "On — no ledger events yet; notes appear as you capture prompts.";
  }
  if (status.lastSeq >= status.totalEvents) {
    return `On — all ${status.totalEvents} events mirrored (${status.noteCount} notes).`;
  }
  return `On — ${status.lastSeq} of ${status.totalEvents} events mirrored (${status.noteCount} notes).`;
}

/** True when the mirror has fallen behind the ledger (a Sync would catch up). */
export function mirrorIsBehind(status: MirrorStatus | null): boolean {
  return (
    !!status &&
    status.enabled &&
    !!status.dir &&
    status.totalEvents > status.lastSeq
  );
}
