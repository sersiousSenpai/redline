// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Build Redline inside Redline — the frontend's vocabulary and its pure
// decisions.
//
// The backend owns every consequential judgement (is this artifact still the
// one we verified? can the previous version read this data? is the filesystem
// able to exchange the bundle?). What lives here is the part the user reads:
// which of the six statuses they are looking at, what a restart will actually
// cost them in seconds, what is about to be interrupted and what will come
// back, and when it is honest to announce that something is ready.
//
// All of it is pure, so the sentences a user is shown at the moment they
// decide to restart their editor can be tested without a build.

export type ReleaseStatus =
  | "preparing"
  | "verifying"
  | "ready"
  | "quiescing"
  | "activating"
  | "checkingStartup"
  | "active"
  | "failed"
  | "outdated"
  | "cancelled"
  | "rolledBack";

export interface SourceCapture {
  repository: string;
  baseRevision: string;
  fingerprint: string;
  fileCount: number;
  modified: string[];
  untracked: string[];
  excluded: string[];
}

export interface CheckResult {
  name: string;
  command: string;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  output: string;
}

export interface DataCompatibility {
  schemaVersion: number;
  memorySchema: string;
  migrations: string[];
  previousCanRead: boolean;
  externalState: string[];
  requiresMaintenance: boolean;
  notes: string;
}

export interface ReleaseManifest {
  manifestVersion: number;
  releaseId: string;
  createdAt: number;
  source: {
    repository: string;
    baseRevision: string;
    fingerprint: string;
    fileCount: number;
    modifiedFiles: string[];
    untrackedFiles: string[];
    planRevisions: string[];
    installedRelease: string | null;
  };
  platform: string;
  arch: string;
  artifact: { bundleName: string; sha256: string; fileCount: number; totalBytes: number };
  signing: { identity: string | null; adHoc: boolean; verified: boolean; authority: string[] };
  checks: CheckResult[];
  data: DataCompatibility;
  helperProtocol: number;
  seal: string;
}

export type ProbeMilestone =
  | "started"
  | "database"
  | "daemon"
  | "frontend"
  | "reads"
  | "shutdown";

export interface ProbeReport {
  profile: string;
  dataDir: string;
  daemonAddr: string;
  steps: { milestone: ProbeMilestone; atMs: number; detail: string }[];
  ok: boolean;
  failure: string;
  interactiveMs: number;
}

export interface Release {
  releaseId: string;
  runId: string | null;
  repository: string;
  status: ReleaseStatus;
  candidateRoot: string;
  bundlePath: string | null;
  manifest: ReleaseManifest | null;
  capture: SourceCapture | null;
  probe: ProbeReport | null;
  failure: string;
  step: string;
  createdAt: number;
  updatedAt: number;
}

export interface RestartPreflight {
  ok: boolean;
  blockers: string[];
  freeBytes: number;
  requiredBytes: number;
}

export interface RestartRefused {
  reason: string;
  blocking: string[];
  retryable: boolean;
}

export interface InterruptedWork {
  kind: "terminal" | "held-review" | "agent-turn" | "browser-tab" | string;
  label: string;
  recovery: string;
}

export interface WorkspaceSnapshot {
  savedAt: number;
  frontend: unknown;
  resumableRuns: string[];
  interrupted: InterruptedWork[];
}

export interface ActivationReport {
  txnId: string;
  releaseId: string;
  accepted: boolean;
  rolledBack: boolean;
  needsAttention: boolean;
  message: string;
  finishedAt: number;
}

export interface ActivationStatus {
  verifying: boolean;
  gated: boolean;
  gatedMessage: string;
  runningRelease: string | null;
  lastReport: ActivationReport | null;
}

export interface Availability {
  available: boolean;
  repository: string | null;
  installedBundle: string | null;
  installedRelease: string | null;
  confinement: boolean;
  confinementDetail: string;
  blockers: string[];
}

export interface PatchView {
  releaseId: string;
  patch: string;
  changedFiles: string[];
  appliesCleanly: boolean;
  repository: string;
}

/** What each status means, in the user's terms. One row per status the
 *  release panel can be in — the table the feature is specified by. */
export const STATUS_LABEL: Record<ReleaseStatus, string> = {
  preparing: "Preparing",
  verifying: "Verifying",
  ready: "Ready to restart",
  quiescing: "Saving your work",
  activating: "Restarting",
  checkingStartup: "Checking the new version",
  active: "Applied",
  failed: "Didn't finish",
  outdated: "Superseded",
  cancelled: "Cancelled",
  rolledBack: "Rolled back",
};

/** The statuses where something is still happening on its own. */
export function isWorking(status: ReleaseStatus): boolean {
  return (
    status === "preparing" ||
    status === "verifying" ||
    status === "quiescing" ||
    status === "activating" ||
    status === "checkingStartup"
  );
}

/** A restart may only ever be offered from here. Mirrors the backend's own
 *  rule; the button is not the authority, but it must not lie either. */
export function canOfferRestart(release: Release): boolean {
  return (
    release.status === "ready" &&
    !!release.bundlePath &&
    !!release.manifest &&
    release.manifest.checks.every((c) => c.ok) &&
    release.manifest.signing.verified &&
    release.manifest.data.previousCanRead &&
    !release.manifest.data.requiresMaintenance
  );
}

/** A release that changes stored data in a way a restart cannot undo is
 *  presented as maintenance, not as a quick restart. */
export function requiresMaintenance(release: Release): boolean {
  const data = release.manifest?.data;
  if (!data) return false;
  return data.requiresMaintenance || !data.previousCanRead;
}

/** How long the user will be without their editor, measured rather than
 *  guessed: the probe actually started this build and recorded when it became
 *  interactive. `null` when nothing has been measured yet — in which case the
 *  UI says so instead of inventing a number. */
export function restartEstimateMs(release: Release): number | null {
  const interactive = release.probe?.interactiveMs;
  if (!interactive || interactive <= 0) return null;
  // The probe measures process start → interactive. A restart adds the
  // exchange and the launch, both small and both bounded; the observed
  // interactive time is the part that varies by build, so it is what the
  // estimate is built on.
  const EXCHANGE_AND_LAUNCH_MS = 1200;
  return interactive + EXCHANGE_AND_LAUNCH_MS;
}

/** "about 4 seconds" — deliberately vague, because it is an estimate. */
export function formatEstimate(ms: number | null): string {
  if (ms == null) return "not measured yet";
  const seconds = ms / 1000;
  if (seconds < 1.5) return "about a second";
  if (seconds < 10) return `about ${Math.round(seconds)} seconds`;
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds`;
  return `about ${Math.round(seconds / 30) / 2} minutes`;
}

/** The target the plan set, and whether this release meets it. Shown as a
 *  measured claim, never as a guarantee. */
export const DOWNTIME_TARGET_MS = 10_000;

export function meetsDowntimeTarget(release: Release): boolean | null {
  const estimate = restartEstimateMs(release);
  return estimate == null ? null : estimate <= DOWNTIME_TARGET_MS;
}

/** What is in this release: the plan's work, plus whatever was already sitting
 *  uncommitted in the checkout when the candidate was taken. The second part
 *  is the one a reviewer would otherwise be surprised by. */
export function includedChanges(release: Release): {
  planChanges: number;
  carriedModifications: string[];
  carriedUntracked: string[];
  baseRevision: string;
} {
  const capture = release.capture;
  return {
    planChanges: release.manifest?.source.planRevisions.length ?? 0,
    carriedModifications: capture?.modified ?? [],
    carriedUntracked: capture?.untracked ?? [],
    baseRevision: capture?.baseRevision?.slice(0, 12) ?? "",
  };
}

/** Every check and probe milestone, as a flat pass/fail list. */
export function validationRows(
  release: Release,
): { name: string; ok: boolean; detail: string }[] {
  const rows: { name: string; ok: boolean; detail: string }[] = [];
  for (const check of release.manifest?.checks ?? []) {
    rows.push({
      name: check.name,
      ok: check.ok,
      detail: check.ok
        ? `${(check.durationMs / 1000).toFixed(1)}s`
        : `exit ${check.exitCode ?? "?"}`,
    });
  }
  const signing = release.manifest?.signing;
  if (signing) {
    rows.push({
      name: "Signature",
      ok: signing.verified,
      detail: signing.adHoc ? "ad-hoc" : signing.identity ?? "signed",
    });
  }
  const probe = release.probe;
  if (probe) {
    rows.push({
      name: "Started for real",
      ok: probe.ok,
      detail: probe.ok
        ? `${probe.steps.length} milestones, isolated on ${probe.daemonAddr}`
        : probe.failure,
    });
  }
  const data = release.manifest?.data;
  if (data) {
    rows.push({
      name: "Your previous version can read this release's data",
      ok: data.previousCanRead,
      detail: data.notes,
    });
  }
  return rows;
}

/** What a restart will do to what is open right now.
 *
 *  Three buckets, because they are three different promises: state that is
 *  saved and comes back, work that will be picked up again, and processes that
 *  simply end. Conflating the last two is the lie the plan calls out. */
export function interruptionPlan(snapshot: {
  resumableRuns: string[];
  interrupted: InterruptedWork[];
}): { resumes: string[]; closes: InterruptedWork[] } {
  return {
    resumes: snapshot.resumableRuns,
    closes: snapshot.interrupted,
  };
}

/** Announce a ready release once per candidate, not once per render, not once
 *  per poll. Returns the id to remember, or null if nothing new is ready. */
export function announceable(
  releases: Release[],
  alreadyAnnounced: string | null,
): string | null {
  const ready = releases.find((r) => canOfferRestart(r));
  if (!ready) return null;
  return ready.releaseId === alreadyAnnounced ? null : ready.releaseId;
}

/** The single sentence the persistent indicator shows. */
export function readyHeadline(release: Release): string {
  if (requiresMaintenance(release)) {
    return "Changes ready — needs maintenance, not a restart";
  }
  return "Changes ready — Restart to apply";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit + 1 < units.length) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}
