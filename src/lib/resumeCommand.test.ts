// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  buildResumeCommand,
  CODEX_PLAN_PROFILE,
  RESTORE_ENV,
  RESTORE_SEAT,
  restoreSentinel,
} from "./resumeCommand";

const NOW = new Date(2026, 5, 12, 18, 7); // 2026-06-12 18:07 local

/** The prompt as the model sees it: the last shell-quoted argument, unquoted.
 *  Asserting on the whole command would let an env assignment or a flag satisfy
 *  a claim about what the CONVERSATION shows. */
const visiblePrompt = (cmd: string): string => {
  const marker = "--permission-mode plan '";
  const i = cmd.indexOf(marker);
  if (i === -1) throw new Error(`no quoted prompt in: ${cmd}`);
  return cmd.slice(i + marker.length, -1).replace(/'\\''/g, "'");
};

describe("buildResumeCommand", () => {
  it("resumes the exact session in plan mode", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toContain("claude --resume 'abc-123' --permission-mode plan ");
  });

  it("is ONE compact, timestamped control event — not a paragraph", () => {
    // A resumed session replays its earlier user turns, so every prior restore
    // of this plan is on screen beside the new one. When each was a paragraph
    // of protocol, two genuine restores read as one accidental double-send.
    // The protocol still reaches the model — as hidden `additionalContext` from
    // the prompt-ingest route (`restore_context.rs`) — it just stops being
    // presented as something the user said.
    for (const primed of [true, false]) {
      const cmd = buildResumeCommand("abc-123", NOW, null, false, primed);
      const prompt = visiblePrompt(cmd);
      expect(prompt.startsWith("Redline restore · 2026-06-12 18:07 — ")).toBe(
        true,
      );
      // The paragraph that used to live here, by its load-bearing phrases.
      expect(prompt).not.toContain("This plan was reopened in Redline");
      expect(prompt).not.toContain("do NOT fetch, read or retype");
      expect(prompt).not.toContain("do not explore the codebase");
      // One line, and a short one.
      expect(prompt).not.toContain("\n");
      expect(prompt.length).toBeLessThan(320);
    }
  });

  it("marks the process so the hook can hand the model the real protocol", () => {
    // The capture hook is a COMMAND hook: it runs inside the resumed claude's
    // environment and expands these into headers. Prefix assignments, not
    // `export` — the marking must die with the process.
    const primed = buildResumeCommand("abc-123", NOW, null, false, true);
    expect(primed).toContain(`${RESTORE_ENV.seat}='${RESTORE_SEAT}' `);
    expect(primed).toContain(`${RESTORE_ENV.target}='abc-123' `);
    expect(primed).toContain(`${RESTORE_ENV.primed}=1 `);
    expect(primed).toContain(`${RESTORE_ENV.rescinded}=0 `);
    expect(primed).not.toContain("export ");
    // …and the two facts track what was actually asked for.
    const plain = buildResumeCommand("abc-123", NOW, null, true, false);
    expect(plain).toContain(`${RESTORE_ENV.primed}=0 `);
    expect(plain).toContain(`${RESTORE_ENV.rescinded}=1 `);
    // The assignments sit on the claude invocation, after any cd.
    const withCd = buildResumeCommand("abc-123", NOW, "/p");
    expect(withCd).toMatch(
      new RegExp(`^cd '/p' && ${RESTORE_ENV.seat}='${RESTORE_SEAT}' `),
    );
  });

  it("stands alone when the hidden context never arrives", () => {
    // Redline closed, hook uninstalled, arming expired: the visible trigger is
    // all the model gets, so it has to be enough on its own. Hidden context is
    // an improvement, never a dependency.
    const unprimed = visiblePrompt(buildResumeCommand("abc-123", NOW));
    expect(unprimed).toContain(restoreSentinel("abc-123"));
    expect(unprimed).toContain("call ExitPlanMode");
    expect(unprimed).toContain("Enter plan mode first");

    const primed = visiblePrompt(
      buildResumeCommand("abc-123", NOW, null, false, true),
    );
    expect(primed).toContain("call ExitPlanMode now");
    expect(primed).toContain("Enter plan mode first");
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
    const primed = visiblePrompt(
      buildResumeCommand("abc-123", NOW, null, false, true),
    );
    expect(primed).toContain("call ExitPlanMode now, as your very first action");
    // No Write step to pay for — and no marker to spell out, because the file
    // already holds it. (The hidden context names it for the "somehow not
    // there" case; the visible line does not spend a clause on it.)
    expect(primed).not.toContain("write exactly");
    expect(primed).not.toContain("then call ExitPlanMode");
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
      // A one-clause fallback, not an instruction to open with.
      expect(cmd).toContain("(Enter plan mode first if you are not in it.)");
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
    // Stays VISIBLE rather than riding only the hidden context: it is one of
    // the things the trigger has to be able to say on its own.
    const rescinded = buildResumeCommand("abc-123", NOW, null, true);
    expect(rescinded).toContain("stand-down in your context is void");
    expect(rescinded).toContain(`${RESTORE_ENV.rescinded}=1 `);
    const plain = buildResumeCommand("abc-123", NOW, null);
    expect(plain).not.toContain("stand-down in your context is void");
    expect(plain).toContain(`${RESTORE_ENV.rescinded}=0 `);
  });

  it("stamps the prompt so replayed history doesn't read as a duplicate send", () => {
    const cmd = buildResumeCommand("abc-123", NOW);
    expect(cmd).toContain("Redline restore · 2026-06-12 18:07 — ");
    // A later restore of the same session produces a visibly different event,
    // so the replay reads as two restores rather than one double-send.
    const later = buildResumeCommand("abc-123", new Date(2026, 5, 13, 9, 30));
    expect(later).not.toEqual(cmd);
    expect(later).toContain("Redline restore · 2026-06-13 09:30 — ");
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
    expect(cmd).toMatch(/^cd '\/Users\/me\/redline' && /);
    expect(cmd).toContain("claude --resume 'abc-123' ");
  });

  it("escapes single quotes in the project path", () => {
    const cmd = buildResumeCommand("abc-123", NOW, "/tmp/o'brien");
    expect(cmd).toContain(`cd '/tmp/o'\\''brien' && ${RESTORE_ENV.seat}=`);
  });

  it("omits the cd when no project path is known", () => {
    const cmd = buildResumeCommand("abc-123", NOW, null);
    expect(cmd).not.toContain("cd '");
    expect(cmd.startsWith(RESTORE_ENV.seat)).toBe(true);
  });
});

describe("buildResumeCommand — the codex arm", () => {
  const BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const codex = { backend: "codex", codexBin: BIN };

  it("resumes the codex thread with the absolute binary", () => {
    const cmd = buildResumeCommand("thr_abc", NOW, "/p", false, false, codex);
    expect(cmd.startsWith(`cd '/p' && '${BIN}' resume 'thr_abc' `)).toBe(true);
  });

  it("never sends a codex thread id down `claude --resume`", () => {
    // It does not error — it silently starts a FRESH session, which then
    // writes the sentinel under an id Redline never held. That surfaces as a
    // phantom new plan showing literal sentinel text.
    const cmd = buildResumeCommand("thr_abc", NOW, "/p", false, false, codex);
    expect(cmd).not.toContain("claude");
    expect(cmd).not.toContain("--permission-mode");
  });

  it("comes back read-only — a restore must not be able to edit the repo", () => {
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, codex);
    expect(cmd).toContain("-s read-only -a never");
  });

  it("asks for the sentinel inside a proposed_plan block, not a plan file", () => {
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, codex);
    expect(cmd).toContain("<proposed_plan><!-- REDLINE_RESTORE:thr_abc --></proposed_plan>");
    // Codex has neither of the Claude mechanics.
    expect(cmd).not.toContain("ExitPlanMode");
    expect(cmd).not.toContain("plan file");
  });

  it("ignores `primed` — there is no plan file to have primed", () => {
    expect(buildResumeCommand("thr_abc", NOW, null, false, true, codex)).toBe(
      buildResumeCommand("thr_abc", NOW, null, false, false, codex),
    );
  });

  it("still carries the rescind sentence and the stamp", () => {
    const cmd = buildResumeCommand("thr_abc", NOW, null, true, false, codex);
    expect(cmd).toContain("stand-down in your context is void");
    expect(cmd).toContain("Redline restore · 2026-06-12 18:07 — ");
  });

  it("degrades to the bare name rather than an empty argument", () => {
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, {
      backend: "codex",
      codexBin: null,
    });
    expect(cmd.startsWith("'codex' resume ")).toBe(true);
  });

  it("resumes under the Redline plan profile", () => {
    // `codex -p redline-plan` is what carries the plan contract as
    // `developer_instructions`. A missing/renamed profile is NOT an error —
    // codex ignores it — so the resumed session would run with no contract at
    // all, silently.
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, codex);
    expect(cmd).toContain(`-p '${CODEX_PLAN_PROFILE}'`);
    expect(CODEX_PLAN_PROFILE).toBe("redline-plan");
  });

  it("asks for the sentinel and NOTHING else", () => {
    // Redline already holds the authoritative plan and re-presents its own
    // copy. Every extra step here is a model round trip against a resumed
    // session's full context, bought for a body that gets ignored — so the
    // trigger ends the turn rather than opening an investigation.
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, codex);
    expect(cmd).toContain("end this turn immediately");
    expect(cmd).toContain("nothing else — no preamble, no tool calls");
    expect(cmd).toContain("ignores what you submit");
    // Self-contained: it never sends Codex back to Redline for anything. The
    // plan sandbox has no network, so a fetch instruction could only ever fail
    // — and Codex fires no UserPromptSubmit hook, so there is no hidden-context
    // channel to lean on either. What is here is all there is.
    expect(cmd).not.toContain("curl");
    expect(cmd).not.toContain("127.0.0.1");
    expect(cmd).not.toContain("/v1/sessions/");
    // …and no environment prefix: the restore seat + headers are the Claude
    // arm's mechanism for reaching the prompt-ingest hook, which Codex has not.
    expect(cmd.startsWith("'")).toBe(true);
    expect(cmd).not.toContain("REDLINE_AGENT_SEAT");
  });

  it("inherits the resumed conversation's model rather than forcing one", () => {
    // A `--model` here would silently re-plan the restore on a different model
    // than the conversation was built with, for a submission that is a marker.
    const cmd = buildResumeCommand("thr_abc", NOW, null, false, false, codex);
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-m ");
  });

  it("escapes the binary path and the thread id for POSIX shells", () => {
    const cmd = buildResumeCommand("thr'x", NOW, "/tmp/o'brien", false, false, {
      backend: "codex",
      codexBin: "/Apps/Cha't/codex",
    });
    expect(cmd).toContain(`cd '/tmp/o'\\''brien' && `);
    expect(cmd).toContain(`'/Apps/Cha'\\''t/codex' resume 'thr'\\''x'`);
  });

  it("leaves the claude command byte-identical when the backend is absent", () => {
    expect(buildResumeCommand("abc-123", NOW, "/p", false, false, {})).toBe(
      buildResumeCommand("abc-123", NOW, "/p"),
    );
    expect(
      buildResumeCommand("abc-123", NOW, "/p", false, false, {
        backend: "claude-code",
      }),
    ).toBe(buildResumeCommand("abc-123", NOW, "/p"));
  });
});

