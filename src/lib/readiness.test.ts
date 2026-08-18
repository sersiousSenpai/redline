// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  blockingItems,
  deriveReadiness,
  HOOK_SILENCE_MS,
  sortReadiness,
  type PreflightStatus,
  type ReadinessId,
  type ReadinessInput,
  type ReadinessItem,
} from "./readiness";

const healthyPreflight = (): PreflightStatus => ({
  claude: { found: true, path: "/usr/local/bin/claude", source: "probe" },
  curl: { ok: true, version: "8.7.1" },
  mode: "active",
  hook: { installed: true, conflictingUrl: null },
  skill: { installed: true, outdated: false },
});

const healthy = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  preflight: healthyPreflight(),
  daemonBound: true,
  hookModalActive: false,
  planEverArrived: true,
  pendingSince: null,
  now: 1_000_000,
  projectCount: 3,
  ...over,
});

const ids = (input: ReadinessInput): ReadinessId[] =>
  deriveReadiness(input).map((i) => i.id);

describe("the healthy invariant", () => {
  it("yields nothing at all — the strip renders no chrome", () => {
    expect(deriveReadiness(healthy())).toEqual([]);
  });

  it("stays silent while the probe is still in flight", () => {
    // Null preflight is 'unknown', not 'broken' — never guess a fault.
    expect(deriveReadiness(healthy({ preflight: null }))).toEqual([]);
  });

  it("stays silent in Ambient — a countdown is not a fault", () => {
    const pf = healthyPreflight();
    pf.mode = "ambient";
    expect(deriveReadiness(healthy({ preflight: pf }))).toEqual([]);
  });
});

describe("the three silent-failure routes", () => {
  it("blocks on Paused with a resume fix", () => {
    const pf = healthyPreflight();
    pf.mode = "paused";
    const items = deriveReadiness(healthy({ preflight: pf }));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("mode-paused");
    expect(items[0].state).toBe("blocked");
    expect(items[0].fix?.kind).toBe("resume-mode");
  });

  it("blocks on a missing `claude` with a locate fix", () => {
    const pf = healthyPreflight();
    pf.claude = { found: false, path: null, source: "path" };
    const items = deriveReadiness(healthy({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["claude-missing"]);
    expect(items[0].fix?.kind).toBe("locate-claude");
  });

  it("blocks on an unapproved hook only after the silence window", () => {
    const now = 1_000_000;
    const justLaunched = healthy({
      now,
      pendingSince: now - 1_000,
      planEverArrived: false,
    });
    expect(ids(justLaunched)).toEqual([]);

    const silent = healthy({
      now,
      pendingSince: now - HOOK_SILENCE_MS - 1,
      planEverArrived: false,
    });
    const items = deriveReadiness(silent);
    expect(items.map((i) => i.id)).toEqual(["hook-unapproved"]);
    expect(items[0].fix?.kind).toBe("copy-hooks");
    expect(items[0].fix?.copyText).toBe("/hooks");
  });

  it("never nudges about /hooks once a plan has ever arrived", () => {
    // A plan landed before, so the hook demonstrably works — this wait has
    // some other cause and blaming the hook would be a confident lie.
    const now = 1_000_000;
    expect(
      ids(
        healthy({
          now,
          pendingSince: now - HOOK_SILENCE_MS * 10,
          planEverArrived: true,
        }),
      ),
    ).toEqual([]);
  });

  it("never nudges when nothing is pending", () => {
    expect(
      ids(healthy({ pendingSince: null, planEverArrived: false })),
    ).toEqual([]);
  });
});

describe("suppression rules", () => {
  it("hides hook + skill items while the setup modal is up", () => {
    const pf = healthyPreflight();
    pf.hook = { installed: false, conflictingUrl: null };
    pf.skill = { installed: false, outdated: false };
    expect(ids(healthy({ preflight: pf, hookModalActive: true }))).toEqual([]);
    expect(ids(healthy({ preflight: pf, hookModalActive: false }))).toEqual([
      "hook-missing",
      "skill-stale",
    ]);
  });

  it("reads as recovery, not onboarding", () => {
    const pf = healthyPreflight();
    pf.hook = { installed: false, conflictingUrl: null };
    const item = deriveReadiness(healthy({ preflight: pf }))[0];
    expect(item.label).toBe("The plan hook was removed");
    expect(item.label.toLowerCase()).not.toContain("welcome");
    expect(item.detail.toLowerCase()).not.toContain("get you set up");
  });

  it("names a foreign hook that took the matcher", () => {
    const pf = healthyPreflight();
    pf.hook = { installed: false, conflictingUrl: "http://localhost:9999/x" };
    const item = deriveReadiness(healthy({ preflight: pf }))[0];
    expect(item.label).toContain("took over");
    expect(item.detail).toContain("http://localhost:9999/x");
  });

  it("treats a stale skill as stale, not as removed", () => {
    const pf = healthyPreflight();
    pf.skill = { installed: false, outdated: true };
    const item = deriveReadiness(healthy({ preflight: pf }))[0];
    expect(item.id).toBe("skill-stale");
    expect(item.label).toContain("out of date");
  });
});

describe("the rest of the item set", () => {
  it("blocks when this window's daemon lost the port", () => {
    const items = deriveReadiness(healthy({ daemonBound: false }));
    expect(items.map((i) => i.id)).toEqual(["daemon-unbound"]);
    // Nothing to click — the fix is quitting the other instance.
    expect(items[0].fix).toBeUndefined();
  });

  it("warns with a create fix when there is no project at all", () => {
    const items = deriveReadiness(healthy({ projectCount: 0 }));
    expect(items.map((i) => i.id)).toEqual(["no-project"]);
    expect(items[0].state).toBe("warn");
    expect(items[0].fix?.kind).toBe("new-project");
  });

  it("warns informationally about an old curl", () => {
    const pf = healthyPreflight();
    pf.curl = { ok: false, version: "7.88.1" };
    const items = deriveReadiness(healthy({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["curl-old"]);
    expect(items[0].state).toBe("warn");
    expect(items[0].fix).toBeUndefined();
    expect(items[0].detail).toContain("7.88.1");
  });
});

describe("the ordering law", () => {
  it("puts every blocked item before every warn", () => {
    const now = 1_000_000;
    const pf = healthyPreflight();
    pf.mode = "paused";
    pf.claude = { found: false, path: null, source: "path" };
    pf.curl = { ok: false, version: "7.88.1" };
    pf.hook = { installed: false, conflictingUrl: null };
    pf.skill = { installed: false, outdated: true };
    const items = deriveReadiness({
      preflight: pf,
      daemonBound: false,
      hookModalActive: false,
      planEverArrived: false,
      pendingSince: now - HOOK_SILENCE_MS - 1,
      now,
      projectCount: 0,
    });
    expect(items.map((i) => i.id)).toEqual([
      "mode-paused",
      "claude-missing",
      "daemon-unbound",
      "hook-unapproved",
      "no-project",
      "hook-missing",
      "skill-stale",
      "curl-old",
    ]);
    const firstWarn = items.findIndex((i) => i.state === "warn");
    expect(items.slice(firstWarn).every((i) => i.state === "warn")).toBe(true);
  });

  it("is stable regardless of the order items were produced in", () => {
    const mk = (id: ReadinessId, state: "blocked" | "warn"): ReadinessItem => ({
      id,
      state,
      label: id,
      detail: "",
    });
    const shuffled = [
      mk("curl-old", "warn"),
      mk("claude-missing", "blocked"),
      mk("no-project", "warn"),
      mk("mode-paused", "blocked"),
    ];
    expect(sortReadiness(shuffled).map((i) => i.id)).toEqual([
      "mode-paused",
      "claude-missing",
      "no-project",
      "curl-old",
    ]);
    // Sorting is pure — the caller's array is untouched.
    expect(shuffled[0].id).toBe("curl-old");
  });
});

describe("blockingItems", () => {
  it("is what the composer refuses ⏎ on", () => {
    const pf = healthyPreflight();
    pf.mode = "paused";
    pf.curl = { ok: false, version: "7.88.1" };
    const blocking = blockingItems(deriveReadiness(healthy({ preflight: pf })));
    expect(blocking.map((i) => i.id)).toEqual(["mode-paused"]);
  });

  it("is empty on a healthy machine, so ⏎ always goes through", () => {
    expect(blockingItems(deriveReadiness(healthy()))).toEqual([]);
  });
});

describe("ext-toolchain — the extension-pack build check", () => {
  const toolchain = (over: Partial<NonNullable<PreflightStatus["extension"]>> = {}) => ({
    cargo: true,
    wasmTarget: true,
    abiDir: "/repo/src-tauri/crates/redline-extension-abi",
    sdkDir: "/repo/src-tauri/crates/redline-extension-sdk",
    templateDir: "/repo/marketplace/redline-extension-template",
    ...over,
  });

  it("stays silent for a plain project even with no toolchain at all", () => {
    const pf = {
      ...healthyPreflight(),
      extension: toolchain({ cargo: false, wasmTarget: false }),
    };
    expect(ids(healthy({ preflight: pf }))).toEqual([]);
  });

  it("stays silent when the target is a pack and the toolchain is whole", () => {
    const pf = { ...healthyPreflight(), extension: toolchain() };
    expect(ids(healthy({ preflight: pf, targetIsExtension: true }))).toEqual([]);
  });

  it("warns — never blocks — when the pack target has no cargo", () => {
    const pf = {
      ...healthyPreflight(),
      extension: toolchain({ cargo: false, wasmTarget: false }),
    };
    const items = deriveReadiness(
      healthy({ preflight: pf, targetIsExtension: true }),
    );
    expect(items.map((i) => [i.id, i.state])).toEqual([
      ["ext-toolchain", "warn"],
    ]);
    expect(blockingItems(items)).toEqual([]);
    expect(items[0].fix?.copyText).toContain("rustup.rs");
  });

  it("offers the one-line target add when only the wasm target is missing", () => {
    const pf = {
      ...healthyPreflight(),
      extension: toolchain({ wasmTarget: false }),
    };
    const items = deriveReadiness(
      healthy({ preflight: pf, targetIsExtension: true }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].fix?.copyText).toBe(
      "rustup target add wasm32-unknown-unknown",
    );
  });

  it("withholds the item when the probe predates the field", () => {
    // An older backend's status has no `extension` key: no answer, no nag.
    expect(ids(healthy({ targetIsExtension: true }))).toEqual([]);
  });
});
