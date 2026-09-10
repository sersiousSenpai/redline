// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  buildOrchestrateLaunchCommand,
  buildOrchestratePrompt,
  buildPlanLaunchCommand,
  tomlString,
} from "./planLaunchCommand";

const CLAUDE = { backend: "claude-code" as const, model: null, effort: null };
const CODEX = { backend: "codex" as const, model: null, effort: null };
const BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";

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

describe("buildPlanLaunchCommand — --add-dir grants", () => {
  const ALLOW = "--allowedTools Read Grep Glob WebSearch WebFetch Bash";

  it("grants each extra dir with its own --add-dir flag", () => {
    const cmd = buildPlanLaunchCommand("hi", "/Users/me/pack", [
      "/repo/src-tauri/crates/redline-extension-abi",
      "/repo/marketplace/redline-extension-template",
    ]);
    expect(cmd).toBe(
      "cd '/Users/me/pack' && claude " +
        "--add-dir '/repo/src-tauri/crates/redline-extension-abi' " +
        "--add-dir '/repo/marketplace/redline-extension-template' " +
        `${ALLOW} --permission-mode plan 'hi'`,
    );
  });

  it("changes nothing when no dirs are granted", () => {
    // The default must stay byte-identical to the pre-A1 command — every
    // existing door launches through this line.
    expect(buildPlanLaunchCommand("hi", "/p", [])).toBe(
      buildPlanLaunchCommand("hi", "/p"),
    );
  });

  it("quotes a granted dir through shq", () => {
    const cmd = buildPlanLaunchCommand("hi", null, ["/tmp/o'brien"]);
    expect(cmd).toContain(`--add-dir '/tmp/o'\\''brien' --allowedTools`);
  });
});

describe("buildPlanLaunchCommand — the claude arm's model/effort", () => {
  const ALLOW = "--allowedTools Read Grep Glob WebSearch WebFetch Bash";

  it("is byte-identical to the legacy command when nothing is chosen", () => {
    // Every existing door launches through this line; a default choice must
    // not move a single byte.
    expect(buildPlanLaunchCommand("hi", "/p", [], CLAUDE)).toBe(
      buildPlanLaunchCommand("hi", "/p"),
    );
  });

  it("puts --model/--effort ahead of the variadic --allowedTools", () => {
    // After it, they would swallow the tool list's terminator.
    const cmd = buildPlanLaunchCommand("hi", null, [], {
      backend: "claude-code",
      model: "opus",
      effort: "high",
    });
    expect(cmd).toBe(
      `claude --model 'opus' --effort 'high' ${ALLOW} --permission-mode plan 'hi'`,
    );
  });

  it("emits only the flag that is set", () => {
    expect(
      buildPlanLaunchCommand("hi", null, [], {
        backend: "claude-code",
        model: "opus",
        effort: null,
      }),
    ).toBe(`claude --model 'opus' ${ALLOW} --permission-mode plan 'hi'`);
    expect(
      buildPlanLaunchCommand("hi", null, [], {
        backend: "claude-code",
        model: null,
        effort: "max",
      }),
    ).toBe(`claude --effort 'max' ${ALLOW} --permission-mode plan 'hi'`);
  });

  it("still grants --add-dir before the model flags", () => {
    const cmd = buildPlanLaunchCommand("hi", null, ["/abi"], {
      backend: "claude-code",
      model: "opus",
      effort: null,
    });
    expect(cmd).toContain("claude --add-dir '/abi' --model 'opus' --allowedTools");
  });
});

describe("buildPlanLaunchCommand — the codex arm", () => {
  it("uses the ABSOLUTE binary, never the bare word", () => {
    // $PATH on a machine with the ChatGPT app usually still resolves `codex`
    // to an older standalone build with no `resume` — it plans once and then
    // fails every restore.
    const cmd = buildPlanLaunchCommand("hi", "/p", [], CODEX, { codex: BIN });
    expect(cmd.startsWith(`cd '/p' && /bin/sh "${'${CODEX_HOME:-$HOME/.codex}'}/redline-codex-launch.sh" '${BIN}' `)).toBe(true);
  });

  it("runs read-only with approvals off — plan mode's physical equivalent", () => {
    const cmd = buildPlanLaunchCommand("hi", null, [], CODEX, { codex: BIN });
    expect(cmd).toContain("-s read-only -a never");
  });

  it("delivers the contract by profile, not on the command line", () => {
    const cmd = buildPlanLaunchCommand("hi", null, [], CODEX, { codex: BIN });
    expect(cmd).toContain("-p 'redline-plan'");
    expect(cmd).not.toContain("developer_instructions");
  });

  it("stays under the tty input queue — the whole reason for the profile", () => {
    // The macOS tty queue is 1024 bytes and DISCARDS the excess silently. The
    // inline-contract version of this command was 6,476 bytes and arrived at
    // zsh truncated at byte 1023, sitting unexecuted with no error anywhere.
    // The prompt can still be long (a Drafter document) — `pty::paced` covers
    // that — but the fixed part of the launch must never be the problem.
    const cmd = buildPlanLaunchCommand("hi", "/Users/me/redline", [], {
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    }, { codex: BIN });
    expect(cmd.length).toBeLessThan(400);
  });

  it("is ONE physical line", () => {
    // A literal newline anywhere in the fixed part would submit the line early
    // and leave the rest as garbage at the prompt.
    const cmd = buildPlanLaunchCommand("hi", null, [], CODEX, { codex: BIN });
    expect(cmd).not.toContain("\n");
  });

  it("quotes the effort as TOML, and omits it when unset", () => {
    const withEffort = buildPlanLaunchCommand(
      "hi",
      null,
      [],
      { backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      { codex: BIN },
    );
    expect(withEffort).toContain(`-m 'gpt-5.6-sol' `);
    expect(withEffort).toContain(`-c 'model_reasoning_effort="xhigh"' `);
    expect(
      buildPlanLaunchCommand("hi", null, [], CODEX, { codex: BIN }),
    ).not.toContain("model_reasoning_effort");
    expect(
      buildPlanLaunchCommand("hi", null, [], CODEX, { codex: BIN }),
    ).not.toContain(" -m ");
  });

  it("keeps the prompt the sole positional, shq-quoted, at the end", () => {
    const cmd = buildPlanLaunchCommand("it's a plan", null, [], CODEX, {
      codex: BIN,
    });
    expect(cmd.endsWith(`'it'\\''s a plan'`)).toBe(true);
  });

  it("never grants --add-dir — that would be a WRITE grant under read-only", () => {
    const cmd = buildPlanLaunchCommand("hi", "/p", ["/abi"], CODEX, {
      codex: BIN,
    });
    expect(cmd).not.toContain("--add-dir");
  });

  it("degrades to the bare name rather than emitting an empty argument", () => {
    expect(buildPlanLaunchCommand("hi", null, [], CODEX, {})).toContain(
      "'codex' ",
    );
    expect(buildPlanLaunchCommand("hi", null, [], CODEX, { codex: "  " })).toContain(
      "'codex' ",
    );
  });
});

describe("tomlString", () => {
  it("escapes what a TOML basic string must escape", () => {
    expect(tomlString("plain")).toBe('"plain"');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString("a\nb")).toBe('"a\\nb"');
    expect(tomlString("a\\b")).toBe('"a\\\\b"');
    expect(tomlString("a\tb")).toBe('"a\\tb"');
  });

  it("quotes values that would otherwise parse as another TOML type", () => {
    // `-c developer_instructions=12345` really does fail with "invalid type:
    // integer" — an unquoted value is TOML-parsed before falling back to a
    // literal, so quoting is what keeps a string a string.
    expect(tomlString("12345")).toBe('"12345"');
    expect(tomlString("true")).toBe('"true"');
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

