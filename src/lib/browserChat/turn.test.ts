// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { ResolvedConversation } from "./scope";
import {
  capturedWorkspace,
  composerModel,
  needsSnapshot,
  replyActions,
  seedPolicy,
  turnEnvelope,
} from "./turn";
import { agentCapabilities, BROWSER_PANELS, pillComposerDestinations } from "./chrome";
import contract from "./contract.json";

// Conformance: what a turn carries, seeds, the composer and reply actions.
// Each title starts with the rule it pins.

const conv = (over: Partial<ResolvedConversation> = {}): ResolvedConversation => ({
  kind: "tab", browseId: "one", title: "one.test", targetLabel: "browser-t-one", targetBrowseId: "one", targetTitle: "Docs", targetNumber: 1,
  scope: "pinned-page", anchoredFrom: null, exception: false, ...over,
});

describe("what rides a turn", () => {
  it("BC-13 only a mission workspace is captured as a mission (mosaics are not)", () => {
    expect(capturedWorkspace("regular")).toBe("regular");
    expect(capturedWorkspace("mosaic:grid")).toBe("regular");
    expect(capturedWorkspace("mission-123")).toBe("mission-123");
  });
  it("BC-12 the envelope carries the captured target, scope and workspace", () => {
    expect(turnEnvelope(conv({ kind: "shared", browseId: "s", scope: "following-tabs", targetLabel: "browser-t-two" }), "mosaic:grid", "hi", null))
      .toEqual({ browseId: "s", text: "hi", targetLabel: "browser-t-two", followingTabs: true, workspaceId: "regular", cwd: null });
    expect(turnEnvelope(conv(), "m1", "hi", "/repo", "SNAP")).toMatchObject({ followingTabs: false, workspaceId: "m1", snapshot: "SNAP" });
  });
  it("BC-11 a snapshot rides until this provider has answered, and on every retarget", () => {
    const c = conv();
    expect(needsSnapshot(c, { lastReplyBackend: null, runsOn: "claude-code", lastGroundedLabel: null })).toBe(true);
    expect(needsSnapshot(c, { lastReplyBackend: "claude-code", runsOn: "claude-code", lastGroundedLabel: "browser-t-one" })).toBe(false);
    expect(needsSnapshot(conv({ targetLabel: "browser-t-two" }), { lastReplyBackend: "claude-code", runsOn: "claude-code", lastGroundedLabel: "browser-t-one" })).toBe(true);
  });
  it("BC-18 a provider switch re-grounds the side that has not seen the page", () => {
    expect(needsSnapshot(conv(), { lastReplyBackend: "claude-code", runsOn: "codex", lastGroundedLabel: "browser-t-one" })).toBe(true);
  });
});

describe("seeds", () => {
  it("BC-14 Ask waits with the caret placed; one-tap intents send without taking it; ＋ List never becomes a turn", () => {
    expect(seedPolicy({ kind: "selection", action: "ask" })).toEqual({ toChat: true, autoSend: false, focusComposer: true, mergesDraft: true });
    expect(seedPolicy({ kind: "selection", action: "ask", note: "why?" })).toMatchObject({ autoSend: true, focusComposer: false });
    for (const action of ["define", "explain", "research"] as const) expect(seedPolicy({ kind: "selection", action })).toMatchObject({ autoSend: true, focusComposer: false, mergesDraft: false });
    expect(seedPolicy({ kind: "selection-list" }).toChat).toBe(false);
  });
  it("BC-15 BC-16 an element or a Task-list item is attached for the user to ask about", () => {
    for (const kind of ["element", "task-item"] as const) expect(seedPolicy({ kind })).toEqual({ toChat: true, autoSend: false, focusComposer: true, mergesDraft: true });
  });
  it("BC-6 BC-33 a plan Search sends its research turn without moving the caret", () => {
    expect(seedPolicy({ kind: "plan-search" })).toMatchObject({ autoSend: true, focusComposer: false });
  });
});

describe("the composer", () => {
  it("BC-27 is never disabled; Enter queues mid-stream; Stop and Send are one control", () => {
    expect(composerModel({ phase: "idle", queued: 0, draft: "" })).toMatchObject({ editable: true, primary: "send", primaryIsStop: false, primaryEnabled: false });
    expect(composerModel({ phase: "streaming", queued: 0, draft: "" })).toMatchObject({ editable: true, primaryIsStop: true, primaryEnabled: true });
    expect(composerModel({ phase: "streaming", queued: 0, draft: "next" })).toMatchObject({ primary: "queue", primaryIsStop: false, canQueue: true });
    expect(composerModel({ phase: "streaming", queued: 5, draft: "next" })).toMatchObject({ canQueue: false, primaryEnabled: false, editable: true });
    expect(composerModel({ phase: "error", queued: 0, draft: "retry" })).toMatchObject({ primary: "send", primaryEnabled: true });
  });
  it("BC-29 browse cannot steer yet; BC-25 the picker stays live", () => {
    expect(composerModel({ phase: "streaming", queued: 0, draft: "x" })).toMatchObject({ canSteer: false, pickerLive: true });
  });
  it("BC-27 one round button: the mic on an empty box, send with text, queue mid-reply, stop on an empty box mid-reply", () => {
    expect(composerModel({ phase: "idle", queued: 0, draft: "" }).button).toBe("mic");
    expect(composerModel({ phase: "idle", queued: 0, draft: "  " }).button).toBe("mic");
    expect(composerModel({ phase: "idle", queued: 0, draft: "hi" }).button).toBe("send");
    expect(composerModel({ phase: "streaming", queued: 0, draft: "next" }).button).toBe("queue");
    expect(composerModel({ phase: "streaming", queued: 0, draft: "" }).button).toBe("stop");
    // With the mic someone else's, an empty box shows a send with nothing to send.
    expect(composerModel({ phase: "idle", queued: 0, draft: "", canDictate: false })).toMatchObject({ button: "send", primaryEnabled: false });
  });
  it("BC-27 a hot mic keeps the button's mic face, the one way to stop it, whatever else is in the box", () => {
    expect(composerModel({ phase: "idle", queued: 0, draft: "typed beside it", listening: true }).button).toBe("mic");
    expect(composerModel({ phase: "idle", queued: 0, draft: "", chips: 1, listening: true }).button).toBe("mic");
    expect(composerModel({ phase: "streaming", queued: 0, draft: "", listening: true }).button).toBe("mic");
    // Enter still sends what was typed.
    expect(composerModel({ phase: "idle", queued: 0, draft: "typed beside it", listening: true })).toMatchObject({ primary: "send", primaryEnabled: true });
  });
  it("BC-40 an attached chip alone is something to send", () => {
    expect(composerModel({ phase: "idle", queued: 0, draft: "", chips: 1 })).toMatchObject({ button: "send", primaryEnabled: true });
    expect(composerModel({ phase: "streaming", queued: 0, draft: "", chips: 1 })).toMatchObject({ button: "queue", primaryIsStop: false });
  });
});

describe("reply actions and the agent's reach", () => {
  it("BC-24 reply actions are the user's: pinning only inside a mission, nothing on errors", () => {
    expect(replyActions({ role: "assistant", status: "complete", body: "x", missionActive: false })).toEqual(["copy", "add-to-task-list", "continue-as"]);
    expect(replyActions({ role: "assistant", status: "complete", body: "x", missionActive: true })).toContain("add-to-mission");
    expect(replyActions({ role: "assistant", status: "error", body: "x", missionActive: true })).toEqual([]);
    expect(replyActions({ role: "user", status: "complete", body: "x", missionActive: true })).toEqual([]);
  });
  it("BC-19 BC-21 BC-24 mutations go through the action route; the only write is download; no curation", () => {
    const reach = agentCapabilities("claude-code", true);
    expect(reach.mutate).toContain("/v1/browser/action");
    for (const legacy of contract.legacyRoutes) expect([...reach.read, ...reach.mutate]).not.toContain(legacy);
    expect(reach.write).toEqual(["/v1/browser/download"]);
    expect([reach.files, reach.git, reach.curate]).toEqual(["read-only", "read-only", false]);
    expect(agentCapabilities("codex", false).mutate).toEqual([]);
  });
  it("BC-16 BC-10 the Task list shares the column but is not a conversation", () => {
    expect(BROWSER_PANELS.filter((p) => !p.conversation).map((p) => p.pill)).toEqual(["cart"]);
  });
  it("BC-37 the pill's hover composer launches Plan/Run on the browser; elsewhere it is unrestricted", () => {
    expect(pillComposerDestinations("browser")).toEqual(["plan", "run"]);
    expect(pillComposerDestinations("document")).toBeUndefined();
  });
});
