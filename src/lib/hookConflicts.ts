// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Backend } from "./backendChoice";

export interface HookConflictIdentity { id: string; sourcePath: string; snapshot: string }
export interface HookConflict {
  identity: HookConflictIdentity;
  backend: Backend;
  event: string;
  installationKind: "direct" | "plugin" | "managed" | "wrapper";
  action: "removeHooks" | "disablePlugin" | "view";
  detail: string;
  command: string | null;
  pluginId: string | null;
}
export interface HookConflictScan {
  conflicts: HookConflict[];
  errors: { sourcePath: string; message: string }[];
  inactivePlugins: string[];
  /** The user's own Claude Code PermissionRequest hooks. They run beside the
   *  one behind the session stage's permission cards, and one that decides
   *  on its own can answer before a card does. Informational only. */
  permissionHooks?: { sourcePath: string; matcher: string | null; command: string }[];
}
export interface HookRemovalReport {
  results: { sourcePath: string; changed: boolean; backupPath: string | null; error: string | null }[];
  scan: HookConflictScan;
}
export const EMPTY_CONFLICT_SCAN: HookConflictScan = { conflicts: [], errors: [], inactivePlugins: [] };
