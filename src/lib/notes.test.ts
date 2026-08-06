// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { noteOnEvent, noteTargetLabel, standaloneNote } from "./notes";

describe("note act builders", () => {
  it("builds a one-act text payload targeting an event by seq", () => {
    expect(noteOnEvent(42, { text: "margin note" })).toEqual({
      targetKind: "ledger_event",
      targetId: "42",
      text: "margin note",
    });
  });

  it("builds a one-act star payload without touching text", () => {
    const w = noteOnEvent(7, { starred: true });
    expect(w).toEqual({ targetKind: "ledger_event", targetId: "7", starred: true });
    expect("text" in w).toBe(false);
  });

  it("creates a standalone thought without a target, edits by row id", () => {
    expect(standaloneNote("a loose thought")).toEqual({ text: "a loose thought" });
    expect(standaloneNote("sharper", 3)).toEqual({ noteId: 3, text: "sharper" });
    expect("targetKind" in standaloneNote("x")).toBe(false);
  });
});

describe("noteTargetLabel", () => {
  it("labels each target keyspace", () => {
    expect(noteTargetLabel({ targetKind: "none", targetId: null })).toBe("standalone");
    expect(noteTargetLabel({ targetKind: "ledger_event", targetId: "42" })).toBe("on event #42");
    expect(noteTargetLabel({ targetKind: "class_node", targetId: "cn-a" })).toBe("on class cn-a");
    expect(
      noteTargetLabel({ targetKind: "session", targetId: "abcdef1234567890" }),
    ).toBe("on session abcdef12");
  });

  it("degrades unknown kinds without crashing", () => {
    expect(noteTargetLabel({ targetKind: "mystery", targetId: null })).toBe("on mystery");
  });
});
