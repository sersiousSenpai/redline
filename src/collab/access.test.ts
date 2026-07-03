// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/** Envelope crypto for key rotation: the revoked peer must not be able to
 *  open ANY envelope; remaining peers open exactly theirs. */
import { beforeAll, describe, expect, it } from "vitest";

import { hashToken, openEnvelope, sealEnvelope, withAuth } from "./access";

beforeAll(async () => {
  // jsdom's crypto lacks subtle; fall back to Node's WebCrypto in tests.
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  }
});

const BASE = "redline:sess-1:0";

describe("secret envelopes", () => {
  it("round-trips for the invite it was sealed to", async () => {
    const sealed = await sealEnvelope("invite-token-a", BASE, {
      secret: "rotated-room-secret",
      epoch: 3,
    });
    const opened = await openEnvelope("invite-token-a", BASE, sealed);
    expect(opened).toEqual({ secret: "rotated-room-secret", epoch: 3 });
  });

  it("stays sealed against the wrong invite token (the revoked peer)", async () => {
    const sealed = await sealEnvelope("invite-token-a", BASE, {
      secret: "rotated-room-secret",
      epoch: 1,
    });
    expect(await openEnvelope("invite-token-b", BASE, sealed)).toBeNull();
  });

  it("is bound to the room family", async () => {
    const sealed = await sealEnvelope("invite-token-a", BASE, {
      secret: "s",
      epoch: 1,
    });
    expect(
      await openEnvelope("invite-token-a", "redline:other:0", sealed),
    ).toBeNull();
  });

  it("rejects garbage without throwing", async () => {
    expect(await openEnvelope("invite-token-a", BASE, "not-a-blob")).toBeNull();
    expect(await openEnvelope("invite-token-a", BASE, "")).toBeNull();
  });
});

describe("hashToken", () => {
  it("is deterministic hex — what the server compares against", async () => {
    const a = await hashToken("invite-token-a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("invite-token-a")).toBe(a);
    expect(await hashToken("invite-token-b")).not.toBe(a);
  });
});

describe("withAuth", () => {
  it("appends the token as a query param", () => {
    expect(withAuth("ws://relay:4444", "tok")).toBe("ws://relay:4444/?auth=tok");
    expect(withAuth("ws://relay:4444/path?x=1", "tok")).toBe(
      "ws://relay:4444/path?x=1&auth=tok",
    );
  });
});
