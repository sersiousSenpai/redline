// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  buildOrchestrateLaunchCommand,
  buildOrchestratePrompt,
  buildPlanLaunchCommand,
} from "./planLaunchCommand";

describe("buildPlanLaunchCommand", () => {
  const ALLOW = "--allowedTools Read Grep Glob WebSearch WebFetch Bash";

  it("launches a fresh Claude session in plan mode with the prompt as one arg", () => {
    const cmd = buildPlanLaunchCommand("Draft a motion to dismiss.");
    expect(cmd).toBe(
      `claude ${ALLOW} --permission-mode plan 'Draft a motion to dismiss.'`,
    );
  });

  it("pre-approves read-only research tools + Bash before the prompt arg", () => {
    // The variadic --allowedTools list is terminated by --permission-mode, so
    // the prompt stays the sole positional argument.
    const cmd = buildPlanLaunchCommand("hi");
    expect(cmd).toBe(
      "claude --allowedTools Read Grep Glob WebSearch WebFetch Bash " +
        "--permission-mode plan 'hi'",
    );
  });

  it("cd's into the chosen project before launching", () => {
    const cmd = buildPlanLaunchCommand("hello", "/Users/me/redline");
    expect(cmd).toBe(
      `cd '/Users/me/redline' && claude ${ALLOW} --permission-mode plan 'hello'`,
    );
  });

  it("omits the cd when no project path is given", () => {
    expect(buildPlanLaunchCommand("hello", null)).toMatch(
      /^claude --allowedTools Read Grep Glob WebSearch WebFetch Bash --permission-mode plan /,
    );
    expect(buildPlanLaunchCommand("hello")).toMatch(
      /^claude --allowedTools Read Grep Glob WebSearch WebFetch Bash --permission-mode plan /,
    );
  });

  it("preserves a multi-paragraph markdown prompt as a single quoted arg", () => {
    const prompt = "# Brief\n\nFirst point.\n\n- a\n- b\n\nSecond point.";
    const cmd = buildPlanLaunchCommand(prompt);
    // The entire body sits inside one pair of single quotes (newlines and all),
    // so the shell hands Claude exactly one argument.
    expect(cmd).toBe(`claude ${ALLOW} --permission-mode plan '${prompt}'`);
  });

  it("escapes single quotes in the prompt for POSIX shells", () => {
    const cmd = buildPlanLaunchCommand("it's a test");
    expect(cmd).toContain(`plan 'it'\\''s a test'`);
  });

  it("escapes single quotes in the project path", () => {
    const cmd = buildPlanLaunchCommand("hi", "/tmp/o'brien");
    expect(cmd).toContain(`cd '/tmp/o'\\''brien' && claude`);
  });
});

describe("buildOrchestrateLaunchCommand", () => {
  it("builds a bare acceptEdits launch that carries no prompt", () => {
    const cmd = buildOrchestrateLaunchCommand("/Users/me/redline", "sonnet");
    expect(cmd).toBe(
      "cd '/Users/me/redline' && claude --permission-mode acceptEdits --model 'sonnet'",
    );
    // The Workflow opt-in is origin-gated: the prompt is typed later, never
    // passed as an argv positional.
    expect(cmd).not.toContain("ultracode");
    expect(cmd).not.toContain("Redline session");
  });

  it("omits the cd when no project path is given", () => {
    expect(buildOrchestrateLaunchCommand(null, "sonnet")).toBe(
      "claude --permission-mode acceptEdits --model 'sonnet'",
    );
  });

  it("quotes the model and path through shq", () => {
    const cmd = buildOrchestrateLaunchCommand("/tmp/o'brien", "sonnet");
    expect(cmd).toContain(`cd '/tmp/o'\\''brien' && claude`);
    expect(cmd).toContain(`--model 'sonnet'`);
  });
});

describe("buildOrchestratePrompt", () => {
  it("is a single line — Enter submits typed input", () => {
    const prompt = buildOrchestratePrompt("abc-123");
    expect(prompt).not.toContain("\n");
    expect(prompt).not.toContain("\r");
  });

  it("opens with the ultracode keyword and asks for a multi-agent workflow", () => {
    const prompt = buildOrchestratePrompt("abc-123");
    // Keyword + natural-language ask are each a sufficient Workflow opt-in.
    expect(prompt.startsWith("ultracode:")).toBe(true);
    expect(prompt).toContain("as a multi-agent workflow");
  });

  it("embeds the pre-authorized plan-fetch curl for the session", () => {
    const prompt = buildOrchestratePrompt("abc-123");
    expect(prompt).toContain(
      'curl -s "http://127.0.0.1:7676/v1/sessions/abc-123/plan"',
    );
    expect(prompt).toContain("rawPlanMarkdown");
  });

  it("points at the orchestrate skill for the execution discipline", () => {
    expect(buildOrchestratePrompt("abc-123")).toContain("orchestrate skill");
  });
});
