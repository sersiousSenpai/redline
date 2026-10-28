// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { PANE_KINDS } from "./model";
import {
  RAIL_MAX_W,
  RAIL_MIN_W,
  clampRailWidth,
  parseRailMemory,
  railTabFor,
  railTabsFor,
  rememberRailTab,
} from "./rail";

describe("the rail's tabs per pane kind", () => {
  it("follows the frame's table, default first", () => {
    expect(railTabsFor("plan")).toEqual(["discussion", "talk", "files", "changes"]);
    expect(railTabsFor("drafter")).toEqual(["discussion", "talk", "files"]);
    expect(railTabsFor("browser")).toEqual(["talk", "files", "changes"]);
    expect(railTabsFor("review")).toEqual(["discussion", "changes", "files", "talk"]);
    for (const kind of ["chat", "terminals", "file", "door"] as const) expect(railTabsFor(kind)).toEqual(["files", "changes", "talk"]);
    expect(railTabsFor(null)).toEqual(["files", "changes", "talk"]);
  });
  it("every kind can reach Talk: voice is never buried", () => {
    for (const kind of PANE_KINDS) expect(railTabsFor(kind)).toContain("talk");
  });
});

describe("the remembered tab", () => {
  it("is the default until one is picked, then that one per kind", () => {
    expect(railTabFor("plan", {})).toBe("discussion");
    const memory = rememberRailTab({}, "plan", "files");
    expect(railTabFor("plan", memory)).toBe("files");
    // Another kind keeps its own.
    expect(railTabFor("browser", memory)).toBe("talk");
  });
  it("ignores a remembered tab the kind no longer offers", () => {
    expect(railTabFor("drafter", { drafter: "changes" })).toBe("discussion");
  });
  it("is identity when nothing changes, and never stores a tab a kind lacks", () => {
    const memory = rememberRailTab({}, "plan", "files");
    expect(rememberRailTab(memory, "plan", "files")).toBe(memory);
    expect(rememberRailTab(memory, "browser", "discussion")).toBe(memory);
    // No kind (nothing focused) is the door's row.
    expect(rememberRailTab({}, null, "changes")).toEqual({ door: "changes" });
  });
  it("parses what was stored as untrusted", () => {
    expect(parseRailMemory(null)).toEqual({});
    expect(parseRailMemory("plan")).toEqual({});
    expect(parseRailMemory(["files"])).toEqual({});
    expect(parseRailMemory({ plan: "files", browser: "discussion", nope: "files", file: 3, review: "talk" })).toEqual({ plan: "files", review: "talk" });
  });
});

describe("the rail's width", () => {
  it("clamps to 280–600 and survives garbage", () => {
    expect(clampRailWidth(240)).toBe(RAIL_MIN_W);
    expect(clampRailWidth(900)).toBe(RAIL_MAX_W);
    expect(clampRailWidth(360.4)).toBe(360);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_MIN_W);
  });
});
