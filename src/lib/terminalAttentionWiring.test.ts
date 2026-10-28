// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const tabs = readFileSync("src/components/TerminalTabs.tsx", "utf8");

// The ⌘⇧J jump lives in App (it selects the session, the wall and the tile
// through the workbench) while TerminalTabs owns which terminal it lands on.
// These pin the seams a refactor could cut silently: the key must be caught
// in the CAPTURE phase or a focused xterm eats it, the footer's chip must run
// the same action, and an interrupt must reach the daemon.
describe("terminal attention wiring", () => {
  it("catches ⌘⇧J in the capture phase, ahead of a focused terminal", () => {
    const listener = app.slice(app.indexOf("if (!isNeedsYouKey(e)) return;"));
    const body = listener.slice(0, listener.indexOf("}, [jumpToNeedsYou]);"));
    expect(body).toContain("e.stopPropagation()");
    expect(body).toContain("jumpToNeedsYou()");
    expect(body).toContain('window.addEventListener("keydown", onKey, true)');
  });

  it("the jump steps out from under the front door, asks the fleet which terminal, then shows it across sessions", () => {
    const start = app.indexOf("const jumpToNeedsYou = useCallback(");
    const jump = app.slice(start, app.indexOf("}, [ensureTerminalReady, showTerminal]);", start));
    expect(jump).toContain("if (termNeedYouRef.current === 0) return;");
    expect(jump).toContain("setFrontDoorOpen(false)");
    expect(jump).toContain("dock?.nextNeedsYou()");
    expect(jump).toContain("showTerminal(target, true)");
  });

  it("showing a terminal selects its session, wall and tile, then hails it and hands it the caret", () => {
    const start = app.indexOf("const showTerminal = useCallback(");
    const show = app.slice(start, app.indexOf("}, []);", start));
    expect(show).toContain('wb.dispatch({ type: "revealTerminal", ptyId: id })');
    // A session's agent terminal is its Agent tab, where its questions are.
    expect(show).toContain('wb.dispatch({ type: "openSurface", key: owner, kind: "chat", data: agent.data })');
    expect(show).toContain("terminalsRef.current?.hailTerminal(id)");
    expect(show).toContain("if (focus) terminalsRef.current?.focusTerminal(id)");
    // Every "show me that terminal" route goes this one way.
    for (const route of ["onRevealPending={() => {", "const showRawTerminal = async (", "onSelectTerminal: (sessionId: string, terminalId: string) =>"]) {
      const at = app.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      expect(app.slice(at, at + 400), route).toContain("showTerminal(");
    }
    expect(app).not.toContain(".selectTab(");
  });

  it("Esc reaches the daemon's interrupt, the one path that retires a working agent no hook reports", () => {
    const start = tabs.indexOf("const handleInterrupt = useCallback(");
    const body = tabs.slice(start, tabs.indexOf("[ackInput],", start));
    expect(body).toContain('invoke("term_attention_interrupted", { terminalId: id })');
  });

  it("the dock's count reaches the footer, whose chip runs the same jump", () => {
    expect(app).toContain("onNeedsYouChange={setTermNeedYou}");
    expect(app).toContain("termNeedYou={termNeedYou}");
    expect(app).toContain("onJumpToNeedsYou={jumpToNeedsYou}");
    expect(app).not.toContain("termHasUnseen");
  });

  it("one status vocabulary: the fleet's states reach the tab dots and the sidebar's terminal rows, never a second derivation", () => {
    expect(app).toContain("onStatesChange={setTermStatuses}");
    const describe = app.slice(app.indexOf("const describePane = useCallback("), app.indexOf("// The strip's right-hand cluster"));
    expect(describe).toContain('if (pane.kind === "terminals") return { status: wallStatus(pane.data.tiles, termStatuses) };');
    const rows = app.slice(app.indexOf("const sidebarTerminals = useMemo("), app.indexOf("// The memoized sidebar and browser pane"));
    // Rows, the Agent tab's dot and the row spinners all read one helper,
    // the fleet's derivation first, a held plan as needing you.
    expect(rows).toContain("terminalStatus(terminalId, { states: termStatuses, attention: terminalKinds, held: heldTermIds, live: liveTermIds })");
    expect(describe).toContain("terminalStatus(pane.data.terminalId, { states: termStatuses, attention: terminalKinds, held: heldTermIds })");
  });

  it("no toast points at a dock that is gone: a build's or a launch's toast shows its terminal", () => {
    expect(app).not.toMatch(/below ↓|terminal below/);
    for (const message of ["in this session's Agent tab", "Running in its Agent tab", "Planning in its Agent tab"]) {
      const at = app.indexOf(message);
      expect(at, message).toBeGreaterThan(-1);
      expect(app.slice(at, at + 200), message).toMatch(/action: \{ label: "Show", onAction: \(\) => showTerminal\(/);
    }
  });
});
