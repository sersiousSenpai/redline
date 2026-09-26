// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";

export const MISSION_CONTEXT_SCOPE = ["mandate", "artifact", "evidence", "judgments", "procedure", "runHistory"] as const;
export const SECURITIES_DEV_HOSTS = ["www.rgrdlaw.com", "robbinsllp.com", "www.glancylaw.com", "pomlaw.com", "www.rosenlegal.com", "www.hbsslaw.com", "faruqilaw.com", "schallfirm.com", "www.bernlieb.com", "zlk.com", "www.blbglaw.com", "scott-scott.com"];
export const SECURITIES_DEV_MANDATE = "Monitor these plaintiff-side firm websites daily for securities investigations, Rule 10b-5 and Section 11 announcements, filed actions, class periods, published lead-plaintiff deadlines, notices, press releases, and dated market observations. Explain relevance and cite dated sources. Distinguish investigation announcements from evidence of a filed action. Recheck time-sensitive dates, retain missing or conflicting dates, and report source failures as partial coverage. Deduplicate across publishers and runs; use confirmed examples when ranking opportunities. Propose additional sources and trends for user review, and distinguish observed publishing patterns from broader interpretations.";
export type HandoffDestination = "drafter" | "plan" | "auto";
export interface MissionHandoff {
  id: string; missionId: string; draftId: string; body: string;
  destination: HandoffDestination; status: "prepared" | "launching" | "uncertain" | "delivered";
  destinationId: string | null; artifactRevision: string; createdAt: number;
}
export interface MissionQuestion {
  id: string; question: string; body?: string; url?: string;
  status: "open" | "deferred" | "dismissed" | "resolved";
  priority: number; observedAt: number; resolutionId?: string;
  uncertainty?: string;
}
export interface MissionContextVersion {
  versionId: string; publishedAt: number; manifestHash: string;
  sourceLedgerHead: string; includedScope: string[]; localOnly: boolean;
}
export interface MissionBot {
  id: string; name: string; mandate: string; cadence: string;
  contextMode: "pinned" | "follow"; versionId: string; status: string;
}
export interface MissionCapturePolicy {
  enabled: boolean; paused: boolean; tabIds: string[]; excludedHosts: string[];
  maxDurationMs: number; maxBytes: number; retentionMs: number; localOnly: true;
}
export interface MissionFoundationState {
  runtime: { status: string; nextAction: string; error?: string | null; updatedAt: number } | null;
  versions: MissionContextVersion[]; bots: MissionBot[];
  runs: { id: string; botId: string; status: string; versionId: string; startedAt: number }[];
  questions: MissionQuestion[]; handoffs: MissionHandoff[];
  capturePolicy: MissionCapturePolicy | null;
  captures: { id: string; status: string; byteSize: number; startedAt?: number; endedAt?: number; frameCount?: number; url?: string; error?: string | null }[];
}

/** Every operation carries its durable owner; changing the selected mission
 * cannot redirect an in-flight request to another workspace. */
export function missionFoundation<T>(missionId: string, action: { op: string; [key: string]: unknown }): Promise<T> {
  return invoke<T>("mission_foundation", { request: { missionId, workspaceId: missionId, ...action } });
}
