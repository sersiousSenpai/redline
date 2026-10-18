// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  anyApproved,
  continueLinks,
  effortLabel,
  flowMode,
  flowModelLabel,
  flowSubmitAction,
  tildePath,
} from "./flowStart";
import { modeHint } from "../shell/FlowStart";
import type { SessionSummary } from "../types";

const key = (over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) => ({
  key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, ...over,
});

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    projectName: "din",
    projectPath: "/Users/me/projects/din",
    latestVersion: 1,
    revisions: [],
    createdAt: 0,
    updatedAt: 0,
    status: "in_review",
    pendingCount: 0,
    awaitingReview: false,
    held: false,
    attachState: "idle",
    ...over,
  };
}

describe("the start screen's two modes", () => {
  it("reads a leftover Drafter or Run destination as Plan", () => {
    expect(flowMode("chat")).toBe("chat");
    expect(flowMode("plan")).toBe("plan");
    expect(flowMode("drafter")).toBe("plan");
    expect(flowMode("run")).toBe("plan");
  });

  it("⏎ sends to the mode, ⇧⏎ is a newline, ⌘⏎ is the direct run where there is one", () => {
    expect(flowSubmitAction(key(), "plan", true)).toBe("plan");
    expect(flowSubmitAction(key(), "chat", true)).toBe("chat");
    expect(flowSubmitAction(key({ shiftKey: true }), "plan", true)).toBe("newline");
    expect(flowSubmitAction(key({ metaKey: true }), "plan", true)).toBe("run");
    expect(flowSubmitAction(key({ ctrlKey: true }), "chat", true)).toBe("run");
    // No verified run on this harness: the modifier changes nothing.
    expect(flowSubmitAction(key({ metaKey: true }), "plan", false)).toBe("plan");
    expect(flowSubmitAction(key({ isComposing: true }), "plan", true)).toBe("ignore");
    expect(flowSubmitAction(key({ key: "a" }), "plan", true)).toBe("ignore");
  });

  it("says what the mode does, naming the harness that will do it", () => {
    expect(modeHint("plan", "Claude")).toBe("Claude writes a plan for you to redline before anything is built.");
    expect(modeHint("plan", "Codex")).toContain("Codex writes a plan");
    expect(modeHint("chat", "Claude")).toMatch(/^Think it through with Claude\./);
  });
});

describe("the model chip", () => {
  const catalogs = { codex: [{ slug: "gpt-5.5", displayName: "GPT-5.5", description: "", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }] };

  it("reads the model and effort, and the harness only when there is a choice of one", () => {
    expect(flowModelLabel({ backend: "codex", model: "gpt-5.5", effort: "high" }, catalogs, false)).toBe("GPT-5.5 · High");
    expect(flowModelLabel({ backend: "codex", model: "gpt-5.5", effort: "xhigh" }, catalogs, true)).toBe("Codex · GPT-5.5 · Extra high");
  });

  it("names the harness and its default when no model is picked", () => {
    expect(flowModelLabel({ backend: "claude-code", model: null, effort: null }, catalogs, false)).toBe("Claude · Default");
    expect(flowModelLabel({ backend: "claude-code", model: null, effort: "high" }, catalogs, false)).toBe("Claude · High");
  });

  it("keeps a model the catalog no longer lists, by its id", () => {
    expect(flowModelLabel({ backend: "codex", model: "gone-1", effort: null }, catalogs, false)).toBe("gone-1");
  });

  it("spells the efforts as the effort menu does", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("medium")).toBe("Medium");
  });
});

describe("the folder chip", () => {
  it("reads a folder under home from ~ and leaves others whole", () => {
    expect(tildePath("/Users/yusuf/projects/din")).toBe("~/projects/din");
    expect(tildePath("/Users/yusuf/projects/din/")).toBe("~/projects/din");
    expect(tildePath("/home/yusuf/code")).toBe("~/code");
    expect(tildePath("/Users/yusuf")).toBe("~");
    expect(tildePath("/opt/work")).toBe("/opt/work");
    expect(tildePath(null)).toBe("~");
  });
});

describe("Continue links", () => {
  it("offers the two most recent sessions still in review, by their shown title", () => {
    const links = continueLinks([
      summary({ sessionId: "old", updatedAt: 1, planTitle: "Old" }),
      summary({ sessionId: "approved", updatedAt: 9, status: "approved", planTitle: "Done" }),
      summary({ sessionId: "archived", updatedAt: 8, archivedAt: 8, planTitle: "Put away" }),
      summary({ sessionId: "renamed", updatedAt: 7, planTitle: "Plan", titleOverride: "Din retrieval plan" }),
      summary({ sessionId: "untitled", updatedAt: 6 }),
    ]);
    expect(links).toEqual([
      { id: "renamed", title: "Din retrieval plan" },
      { id: "untitled", title: "din" },
    ]);
  });
});

describe("the four-step strip", () => {
  it("retires once any session is approved, or has run", () => {
    expect(anyApproved([summary({ sessionId: "a" })])).toBe(false);
    expect(anyApproved([summary({ sessionId: "a", status: "approved" })])).toBe(true);
    expect(anyApproved([summary({ sessionId: "a", runState: "landed" })])).toBe(true);
  });
});
