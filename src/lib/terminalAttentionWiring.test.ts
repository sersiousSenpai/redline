// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");

// The ⌘⇧J jump lives in App (it must reveal the dock) while TerminalTabs owns
// which terminal it lands on. These pin the seams a refactor could cut
// silently: the key must be caught in the CAPTURE phase or a focused xterm
// eats it, and the footer's chip must run the same action.
describe("terminal attention wiring", () => {
  it("catches ⌘⇧J in the capture phase, ahead of a focused terminal", () => {
    const listener = app.slice(app.indexOf("if (!isNeedsYouKey(e)) return;"));
    const body = listener.slice(0, listener.indexOf("}, [jumpToNeedsYou]);"));
    expect(body).toContain("e.stopPropagation()");
    expect(body).toContain("jumpToNeedsYou()");
    expect(body).toContain('window.addEventListener("keydown", onKey, true)');
  });

  it("the jump reveals the dock from under the front door, then lets the dock pick the terminal", () => {
    const jump = app.slice(app.indexOf("const jumpToNeedsYou = useCallback("), app.indexOf("}, [revealTerm, ensureTerminalReady]);"));
    expect(jump).toContain("if (termNeedYouRef.current === 0) return;");
    expect(jump).toContain("setFrontDoorOpen(false)");
    expect(jump).toContain("revealTerm()");
    expect(jump).toContain("dock?.jumpToNeedsYou()");
  });

  it("the dock's count reaches the footer, whose chip runs the same jump", () => {
    expect(app).toContain("onNeedsYouChange={setTermNeedYou}");
    expect(app).toContain("termNeedYou={termNeedYou}");
    expect(app).toContain("onJumpToNeedsYou={jumpToNeedsYou}");
    expect(app).not.toContain("termHasUnseen");
  });
});
