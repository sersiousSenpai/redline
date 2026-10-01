import { describe, expect, it, vi } from "vitest";
import { integrationNeedsRepair, integrationVerified, repairIntegration } from "./integrationSetup";
import type { PreflightStatus } from "./readiness";

function health(): PreflightStatus {
  return { claude: { found: true, path: "/claude", source: "test" }, curl: { ok: true, version: null }, mode: "active", hook: { installed: true, conflictingUrl: null }, skill: { installed: true, outdated: false }, codex: { found: true, path: "/codex", source: "test", usable: true, signedIn: true, profile: { installed: true, outdated: false, path: "/profile" } }, codexHook: { installed: true, available: true, stopFound: true, promptCaptureFound: true, hooksPath: "/hooks", trust: "trusted" }, codexSkill: { installed: true, outdated: false } };
}
describe("selected harness setup", () => {
  it("withholds unknown health and never uses Claude's healthy state for Codex", () => {
    expect(integrationNeedsRepair("codex", null)).toBe(false);
    const value = health(); value.codexHook!.installed = false;
    expect(integrationNeedsRepair("codex", value)).toBe(true);
    expect(integrationNeedsRepair("claude-code", value)).toBe(false);
  });
  it("does not declare untrusted or unverifiable hooks ready", () => {
    const value = health();
    for (const trust of ["needs-review", "unknown"] as const) { value.codexHook!.trust = trust; expect(integrationVerified("codex", value)).toBe(false); }
  });
  it("prompts for a signed-out Codex account even when files are current", () => {
    const value = health(); value.codex!.authState = "signed-out"; value.codex!.signedIn = false;
    expect(integrationNeedsRepair("codex", value)).toBe(true);
    expect(integrationVerified("codex", value)).toBe(false);
  });
  it("repairs independent components and verifies even after a failed write", async () => {
    const calls: string[] = []; const verify = vi.fn(async () => health());
    const result = await repairIntegration("codex", async step => { calls.push(step.command); if (step.command === "install_codex_hook") throw new Error("read-only directory"); }, verify, () => {});
    expect(calls).toEqual(["install_codex_hook", "install_codex_profile", "install_codex_skill"]);
    expect(verify).toHaveBeenCalledOnce(); expect(result.verified).toBe(false);
    expect(result.errors[0]).toContain("read-only directory");
  });
  it("does not resume when post-install verification fails", async () => {
    const result = await repairIntegration("codex", async () => {}, async () => { throw new Error("probe timed out"); }, () => {});
    expect(result.verified).toBe(false); expect(result.health).toBeNull();
    expect(result.errors).toContain("Verification failed: Error: probe timed out");
  });
});
