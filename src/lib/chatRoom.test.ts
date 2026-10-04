// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { contextSummary, deliveryLabel, ideaNote, planFromReplyInstruction, repoState, type ChatContext } from "./chatRoom";

const ctx = (over: Partial<ChatContext["brief"]> = {}, memory: string | null = null): ChatContext => ({
  companionId: "c1",
  delivery: "full",
  briefBytes: 100,
  memory,
  at: 1,
  brief: { plans: [], repos: [], readyCount: null, ready: [], pages: [], decisions: [], mission: null, ...over },
});

describe("chat room context", () => {
  it("summarizes only what was injected, with honest counts", () => {
    expect(contextSummary(ctx())).toEqual([]);
    const full = ctx({
      plans: [{ sessionId: "s", title: "A", project: "p", status: "building", day: "2026-10-02" }],
      repos: [{ name: "r", path: "/r", branch: "main", dirty: 2 }, { name: "q", path: "/q", branch: null, dirty: null }],
      readyCount: 4,
      pages: [{ title: "T", url: "https://t" }],
      decisions: ["approval"],
      mission: { title: "M", goal: "G" },
    }, "Found 3 notes");
    expect(contextSummary(full)).toEqual(["1 plan", "2 repos", "4 ready", "1 page", "1 decision", "mission", "memory"]);
    // Zero ready work is not news; an unknown count is not zero.
    expect(contextSummary(ctx({ readyCount: 0 }))).toEqual([]);
  });

  it("says how the brief was delivered", () => {
    expect(deliveryLabel("full")).toMatch(/whole brief/);
    expect(deliveryLabel("delta")).toMatch(/only what changed/);
    expect(deliveryLabel("unchanged")).toMatch(/nothing was re-sent/);
  });

  it("reads a repo's git state plainly", () => {
    expect(repoState({ name: "r", path: "/r", branch: "main", dirty: 0 })).toBe("main · clean");
    expect(repoState({ name: "r", path: "/r", branch: "dev", dirty: 1 })).toBe("dev · 1 changed file");
    expect(repoState({ name: "r", path: "/r", branch: null, dirty: null })).toBe("no branch read · status unknown");
  });
});

describe("chat room capture", () => {
  it("tags a saved idea with the chat and the project", () => {
    const note = ideaNote("  Use a warm child.  ", { id: "c-9", title: "Speed" }, "/Users/me/redline/");
    expect(note.split("\n")[0]).toBe('💡 Idea from chat "Speed" · project redline [chat:c-9]');
    expect(note.endsWith("Use a warm child.")).toBe(true);
    expect(ideaNote("x", { id: "c", title: "T" }, null).split("\n")[0]).toBe('💡 Idea from chat "T" [chat:c]');
    expect(ideaNote("y".repeat(20_000), { id: "c", title: "T" }, null).length).toBeLessThan(8_100);
  });

  it("builds the plan instruction around the reply, bounded", () => {
    expect(planFromReplyInstruction("Option B")).toBe("Build the plan around this idea from the conversation:\n\nOption B");
    expect(planFromReplyInstruction("z".repeat(10_000)).length).toBeLessThan(4_100);
  });
});
