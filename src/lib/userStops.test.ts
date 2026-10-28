// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { stoppedByUser, USER_STOP_WINDOW_MS } from "./autoResume";
import {
  foldInput,
  noteTerminalExited,
  noteTerminalInput,
  noteTerminalInterrupted,
  RECENT_INPUT_MS,
  userStops,
} from "./userStops";

const T0 = 1_700_000_000_000;

describe("ending a session at the keyboard", () => {
  it("an exit line's Enter, in the CLI or the shell, is a stop", () => {
    for (const line of ["exit", "/exit", "quit", "/quit", "logout", "  exit  "]) {
      expect(foldInput("", `${line}\r`).stop, line).toBe(true);
    }
    // Typed a key at a time, as xterm sends it.
    let st = { line: "", stop: false };
    for (const ch of ["/", "e", "x", "i", "t"]) st = foldInput(st.line, ch);
    expect(st).toEqual({ line: "/exit", stop: false });
    expect(foldInput(st.line, "\r").stop).toBe(true);
  });

  it("Ctrl-D is a stop; other lines, edits and escape sequences are not", () => {
    expect(foldInput("", "\x04").stop).toBe(true);
    expect(foldInput("", "exit the plan\r").stop).toBe(false);
    expect(foldInput("exitt", "\x7f\r").stop).toBe(true); // backspaced to `exit`
    expect(foldInput("exit", "\x1b[A")).toEqual({ line: "exit", stop: false });
    expect(foldInput("exit", "\x15\r").stop).toBe(false); // ^U cleared it
  });
});

describe("what a PTY exit means", () => {
  it("`/exit` then `exit`: the reviewer's, and so is the detach behind it", () => {
    noteTerminalInput("t-exit", "/exit\r", T0);
    noteTerminalInput("t-exit", "exit\r", T0 + 2_000);
    expect(noteTerminalExited("t-exit", T0 + 2_100)).toBe(true);
    expect(stoppedByUser(userStops(), ["t-exit"], T0 + 3_000)).toBe(true);
  });

  it("an exit just after typing anything is the reviewer's", () => {
    noteTerminalInput("t-typed", "ls\r", T0);
    expect(noteTerminalExited("t-typed", T0 + RECENT_INPUT_MS)).toBe(true);
  });

  it("an exit nobody typed toward is a death", () => {
    noteTerminalInput("t-old", "ls\r", T0);
    expect(noteTerminalExited("t-old", T0 + RECENT_INPUT_MS + 1)).toBe(false);
    expect(noteTerminalExited("t-never", T0)).toBe(false);
  });

  it("a Ctrl-C is remembered past the revise watchdog's next probe", () => {
    noteTerminalInterrupted("t-cc", T0);
    expect(USER_STOP_WINDOW_MS).toBeGreaterThanOrEqual(120_000);
    expect(stoppedByUser(userStops(), ["t-cc"], T0 + 119_000)).toBe(true);
  });
});
