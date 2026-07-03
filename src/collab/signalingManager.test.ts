// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Transport-side revocation core: the signaling server's RoomManager.
 * Pure-logic tests — the ws glue in server.mjs stays thin over this.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain-JS module shared with the node signaling server.
import { RoomManager, topicBase } from "../../signaling-server/manager.mjs";

const BASE = "redline:sess-1:0";

describe("topicBase", () => {
  it("maps every version and epoch topic to one room family", () => {
    expect(topicBase("redline:sess-1:0:v3")).toBe(BASE);
    expect(topicBase("redline:sess-1:0:v4:e2")).toBe(BASE);
  });

  it("leaves non-redline topics unmanaged", () => {
    expect(topicBase("some-other-room")).toBeNull();
    expect(topicBase("redline:short")).toBeNull();
  });
});

describe("RoomManager", () => {
  it("relays unmanaged rooms freely, with or without auth", () => {
    const m = new RoomManager();
    expect(m.canJoin("redline:sess-1:0:v1", null)).toBe(true);
    expect(m.canJoin("redline:sess-1:0:v1", "any-hash")).toBe(true);
    expect(m.canJoin("plain-yjs-room", null)).toBe(true);
  });

  it("enforces the allowlist once managed", () => {
    const m = new RoomManager();
    const r = m.manage(BASE, "admin-hash", {
      allowed: ["invite-a"],
      revoked: [],
      envelopes: {},
      epoch: 0,
    });
    expect(r.ok).toBe(true);
    expect(m.canJoin("redline:sess-1:0:v1", "admin-hash")).toBe(true);
    expect(m.canJoin("redline:sess-1:0:v1", "invite-a")).toBe(true);
    expect(m.canJoin("redline:sess-1:0:v1", "invite-b")).toBe(false);
    expect(m.canJoin("redline:sess-1:0:v1", null)).toBe(false);
    // Every topic of the family is covered, including future epochs.
    expect(m.canJoin("redline:sess-1:0:v9:e4", "invite-b")).toBe(false);
  });

  it("only the first admin can manage a base", () => {
    const m = new RoomManager();
    expect(m.manage(BASE, "admin-hash", { allowed: [], revoked: [], envelopes: {}, epoch: 0 }).ok).toBe(true);
    expect(m.manage(BASE, "impostor", { allowed: ["impostor"], revoked: [], envelopes: {}, epoch: 0 }).ok).toBe(false);
    expect(m.canJoin("redline:sess-1:0:v1", "impostor")).toBe(false);
  });

  it("revocation kicks exactly the newly revoked and sticks", () => {
    const m = new RoomManager();
    m.manage(BASE, "admin-hash", {
      allowed: ["invite-a", "invite-b"],
      revoked: [],
      envelopes: {},
      epoch: 0,
    });
    const r = m.manage(BASE, "admin-hash", {
      allowed: ["invite-a"],
      revoked: ["invite-b"],
      envelopes: { "invite-a": "sealed-blob" },
      epoch: 1,
    });
    expect(r.kicked).toEqual(["invite-b"]);
    expect(m.canJoin("redline:sess-1:0:v1", "invite-b")).toBe(false);
    expect(m.canJoin("redline:sess-1:0:v1", "invite-a")).toBe(true);
    // Re-managing the same state kicks nobody twice.
    const again = m.manage(BASE, "admin-hash", {
      allowed: ["invite-a"],
      revoked: ["invite-b"],
      envelopes: { "invite-a": "sealed-blob" },
      epoch: 1,
    });
    expect(again.kicked).toEqual([]);
  });

  it("serves each invite its own envelope and the current epoch", () => {
    const m = new RoomManager();
    m.manage(BASE, "admin-hash", {
      allowed: ["invite-a", "invite-b"],
      revoked: ["invite-c"],
      envelopes: { "invite-a": "blob-a", "invite-b": "blob-b" },
      epoch: 2,
    });
    expect(m.info(BASE, "invite-a")).toEqual({
      managed: true,
      allowed: true,
      epoch: 2,
      envelope: "blob-a",
      extra: {},
    });
    expect(m.info(BASE, "invite-c")).toEqual({
      managed: true,
      allowed: false,
      epoch: 2,
      envelope: null,
      extra: {},
    });
    expect(m.info("redline:other:0", "invite-a")).toEqual({
      managed: false,
      allowed: true,
      epoch: 0,
      envelope: null,
      extra: {},
    });
  });

  it("relays opaque room extras (current version) to joiners", () => {
    const m = new RoomManager();
    m.manage(BASE, "admin-hash", {
      allowed: ["invite-a"],
      revoked: [],
      envelopes: {},
      epoch: 0,
      extra: { version: 5 },
    });
    expect(m.info(BASE, "invite-a").extra).toEqual({ version: 5 });
  });
});
