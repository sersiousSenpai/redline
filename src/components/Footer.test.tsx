// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Comment } from "../types";
import { Footer, footerStatus, type FooterProps } from "./Footer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const base: FooterProps = { comments: [], sessionReady: true, version: 3, waiting: false, waitingAsk: false };
async function mount(over: Partial<FooterProps> = {}) {
  await act(async () => root.render(createElement(Footer, { ...base, ...over })));
}
const mark = (id: string, over: Partial<Comment> = {}): Comment => ({ id, type: "feedback", status: "draft", body: "x", anchorId: "a", ...over } as Comment);

describe("the status bar (RLFooter)", () => {
  it("is one row: status, the pill's place, the bridge", async () => {
    await mount();
    const bar = host.querySelector("footer.rl-app-footer.rl-statusbar")!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector(".rl-footer-status")).not.toBeNull();
    // The pill's place, which the tour points at.
    expect(bar.querySelector('.rl-statusbar-pill[data-tour="pill"]')).not.toBeNull();
    expect(bar.querySelector(".rl-footer-meta")?.textContent).toBe("Bridge 7676");
  });

  it("carries no plan verbs at all, on a plan or anywhere else (D13)", async () => {
    for (const over of [{}, { sessionReady: false }, { comments: [mark("c1")] }, { approval: { version: 2, runState: null } }]) {
      await mount(over);
      expect(host.querySelectorAll("button").length).toBe(0);
      expect(host.textContent).not.toMatch(/Approve &|Approve,|Send to|Send \d|\bBuild\b|Reopen/);
    }
  });

  it.each([["claude-code", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"], ["antigravity", "Antigravity"]])(
    "names %s as the author at work, and its line shows the terminal",
    async (backend, author) => {
      let shown = 0;
      await mount({ backend, waiting: true, waitingAsk: true, onShowTerminal: () => shown++ });
      expect(host.textContent).toContain(`${author} is answering on v3`);
      await mount({ backend, waiting: true, waitingAsk: false, onShowTerminal: () => shown++ });
      expect(host.textContent).toContain(`${author} is revising v3`);
      // Working is the shared Spinner, not a dot.
      expect(host.querySelector(".rl-spinner")).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('button[title="Show terminal"]')!.click());
      expect(shown).toBe(1);
    },
  );

  it("says the plan's state in a word", () => {
    expect(footerStatus({ ...base, sessionReady: false }).text).toBe("No plan open");
    expect(footerStatus(base)).toEqual({ text: "In review v3", tone: "idle" });
    expect(footerStatus({ ...base, comments: [mark("a"), mark("b")] })).toEqual({ text: "In review v3 · 2 marks to send", tone: "needs" });
    expect(footerStatus({ ...base, comments: [mark("a", { status: "resolved" })] }).text).toBe("In review v3 · 1 answer to read");
    expect(footerStatus({ ...base, approval: { version: 3, runState: null } })).toEqual({ text: "Approved · v3 · not built", tone: "done" });
    expect(footerStatus({ ...base, approval: { version: 3, runState: "building_now" } }).text).toBe("Approved · v3 · building now");
  });

  it("says when the bridge is not this window's", async () => {
    await mount({ bridge: "failed" });
    expect(host.querySelector(".rl-footer-meta")?.textContent).toBe("Bridge offline");
  });
});

describe("the terminals that need you", () => {
  const chip = () => [...host.querySelectorAll("button")].find((b) => b.title.includes("⌘⇧J"));

  it("shows a chip only while something needs you, and its click runs the jump", async () => {
    let jumps = 0;
    await mount({ termNeedYou: 0, onJumpToNeedsYou: () => { jumps++; } });
    expect(chip()).toBeUndefined();
    // No terminal count: the bottom dock that chip opened is gone.
    expect(host.textContent).not.toMatch(/\d terminals?/);
    await mount({ termNeedYou: 2, onJumpToNeedsYou: () => { jumps++; } });
    expect(chip()?.textContent).toBe("2 need you");
    await act(async () => chip()!.click());
    expect(jumps).toBe(1);
    await mount({ termNeedYou: 1, onJumpToNeedsYou: () => {} });
    expect(chip()?.textContent).toBe("1 needs you");
  });
});

// An agent's review request is news, never a move (10/10): the chip is the
// way there, for as long as the agent waits.
describe("a review waiting for you", () => {
  const chip = () => [...host.querySelectorAll("button")].find((b) => b.title === "Open the review surface");

  it("shows a chip only while a review waits, and its click is the way there", async () => {
    let opened = 0;
    await mount({ reviewNews: null, onOpenReviewNews: () => { opened++; } });
    expect(chip()).toBeUndefined();
    await mount({ reviewNews: "Review ready", onOpenReviewNews: () => { opened++; } });
    expect(chip()?.textContent).toBe("Review ready → Open");
    await act(async () => chip()!.click());
    expect(opened).toBe(1);
  });
});

describe("App's status bar", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const footer = app.slice(app.indexOf("<Footer\n"), app.indexOf("/>", app.indexOf("<Footer\n")));

  it("is handed no plan verb: they are the Plan pane's footer's", () => {
    for (const verb of ["onSubmit", "onApprove", "onApproveLater", "onBuild", "onReopen", "buildTargets", "canSubmit", "canApprove", "onSetPlanState", "planVerbs"]) {
      expect(footer, verb).not.toContain(`${verb}=`);
    }
    expect(footer).toContain("bridge={daemonState}");
  });

  it("holds its row while its chunk lands, so the pill centres from the first frame", () => {
    expect(app).toContain('<Suspense fallback={<div className="rl-app-footer rl-statusbar" aria-hidden />}>');
  });
});
