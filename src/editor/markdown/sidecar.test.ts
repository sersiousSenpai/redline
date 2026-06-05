// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  parseSidecarId,
  parseSidecarIdTyped,
  sidecarIdToString,
  type SidecarId,
} from "./sidecar";

describe("parseSidecarId — full sidecar comment matcher", () => {
  it("matches a bare block sidecar", () => {
    expect(parseSidecarId("<!-- rl:blk-7f3a -->")).toBe("blk-7f3a");
    expect(parseSidecarId("<!--rl:blk-AB_c-1-->")).toBe("blk-AB_c-1");
  });

  it("rejects non-sidecar comments and malformed payloads", () => {
    expect(parseSidecarId("<!-- not ours -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:other -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk- -->")).toBeNull();
    expect(parseSidecarId("plain text")).toBeNull();
  });

  it("accepts the sub-block grammar end-to-end", () => {
    expect(parseSidecarId("<!-- rl:blk-7f3a.l2 -->")).toBe("blk-7f3a.l2");
    expect(parseSidecarId("<!-- rl:blk-7f3a.l2.w5 -->")).toBe(
      "blk-7f3a.l2.w5",
    );
    expect(parseSidecarId("<!-- rl:blk-7f3a.s3.w2-w4 -->")).toBe(
      "blk-7f3a.s3.w2-w4",
    );
    // Single-word ranges canonicalize without redundant `-wN` half — mirrors
    // the Rust side so the wire format is byte-identical across runtimes.
    expect(parseSidecarId("<!-- rl:blk-7f3a.l1.w1-w1 -->")).toBe(
      "blk-7f3a.l1.w1",
    );
  });

  it("rejects malformed sub-block grammar", () => {
    // Trailing/leading/double dot, zero index, missing index, unknown axis,
    // reversed range, trailing garbage.
    expect(parseSidecarId("<!-- rl:blk-7f3a. -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a..l1 -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a.l0 -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a.l -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a.x2 -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a.l2.w5-w2 -->")).toBeNull();
    expect(parseSidecarId("<!-- rl:blk-7f3a.l2.w5.extra -->")).toBeNull();
  });
});

describe("parseSidecarIdTyped → SidecarId round-trip", () => {
  it("preserves every grammar shape through to-string-and-back", () => {
    const cases = [
      "blk-abc12345",
      "blk-abc12345.l2",
      "blk-abc12345.s3",
      "blk-abc12345.l2.w5",
      "blk-abc12345.l2.w5-w8",
      "blk-abc12345.s3.w2",
      "blk-abc12345.s3.w2-w4",
    ] as const;
    for (const s of cases) {
      const parsed = parseSidecarIdTyped(s);
      expect(parsed, `parse ${s}`).not.toBeNull();
      expect(sidecarIdToString(parsed as SidecarId)).toBe(s);
    }
  });

  it("returns the parent block id from the typed enum", () => {
    const parsed = parseSidecarIdTyped("blk-abc12345.s3.w2-w4");
    expect(parsed).toEqual({
      kind: "subBlock",
      blockId: "blk-abc12345",
      axis: { kind: "sentence", index: 3 },
      words: { start: 2, end: 4 },
    });
  });
});
