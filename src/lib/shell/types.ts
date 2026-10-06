// SPDX-License-Identifier: Apache-2.0
export interface AgentShellLaunch {
  cwd: string | null; prompt: string; sessionId?: string; permissionMode: "plan" | "default" | "acceptEdits" | "auto";
  model?: string | null; effort?: string | null; addDirs?: string[]; launchId?: string; settingsPath?: string; restore?: boolean; restorePrimed?: boolean; restoreRescinded?: boolean; backend?: "claude-code" | "codex";
}
export interface ShellEvent { seq: number; kind: string; data: Record<string, unknown> }
export interface ShellInfo { driverId?: string; id: string; sessionId: string; cwd: string; alive: boolean; busy: boolean; raw: boolean }
export interface ShellBatch { events: ShellEvent[]; alive: boolean; busy: boolean }
export type ShellBlock = { id: string; kind: "user" | "text" | "explore" | "command" | "diff" | "todo" | "agent" | "plan" | "permission" | "context" | "error" | "status"; text?: string; tool?: string; input?: Record<string, unknown>; output?: unknown; children?: ShellBlock[]; event?: ShellEvent; done?: boolean; requestId?: string; resolved?: boolean; suggestions?: unknown[] };
