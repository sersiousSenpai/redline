// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildResumeCommand } from "./resumeCommand";

const NOW = new Date(2026, 5, 12, 18, 7); // 2026-06-12 18:07 local

describe("buildResumeCommand", () => {
  it("resumes the exact session in plan mode", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toMatch(/^claude --resume 'abc-123' --permission-mode plan /);
  });

  it("tells the resumed Claude it is already in plan mode (no EnterPlanMode round-trip)", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toContain("already in plan mode");
    expect(cmd).toContain("call ExitPlanMode");
    expect(cmd).not.toContain("re-enter plan mode");
  });

  it("stamps the prompt so replayed history doesn't read as a duplicate send", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toContain("(Restore requested 2026-06-12 18:07.)");
    // A later restore of the same session produces a visibly different prompt.
    const later = buildResumeCommand("abc-123", new Date(2026, 5, 13, 9, 30));
    expect(later).not.toEqual(cmd);
  });

  it("escapes single quotes in the session id for POSIX shells", () => {
    const cmd = buildResumeCommand("we'rd", NOW);
    expect(cmd).toContain(`--resume 'we'\\''rd'`);
  });
});
