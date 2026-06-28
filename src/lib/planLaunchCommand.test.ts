// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildPlanLaunchCommand } from "./planLaunchCommand";

describe("buildPlanLaunchCommand", () => {
  it("launches a fresh Claude session in plan mode with the prompt as one arg", () => {
    const cmd = buildPlanLaunchCommand("Draft a motion to dismiss.");
    expect(cmd).toBe(
      "claude --permission-mode plan 'Draft a motion to dismiss.'",
    );
  });

  it("cd's into the chosen project before launching", () => {
    const cmd = buildPlanLaunchCommand("hello", "/Users/me/redline");
    expect(cmd).toMatch(
      /^cd '\/Users\/me\/redline' && claude --permission-mode plan 'hello'$/,
    );
  });

  it("omits the cd when no project path is given", () => {
    expect(buildPlanLaunchCommand("hello", null)).toMatch(
      /^claude --permission-mode plan /,
    );
    expect(buildPlanLaunchCommand("hello")).toMatch(
      /^claude --permission-mode plan /,
    );
  });

  it("preserves a multi-paragraph markdown prompt as a single quoted arg", () => {
    const prompt = "# Brief\n\nFirst point.\n\n- a\n- b\n\nSecond point.";
    const cmd = buildPlanLaunchCommand(prompt);
    // The entire body sits inside one pair of single quotes (newlines and all),
    // so the shell hands Claude exactly one argument.
    expect(cmd).toBe(`claude --permission-mode plan '${prompt}'`);
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
