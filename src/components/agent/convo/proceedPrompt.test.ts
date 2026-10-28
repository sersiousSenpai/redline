// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { keysFor, parsePermissionPrompt, parseProceedPrompt, stripAnsi } from "./proceedPrompt";

/** The prompt the re-walk captured after Approve on a restored session
 *  (FAIL-approve-after-restore-cli-native-proceed-prompt.png), as the
 *  terminal drew it. */
const CAPTURED = `● Reopening the plan for review as requested.

 ────────────────────────────────────────────────────────────────
 Ready to code?

 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 <!-- rl:blk-20721ae1 -->
 wb-rewalk: add one README line

 <!-- rl:blk-3b671b1a -->
 Append wb-rewalk ok as a new last line of README.md (after line-two), ending
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Claude has written up a plan and is ready to execute. Would you like to
 proceed?

 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback

 ctrl+g to edit in Vim · ~/.claude/plans/wb-rewalk-add-one-readme-abstract-abelson.md
`;

/** The same prompt as a TUI's raw bytes arrive: colours, cursor moves for
 *  the spaces, carriage returns (claude 2.1.312, the experiment's PTY). */
const RAW = "\x1b[?25l\x1b[2K\x1b[1mClaude\x1b[1Chas\x1b[1Cwritten\x1b[1Cup\x1b[1Ca\x1b[1Cplan\x1b[1Cand\x1b[1Cis\x1b[1Cready\x1b[1Cto\x1b[1Cexecute.\x1b[1CWould\x1b[1Cyou\x1b[1Clike\x1b[1Cto\x1b[1Cproceed?\x1b[22m\r\n\r\n\x1b[38;5;153m❯\x1b[1C1.\x1b[1CYes,\x1b[1Cand\x1b[1Cuse\x1b[1Cauto\x1b[1Cmode\x1b[39m\r\n\x1b[3C2.\x1b[1CYes,\x1b[1Cmanually\x1b[1Capprove\x1b[1Cedits\r\n\x1b[3C3.\x1b[1CTell\x1b[1CClaude\x1b[1Cwhat\x1b[1Cto\x1b[1Cchange\r\n\x1b[6Cshift+tab\x1b[1Cto\x1b[1Capprove\x1b[1Cwith\x1b[1Cthis\x1b[1Cfeedback\r\n\r\nctrl+g\x1b[1Cto\x1b[1Cedit\x1b[1Cin\x1b[1CVS\x1b[1CCode\x1b[1C·\x1b[1C~/.claude/plans/write-a-one-line-plan-humming-locket.md\r\n";

describe("the CLI's own proceed prompt, read off its terminal", () => {
  it("recognises the captured prompt and its three choices", () => {
    const p = parseProceedPrompt(CAPTURED);
    expect(p).toEqual({
      selected: 1,
      options: [
        { n: 1, label: "Yes, and use auto mode", approves: true },
        { n: 2, label: "Yes, manually approve edits", approves: true },
        { n: 3, label: "Tell Claude what to change", approves: false },
      ],
    });
  });

  it("reads the raw bytes too, where the spaces are cursor moves", () => {
    expect(stripAnsi(RAW)).toContain("Wouldyouliketoproceed?");
    const p = parseProceedPrompt(RAW);
    expect(p?.options.map((o) => o.label)).toEqual(["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]);
    expect(p?.selected).toBe(1);
  });

  it("is gone once the CLI moved on past it", () => {
    expect(parseProceedPrompt(CAPTURED + "\n⏺ User approved Claude's plan\n✻ Building…\n")).toBeNull();
  });

  it("is nothing else: a permission dialog, an ordinary turn", () => {
    expect(parseProceedPrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No\n")).toBeNull();
    expect(parseProceedPrompt("⏺ Done. README.md now ends with the line.")).toBeNull();
  });

  it("chooses with the keys a person presses: arrows from the cursor, then Enter", () => {
    const p = parseProceedPrompt(CAPTURED)!;
    expect(keysFor(p, 1)).toBe("\r");
    expect(keysFor(p, 2)).toBe("\x1b[B\r");
    expect(keysFor({ ...p, selected: 3 }, 1)).toBe("\x1b[A\x1b[A\r");
  });
});

describe("the CLI's own permission prompt, read off its terminal (the last walk's restored write)", () => {
  const WRITE = `● Write(notes.txt)

 ╭──────────────────────────────────────────────╮
 │ Create file                                  │
 │ notes.txt                                    │
 │ 1 restored                                   │
 ╰──────────────────────────────────────────────╯
 Do you want to create notes.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
`;

  it("recognises the write prompt, its question and its three choices", () => {
    expect(parsePermissionPrompt(WRITE)).toEqual({
      question: "Do you want to create notes.txt?",
      selected: 1,
      options: [
        { n: 1, label: "Yes", approves: true },
        { n: 2, label: "Yes, allow all edits during this session", approves: true },
        { n: 3, label: "No, and tell Claude what to do differently", approves: false },
      ],
    });
  });

  it("reads a Bash prompt whose spaces were cursor moves, without its question", () => {
    const raw = "Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\r\n\x1b[38;5;153m❯\x1b[1C1.\x1b[1CYes\x1b[39m\r\n\x1b[3C2.\x1b[1CYes,\x1b[1Cand\x1b[1Cdon't\x1b[1Cask\x1b[1Cagain\x1b[1Cfor\x1b[1Csleep\x1b[1Ccommands\r\n\x1b[3C3.\x1b[1CNo,\x1b[1Cand\x1b[1Ctell\x1b[1CClaude\x1b[1Cwhat\x1b[1Cto\x1b[1Cdo\x1b[1Cdifferently\x1b[1C(esc)\r\n";
    const p = parsePermissionPrompt(raw);
    expect(p?.question).toBeNull();
    expect(p?.options.map((o) => o.label)).toEqual(["Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"]);
    expect(keysFor(p!, 3)).toBe("\x1b[B\x1b[B\r");
  });

  it("is gone once answered, and leaves a plan's proceed prompt to its own reader", () => {
    expect(parsePermissionPrompt(WRITE + "\n⏺ Wrote 1 lines to notes.txt\n")).toBeNull();
    expect(parsePermissionPrompt(WRITE + "\n" + CAPTURED)).toBeNull();
    expect(parsePermissionPrompt("Do you want to create notes.txt?")).toBeNull();
  });
});
