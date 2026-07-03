// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  collabRevisionKey,
  collabRoomName,
  decodeJoinCode,
  encodeJoinCode,
  randomToken,
  type CollabConfig,
} from "./collabConfig";

const config: CollabConfig = {
  sessionId: "s-abc123",
  threadStart: 2,
  version: 5,
  signaling: ["ws://192.168.1.10:4444", "wss://relay.example.com"],
  secret: "k3y-_secret",
  invite: "inv-42",
  ownerName: "Yusuf",
};

describe("join code", () => {
  it("round-trips every field", () => {
    expect(decodeJoinCode(encodeJoinCode(config))).toEqual(config);
  });

  it("round-trips without the optional owner name", () => {
    const { ownerName: _o, ...anon } = config;
    expect(decodeJoinCode(encodeJoinCode(anon))).toEqual(anon);
  });

  it("survives surrounding whitespace from a paste", () => {
    expect(decodeJoinCode(`  ${encodeJoinCode(config)}\n`)).toEqual(config);
  });

  it("round-trips unicode owner names", () => {
    const cfg = { ...config, ownerName: "يوسف ✅" };
    expect(decodeJoinCode(encodeJoinCode(cfg))).toEqual(cfg);
  });

  it("rejects garbage, wrong prefixes, and truncated payloads", () => {
    expect(decodeJoinCode("")).toBeNull();
    expect(decodeJoinCode("not a code")).toBeNull();
    expect(decodeJoinCode("RLC2." + "AAAA")).toBeNull();
    const code = encodeJoinCode(config);
    expect(decodeJoinCode(code.slice(0, code.length - 8))).toBeNull();
  });

  it("rejects structurally valid JSON missing required fields", () => {
    const wire = { v: 1, s: "session" }; // no signaling/secret/invite
    const b64 = btoa(JSON.stringify(wire))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeJoinCode("RLC1." + b64)).toBeNull();
  });

  it("rejects an empty signaling list", () => {
    expect(
      decodeJoinCode(encodeJoinCode({ ...config, signaling: [] })),
    ).toBeNull();
  });
});

describe("room naming", () => {
  it("derives room + revisionKey from the same triple", () => {
    const id = { sessionId: "s-1", threadStart: 0, version: 3 };
    expect(collabRoomName(id)).toBe("redline:s-1:0:v3");
    expect(collabRevisionKey(id)).toBe("s-1:0:3");
  });
});

describe("randomToken", () => {
  it("is URL-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
