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
}
export interface HookRemovalReport {
  results: { sourcePath: string; changed: boolean; backupPath: string | null; error: string | null }[];
  scan: HookConflictScan;
}
export const EMPTY_CONFLICT_SCAN: HookConflictScan = { conflicts: [], errors: [], inactivePlugins: [] };
