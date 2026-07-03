// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { observeMeta, publishMeta, readMeta } from "./meta";

function wire(a: Y.Doc, b: Y.Doc): void {
  a.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(b, u, "relay");
  });
  b.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(a, u, "relay");
  });
}

describe("collab meta", () => {
  it("round-trips and republish is a no-op", () => {
    const ydoc = new Y.Doc();
    const meta = {
      currentVersion: 4,
      threadStart: 2,
      ownerName: "Yusuf",
      projectName: "redline",
      status: "reviewing",
    };
    expect(publishMeta(ydoc, meta)).toBe(5);
    expect(readMeta(ydoc)).toEqual(meta);
    expect(publishMeta(ydoc, meta)).toBe(0);
    expect(publishMeta(ydoc, { ...meta, currentVersion: 5 })).toBe(1);
    expect(readMeta(ydoc).currentVersion).toBe(5);
  });

  it("partial publish never clears other keys", () => {
    const ydoc = new Y.Doc();
    publishMeta(ydoc, { currentVersion: 3, ownerName: "Yusuf" });
    publishMeta(ydoc, { currentVersion: 4 });
    expect(readMeta(ydoc)).toEqual({ currentVersion: 4, ownerName: "Yusuf" });
  });

  it("hands the rollover bump across peers and observers see it", () => {
    const owner = new Y.Doc();
    const collab = new Y.Doc();
    wire(owner, collab);
    publishMeta(owner, { currentVersion: 1, threadStart: 0 });

    const seen: number[] = [];
    const unobserve = observeMeta(collab, () => {
      const v = readMeta(collab).currentVersion;
      if (typeof v === "number") seen.push(v);
    });
    // The pre-setSession bump: written into the old room's doc.
    publishMeta(owner, { currentVersion: 2 });
    expect(readMeta(collab).currentVersion).toBe(2);
    expect(seen).toContain(2);

    unobserve();
    const spy = vi.fn();
    const un2 = observeMeta(collab, spy);
    un2();
    publishMeta(owner, { currentVersion: 3 });
    expect(spy).not.toHaveBeenCalled();
    expect(readMeta(collab).currentVersion).toBe(3);
  });
});
