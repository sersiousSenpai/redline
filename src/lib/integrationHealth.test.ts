// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import {
  makeHealthService,
  type HealthProbe,
  type HealthQuery,
  type IntegrationHealth,
} from "./integrationHealth";

const CLAUDE: HealthQuery = { backend: "claude-code", extension: false };
const CODEX: HealthQuery = { backend: "codex", extension: false };
const EXT: HealthQuery = { backend: "claude-code", extension: true };

function health(tag: string): IntegrationHealth {
  return {
    preflight: {
      claude: { found: true, path: `/bin/${tag}`, source: "probe" },
      curl: { ok: true, version: "8.7.1" },
      mode: "active",
      hook: { installed: true, conflictingUrl: null },
      skill: { installed: true, outdated: false },
    },
    hook: {
      installed: true,
      settingsPath: "/s.json",
      matcherFound: true,
      conflictingUrl: null,
    },
    skill: { installed: true, skillPath: "/k.md", outdated: false, version: 8 },
    codexHook: null,
    codexSkill: null,
  };
}

/** A probe that never resolves until told to, so "did these two callers share
 *  one execution" is observable rather than a race. */
function deferredProbe() {
  const calls: { query: HealthQuery; resolve: (h: IntegrationHealth) => void; reject: (e: unknown) => void }[] =
    [];
  const probe: HealthProbe = (query) =>
    new Promise<IntegrationHealth>((resolve, reject) => {
      calls.push({ query, resolve, reject });
    });
  return { probe, calls };
}

describe("integration health", () => {
  it("concurrent askers of the same question share one probe", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const a = service.ensure(CLAUDE, 1000);
    const b = service.ensure(CLAUDE, 1000);
    const c = service.ensure(CLAUDE, 1000);
    expect(calls, "boot, focus and the launch gate must not each probe").toHaveLength(
      1,
    );
    calls[0].resolve(health("one"));
    expect(await a).toBe(await b);
    expect(await b).toBe(await c);
  });

  it("a different question is a different probe, never a stale hit", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    void service.ensure(CLAUDE, 1000);
    void service.ensure(CODEX, 1000);
    void service.ensure(EXT, 1000);
    // Handing a Codex asker an answer probed with no codex in it is exactly
    // the bug that scoping the probe introduces if the key is ignored.
    expect(calls.map((c) => c.query.backend)).toEqual([
      "claude-code",
      "codex",
      "claude-code",
    ]);
    expect(calls.map((c) => c.query.extension)).toEqual([false, false, true]);
  });

  it("a fresh answer is reused; a stale one is re-probed", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe, 30_000);
    const first = service.ensure(CLAUDE, 1_000);
    calls[0].resolve(health("one"));
    await first;

    await service.ensure(CLAUDE, 20_000);
    expect(calls, "inside the window: no new probe").toHaveLength(1);

    void service.ensure(CLAUDE, 40_000);
    expect(calls, "past the window: probe again").toHaveLength(2);
  });

  it("refresh probes even when the answer is fresh", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const first = service.ensure(CLAUDE, 1_000);
    calls[0].resolve(health("one"));
    await first;
    void service.refresh(CLAUDE, 1_000);
    expect(calls).toHaveLength(2);
  });

  it("a failed probe caches nothing — the next asker tries again", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const failed = service.ensure(CLAUDE, 1_000);
    calls[0].reject(new Error("no such command"));
    await expect(failed).rejects.toThrow("no such command");
    void service.ensure(CLAUDE, 1_001);
    expect(calls, "a silence must not be cached as an answer").toHaveLength(2);
  });

  it("every sharer of a failed probe sees the rejection", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const a = service.ensure(CLAUDE, 1_000);
    const b = service.ensure(CLAUDE, 1_000);
    calls[0].reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
  });

  it("invalidate drops the cache — an install just changed the answer", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const first = service.ensure(CLAUDE, 1_000);
    calls[0].resolve(health("before"));
    await first;
    service.invalidate();
    void service.ensure(CLAUDE, 1_001);
    expect(
      calls,
      "serving the pre-install answer tells the user their fix did nothing",
    ).toHaveLength(2);
  });

  it("peek reads without probing", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    expect(service.peek(CLAUDE, 1_000)).toBe(null);
    expect(calls, "peek must never start work").toHaveLength(0);
    const first = service.ensure(CLAUDE, 1_000);
    calls[0].resolve(health("one"));
    await first;
    expect(service.peek(CLAUDE, 1_000)?.preflight.claude.path).toBe("/bin/one");
    expect(service.peek(CODEX, 1_000), "wrong question, no answer").toBe(null);
    expect(service.peek(CLAUDE, 99_000), "stale, no answer").toBe(null);
  });

  it("refresh joins an in-flight probe of the same question", async () => {
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const a = service.ensure(CLAUDE, 1_000);
    const b = service.refresh(CLAUDE, 1_000);
    expect(
      calls,
      "a focus refresh landing mid-boot must not spawn a second child process",
    ).toHaveLength(1);
    calls[0].resolve(health("one"));
    expect(await a).toBe(await b);
  });

  it("invalidate disowns an in-flight probe, not just the cache", async () => {
    // The install path: probe starts, the user installs the hook, we
    // invalidate + refresh. Joining the pre-install probe — or letting it land
    // in the cache — would report the fix as having done nothing.
    const { probe, calls } = deferredProbe();
    const service = makeHealthService(probe);
    const before = service.ensure(CLAUDE, 1_000);
    service.invalidate();
    const after = service.refresh(CLAUDE, 1_000);
    expect(calls, "refresh must start a real probe after invalidate").toHaveLength(
      2,
    );
    // The stale probe answers LAST, which is the dangerous ordering.
    calls[1].resolve(health("after-install"));
    expect((await after).preflight.claude.path).toBe("/bin/after-install");
    calls[0].resolve(health("before-install"));
    await before;
    expect(
      service.peek(CLAUDE, 1_000)?.preflight.claude.path,
      "a probe from before the change must never become the cached answer",
    ).toBe("/bin/after-install");
  });

  it("the service never swallows a probe error into a silent success", async () => {
    const probe = vi.fn(async () => {
      throw new Error("preflight_status failed");
    });
    const service = makeHealthService(probe);
    await expect(service.ensure(CLAUDE, 1_000)).rejects.toThrow(
      "preflight_status failed",
    );
    expect(service.peek(CLAUDE, 1_000)).toBe(null);
  });
});
