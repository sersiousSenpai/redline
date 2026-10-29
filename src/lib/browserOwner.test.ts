// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { groupByOwner, isOwnerKey, ownerFor } from "./browserOwner";
import { restoreBrowserTabs } from "./browserLayout";

const page = (id: string, owner?: string) => ({ id, ...(owner ? { owner } : {}) });

describe("the browser's owner filter (W5)", () => {
  it("owners are plan and launch session keys; Home and junk own nothing", () => {
    expect(isOwnerKey("plan:s1")).toBe(true);
    expect(isOwnerKey("launch:l1")).toBe(true);
    for (const bad of ["home", "plan:", "regular", "plan:<script>", 3, null, undefined]) expect(isOwnerKey(bad)).toBe(false);
    expect(ownerFor("plan:s1")).toBe("plan:s1");
    expect(ownerFor("home")).toBeUndefined();
    expect(ownerFor(null)).toBeUndefined();
  });

  it("a session's pane leads with its own pages, then every other session's, each in strip order", () => {
    const tabs = [page("a", "plan:s2"), page("b", "plan:s1"), page("c"), page("d", "plan:s1")];
    expect(groupByOwner(tabs, "plan:s1")).toEqual({ here: [tabs[1], tabs[3]], others: [tabs[0], tabs[2]] });
  });

  it("Home shows everything in order, and a session with only its own pages needs no groups", () => {
    const tabs = [page("a", "plan:s1"), page("b")];
    expect(groupByOwner(tabs, "home")).toBeNull();
    expect(groupByOwner(tabs, null)).toBeNull();
    expect(groupByOwner([page("a", "plan:s1")], "plan:s1")).toBeNull();
    // A session with none of its own still says the rest are others'.
    expect(groupByOwner(tabs, "plan:s9")).toEqual({ here: [], others: tabs });
  });

  it("a page's owner survives the stored tab list, and junk is dropped", () => {
    const back = restoreBrowserTabs(
      [
        { browseId: "b1", url: "https://a.test", owner: "plan:s1" },
        { browseId: "b2", url: "https://b.test", owner: "<img onerror>" },
        { browseId: "b3", url: "https://c.test" },
      ],
      () => "x",
      (u) => u,
    );
    expect(back.map((t) => ("owner" in t ? t.owner : undefined))).toEqual(["plan:s1", undefined, undefined]);
  });
});
