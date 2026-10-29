// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-level invariants for the restore path, the same way `boot.test.ts`
// pins the dock's deferral. The behaviours below are not expressible as pure
// functions — they are about which imperative call a component makes — and each
// one is a regression that would be silent: a restore that quietly takes a tile
// back, a "Show raw terminal" that opens a SECOND resume, an arming that races
// the command it is supposed to precede.

const read = (p: string) =>
  readFileSync(join(process.cwd(), "src", p), "utf8");

const app = read("App.tsx");
const tabs = read("components/TerminalTabs.tsx");
const notices = read("components/plan/PlanNotices.tsx");
/** `restorePlanSession`'s body, from its declaration to the next top-level
 *  `const` at the same indentation. */
const restoreBody = (() => {
  // The body lives in `restorePlanSessionWith` (Reopen passes `rescinded`);
  // `restorePlanSession` is its no-option alias.
  const start = app.indexOf("const restorePlanSession = () => restorePlanSessionWith({});");
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("\n  // Candidate project directories", start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
})();

describe("a restore runs in the background", () => {
  it("opens its terminal without showing it or taking a tile", () => {
    // The reviewer must not be dropped in front of a resumed session replaying
    // its own control messages: that replay is valid history that reads as an
    // accidental double-send, which is the entire failure this rework removes.
    expect(restoreBody).toContain("await openTerminal(projectPath, true)");
    expect(restoreBody).not.toContain("showTerminal(");
    expect(restoreBody).not.toContain("revealTerm()");
    expect(restoreBody).not.toContain("setTermFullscreen(");
    expect(restoreBody).not.toContain("suppressTerminalRevealFocus()");
  });

  it("a background terminal still spawns: the fleet adds it, only the wall leaves it off", () => {
    // The tab still exists, so its <TerminalView> still mounts and its PTY
    // still spawns — a terminal on no wall is display:none, not unmounted. If
    // this ever became "don't create the tab", the restore would silently
    // never run.
    const open = app.slice(app.indexOf("const openTerminal = useCallback("), app.indexOf("}, [ensureTerminalReady, showTerminal]);"));
    expect(open).toContain("(await ensureTerminalReady())?.openSessionTerminal(cwd)");
    expect(open).toContain("if (id && !background) showTerminal(id);");
    const start = tabs.indexOf("openSessionTerminal: (cwd: string | null) => {");
    expect(start).toBeGreaterThan(-1);
    const body = tabs.slice(start, tabs.indexOf("return id;", start));
    expect(body).toContain("setTabs((prev) => [...prev, { id, cwd }]);");
    expect(body).not.toContain("onPlaceRef");
  });

  it("keeps the banner up, because the banner is now the only narrator", () => {
    // It used to dismiss it and hand the reviewer a terminal instead.
    expect(restoreBody).toContain("setDetachDismissed(false)");
    expect(restoreBody).not.toContain("setDetachDismissed(true)");
  });
});

describe("Show raw terminal", () => {
  it("promotes the EXISTING terminal instead of opening another", () => {
    // Another `openSessionTerminal` here would resume the same conversation a
    // second time — two claudes racing to hold one plan.
    const start = app.indexOf("const showRawTerminal = async (");
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf("\n  };", start));
    // Its session, its wall and its tile: a kept terminal comes back onto a
    // wall, one already on screen is hailed.
    // The raw PTY, never the Agent tab: that is what this button names.
    expect(body).toContain("showTerminal(terminalId, false, true)");
    expect(body).not.toContain("openSessionTerminal");
    expect(body).not.toContain("openTerminal(");
  });

  it("is offered from both the running and the failed notice", () => {
    // The Plan pane's notices (components/plan/PlanNotices) carry the restore
    // now: App hands them the restore's own terminal while one runs or has
    // failed, and the notice offers it in both states.
    expect(app).toContain("const restoreTerminalId = attemptHere?.terminalId ?? restoreFailure?.terminalId ?? null;");
    expect(app).toContain("void showRawTerminal(restoreTerminalId ?? planChromeTerminalId);");
    const detached = notices.slice(notices.indexOf("function Detached("));
    const running = detached.slice(detached.indexOf("if (d.restoring)"), detached.indexOf("if (d.failure)"));
    const failed = detached.slice(detached.indexOf("if (d.failure)"), detached.indexOf("<Notice title={d.copy.lede}"));
    expect(running).toContain("onClick={d.onShowTerminal}");
    expect(failed).toContain("onClick={d.onShowTerminal}");
  });
});

describe("the arming precedes the command", () => {
  it("awaits arm_restore on both restore paths", () => {
    // It arms two one-shots the restore depends on — the "vN restored" label
    // and the resumed session's entitlement to the hidden protocol — and both
    // are consumed by events the command itself triggers. A bare `void invoke`
    // is a race with the arming that is supposed to come first.
    const armings = [...app.matchAll(/invoke\("arm_restore"/g)];
    expect(armings.length).toBe(2); // the embedded terminal, and the clipboard
    for (const m of armings) {
      const before = app.slice(Math.max(0, m.index! - 40), m.index!);
      expect(before).toContain("await ");
      expect(before).not.toContain("void ");
    }
  });
});

describe("a failed restore stays actionable", () => {
  it("offers Retry rather than reverting to the plain detached notice", () => {
    // Reverting silently is indistinguishable from never having clicked.
    const start = notices.indexOf("Couldn't reopen this plan.");
    expect(start).toBeGreaterThan(-1);
    const branch = notices.slice(start, notices.indexOf("</Notice>", start));
    expect(branch).toContain("{d.failure}");
    expect(branch).toContain("onClick={d.onRestore}");
    expect(branch).toContain("Retry");
    // …and a way out that doesn't need Redline's terminal at all.
    expect(branch).toContain("onCopy={d.onCopyResume}");
    // App wires the notice to the real restore and its failure.
    const bundle = app.slice(app.indexOf("const planNotices = {"), app.indexOf("onViewPrior: setViewedVersionNumber,"));
    expect(bundle).toContain("failure: restoreFailure?.error ?? null,");
    expect(bundle).toContain("onRestore: restorePlanSession,");
    expect(bundle).toContain("onCopyResume: copyRestoreCommand,");
  });

  it("cannot be dismissed while it is still running", () => {
    // The running notice IS the progress: it has no dismiss.
    const detached = notices.slice(notices.indexOf("function Detached("));
    const running = detached.slice(detached.indexOf("if (d.restoring)"), detached.indexOf("if (d.failure)"));
    expect(running).toContain('<Notice title="Reopening this plan…"');
    expect(running).not.toContain("onDismiss");
  });
});

describe("the automatic resume rides the same restore", () => {
  const hook = read("lib/useAutoResume.ts");
  const ctl = read("lib/autoResumeController.ts");
  const api = read("components/agent/convo/api.ts");

  it("starts through the click's own function, never a second path", () => {
    // One body, so one-at-a-time and every step above hold for both.
    expect(app).toContain("return target ? restorePlanSessionWith({ target }) : Promise.resolve(\"blocked\" as const);");
    for (const src of [hook, ctl]) {
      expect(src).not.toContain("arm_restore");
      expect(src).not.toContain("openTerminal");
    }
  });

  it("a PTY's exit asks the daemon to reconcile; only its detach triggers", () => {
    // A restore started off the exit would close on the first summary that
    // says the session is not detached.
    const exit = hook.slice(hook.indexOf('listen<{ id: string }>("pty-exit"'), hook.indexOf("return () => {", hook.indexOf('"pty-exit"')));
    expect(exit).toContain('invoke("report_agent_exit", { sessionId })');
    expect(exit).not.toContain("dispatch(");
    expect(exit).not.toContain("start(");
  });

  it("the reviewer's own closes and interrupts are recorded where they happen", () => {
    const forget = tabs.slice(tabs.indexOf("const forgetTab = useCallback("), tabs.indexOf('invoke("pty_kill", { id })'));
    expect(forget).toContain("noteTerminalClosed(id);");
    const interrupt = tabs.slice(tabs.indexOf("const handleInterrupt = useCallback("), tabs.indexOf("term_attention_interrupted"));
    expect(interrupt).toContain("noteTerminalInterrupted(id);");
    const stop = api.slice(api.indexOf("export async function interruptTerminal("), api.indexOf("await ptyInterrupt(terminalId);"));
    expect(stop).toContain("noteTerminalInterrupted(terminalId);");
  });
});
