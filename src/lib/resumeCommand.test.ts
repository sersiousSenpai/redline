// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildResumeCommand } from "./resumeCommand";

describe("buildResumeCommand", () => {
  it("resumes the exact session in plan mode", () => {
    const cmd = buildResumeCommand("abc-123");
    expect(cmd).toMatch(/^claude --resume 'abc-123' --permission-mode plan /);
  });

  it("tells the resumed Claude it is already in plan mode (no EnterPlanMode round-trip)", () => {
    const cmd = buildResumeCommand("abc-123");
    expect(cmd).toContain("already in plan mode");
    expect(cmd).toContain("call ExitPlanMode");
    expect(cmd).not.toContain("re-enter plan mode");
  });

  it("escapes single quotes in the session id for POSIX shells", () => {
    const cmd = buildResumeCommand("we'rd");
    expect(cmd).toContain(`--resume 'we'\\''rd'`);
  });
});
