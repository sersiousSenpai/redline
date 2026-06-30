// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildResumeCommand, restoreSentinel } from "./resumeCommand";

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
    // The marker carries the held plan's session id so the daemon can rebind
    // the restore even when the handshake lands under a forked/foreign id.
    expect(cmd).toContain(restoreSentinel("abc-123"));
    expect(cmd).toContain("<!-- REDLINE_RESTORE:abc-123 -->");
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

  it("cd's into the project dir so resume resolves wherever it's pasted", () => {
    // Claude scopes resumable sessions per project; without the cd, `--resume`
    // from another cwd fails ("No conversation found") and spawns a fresh
    // session that writes the sentinel under an unheld id.
    const cmd = buildResumeCommand("abc-123", NOW, "/Users/me/redline");
    expect(cmd).toMatch(
      /^cd '\/Users\/me\/redline' && claude --resume 'abc-123' /,
    );
  });

  it("escapes single quotes in the project path", () => {
    const cmd = buildResumeCommand("abc-123", NOW, "/tmp/o'brien");
    expect(cmd).toContain(`cd '/tmp/o'\\''brien' && claude`);
  });

  it("omits the cd when no project path is known", () => {
    const cmd = buildResumeCommand("abc-123", NOW, null);
    expect(cmd).toMatch(/^claude --resume /);
  });
});
