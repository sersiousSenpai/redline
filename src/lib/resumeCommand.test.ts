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

  it("tells Claude to re-establish the hold without fetching or retyping the plan", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    // Un-primed, the model writes the marker itself and exits plan mode.
    // (the prompt is shell-quoted, so an apostrophe would appear escaped)
    expect(cmd).toContain("as your plan file");
    expect(cmd).toContain("call ExitPlanMode");
    // The marker carries the held plan's session id so the daemon can rebind
    // the restore even when the handshake lands under a forked/foreign id.
    expect(cmd).toContain(restoreSentinel("abc-123"));
    expect(cmd).toContain("<!-- REDLINE_RESTORE:abc-123 -->");
  });

  it("asks for ONE tool call once Redline has primed the plan file", () => {
    // Each step of the handshake is a model round trip against a resumed
    // session's full context — 4-6s apiece measured on a 1.7MB transcript.
    // Priming the file in Rust turns three of them into one.
    const primed = buildResumeCommand("abc-123", NOW, null, false, true);
    expect(primed).toContain("already been written for you");
    expect(primed).toContain("Call ExitPlanMode now");
    expect(primed).toContain(restoreSentinel("abc-123"));
    // No Write step to pay for.
    expect(primed).not.toContain("as your plan file");
    // …and no exploring on the way there.
    expect(primed).toContain("do not explore the codebase");
  });

  it("never spends a round trip entering plan mode it is already in", () => {
    // `--permission-mode plan` lands a RESUMED session in plan mode on 2.1.222
    // (it did not on 2.1.178). EnterPlanMode survives only as a conditional
    // fallback, never as an instruction to open with.
    for (const cmd of [
      buildResumeCommand("abc-123", NOW),
      buildResumeCommand("abc-123", NOW, null, false, true),
    ]) {
      expect(cmd).toContain("--permission-mode plan");
      expect(cmd).not.toContain("Just call EnterPlanMode");
      expect(cmd).toContain("If you are not in plan mode, call EnterPlanMode");
    }
  });

  it("never makes Claude curl the daemon or retype the plan body on restore", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).not.toContain("curl");
    expect(cmd).not.toContain("/v1/sessions/");
    expect(cmd).not.toContain("rawPlanMarkdown");
  });

  it("carries the rescission sentence only for an un-approved Orchestrate", () => {
    // The resumed session's context still holds ORCHESTRATE_STAND_DOWN
    // ("this session's work is done"); the restore prompt must void it, or
    // the resumed claude obeys the stale stand-down instead of the restore.
    const rescinded = buildResumeCommand("abc-123", NOW, null, true);
    expect(rescinded).toContain("stand-down in your context is void");
    expect(rescinded).toContain("rescinded that approval");
    const plain = buildResumeCommand("abc-123", NOW, null);
    expect(plain).not.toContain("stand-down in your context is void");
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
