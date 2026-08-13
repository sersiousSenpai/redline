// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  CLAUDE_READY,
  deliverToTerminal,
  orchestrateHandoff,
  type HandoffResult,
  type OrchestrateDeps,
  type OrchestrateTiming,
} from "./terminalHandoff";

/** Microsecond-scale timing so every path runs in-process. */
const FAST: OrchestrateTiming = {
  spawnTimeoutMs: 50,
  readyTimeoutMs: 10,
  readyFallbackMs: 1,
  claimTimeoutMs: 4,
  claimPollMs: 2,
  maxPromptRetries: 2,
};

interface FakeOptions {
  spawn?: () => Promise<void>;
  live?: boolean;
  ready?: boolean;
  /** Sequence of run states the poller sees (last value repeats). */
  runStates?: (string | null)[];
  failWriteMatching?: RegExp;
}

function makeFake(opts: FakeOptions = {}) {
  const writes: string[] = [];
  const journal: string[] = [];
  let rearms = 0;
  let stateCursor = 0;
  const deps: OrchestrateDeps = {
    whenSpawned: () => (opts.spawn ? opts.spawn() : Promise.resolve()),
    isLive: () => Promise.resolve(opts.live ?? false),
    writeChecked: (_id, data) => {
      if (opts.failWriteMatching?.test(data)) {
        return Promise.reject(new Error("terminal tab-x is not running"));
      }
      writes.push(data);
      return Promise.resolve();
    },
    awaitOutput: (_id, _re, _t) => Promise.resolve(opts.ready ?? true),
    journal: (stage, detail) => journal.push(detail ? `${stage}:${detail}` : stage),
    sleep: () => Promise.resolve(),
    getRunState: () => {
      const states = opts.runStates ?? ["running"];
      const s = states[Math.min(stateCursor, states.length - 1)];
      stateCursor += 1;
      return Promise.resolve(s);
    },
    rearm: () => {
      rearms += 1;
      return Promise.resolve();
    },
  };
  return { deps, writes, journal, rearms: () => rearms };
}

function run(deps: OrchestrateDeps): Promise<HandoffResult> {
  return orchestrateHandoff(deps, "tab-1", "sid-1", "claude --model x", "ultracode: go", FAST);
}

describe("deliverToTerminal", () => {
  it("delivers once the spawn resolves, even when it resolves late", async () => {
    // openSessionTerminal returns before mount — a caller may await the
    // spawn before the TerminalView for that id even exists.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const fake = makeFake({ spawn: () => gate });
    const p = deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "npm run dev\r" },
    ]);
    release();
    expect(await p).toEqual({ ok: true });
    expect(fake.writes).toEqual(["npm run dev\r"]);
    expect(fake.journal).toContain("handoff_spawned");
    expect(fake.journal).toContain("handoff_launch_written");
  });

  it("fails at stage spawn when the terminal never comes up", async () => {
    const fake = makeFake({
      spawn: () => Promise.reject(new Error("terminal tab-1 did not spawn within 50ms")),
      live: false,
    });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("spawn");
      expect(r.reason).toContain("did not spawn");
    }
    expect(fake.writes).toEqual([]);
  });

  it("believes the live registry over a stale spawn signal", async () => {
    // A failed first mount whose remount succeeded leaves the deferred
    // rejected while the PTY is alive — the registry is ground truth.
    const fake = makeFake({
      spawn: () => Promise.reject(new Error("stale")),
      live: true,
    });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
    ]);
    expect(r).toEqual({ ok: true });
    expect(fake.writes).toEqual(["claude\r"]);
  });

  it("falls back to a settle and still writes when the marker never appears", async () => {
    const fake = makeFake({ ready: false });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      {
        stage: "prompt",
        data: "hello\r",
        awaitBefore: CLAUDE_READY,
        awaitTimeoutMs: 5,
        fallbackSettleMs: 1,
      },
    ]);
    expect(r).toEqual({ ok: true });
    expect(fake.writes).toEqual(["hello\r"]);
  });

  it("surfaces a rejected write as a stage failure", async () => {
    const fake = makeFake({ failWriteMatching: /hello/ });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
      { stage: "prompt", data: "hello\r" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("prompt");
      expect(r.reason).toContain("not running");
    }
    expect(fake.writes).toEqual(["claude\r"]);
  });
});

describe("orchestrateHandoff", () => {
  it("succeeds when the ingest claim advances the run state", async () => {
    const fake = makeFake({ runStates: ["orchestrating", "running"] });
    expect(await run(fake.deps)).toEqual({ ok: true });
    // launch + one prompt write, no retries needed.
    expect(fake.writes).toEqual(["claude --model x\r", "ultracode: go\r"]);
    expect(fake.rearms()).toBe(0);
  });

  it("misses the readiness marker, falls back, and still delivers", async () => {
    const fake = makeFake({ ready: false, runStates: ["running"] });
    expect(await run(fake.deps)).toEqual({ ok: true });
    expect(fake.writes).toEqual(["claude --model x\r", "ultracode: go\r"]);
  });

  it("retries the prompt (re-arming first) and fails at stage prompt when the claim never fires", async () => {
    const fake = makeFake({ runStates: ["orchestrating"] });
    const r = await run(fake.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("prompt");
      expect(r.reason).toContain("never left 'orchestrating'");
    }
    // 1 launch + 3 prompt attempts (initial + maxPromptRetries).
    expect(fake.writes.filter((w) => w.startsWith("ultracode"))).toHaveLength(3);
    // Every retry re-armed the consume-once, TTL-bounded guards.
    expect(fake.rearms()).toBe(2);
    expect(fake.journal).toContain("handoff_prompt_written:attempt 3");
    expect(fake.journal.some((j) => j.startsWith("handoff_failed:prompt"))).toBe(true);
  });

  it("a retry that recovers reports success", async () => {
    // First attempt's window sees only `orchestrating`; the claim lands
    // during the second attempt.
    const fake = makeFake({
      runStates: ["orchestrating", "orchestrating", "running"],
    });
    expect(await run(fake.deps)).toEqual({ ok: true });
    expect(fake.rearms()).toBe(1);
  });

  it("fails at stage prompt when the prompt write itself is refused", async () => {
    const fake = makeFake({ failWriteMatching: /ultracode/ });
    const r = await run(fake.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("prompt");
  });

  it("fails at stage launch when the launch write is refused", async () => {
    const fake = makeFake({ failWriteMatching: /claude --model/ });
    const r = await run(fake.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("launch");
  });
});

// The readiness marker, pinned against REAL boot output per CLI generation.
// 2.1.222 printed none of the original hints, so every orchestrate burned the
// full ready timeout before the fallback typed — a 30s stall the user read as
// "it didn't work". A new CLI banner belongs HERE the day it appears.
describe("CLAUDE_READY marker", () => {
  it("matches the v2.x boot banner and the persistent mode bar", () => {
    expect(CLAUDE_READY.test("Claude Code v2.1.222")).toBe(true);
    expect(
      CLAUDE_READY.test("accept edits on (shift+tab to cycle) · ← 1 agent"),
    ).toBe(true);
    expect(
      CLAUDE_READY.test("plan mode on (shift+tab to cycle) · ← 1 agent"),
    ).toBe(true);
  });

  it("still matches the older generation's hints", () => {
    expect(CLAUDE_READY.test("? for shortcuts")).toBe(true);
    expect(CLAUDE_READY.test("Welcome to Claude Code")).toBe(true);
    expect(CLAUDE_READY.test("╭────────────╮")).toBe(true);
  });

  it("never matches the pre-TUI screen: echoed launch command or the zsh banner", () => {
    expect(
      CLAUDE_READY.test(
        "cd '/Users/x/repo' && claude --permission-mode acceptEdits --model 'sonnet'",
      ),
    ).toBe(false);
    expect(CLAUDE_READY.test("Restored session: Wed Aug 12 03:23:51 PDT 2026")).toBe(
      false,
    );
    expect(CLAUDE_READY.test("yusufalbazian@Yusufs-MacBook-Pro qwallah %")).toBe(
      false,
    );
  });
});
