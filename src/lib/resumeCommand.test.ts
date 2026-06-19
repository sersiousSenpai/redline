// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildResumeCommand, REDLINE_RESTORE_SENTINEL } from "./resumeCommand";

const NOW = new Date(2026, 5, 12, 18, 7); // 2026-06-12 18:07 local

describe("buildResumeCommand", () => {
  it("resumes the exact session in plan mode", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toMatch(/^claude --resume 'abc-123' --permission-mode plan /);
  });

  it("tells Claude to re-establish plan mode without fetching or retyping the plan", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    // The old prompt claimed the resumed session was already in plan mode; it
    // isn't, which forced an expensive recovery dance.
    expect(cmd).not.toContain("already in plan mode");
    expect(cmd).toContain("not in plan mode");
    // The lightweight sequence: EnterPlanMode, drop the marker, ExitPlanMode.
    expect(cmd).toContain("call EnterPlanMode");
    expect(cmd).toContain("call ExitPlanMode");
    expect(cmd).toContain(REDLINE_RESTORE_SENTINEL);
  });

  it("never makes Claude curl the daemon or retype the plan body on restore", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).not.toContain("curl");
    expect(cmd).not.toContain("/v1/sessions/");
    expect(cmd).not.toContain("rawPlanMarkdown");
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
