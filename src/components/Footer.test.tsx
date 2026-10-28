// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Comment } from "../types";
import type { CollabProviderHandle } from "../collab/provider";
import { Footer, footerStatus, type FooterProps } from "./Footer";
import { liveLabel } from "./LiveSessionMenu";
import { chipTitle } from "./MemoryStatusPill";

// The Memory chip reads the daemon; here it reads a quiet one.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "memory_status") return { live: true, itemCount: 1236, backlog: 3, lastOrganizedTs: Date.now() - 8 * 60_000, lastOrganizedSummary: null, chainOk: true, compactedCount: 0, reclaimedBytes: 0, lastCompactionTs: null, queuedProposals: 0 };
    if (cmd === "work_ready_count") return 1236;
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

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

// D26: the top bar's Memory pill and Live Session menu came down to the
// status bar; the sessions waiting on you went up to the top bar.
describe("the chips that came down from the top bar", () => {
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

  it("Memory is a quiet chip on the left: a dot and the word, the detail on hover, a click its popover", async () => {
    let opened = 0;
    await mount({ memory: { onOpenMemory: () => { opened++; }, onOpenInspector: () => {} } });
    // Let the status read land.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    const chip = button(/^Memory status$/)!;
    expect(chip.closest(".rl-footer-status")).not.toBeNull();
    expect(chip.textContent).toBe("Memory");
    expect(chip.title).toMatch(/^Memory · organized 8m ago · 1236 ready\n1236 events/);
    await act(async () => chip.click());
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open Memory →")!;
    await act(async () => open.click());
    expect(opened).toBe(1);
  });

  it("its tooltip is the pill's old line", () => {
    expect(chipTitle(null, 0)).toBe("Open memory");
    expect(chipTitle(null, 0, 4)).toBe("Memory · 4 ready");
  });

  it("the live session sits on the right, in its three states, and nothing in it is red", async () => {
    const live = { canInvite: true, collabActive: false, onInvite: () => {}, onJoinSession: () => {} };
    await mount({ live });
    const trigger = () => host.querySelector<HTMLButtonElement>(".rl-footer-meta .rl-live-chip")!;
    expect(trigger().textContent).toBe("Live session");
    await act(async () => trigger().click());
    expect([...host.querySelectorAll("[role=menuitem]")].map((b) => b.textContent)).toEqual(["Invite to a live session", "Join a session…"]);
    expect(liveLabel(true, null, 0)).toBe("Live");
    expect(liveLabel(true, { role: "owner" }, 2)).toBe("Live · 2");
    expect(liveLabel(true, { role: "collaborator" }, 3)).toBe("Joined · 3");
  });

  it("a room on screen lists its people and its ending in the same menu", async () => {
    const states = new Map<number, unknown>([[1, { user: { name: "Ada", color: "#5b9fe4", role: "owner" } }], [2, { user: { name: "Lin", color: "#5dc585" } }]]);
    const handle = { awareness: { clientID: 1, getStates: () => states, on: () => {}, off: () => {} } } as unknown as CollabProviderHandle;
    let ended = 0;
    await mount({ live: { canInvite: true, collabActive: true, onInvite: () => {}, onJoinSession: () => {}, presence: { handle, role: "owner", onEnd: () => { ended++; } } } });
    const trigger = host.querySelector<HTMLButtonElement>(".rl-live-chip")!;
    expect(trigger.textContent).toBe("Live · 2");
    await act(async () => trigger.click());
    const menu = host.querySelector("[role=menu]")!;
    expect(menu.textContent).toContain("Ada(you)· owner");
    expect(menu.textContent).toContain("Lin");
    const stop = [...menu.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Stop sharing")!;
    await act(async () => (stop as HTMLButtonElement).click());
    expect(ended).toBe(1);
    expect(readFileSync("src/components/LiveSessionMenu.tsx", "utf8")).not.toMatch(/#d64545|--color-(danger|error)|mode-danger/);
  });

  it("the sessions that need you are not the bar's any more: they are the top bar's", async () => {
    await mount();
    expect([...host.querySelectorAll("button")].some((b) => b.title.includes("⌘⇧J"))).toBe(false);
    expect(readFileSync("src/components/Footer.tsx", "utf8")).not.toContain("termNeedYou");
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

  it("carries Memory and the live session when the manifest has them (D26)", () => {
    expect(footer).toContain('memory={surfaceEnabled(effectiveWorkspace, "memory") ? footerMemory : null}');
    expect(footer).toContain('live={surfaceEnabled(effectiveWorkspace, "collab") ? footerLive : null}');
    const bar = readFileSync("src/components/Footer.tsx", "utf8");
    expect(bar).toMatch(/^import \{ MemoryStatusPill \} from "\.\/MemoryStatusPill";/m);
    expect(bar).toMatch(/^import \{ LiveSessionMenu, type LiveSessionMenuProps \} from "\.\/LiveSessionMenu";/m);
  });

  it("holds its row while its chunk lands, so the pill centres from the first frame", () => {
    expect(app).toContain('<Suspense fallback={<div className="rl-app-footer rl-statusbar" aria-hidden />}>');
  });
});
