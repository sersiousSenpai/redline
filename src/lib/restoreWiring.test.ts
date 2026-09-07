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
/** `restorePlanSession`'s body, from its declaration to the next top-level
 *  `const` at the same indentation. */
const restoreBody = (() => {
  const start = app.indexOf("const restorePlanSession = async () => {");
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("\n  // Candidate project directories", start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
})();

describe("a restore runs in the background", () => {
  it("opens its terminal without taking a tile or the dock", () => {
    // The reviewer must not be dropped in front of a resumed session replaying
    // its own control messages: that replay is valid history that reads as an
    // accidental double-send, which is the entire failure this rework removes.
    expect(restoreBody).toContain("background: true");
    expect(restoreBody).not.toContain("revealTerm()");
    expect(restoreBody).not.toContain("setTermFullscreen(");
    expect(restoreBody).not.toContain("suppressTerminalRevealFocus()");
  });

  it("the background option skips tiling and nothing else", () => {
    // The tab still exists, so its <TerminalView> still mounts and its PTY
    // still spawns — untiled wrappers are display:none, not unmounted. If this
    // ever became "don't create the tab", the restore would silently never run.
    const start = tabs.indexOf("openSessionTerminal: (cwd: string | null, opts)");
    expect(start).toBeGreaterThan(-1);
    const body = tabs.slice(start, tabs.indexOf("return id;", start));
    // The tab is created unconditionally…
    expect(body).toContain("setTabs((prev) => [...prev, { id, cwd }]);");
    // …and only the TILING is conditional.
    expect(body).toContain(
      "if (!opts?.background) openTileRef.current(id, focusIdxRef.current);",
    );
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
    expect(body).toContain("dock?.selectTab(terminalId)");
    expect(body).toContain("revealTerm()");
    expect(body).not.toContain("openSessionTerminal");
  });

  it("is offered from both the running and the failed banner", () => {
    expect(app).toContain("void showRawTerminal(attemptHere?.terminalId ?? null)");
    expect(app).toContain("void showRawTerminal(restoreFailure.terminalId)");
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
  it("offers Retry rather than reverting to the plain detached banner", () => {
    // Reverting silently is indistinguishable from never having clicked.
    const start = app.indexOf("Couldn&rsquo;t reopen this plan.");
    expect(start).toBeGreaterThan(-1);
    const branch = app.slice(start, app.indexOf("</>", start));
    expect(branch).toContain("{restoreFailure.error}");
    expect(branch).toContain("onClick={restorePlanSession}");
    expect(branch).toContain("Retry");
    // …and a way out that doesn't need Redline's terminal at all.
    expect(branch).toContain("onClick={copyRestoreCommand}");
  });

  it("cannot be dismissed while it is still running", () => {
    expect(app).toContain("{!restoring && (");
  });
});
