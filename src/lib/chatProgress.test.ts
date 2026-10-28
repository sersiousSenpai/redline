// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { chatProgress, elapsedLabel, isWaitingStatus } from "./chatProgress";
import { emptyMeter } from "./turnMeter";

describe("a live reply's progress phrase", () => {
  it("is the quiet typing state before any text or activity arrives, with a meaningful clock", () => {
    const p = chatProgress([], null, null, 10_000, 413_000);
    // D28: no "Preparing your reply" — the Spinner says it.
    expect(p.label).toBeNull();
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
    expect(chatProgress([], null, { at: 4_000, label: "Prior turn" }, 5_000, 11_000).label).toBeNull();
  });

  it("reads a growing reply as typing — no words — and never as inactive", () => {
    const activity = [{ at: 2_000, kind: "tool", label: "Grep…" }];
    const writing = chatProgress(activity, null, null, 1_000, 45_000, 44_000);
    expect(writing.label).toBeNull();
    expect(writing.quietFor).toBe(1_000);
    // A tool after the text began is the turn's newest step again.
    expect(chatProgress([...activity, { at: 46_000, kind: "tool", label: "Read…" }], null, null, 1_000, 47_000, 44_000).label).toBe("Reading files");
  });

  it("keeps a step the surface knows is still running ahead of the text written before it", () => {
    // The step's clock is the backend's and the text's is the render's, so a
    // step that fired a beat after the text can look older than it.
    const activity = [{ at: 43_000, kind: "tool", label: "reading the page…" }];
    expect(chatProgress(activity, null, { at: 43_000, label: "Reading the page" }, 1_000, 45_000, 44_000).label).toBeNull();
    expect(chatProgress(activity, null, { at: 43_000, label: "Reading the page", running: true }, 1_000, 45_000, 44_000).label).toBe("Reading the page");
  });

  it("never says a request is starting or rate limited: that is the wait (D28)", () => {
    const limited = { ...emptyMeter(), rateLimited: { status: "allowed_warning", resetsAt: null, kind: "five_hour" } };
    // The meter's flag alone, and its activity entry, read as the typing state.
    expect(chatProgress([], limited, null, 0, 12).label).toBeNull();
    expect(chatProgress([{ at: 5, kind: "rateLimit", label: "Rate limited (five_hour) · waiting" }], limited, null, 0, 12).label).toBeNull();
    expect(chatProgress([{ at: 5, kind: "requesting", label: "Requesting…" }], null, null, 0, 12).label).toBeNull();
    // A real step behind the notice still names itself.
    expect(chatProgress([{ at: 1, kind: "tool", label: "Read 1" }, { at: 5, kind: "rateLimit", label: "Rate limited (usage) · waiting" }], limited, { at: 11, label: "Fetching" }, 0, 12).label).toBe("Fetching");
    // Still the turn's sign of life for the quiet clock.
    expect(chatProgress([{ at: 5, kind: "rateLimit", label: "x" }], limited, null, 0, 12).quietFor).toBe(7);
    expect(elapsedLabel(-1)).toBe("0s");
  });

  it("never shows the daemon's own waiting words before the first token: the Spinner alone", () => {
    for (const label of ["Preparing chat context", "Starting the selected model", "Waiting for the model"]) {
      expect(isWaitingStatus(label)).toBe(true);
      expect(chatProgress([], null, { at: 2, label }, 0, 12).label).toBeNull();
    }
    // A real step before the wait word keeps its name.
    expect(chatProgress([{ at: 1, kind: "tool", label: "Read…" }], null, { at: 3, label: "Waiting for the model" }, 0, 12).label).toBe("Reading files");
    // And a real step the surface names is still a step.
    expect(isWaitingStatus("Opening the requested page")).toBe(false);
    expect(chatProgress([], null, { at: 2, label: "Searching your memory" }, 0, 12).label).toBe("Searching your memory");
  });
});
