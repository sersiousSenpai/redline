// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  groupOffers,
  offerChipLabel,
  type CommentOffer,
} from "./commentOffers";

const offer = (over: Partial<CommentOffer> = {}): CommentOffer => ({
  id: "o1",
  sessionId: "sess-1",
  messageId: null,
  blockId: "rl:blk-abc",
  body: "Make the retry budget configurable",
  label: null,
  agentId: "voice",
  status: "pending",
  createdAt: 100,
  ...over,
});

describe("groupOffers", () => {
  it("attaches offers to the reply they name", () => {
    const { byMessage, loose } = groupOffers(
      [{ id: "m1" }, { id: "m2" }],
      [
        offer({ id: "a", messageId: "m1" }),
        offer({ id: "b", messageId: "m2" }),
      ],
    );
    expect(loose).toEqual([]);
    expect(byMessage.get("m1")?.map((o) => o.id)).toEqual(["a"]);
    expect(byMessage.get("m2")?.map((o) => o.id)).toEqual(["b"]);
  });

  it("keeps unbound offers loose rather than dropping them", () => {
    // Not yet bound (the turn is still streaming), and bound to a line this
    // transcript doesn't have — both must still render somewhere.
    const { byMessage, loose } = groupOffers(
      [{ id: "m1" }],
      [
        offer({ id: "a", messageId: null }),
        offer({ id: "b", messageId: "m-gone" }),
      ],
    );
    expect(byMessage.size).toBe(0);
    expect(loose.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("groups several offers under one message, in order", () => {
    const { byMessage } = groupOffers(
      [{ id: "m1" }],
      [
        offer({ id: "a", messageId: "m1", createdAt: 100 }),
        offer({ id: "b", messageId: "m1", createdAt: 200 }),
      ],
    );
    expect(byMessage.get("m1")?.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("is stable when a message id repeats in the transcript", () => {
    // Locally-appended lines carry no id, and a rehydrate merge can briefly
    // show the same id twice — grouping must not duplicate the offer.
    const { byMessage, loose } = groupOffers(
      [{ id: "m1" }, {}, { id: "m1" }],
      [offer({ id: "a", messageId: "m1" })],
    );
    expect(byMessage.size).toBe(1);
    expect(byMessage.get("m1")?.map((o) => o.id)).toEqual(["a"]);
    expect(loose).toEqual([]);
  });

  it("treats an empty transcript as all-loose", () => {
    const { loose } = groupOffers([], [offer({ messageId: "m1" })]);
    expect(loose).toHaveLength(1);
  });
});

describe("offerChipLabel", () => {
  it("prefers the agent's own label", () => {
    expect(offerChipLabel(offer({ label: "  Configurable retries  " }))).toBe(
      "Configurable retries",
    );
  });

  it("falls back to the body, truncated", () => {
    expect(offerChipLabel(offer({ body: "  short body  " }))).toBe("short body");
    const long = "x".repeat(80);
    const out = offerChipLabel(offer({ body: long }));
    expect(out).toHaveLength(48);
    expect(out.endsWith("…")).toBe(true);
  });

  it("ignores a blank label", () => {
    expect(offerChipLabel(offer({ label: "   ", body: "the body" }))).toBe(
      "the body",
    );
  });
});
