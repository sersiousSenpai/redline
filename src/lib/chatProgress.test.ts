// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { chatProgress, elapsedLabel } from "./chatProgress";
import { emptyMeter } from "./turnMeter";

describe("a live reply's progress phrase", () => {
  it("keeps a meaningful elapsed clock before any text or activity arrives", () => {
    const p = chatProgress([], null, null, 10_000, 413_000);
    expect(p.label).toBe("Preparing your reply");
    expect(p.elapsed).toBe("6m 43s");
    expect(p.quietFor).toBe(403_000);
  });

  it("names observed tool work in plain words, never its arguments or reasoning", () => {
    expect(chatProgress([{ at: 1_000, kind: "tool", label: "Grep…" }], null, null, 500, 2_000).label).toBe("Searching source files");
    expect(chatProgress([{ at: 1_000, kind: "tool", label: "Reading session history" }], null, null, 500, 2_000).label).toBe("Reading session history");
  });

  it("uses fresh model activity over an obsolete retrieval caption and rejects a prior turn caption", () => {
    const activity = [{ at: 10_000, kind: "thinking", label: "Thinking…" }];
    expect(chatProgress(activity, null, { at: 9_000, label: "Old lookup" }, 5_000, 11_000).label).toBe("Thinking…");
    expect(chatProgress([], null, { at: 4_000, label: "Prior turn" }, 5_000, 11_000).label).toBe("Preparing your reply");
  });

  it("reads a growing reply as writing, and never as inactive", () => {
    const activity = [{ at: 2_000, kind: "tool", label: "Grep…" }];
    const writing = chatProgress(activity, null, null, 1_000, 45_000, 44_000);
    expect(writing.label).toBe("Writing the reply");
    expect(writing.quietFor).toBe(1_000);
    // A tool after the text began is the turn's newest step again.
    expect(chatProgress([...activity, { at: 46_000, kind: "tool", label: "Read…" }], null, null, 1_000, 47_000, 44_000).label).toBe("Reading files");
  });

  it("keeps a step the surface knows is still running ahead of the text written before it", () => {
    // The step's clock is the backend's and the text's is the render's, so a
    // step that fired a beat after the text can look older than it.
    const activity = [{ at: 43_000, kind: "tool", label: "reading the page…" }];
    expect(chatProgress(activity, null, { at: 43_000, label: "Reading the page" }, 1_000, 45_000, 44_000).label).toBe("Writing the reply");
    expect(chatProgress(activity, null, { at: 43_000, label: "Reading the page", running: true }, 1_000, 45_000, 44_000).label).toBe("Reading the page");
  });

  it("prioritizes rate limits", () => {
    const p = chatProgress([{ at: 1, kind: "tool", label: "Read 1" }], { ...emptyMeter(), rateLimited: { status: "limited", resetsAt: null, kind: "usage" } }, { at: 11, label: "Fetching" }, 0, 12);
    expect(p.label).toContain("Rate limited");
    expect(elapsedLabel(-1)).toBe("0s");
  });
});
