// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  contextLine,
  dockDescriptor,
  eventTakesFocus,
  hydrate,
  reduceChatWorld,
  resolveConversation,
  type ChatEvent,
  type ChatTab,
  type ChatWorld,
} from "./scope";

// Conformance: conversation scope. Each title starts with the rule it pins
// (invariants.ts), and every gesture runs through the one reducer.

const tab = (id: string): ChatTab => ({ id: `t-${id}`, browseId: id, title: `${id}.test`, url: `https://${id}.test` });
let minted = 0;
const mint = () => `shared-${++minted}`;
const world = (over: Partial<ChatWorld> = {}): ChatWorld => ({
  workspace: "regular",
  tabs: [tab("one"), tab("two")],
  activeId: "t-two",
  discussionId: "t-two",
  linkedMode: false,
  flipFor: null,
  shared: {},
  ...over,
});
const run = (w: ChatWorld, ...events: ChatEvent[]) => events.reduce((acc, e) => reduceChatWorld(acc, e, mint), w);
const thread = (w: ChatWorld) => resolveConversation(w)?.browseId;
const select = (id: string): ChatEvent => ({ type: "user-select-tab", tabId: `t-${id}` });
const flip: ChatEvent = { type: "toggle-tab-chat" };
const mode: ChatEvent = { type: "toggle-linked-mode" };

describe("linked mode decides tab chat vs shared chat", () => {
  it("BC-2 off: every tab lands in its own chat", () => {
    let w = world();
    expect(thread(w)).toBe("two");
    w = run(w, select("one"));
    expect(thread(w)).toBe("one");
    expect(resolveConversation(w)).toMatchObject({ kind: "tab", scope: "pinned-page", exception: false });
  });
  it("BC-2 on: tab switches stay in the one shared chat and retarget the page", () => {
    let w = run(world(), mode);
    const shared = thread(w);
    for (const id of ["one", "two", "one"]) {
      w = run(w, select(id));
      expect(thread(w)).toBe(shared);
      expect(resolveConversation(w)).toMatchObject({ kind: "shared", targetLabel: `browser-t-${id}`, scope: "following-tabs" });
    }
  });
  it("BC-3 a flip to shared lasts until you switch away, and mode wins on return", () => {
    let w = run(world(), select("one"), flip);
    expect(resolveConversation(w)).toMatchObject({ kind: "shared", targetLabel: "browser-t-one", exception: true });
    w = run(w, select("two"), select("one"));
    expect(thread(w)).toBe("one");
    expect(w.flipFor).toBeNull();
  });
  it("BC-3 under linked mode, Tab chat is the exception and lasts until a switch", () => {
    let w = run(world(), mode, select("one"), flip);
    expect(resolveConversation(w)).toMatchObject({ kind: "tab", browseId: "one", exception: true });
    w = run(w, select("two"));
    expect(resolveConversation(w)!.kind).toBe("shared");
    w = run(w, mode);
    expect(thread(w)).toBe("two");
  });
  it("BC-3 the context line names the kind of chat only when it is the exception", () => {
    expect(contextLine(resolveConversation(world())!)).toEqual([]);
    expect(contextLine(resolveConversation(run(world(), mode, flip))!)).toEqual(["This tab’s own chat"]);
    expect(contextLine(resolveConversation(run(world(), flip))!)).toEqual(["Shared chat", "On tab 2 — two.test"]);
  });
  it("BC-9 the shared thread exists before anything renders it", () => {
    for (const w of [run(world(), mode), run(world(), flip), hydrate(world({ linkedMode: true }), mint)]) {
      expect(w.shared.regular).toBeDefined();
      expect(resolveConversation(w)!.kind).toBe("shared");
    }
    // A hand-built world asking for shared without an id resolves to nothing,
    // never to the tab's own thread dressed as shared.
    expect(resolveConversation({ ...world({ linkedMode: true }), shared: {} })).toBeNull();
  });
  it("BC-9 a shared chat already minted is reused, never re-minted", () => {
    const w = run(world({ shared: { regular: "kept" } }), mode, select("one"), mode, mode);
    expect(thread(w)).toBe("kept");
  });
});

describe("an agent-opened tab keeps the conversation anchored", () => {
  it("BC-5 the page comes forward, the thread stays, a manual click re-couples", () => {
    let w = run(world(), flip);
    const shared = thread(w);
    w = run(w, { type: "agent-open-tab", tab: tab("three") });
    expect(thread(w)).toBe(shared);
    expect(resolveConversation(w)).toMatchObject({ targetLabel: "browser-t-three", targetNumber: 3 });
    w = run(w, select("one"));
    expect(thread(w)).toBe("one");
  });
  it("BC-5 an agent /focus is a full switch, like a click", () => {
    const w = run(world(), { type: "agent-open-tab", tab: tab("three") }, { type: "agent-focus-tab", tabId: "t-one" });
    expect(resolveConversation(w)).toMatchObject({ browseId: "one", targetLabel: "browser-t-one", anchoredFrom: null });
  });
  it("BC-5 an anchored tab chat names its origin and the page it acts on — never the shared chat's name", () => {
    const w = run(world(), { type: "agent-open-tab", tab: tab("three") });
    expect(resolveConversation(w)).toMatchObject({ browseId: "two", anchoredFrom: "two.test" });
    expect(contextLine(resolveConversation(w)!)).toEqual(["On tab 3 — three.test", "From two.test"]);
    const shared = run(world(), mode);
    expect(resolveConversation(shared)!.anchoredFrom).toBeNull();
    expect(contextLine(resolveConversation(shared)!).join(" ")).not.toContain("Browser chat");
  });
  it("BC-5 Tab chat from an anchored shared chat shows the VISIBLE tab's own chat", () => {
    const w = run(world(), flip, { type: "agent-open-tab", tab: tab("three") }, flip);
    expect(resolveConversation(w)).toMatchObject({ kind: "tab", browseId: "three" });
  });
  it("BC-5 closing the anchored tab re-anchors to the page on screen", () => {
    const w = run(world(), { type: "agent-open-tab", tab: tab("three") }, { type: "close-tab", tabId: "t-two" });
    expect(thread(w)).toBe("three");
  });
  it("BC-5 a cited source opens beside the conversation; an open one is selected", () => {
    let w = run(world(), { type: "open-source", tab: tab("src"), existing: false });
    expect(resolveConversation(w)).toMatchObject({ browseId: "two", targetLabel: "browser-t-src" });
    w = run(w, { type: "open-source", tab: tab("one"), existing: true });
    expect(thread(w)).toBe("one");
  });
});

describe("explicit destinations ignore the mode", () => {
  it.each([false, true])("BC-6 plan Search opens its own chat (linked mode %s)", (linkedMode) => {
    let w = world({ linkedMode, shared: { regular: "shared-x" } });
    w = run(w, { type: "plan-search-opened", tab: tab("search") });
    expect(thread(w)).toBe("search");
    w = run(w, select("one"), { type: "reopen-tab", tabId: "t-search", quiet: false });
    expect(thread(w)).toBe("search");
    w = run(w, { type: "reopen-tab", tabId: "t-search", quiet: true });
    expect(thread(w)).toBe(linkedMode ? "shared-x" : "search");
  });
  it.each([false, true])("BC-7 a conversation link returns to that exact thread (linked mode %s)", (linkedMode) => {
    let w = world({ linkedMode, shared: { regular: "shared-x" } });
    w = run(w, { type: "open-conversation", browseId: "one" });
    expect(thread(w)).toBe("one");
    w = run(w, { type: "open-conversation", browseId: "shared-x" });
    expect(thread(w)).toBe("shared-x");
    const before = w;
    expect(run(w, { type: "open-conversation", browseId: "closed-tab" })).toEqual(before);
  });
});

describe("workspaces", () => {
  it("BC-4 a mission started from regular takes the shared chat with its tabs; regular starts fresh", () => {
    let w = run(world(), mode);
    const shared = w.shared.regular;
    w = run(w, { type: "mission-started-from-regular", missionId: "m1" });
    expect(w.workspace).toBe("m1");
    expect(thread(w)).toBe(shared);
    expect(w.shared.regular).toBeUndefined();
  });
  it("BC-4 one shared chat per workspace, mosaics included", () => {
    let w = run(world(), mode);
    const regular = thread(w);
    w = run(w, { type: "workspace-swapped", workspace: "mosaic:grid", tabs: [tab("cell")], activeId: "t-cell" });
    const mosaic = thread(w);
    expect(mosaic).not.toBe(regular);
    w = run(w, { type: "workspace-swapped", workspace: "regular", tabs: [tab("one")], activeId: "t-one" });
    expect(thread(w)).toBe(regular);
  });
  it("BC-8 a workspace swap drops any flip and lands on the mode's choice", () => {
    let w = run(world(), flip);
    w = run(w, { type: "workspace-swapped", workspace: "mosaic:grid", tabs: [tab("cell")], activeId: "t-cell" });
    expect(w.flipFor).toBeNull();
    expect(thread(w)).toBe("cell");
  });
});

describe("identity and the dock", () => {
  it("BC-1 numbers are positional; threads ride the durable browseId through a reorder", () => {
    let w = run(world(), select("one"));
    expect(resolveConversation(w)).toMatchObject({ browseId: "one", targetNumber: 1 });
    w = run(w, { type: "reorder-tabs", order: ["t-two", "t-one"] });
    expect(resolveConversation(w)).toMatchObject({ browseId: "one", targetNumber: 2, targetLabel: "browser-t-one" });
  });
  it("BC-10 the dock advertises the resolved conversation, whatever the panel's state", () => {
    const w = run(world(), mode);
    expect(dockDescriptor(w)).toEqual({ browseId: w.shared.regular, title: "Browser chat" });
    expect(dockDescriptor(world())).toEqual({ browseId: "two", title: "two.test" });
  });
  it("BC-15 an inspected element anchors the chat to its tab", () => {
    const w = run(world(), { type: "inspect", tabId: "t-one" });
    expect(resolveConversation(w)).toMatchObject({ browseId: "one", targetLabel: "browser-t-one" });
  });
  it("BC-33 only a gesture aimed at the composer may take focus", () => {
    const events: ChatEvent[] = [select("one"), flip, mode, { type: "agent-open-tab", tab: tab("x") }, { type: "agent-focus-tab", tabId: "t-one" }, { type: "workspace-swapped", workspace: "regular", tabs: [], activeId: "" }];
    expect(events.filter(eventTakesFocus)).toEqual([]);
    expect(eventTakesFocus({ type: "inspect", tabId: "t-one" })).toBe(true);
  });
});
