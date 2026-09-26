// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  announceable,
  canOfferRestart,
  DOWNTIME_TARGET_MS,
  formatEstimate,
  includedChanges,
  interruptionPlan,
  isWorking,
  meetsDowntimeTarget,
  readyHeadline,
  requiresMaintenance,
  restartEstimateMs,
  STATUS_LABEL,
  validationRows,
  type Release,
  type ReleaseStatus,
} from "./selfDevelop";

function release(over: Partial<Release> = {}): Release {
  return {
    releaseId: "rel-1",
    runId: "run-1",
    repository: "/Users/x/redline",
    status: "ready",
    candidateRoot: "/data/self-develop/rel-1/source",
    bundlePath: "/data/self-develop/rel-1/out/Redline.app",
    manifest: {
      manifestVersion: 1,
      releaseId: "rel-1",
      createdAt: 1,
      source: {
        repository: "/Users/x/redline",
        baseRevision: "abcdef0123456789",
        fingerprint: "f",
        fileCount: 900,
        modifiedFiles: ["src/App.tsx"],
        untrackedFiles: ["src/new.ts"],
        planRevisions: ["plan-1"],
        installedRelease: "rel-0",
      },
      platform: "macos",
      arch: "aarch64",
      artifact: { bundleName: "Redline.app", sha256: "abc", fileCount: 40, totalBytes: 37_000_000 },
      signing: { identity: "Redline Dev", adHoc: false, verified: true, authority: ["Redline Dev"] },
      checks: [
        { name: "Frontend tests", command: "npm test", exitCode: 0, ok: true, durationMs: 4200, output: "" },
      ],
      data: {
        schemaVersion: 4,
        memorySchema: "911d24e",
        migrations: [],
        previousCanRead: true,
        externalState: [],
        requiresMaintenance: false,
        notes: "This release does not change how anything is stored.",
      },
      helperProtocol: 1,
      seal: "sealed",
    },
    capture: {
      repository: "/Users/x/redline",
      baseRevision: "abcdef0123456789",
      fingerprint: "f",
      fileCount: 900,
      modified: ["src/App.tsx"],
      untracked: ["src/new.ts"],
      excluded: [".env"],
    },
    probe: {
      profile: "probe on 127.0.0.1:51234",
      dataDir: "/data/probe",
      daemonAddr: "127.0.0.1:51234",
      steps: [
        { milestone: "started", atMs: 0, detail: "" },
        { milestone: "database", atMs: 300, detail: "" },
        { milestone: "daemon", atMs: 420, detail: "" },
        { milestone: "frontend", atMs: 2600, detail: "" },
        { milestone: "reads", atMs: 2700, detail: "" },
        { milestone: "shutdown", atMs: 2800, detail: "" },
      ],
      ok: true,
      failure: "",
      interactiveMs: 2600,
    },
    failure: "",
    step: "ready to restart",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

describe("offering a restart", () => {
  it("offers one only from a ready, packaged, fully validated release", () => {
    expect(canOfferRestart(release())).toBe(true);
    expect(canOfferRestart(release({ status: "verifying" }))).toBe(false);
    expect(canOfferRestart(release({ bundlePath: null }))).toBe(false);
    expect(canOfferRestart(release({ manifest: null }))).toBe(false);
  });

  it("does not offer one when a check failed, even though the status says ready", () => {
    const r = release();
    r.manifest!.checks[0].ok = false;
    expect(canOfferRestart(r)).toBe(false);
  });

  it("does not offer one when the signature did not verify", () => {
    const r = release();
    r.manifest!.signing.verified = false;
    expect(canOfferRestart(r)).toBe(false);
  });

  it("presents a release with no way back as maintenance, not as a restart", () => {
    const r = release();
    r.manifest!.data.previousCanRead = false;
    expect(requiresMaintenance(r)).toBe(true);
    expect(canOfferRestart(r)).toBe(false);
    expect(readyHeadline(r)).toContain("maintenance");
  });

  it("says Restart to apply when a restart really is all it takes", () => {
    expect(readyHeadline(release())).toBe("Changes ready — Restart to apply");
  });
});

describe("the restart estimate", () => {
  it("is measured from the probe, not invented", () => {
    expect(restartEstimateMs(release())).toBe(2600 + 1200);
    // Nothing measured: say so rather than printing a number.
    expect(restartEstimateMs(release({ probe: null }))).toBeNull();
    expect(formatEstimate(null)).toBe("not measured yet");
  });

  it("reads like an estimate", () => {
    expect(formatEstimate(900)).toBe("about a second");
    expect(formatEstimate(3800)).toBe("about 4 seconds");
    expect(formatEstimate(23_000)).toBe("about 25 seconds");
    expect(formatEstimate(90_000)).toBe("about 1.5 minutes");
  });

  it("compares against the target without promising it", () => {
    expect(meetsDowntimeTarget(release())).toBe(true);
    const slow = release();
    slow.probe!.interactiveMs = DOWNTIME_TARGET_MS + 5_000;
    expect(meetsDowntimeTarget(slow)).toBe(false);
    expect(meetsDowntimeTarget(release({ probe: null }))).toBeNull();
  });
});

describe("what the reviewer is told", () => {
  it("surfaces the uncommitted work that came along with the plan", () => {
    // The checkout is never clean. A reviewer who is not told that their own
    // in-progress edits are inside the release has been misled.
    const changes = includedChanges(release());
    expect(changes.carriedModifications).toEqual(["src/App.tsx"]);
    expect(changes.carriedUntracked).toEqual(["src/new.ts"]);
    expect(changes.baseRevision).toBe("abcdef012345");
  });

  it("lists every validation, including the one about getting back", () => {
    const rows = validationRows(release());
    expect(rows.map((r) => r.name)).toEqual([
      "Frontend tests",
      "Signature",
      "Started for real",
      "Your previous version can read this release's data",
    ]);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("shows a failed probe with its reason, not just a cross", () => {
    const r = release();
    r.probe!.ok = false;
    r.probe!.failure = "the candidate did not shut down cleanly";
    const row = validationRows(r).find((x) => x.name === "Started for real")!;
    expect(row.ok).toBe(false);
    expect(row.detail).toBe("the candidate did not shut down cleanly");
  });

  it("separates what resumes from what simply closes", () => {
    const plan = interruptionPlan({
      resumableRuns: ["run-7"],
      interrupted: [
        { kind: "terminal", label: "terminal 2", recovery: "Reopen it" },
        { kind: "held-review", label: "plan review s-1", recovery: "Use Restore" },
      ],
    });
    expect(plan.resumes).toEqual(["run-7"]);
    expect(plan.closes.map((c) => c.kind)).toEqual(["terminal", "held-review"]);
    // Every closing thing says what to do about it.
    expect(plan.closes.every((c) => c.recovery.length > 0)).toBe(true);
  });
});

describe("announcing readiness", () => {
  it("announces once per candidate, not once per poll", () => {
    const ready = release();
    expect(announceable([ready], null)).toBe("rel-1");
    expect(announceable([ready], "rel-1")).toBeNull();
    // A NEW candidate is a new announcement.
    expect(announceable([release({ releaseId: "rel-2" })], "rel-1")).toBe("rel-2");
  });

  it("never announces something that is not offerable", () => {
    expect(announceable([release({ status: "preparing" })], null)).toBeNull();
    const broken = release();
    broken.manifest!.data.requiresMaintenance = true;
    expect(announceable([broken], null)).toBeNull();
  });
});

describe("status vocabulary", () => {
  it("labels every status a release can be in", () => {
    const all: ReleaseStatus[] = [
      "preparing", "verifying", "ready", "quiescing", "activating",
      "checkingStartup", "active", "failed", "outdated", "cancelled", "rolledBack",
    ];
    for (const status of all) {
      expect(STATUS_LABEL[status]).toBeTruthy();
    }
  });

  it("knows which statuses are still moving on their own", () => {
    expect(isWorking("preparing")).toBe(true);
    expect(isWorking("checkingStartup")).toBe(true);
    expect(isWorking("ready")).toBe(false);
    expect(isWorking("active")).toBe(false);
    expect(isWorking("rolledBack")).toBe(false);
  });
});
