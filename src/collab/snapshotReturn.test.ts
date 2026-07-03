// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Async Review Request round-trips (plan §Verification):
 *  - snapshot encrypt → decrypt round-trip
 *  - HMAC-signed return verifies; wrong key / tampering rejected
 *  - re-anchor lands comments on the current revision and reports
 *    unresolvable anchors
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  decodeSnapshot,
  encodeSnapshot,
  normalizeViewerBase,
  snapshotLink,
  tokenFromLink,
  type SnapshotPayload,
} from "./snapshot";
import {
  deriveSigningKey,
  peekReturn,
  reanchorReturn,
  signReturn,
  verifyReturn,
  type ReturnPayload,
} from "./returnBlob";

beforeAll(async () => {
  // jsdom's crypto lacks subtle; fall back to Node's WebCrypto in tests.
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  }
});

const PLAN = `# Title <!-- rl:blk-1 -->

Intro paragraph. <!-- rl:blk-2 -->

## Detail <!-- rl:blk-3 -->

Body text that goes on for a while so compression has something to chew on.
Body text that goes on for a while so compression has something to chew on.
`;

function snapshot(): SnapshotPayload {
  return {
    v: 1,
    requestId: "req-1",
    baseVersion: 3,
    reviewerName: "John Doe",
    ownerName: "Yusuf",
    projectName: "redline",
    planTitle: "Title",
    markdown: PLAN,
    signingKey: "c2lnbmluZy1rZXk",
    createdAt: 1_700_000_000_000,
  };
}

describe("snapshot", () => {
  it("encrypt → decrypt round-trips the full payload", async () => {
    const token = await encodeSnapshot(snapshot());
    expect(token.startsWith("RLS1.")).toBe(true);
    const decoded = await decodeSnapshot(token);
    expect(decoded).toEqual(snapshot());
  });

  it("rejects a tampered token", async () => {
    const token = await encodeSnapshot(snapshot());
    const parts = token.split(".");
    // Flip a ciphertext character — GCM auth must fail.
    const data = parts[3];
    const flipped =
      data.slice(0, 10) + (data[10] === "A" ? "B" : "A") + data.slice(11);
    expect(
      await decodeSnapshot([parts[0], parts[1], parts[2], flipped].join(".")),
    ).toBeNull();
  });

  it("rejects garbage and foreign formats", async () => {
    expect(await decodeSnapshot("not-a-token")).toBeNull();
    expect(await decodeSnapshot("RLS1.z.only-three")).toBeNull();
    expect(await decodeSnapshot("")).toBeNull();
  });

  it("builds and re-parses viewer links", async () => {
    const token = await encodeSnapshot(snapshot());
    const link = snapshotLink("https://reviews.example/viewer/", token);
    expect(tokenFromLink(link)).toBe(token);
    expect(tokenFromLink(token)).toBe(token);
    expect(tokenFromLink("https://reviews.example/#nope")).toBeNull();
  });
});

describe("normalizeViewerBase", () => {
  it("accepts real http(s) URLs as-is", () => {
    expect(normalizeViewerBase("https://reviews.example.com/viewer/")).toBe(
      "https://reviews.example.com/viewer/",
    );
    expect(normalizeViewerBase("http://localhost:8080")).toBe(
      "http://localhost:8080/",
    );
  });

  it("upgrades plausible bare hosts to https", () => {
    expect(normalizeViewerBase("reviews.example.com/viewer")).toBe(
      "https://reviews.example.com/viewer",
    );
    expect(normalizeViewerBase("localhost:8080")).toBe(
      "https://localhost:8080/",
    );
  });

  it("rejects stray text — the T1#RLS1 bug", () => {
    // A leftover keystroke persisted in the field must NOT mint "T1#RLS1.…"
    // labeled as a review link.
    expect(normalizeViewerBase("T1")).toBeNull();
    expect(normalizeViewerBase("viewer")).toBeNull();
    expect(normalizeViewerBase("")).toBeNull();
    expect(normalizeViewerBase("   ")).toBeNull();
  });

  it("rejects non-web schemes and strips fragments", () => {
    expect(normalizeViewerBase("file:///tmp/viewer.html")).toBeNull();
    expect(normalizeViewerBase("javascript://alert(1)")).toBeNull();
    expect(normalizeViewerBase("https://reviews.example.com/#old")).toBe(
      "https://reviews.example.com/",
    );
  });
});

function returnPayload(): ReturnPayload {
  return {
    v: 1,
    requestId: "req-1",
    baseVersion: 3,
    reviewerName: "John Doe",
    createdAt: 1_700_000_100_000,
    comments: [
      {
        type: "feedback",
        blockId: "blk-2",
        body: "Tighten the intro.",
        selection: {
          charStart: 0,
          charEnd: 5,
          quotedText: "Intro",
        },
      },
      {
        type: "edit",
        blockId: "blk-3",
        body: "(edit)",
        edit: { original: "Detail", revised: "Details" },
      },
      { type: "question", blockId: "blk-gone", body: "Where did this go?" },
    ],
  };
}

describe("signed returns", () => {
  it("signs and verifies with the derived per-request key", async () => {
    const key = await deriveSigningKey("owner-secret-hex", "req-1");
    const blob = await signReturn(returnPayload(), key);
    expect(blob.startsWith("RLR1.")).toBe(true);
    expect(await verifyReturn(blob, key)).toEqual(returnPayload());
  });

  it("rejects the wrong key (different request / different owner)", async () => {
    const key = await deriveSigningKey("owner-secret-hex", "req-1");
    const otherRequest = await deriveSigningKey("owner-secret-hex", "req-2");
    const otherOwner = await deriveSigningKey("other-secret", "req-1");
    const blob = await signReturn(returnPayload(), key);
    expect(await verifyReturn(blob, otherRequest)).toBeNull();
    expect(await verifyReturn(blob, otherOwner)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const key = await deriveSigningKey("owner-secret-hex", "req-1");
    const blob = await signReturn(returnPayload(), key);
    const parts = blob.split(".");
    const forged = { ...returnPayload(), reviewerName: "Mallory" };
    const body = btoa(JSON.stringify(forged))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyReturn([parts[0], body, parts[2]].join("."), key)).toBeNull();
  });

  it("peeks the requestId without verifying", () => {
    expect(peekReturn("RLR1.junk.junk")).toBeNull();
  });
});

describe("re-anchor to current revision", () => {
  it("lands surviving blocks and surfaces unresolvable anchors", () => {
    // Current revision: blk-2 survived (new anchor position), blk-3 survived,
    // blk-gone was deleted by a revise round.
    const anchors = new Map([
      ["blk-1", "A"],
      ["blk-2", "A.p2"],
      ["blk-3", "A.s1"],
    ]);
    const { placed, orphans } = reanchorReturn(returnPayload(), anchors);
    expect(placed).toHaveLength(2);
    expect(placed[0]).toMatchObject({
      type: "feedback",
      anchorId: "A.p2",
      blockId: "blk-2",
      reviewer: "John Doe",
    });
    expect(placed[0].selection?.quotedText).toBe("Intro");
    expect(placed[1]).toMatchObject({
      type: "edit",
      anchorId: "A.s1",
      edit: { original: "Detail", revised: "Details" },
    });
    expect(orphans).toHaveLength(1);
    expect(orphans[0].blockId).toBe("blk-gone");
  });
});
