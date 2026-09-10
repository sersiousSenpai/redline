// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  blockingItems,
  codexRestoreBlockers,
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
  codex: {
    found: true,
    path: "/Applications/ChatGPT.app/Contents/Resources/codex",
    source: "probe",
    usable: true,
    signedIn: true,
    profile: {
      installed: true,
      outdated: false,
      path: "/Users/me/.codex/redline-plan.config.toml",
    },
  },
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

  it("explains Codex hook trust when an installed integration never sends its first plan", () => {
    const items = deriveReadiness(healthy({
      targetIsCodex: true, codexHookInstalled: true,
      now: 1_000_000, pendingSince: 1_000_000 - HOOK_SILENCE_MS - 1,
      planEverArrived: false,
    }));
    const hook = items.find(item => item.id === "hook-unapproved");
    expect(hook?.detail).toContain("new or modified");
    expect(hook?.detail).toContain("not necessarily trusted");
    expect(hook?.fix?.copyText).toBe("/hooks");
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

describe("the codex routes", () => {
  // The governing rule: a Claude user must never see a Codex blocker. Every
  // item below is gated on the door's stored choice, not on what happens to
  // be installed.
  const onCodex = (over: Partial<ReadinessInput> = {}) =>
    healthy({ targetIsCodex: true, codexHookInstalled: true, ...over });

  it("says nothing about codex while the door is on Claude", () => {
    const pf = healthyPreflight();
    pf.codex = { found: false, path: null, source: "path", usable: false, signedIn: false };
    expect(deriveReadiness(healthy({ preflight: pf, codexHookInstalled: false }))).toEqual([]);
  });

  it("blocks on a missing codex with a locate fix", () => {
    const pf = healthyPreflight();
    pf.codex = { found: false, path: null, source: "path", usable: false, signedIn: false };
    const items = deriveReadiness(onCodex({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["codex-missing"]);
    expect(items[0].state).toBe("blocked");
    expect(items[0].fix?.kind).toBe("locate-codex");
    expect(items[0].label).toContain("Can't find");
  });

  it("blocks a codex that EXISTS but is too old — the live bug", () => {
    // $PATH on a machine with the ChatGPT app usually still resolves an old
    // standalone build: it starts, plans once, and then fails every restore.
    const pf = healthyPreflight();
    pf.codex = {
      found: true,
      path: "/opt/homebrew/bin/codex",
      source: "probe",
      usable: false,
      signedIn: true,
    };
    const items = deriveReadiness(onCodex({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["codex-missing"]);
    expect(items[0].label).toContain("too old");
    expect(items[0].detail).toContain("/opt/homebrew/bin/codex");
  });

  it("blocks a missing plan contract — codex ignores the profile silently", () => {
    // `codex -p redline-plan` with no such file is NOT an error. A session
    // would plan with no contract, look perfect on v1, and lose every
    // block-identity sidecar on v2.
    const pf = healthyPreflight();
    pf.codex = { ...pf.codex!, profile: { installed: false, outdated: false, path: "/p" } };
    const items = deriveReadiness(onCodex({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["codex-contract-missing"]);
    expect(items[0].state).toBe("blocked");
    expect(items[0].fix?.kind).toBe("install-integration");
  });

  it("blocks a STALE contract too — it fails the same silent way", () => {
    const pf = healthyPreflight();
    pf.codex = { ...pf.codex!, profile: { installed: true, outdated: true, path: "/p" } };
    const items = deriveReadiness(onCodex({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["codex-contract-missing"]);
    expect(items[0].label).toContain("out of date");
  });

  it("withholds the contract item while the probe predates the field", () => {
    const pf = healthyPreflight();
    pf.codex = { ...pf.codex!, profile: undefined };
    expect(deriveReadiness(onCodex({ preflight: pf }))).toEqual([]);
  });

  it("blocks a logged-out codex rather than letting it spin", () => {
    const pf = healthyPreflight();
    pf.codex = { ...pf.codex!, signedIn: false };
    const items = deriveReadiness(onCodex({ preflight: pf }));
    expect(items.map((i) => i.id)).toEqual(["codex-logged-out"]);
    expect(items[0].state).toBe("blocked");
    expect(items[0].fix?.copyText).toBe("codex login");
  });

  it("names only ONE binary fault at a time", () => {
    // Missing beats logged-out: a binary that isn't there can't be signed in,
    // and two blockers for one cause is a wall, not a fix.
    const pf = healthyPreflight();
    pf.codex = { found: false, path: null, source: "path", usable: false, signedIn: false };
    expect(ids(onCodex({ preflight: pf }))).toEqual(["codex-missing"]);
  });

  it("warns — never blocks — on a missing codex Stop hook", () => {
    const items = deriveReadiness(onCodex({ codexHookInstalled: false }));
    expect(items.map((i) => i.id)).toEqual(["codex-hook-missing"]);
    expect(items[0].state).toBe("warn");
    expect(blockingItems(items)).toEqual([]);
    // The one-time trust confirmation is the part nobody would guess.
    expect(items[0].detail).toContain("trust");
  });

  it("withholds the hook warning while the probe is unanswered", () => {
    expect(deriveReadiness(healthy({ targetIsCodex: true }))).toEqual([]);
  });

  it("keeps codex items in a fixed place in the order", () => {
    const pf = healthyPreflight();
    pf.mode = "paused";
    pf.codex = { ...pf.codex!, signedIn: false };
    // (signed-out is reported only once the contract is present — one binary
    // fault at a time, same rule as missing-beats-logged-out.)
    expect(ids(onCodex({ preflight: pf, codexHookInstalled: false }))).toEqual([
      "mode-paused",
      "codex-logged-out",
      "codex-hook-missing",
    ]);
  });
});

describe("the codex RESTORE gate", () => {
  // A restore is narrower than a launch and fails differently: it is a round
  // trip. The command runs, the terminal looks healthy, and the plan never
  // comes back — with the detached banner already dismissed behind it.
  const restore = (
    mutate: (pf: PreflightStatus) => void = () => {},
    hookInstalled: boolean | undefined = true,
  ) => {
    const pf = healthyPreflight();
    mutate(pf);
    return codexRestoreBlockers(pf, hookInstalled);
  };

  it("clears a healthy Codex — nothing between the review and its plan", () => {
    expect(restore()).toEqual([]);
  });

  it("says nothing while the probe is still in flight", () => {
    // Refusing on no answer would be worse than the fault it guards against:
    // the reviewer's own terminal was always the fallback.
    expect(codexRestoreBlockers(null, undefined)).toEqual([]);
    expect(codexRestoreBlockers(null, false)).toEqual([]);
  });

  it("blocks a missing codex, with the locate fix the door already offers", () => {
    const items = restore((pf) => {
      pf.codex = {
        found: false,
        path: null,
        source: "path",
        usable: false,
        signedIn: false,
      };
    });
    expect(items.map((i) => i.id)).toEqual(["codex-missing"]);
    expect(items[0].fix?.kind).toBe("locate-codex");
  });

  it("blocks a codex too old to have `resume` at all", () => {
    // The live bug: `$PATH` on a machine with the ChatGPT desktop app usually
    // resolves an older standalone build. `resume` IS the restore mechanism,
    // so this one is fatal here in a way it never is at the door.
    const items = restore((pf) => {
      pf.codex = {
        found: true,
        path: "/opt/homebrew/bin/codex",
        source: "path",
        usable: false,
        signedIn: true,
      };
    });
    expect(items.map((i) => i.id)).toEqual(["codex-missing"]);
    expect(items[0].detail).toContain("resume");
  });

  it("blocks a logged-out codex", () => {
    const items = restore((pf) => {
      pf.codex = { ...pf.codex!, signedIn: false };
    });
    expect(items.map((i) => i.id)).toEqual(["codex-logged-out"]);
    expect(items[0].fix?.copyText).toBe("codex login");
  });

  it("blocks a missing or stale plan contract", () => {
    for (const profile of [
      { installed: false, outdated: false, path: "/p" },
      { installed: true, outdated: true, path: "/p" },
    ]) {
      const items = restore((pf) => {
        pf.codex = { ...pf.codex!, profile };
      });
      expect(items.map((i) => i.id)).toEqual(["codex-contract-missing"]);
      expect(items[0].fix?.kind).toBe("install-integration");
    }
  });

  it("ESCALATES the missing Stop hook from a warning to a blocker", () => {
    // At the door this is correctly a warning: the plan still reaches the
    // model, only the return trip is lost. A restore is nothing BUT the return
    // trip — the sentinel it writes would reach nothing.
    const items = restore(() => {}, false);
    expect(items.map((i) => i.id)).toEqual(["codex-hook-missing"]);
    expect(items[0].state).toBe("blocked");
    expect(items[0].fix?.kind).toBe("install-integration");

    // Unprobed is not "missing" — withheld, like every other null answer.
    expect(restore(() => {}, undefined)).toEqual([]);
  });

  it("ignores faults that have nothing to do with a restore", () => {
    // Paused interception, an unbound daemon, a stale skill, an old curl and a
    // projectless machine are all real — and none of them is what this gate is
    // for. Refusing a restore on them would strand a review that could have
    // come back fine.
    const items = restore((pf) => {
      pf.mode = "paused";
      pf.claude = { found: false, path: null, source: "path" };
      pf.skill = { installed: false, outdated: false };
      pf.curl = { ok: false, version: "7.88.1" };
    });
    expect(items).toEqual([]);
  });

  it("reports every blocker at once, blockers first", () => {
    // A reviewer with two faults should see both, not fix one and discover the
    // next on the following click.
    const items = restore((pf) => {
      pf.codex = {
        found: false,
        path: null,
        source: "path",
        usable: false,
        signedIn: false,
      };
    }, false);
    expect(items.map((i) => i.id)).toEqual([
      "codex-missing",
      "codex-hook-missing",
    ]);
    expect(items.every((i) => i.state === "blocked")).toBe(true);
  });
});
