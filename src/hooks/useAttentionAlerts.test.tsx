// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windowFocused: true,
  focusChanged: null as null | ((event: { payload: boolean }) => void),
  notify: vi.fn(),
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: mocks.notify }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => { mocks.listeners.set(name, handler); return () => {}; } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isFocused: async () => mocks.windowFocused,
  onFocusChanged: async (handler: (event: { payload: boolean }) => void) => { mocks.focusChanged = handler; return () => {}; },
}) }));

import { useAttentionAlerts, type AttentionAlertSources } from "./useAttentionAlerts";
import { resetNotifyPrefsCache, setNotifyPref } from "../lib/notifyPrefs";
import type { TermState } from "../lib/termState";
import type { SessionSummary, TermAttention } from "../types";
import { emptyWorkbench, type SessionKey } from "../workbench/model";
import { createWorkbenchStore } from "../workbench/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let store = createWorkbenchStore(emptyWorkbench(), (s, _a) => s);
let src: AttentionAlertSources;
const onReveal = vi.fn();

function Probe(props: AttentionAlertSources) {
  useAttentionAlerts(props);
  return null;
}
const render = (patch: Partial<AttentionAlertSources> = {}) => {
  src = { ...src, ...patch };
  return act(async () => root.render(<Probe {...src} />));
};
// The plugin import and the permission check settle over a few microtasks.
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const notes = () => mocks.notify.mock.calls.map(([n]) => n as { title: string; body: string });
const badges = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "set_attention_badge").map(([, args]) => (args as { count: number }).count);
const lastBadge = () => badges()[badges().length - 1];
const show = (key: SessionKey) => act(async () => store.replace({ ...store.getState(), activeKey: key }));
const away = () => act(async () => mocks.focusChanged!({ payload: false }));
const back = () => act(async () => mocks.focusChanged!({ payload: true }));

const needsYou = (terminalId: string, at: number): TermAttention => ({ terminalId, sessionId: "s", at, kind: "needs-you", reason: "permission_prompt", message: "Claude needs your permission" });
const yourTurn = (terminalId: string, at: number, excerpt: string | null): TermAttention => ({ terminalId, sessionId: "s", at, kind: "your-turn", excerpt });
const attention = (...rows: TermAttention[]) => new Map(rows.map((r) => [r.terminalId, r]));
const summary = (sessionId: string, receivedAt: number, held: boolean, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId, projectName: "repo", projectPath: "/repo", planTitle: "Auth rework", latestVersion: 1,
  revisions: [{ versionNumber: 1, receivedAt, threadStart: true, restored: false }],
  createdAt: receivedAt, updatedAt: receivedAt, status: "in_review", pendingCount: 0, awaitingReview: held, held,
  attachState: "attached", ...extra,
} as SessionSummary);

beforeEach(async () => {
  mocks.windowFocused = true;
  mocks.focusChanged = null;
  mocks.notify.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(null);
  mocks.listeners.clear();
  onReveal.mockReset();
  localStorage.clear();
  resetNotifyPrefsCache();
  store = createWorkbenchStore(emptyWorkbench(), (s, _a) => s);
  src = {
    store,
    summaries: [],
    termStatuses: new Map(),
    terminalAttention: new Map(),
    liveTermIds: null,
    sessionTerminals: new Map(),
    sessionLabels: new Map([["plan:s1", "Auth rework"]]),
    chats: [{ companionId: "c1", title: "Pricing", status: "active", createdAt: 0, updatedAt: 0 }],
    onReveal,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAttentionAlerts", () => {
  it("notifies once per transition while away, never for what happened before it armed", async () => {
    mocks.windowFocused = false;
    const old = Date.now() - 60_000;
    await render({ terminalAttention: attention(needsYou("t1", old)), termStatuses: new Map([["t1", { state: "needs-you", label: "repo 1" }]]) });
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    const at = Date.now() + 1;
    await render({ terminalAttention: attention(needsYou("t1", at)) });
    await flush();
    expect(notes()).toEqual([{ title: "repo 1 · needs you", body: "Claude needs your permission" }]);
    // The same transition again (a re-sent event, a re-render) is not news.
    await render({ terminalAttention: attention(needsYou("t1", at)) });
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while you're looking at its session, and speaks up when another is shown", async () => {
    await render({ sessionTerminals: new Map([["s1", "t1"]]) });
    await show("plan:s1");
    await flush();
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 1)) });
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await show("home");
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 2)) });
    await flush();
    expect(notes()).toEqual([{ title: "Auth rework · needs you", body: "Claude needs your permission" }]);
  });

  it("counts a caret in one of Redline's own browser pages as looking, and another app in front as away", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await render({ sessionTerminals: new Map([["s1", "t1"]]) });
    await show("plan:s1");
    await flush();
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 1)) });
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await away();
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 2)) });
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("a your-turn notifies after a beat, with the excerpt that filled in — or not at all once read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.windowFocused = false;
    await render();
    await flush();
    const at = Date.now() + 1;
    const statuses = new Map<string, { state: TermState; label: string }>([["t1", { state: "your-turn", label: "repo 1" }], ["t2", { state: "your-turn", label: "repo 2" }]]);
    await render({ termStatuses: statuses, terminalAttention: attention(yourTurn("t1", at, null), yourTurn("t2", at, "All done.")) });
    await render({ terminalAttention: attention(yourTurn("t1", at, "Which API key should I use?"), yourTurn("t2", at, "All done.")) });
    // t2's turn is read before the beat is up.
    await render({ termStatuses: new Map([...statuses, ["t2", { state: "idle", label: "repo 2" }]]) });
    await tick(2499);
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    await tick(1);
    await flush();
    expect(notes()).toEqual([{ title: "repo 1 · your turn", body: "Which API key should I use?" }]);
  });

  it("a held plan's arrival says it is waiting, unless the ambient countdown's own notice covers it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.windowFocused = false;
    await render();
    await flush();
    await render({ summaries: [summary("s1", Date.now() + 1, true)] });
    await tick(1500);
    await flush();
    expect(notes()).toEqual([{ title: "Auth rework", body: "Plan v1 ready · waiting for you" }]);
    await act(async () => mocks.listeners.get("plan-decision-window")!({ payload: { sessionId: "s2", version: 1, deadlineMs: 0, windowSecs: 20 } }));
    await render({ summaries: [summary("s1", Date.now() - 10_000, true), summary("s2", Date.now() + 1, true, { planTitle: "Other" })] });
    await tick(1500);
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("a chat's reply notifies while its room is not on screen", async () => {
    mocks.windowFocused = false;
    await render();
    await flush();
    await act(async () => mocks.listeners.get("companion-done")!({ payload: { companionId: "c1", messageId: "m1", body: "Short answer: yes." } }));
    await flush();
    expect(notes()).toEqual([{ title: "Pricing · replied", body: "Short answer: yes." }]);
  });

  it("each kind can be turned off", async () => {
    mocks.windowFocused = false;
    setNotifyPref("waiting", false);
    await render();
    await flush();
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 1)) });
    await act(async () => mocks.listeners.get("companion-done")!({ payload: { companionId: "c1", messageId: "m1", body: "ok" } }));
    await flush();
    expect(notes().map((n) => n.title)).toEqual(["Pricing · replied"]);
    setNotifyPref("finished", false);
    await act(async () => mocks.listeners.get("companion-done")!({ payload: { companionId: "c1", messageId: "m2", body: "again" } }));
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("badges the sessions waiting on you, each once, and clears one once seen", async () => {
    mocks.windowFocused = false;
    await render({
      sessionTerminals: new Map([["s1", "t1"]]),
      summaries: [summary("s1", 5, true)],
      terminalAttention: attention(needsYou("t1", 6), needsYou("t2", 7), yourTurn("t3", 8, "Done.")),
    });
    await flush();
    // s1's held plan and its question are one session; t2 is another; a
    // finished turn is not waiting on you.
    expect(lastBadge()).toBe(2);
    await show("plan:s1");
    expect(lastBadge()).toBe(2);
    await back();
    expect(lastBadge()).toBe(1);
    // A revision is new: badged again once you are elsewhere, and seen at
    // once when it lands in front of you.
    await show("home");
    await render({ summaries: [summary("s1", 9, true)] });
    expect(lastBadge()).toBe(2);
    await show("plan:s1");
    await render({ summaries: [summary("s1", 10, true)] });
    expect(lastBadge()).toBe(1);
  });

  it("the return to the window after a notification shows what it was about, once", async () => {
    mocks.windowFocused = false;
    await render({ sessionTerminals: new Map([["s1", "t1"]]) });
    await flush();
    await render({ terminalAttention: attention(needsYou("t1", Date.now() + 1)) });
    await flush();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    await back();
    expect(onReveal).toHaveBeenCalledWith({ type: "terminal", terminalId: "t1" });
    await away();
    await back();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("a notification about something that has since finished pulls you nowhere on the way back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.windowFocused = false;
    await render();
    await flush();
    const at = Date.now() + 1;
    await render({ summaries: [summary("s1", at, true)] });
    await tick(1500);
    await flush();
    expect(notes()).toEqual([{ title: "Auth rework", body: "Plan v1 ready · waiting for you" }]);
    // Approved elsewhere (the same transition, no longer held): it finished.
    await render({ summaries: [summary("s1", at, false)] });
    await back();
    expect(onReveal).not.toHaveBeenCalled();
  });
});

