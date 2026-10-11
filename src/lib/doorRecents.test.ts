// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { doorRecents, loadDoorTabs, PLAN_CACHE_MAX, rankDoorTabs, terms, type PlanText } from "./doorRecents";

const plan = (over: Partial<PlanText>): PlanText => ({ sessionId: "s", title: "", project: "", focus: "", text: "", research: [], ...over });

describe("terms", () => {
  it("meets a run-together name halfway", () => {
    expect(terms("MachineOS Desk").has("machineos")).toBe(true);
    // An acronym stays whole, and GitHub never reads as "git".
    expect(terms("LiDAR-GS on GitHub").has("lidar")).toBe(true);
    expect(terms("LiDAR-GS on GitHub").has("git")).toBe(false);
    expect(terms("current machine OS implementation").has("machineos")).toBe(true);
  });
});

describe("rankDoorTabs", () => {
  const plans = [
    plan({ sessionId: "m", title: "MachineOS Desk: native macOS companion", project: "machineos", focus: "Context Architecture", text: "current LiDAR shop scans, point clouds, room capture for the shop floor" }),
    plan({ sessionId: "r", title: "Sidebar: repo tabs → one dropdown", project: "redline", focus: "Context", text: "current sidebar dropdown repo tabs header" }),
  ];

  it("puts a mission's research next to the plan its goal is about, even unlinked", () => {
    const ranked = rankDoorTabs(plans, [
      { browseId: "news", url: "https://www.wsj.com/", title: "WSJ" },
      {
        browseId: "gs",
        url: "https://github.com/cqf7419/LiDAR-GS",
        title: "LiDAR-GS: Real-time LiDAR Re-Simulation using Gaussian Splatting",
        context: "Determine the optimal use of LiDAR for current machine OS implementation",
      },
    ]);
    expect(ranked[0]).toMatchObject({ browseId: "gs", plan: "MachineOS Desk: native macOS companion" });
    // Unrelated browsing still follows, unranked.
    expect(ranked[1]).toMatchObject({ browseId: "news" });
    expect(ranked[1].plan).toBeUndefined();
  });

  it("an explicit research link outranks everything and survives its tab closing", () => {
    const ranked = rankDoorTabs(
      [plan({ title: "Auth rewrite", research: [{ browseId: "gone", url: "https://oauth.net/2/", query: "oauth refresh rotation", createdAt: 1 }] })],
      [{ browseId: "gs", url: "https://github.com/x/lidar", title: "lidar" }],
    );
    expect(ranked[0]).toMatchObject({ browseId: "gone", url: "https://oauth.net/2/", title: "oauth refresh rotation", research: true });
  });

  it("a project name outweighs a word that merely appears in another plan's title", () => {
    const ranked = rankDoorTabs(
      [
        ...plans,
        plan({ sessionId: "a", title: "agent-craft: the creator’s harness for organizations", project: "redline" }),
      ],
      [{ browseId: "gs", url: "https://arxiv.org/abs/1", title: "LiDAR scan fusion", context: "LiDAR for machine OS and a VR goggles harness" }],
    );
    expect(ranked[0].plan).toBe("MachineOS Desk: native macOS companion");
  });

  it("a mission's goal never makes an unrelated page in it research", () => {
    const ranked = rankDoorTabs(plans, [
      { browseId: "cal", url: "https://muslimcalendar.com/host", title: "Host your event on MuslimCalendar", context: "LiDAR for machine OS" },
    ]);
    expect(ranked[0].plan).toBeUndefined();
  });

  it("does not tie a page to a plan over shared prose", () => {
    const ranked = rankDoorTabs(plans, [
      { browseId: "x", url: "https://example.dev/", title: "Current releases including client packages" },
    ]);
    expect(ranked[0].plan).toBeUndefined();
  });

  it("time breaks a tie between two plans the page shares words with", () => {
    const day = 86_400_000;
    const twins = [
      plan({ sessionId: "a", title: "Scan pipeline", project: "machineos", text: "lidar", times: [10 * day] }),
      plan({ sessionId: "b", title: "Scan viewer", project: "machineos", text: "lidar", times: [40 * day] }),
    ];
    const tab = { browseId: "t", url: "https://x.dev/lidar", title: "LiDAR scan fusion for MachineOS" };
    expect(rankDoorTabs(twins, [{ ...tab, at: 10 * day }])[0].plan).toBe("Scan pipeline");
    expect(rankDoorTabs(twins, [{ ...tab, at: 40 * day }])[0].plan).toBe("Scan viewer");
  });

  it("skips blank pages and duplicates", () => {
    const ranked = rankDoorTabs([], [
      { browseId: "a", url: "https://www.google.com/" },
      { browseId: "b", url: "https://a.dev/x" },
      { browseId: "c", url: "https://a.dev/x/" },
    ]);
    expect(ranked.map((t) => t.browseId)).toEqual(["b"]);
  });
});

describe("loadDoorTabs", () => {
  it("reads only recent unresolved plans, and missions' tabs with their goal", async () => {
    const now = 100 * 86_400_000;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_session") return { revisions: [{ rawPlanMarkdown: "# MachineOS LiDAR scans\nshop floor capture", comments: [] }] };
      if (cmd === "mission_list") return [{ missionId: "m1", title: "LiDAR", goal: "LiDAR for machine OS", status: "waiting_for_input", updatedAt: now }];
      if (cmd === "browser_workspace_read" && args?.workspaceId === "m1")
        return { tabs: [{ browseId: "gs", url: "https://github.com/x/gaussian-splats", title: "Gaussian Splatting from LiDAR" }] };
      if (cmd === "browser_workspace_read") return { tabs: [{ browseId: "w", url: "https://www.wsj.com/", title: "WSJ" }] };
      return null;
    }) as never;
    const tabs = await loadDoorTabs(invoke, [
      { sessionId: "fresh", planTitle: "MachineOS LiDAR scans", projectName: "machineos", updatedAt: now - 1, status: "in_review" },
      { sessionId: "done", planTitle: "Old", projectName: "x", updatedAt: now - 1, status: "approved" },
      { sessionId: "stale", planTitle: "Ancient", projectName: "y", updatedAt: 0, status: "in_review" },
    ], now);
    expect((invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "get_session")).toEqual([
      ["get_session", { id: "fresh" }],
    ]);
    expect(tabs.map((t) => t.browseId)).toEqual(["gs", "w"]);
    expect(tabs[0].plan).toBe("MachineOS LiDAR scans");
  });

  it("reads a plan again only when it changes, and remembers a bounded number", async () => {
    const now = 100 * 86_400_000;
    const invoke = vi.fn(async (cmd: string, _args?: { id: string }) =>
      cmd === "get_session" ? { revisions: [{ rawPlanMarkdown: "# Cache plan", comments: [] }] } : cmd === "mission_list" ? [] : null,
    );
    const reads = (id: string) => invoke.mock.calls.filter(([cmd, args]) => cmd === "get_session" && args?.id === id).length;
    const summary = (sessionId: string, updatedAt = now - 1) =>
      ({ sessionId, planTitle: sessionId, projectName: "p", updatedAt, status: "in_review" });
    await loadDoorTabs(invoke as never, [summary("cache-a")], now);
    await loadDoorTabs(invoke as never, [summary("cache-a")], now);
    expect(reads("cache-a")).toBe(1);
    await loadDoorTabs(invoke as never, [summary("cache-a", now - 2)], now);
    expect(reads("cache-a")).toBe(2);
    // Enough other plans to push the first one out.
    for (let pass = 0; pass < PLAN_CACHE_MAX / 8; pass++) {
      await loadDoorTabs(invoke as never, Array.from({ length: 8 }, (_, i) => summary(`cache-${pass}-${i}`)), now);
    }
    await loadDoorTabs(invoke as never, [summary("cache-a", now - 2)], now);
    expect(reads("cache-a")).toBe(3);
  });
});

describe("doorRecents", () => {
  it("groups plans, chats and tabs, capped per kind, tabs in ranked order", () => {
    const r = doorRecents({
      plans: [
        { sessionId: "p1", planTitle: "Old plan", projectName: "npla", updatedAt: 1 },
        { sessionId: "p2", planTitle: "Auth rewrite", projectName: "npla", updatedAt: 3 },
        { sessionId: "p3", planTitle: null, projectName: "redline", updatedAt: 2 },
      ],
      chats: [
        { companionId: "c1", title: "Pricing", status: "active", updatedAt: 5 },
        { companionId: "c2", title: "Gone", status: "archived", updatedAt: 9 },
      ],
      tabs: [
        { browseId: "b2", url: "https://www.cloudflare.com/x", title: "", plan: "Auth rewrite", why: "oauth" },
        { browseId: "b3", url: "https://a.dev/", title: "A" },
      ],
    });
    expect(r.map((x) => [x.kind, x.id, x.label])).toEqual([
      ["plan", "p2", "Auth rewrite"],
      ["plan", "p3", "redline"],
      ["chat", "c1", "Pricing"],
      ["browse", "b2", "cloudflare.com"],
      ["browse", "b3", "A"],
    ]);
    expect(r[3].detail).toContain("Research for “Auth rewrite”");
    // A page's row names where it lives, quietly; plans and chats live here.
    expect(r.map((x) => x.host)).toEqual([undefined, undefined, undefined, "cloudflare.com", "a.dev"]);
  });

  it("lists up to ten pages, while plans and chats stay at two", () => {
    const tabs = Array.from({ length: 14 }, (_, i) => ({ browseId: `b${i}`, url: `https://p${i}.dev/`, title: `P${i}`, mission: "LiDAR" }));
    const r = doorRecents({ plans: [], chats: [], tabs });
    expect(r.filter((x) => x.kind === "browse")).toHaveLength(10);
    expect(r[0].detail).toContain("From the “LiDAR” mission");
  });
});
