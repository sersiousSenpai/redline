// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { modelsFor, normalizeChoice, parseBackend, PLAN_BACKENDS, type ModelCatalogs } from "./backendChoice";
import { buildPlanLaunchCommand } from "./planLaunchCommand";
import { buildResumeCommand, shq } from "./resumeCommand";
import { deriveReadiness, providerReadiness, type PreflightStatus, type ProviderProbe } from "./readiness";
import { resolveRestoreHarness } from "./restoreHarness";

const catalog: ModelCatalogs = { "claude-code": [{ slug: "claude-opus-4-7", displayName: "Opus 4.7", description: "Installed", defaultEffort: null, efforts: ["high"] }] };
const probe: ProviderProbe = { found: true, usable: true, path: "/cli/agy", source: "override", identity: "agy-v1", authentication: "signed-in", hook: { installed: true, state: "current", hooksPath: "/hooks.json" }, skill: { installed: true, outdated: false } };
const health: PreflightStatus = { claude: { found: false, path: null, source: "path" }, providers: { antigravity: probe, cursor: probe }, curl: { ok: true, version: "8.7.1" }, mode: "active", hook: { installed: false, conflictingUrl: null }, skill: { installed: false, outdated: false } };

describe("native planning provider contracts", () => {
  it("preserves known provenance and uses independent Claude sidecars", () => {
    for (const backend of ["cursor", "antigravity"] as const) {
      expect(parseBackend(` ${backend.toUpperCase()} `)).toBe(backend);
      expect(resolveRestoreHarness({ backend }).harness).toBe(backend);
      expect(PLAN_BACKENDS[backend].discussion).toBe("claude-sidecar");
    }
    expect(parseBackend("unknown-provider")).toBe("claude-code");
  });
  it("keeps a pinned Claude choice while discovery is pending, then validates the real catalog", () => {
    const choice = { backend: "claude-code" as const, model: "claude-opus-4-7", effort: "high" };
    expect(normalizeChoice(choice, {}).model).toBe(choice.model);
    expect(normalizeChoice(choice, catalog).model).toBe(choice.model);
    expect(modelsFor("claude-code", catalog)[0].label).toBe("Opus 4.7");
    expect(modelsFor("claude-code", {}).map(m => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(normalizeChoice({ ...choice, model: "nonexistent" }, catalog).model).toBeNull();
  });
  it("keeps shell metacharacters inside arguments and binds the actual native workspace", () => {
    const cwd = "/tmp/a'b $(touch NEVER)";
    const prompt = "plan `touch NEVER` and $HOME";
    const command = buildPlanLaunchCommand(prompt, cwd, [], { backend: "antigravity", model: "gemini-test", effort: "high" }, { antigravity: "/cli/agy" }, "launch-one");
    expect(command).toContain(`cd ${shq(cwd)} && REDLINE_PLAN_LAUNCH_ID='launch-one' REDLINE_PROJECT_PATH=${shq(cwd)}`);
    expect(command).toContain(`--add-dir ${shq(cwd)} --model 'gemini-test' --effort 'high' --prompt-interactive`);
    expect(command.endsWith(`${prompt}'`)).toBe(true);
    const cursor = buildPlanLaunchCommand("plan", cwd, [], { backend: "cursor", model: null, effort: "high" }, { cursor: "/cli/agent" });
    expect(cursor).toContain("'/cli/agent' --mode=plan");
    expect(cursor).not.toContain("--effort");
  });
  it("restores the original provider and model/effort without a Claude author resume", () => {
    const now = new Date("2026-09-09T00:00:00Z");
    for (const backend of ["cursor", "antigravity", "codex"] as const) {
      const cmd = buildResumeCommand("conversation-one", now, "/tmp/project", false, false, { backend, model: "chosen-model", effort: "high", cursorBin: "/cli/agent", antigravityBin: "/cli/agy", codexBin: "/cli/codex" });
      expect(cmd).toContain("'chosen-model'");
      expect(cmd).toContain("REDLINE_RESTORE:conversation-one");
      expect(cmd).not.toContain("claude --resume");
      if (backend === "codex") expect(cmd).toContain(`-m 'chosen-model' -c 'model_reasoning_effort="high"' -s read-only -a never`);
      if (backend === "antigravity") expect(cmd).toContain("--conversation 'conversation-one' --mode=plan --add-dir '/tmp/project'");
    }
  });
  it("uses the same selected Claude executable for launch and restore", () => {
    const path = "/Applications/My Claude/bin/claude";
    expect(buildPlanLaunchCommand("plan", "/repo", [], { backend: "claude-code", model: null, effort: null }, { "claude-code": path })).toContain(`${shq(path)} --allowedTools`);
    expect(buildResumeCommand("session", new Date(), "/repo", false, false, { backend: "claude-code", claudeBin: path })).toContain(`${shq(path)} --resume 'session'`);
  });
  it("blocks an extension fallback until the effective Claude integration is ready", () => {
    const rows = deriveReadiness({ preflight: { ...health, claude: { found: true, path: "/cli/claude", source: "override" } }, targetBackend: "cursor", targetIsExtension: true, requireIntegration: true, daemonBound: true, hookModalActive: false, planEverArrived: false, pendingSince: null, now: 1_000, projectCount: 1 });
    const missing = rows.find(row => row.id === "hook-missing");
    expect(missing?.state).toBe("blocked");
    expect(missing?.fix?.backend).toBe("claude-code");
    expect(rows.some(row => row.id === "provider-missing")).toBe(false);
  });
  it("gates the selected provider independently of Claude setup", () => {
    const rows = deriveReadiness({ preflight: health, targetBackend: "antigravity", daemonBound: true, hookModalActive: false, planEverArrived: false, pendingSince: 0, now: 1_000_000, projectCount: 1 });
    expect(rows.filter(row => row.state === "blocked")).toEqual([]);
    const loggedOut = { ...health, providers: { antigravity: { ...probe, authentication: "signed-out" as const } } };
    expect(providerReadiness("antigravity", loggedOut)[0].id).toBe("provider-logged-out");
    expect(providerReadiness("cursor", { ...health, providers: {} })[0].fix?.backend).toBe("cursor");
  });
});
