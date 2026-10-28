// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser's new-tab page as RLPaneBrowser draws it (state "newtab"):
// kicker, 40 px serif title, the omnibox with Browse ⏎ and Agent search ⌥⏎,
// the live strip, Pick back up, Reading by subject and the Memory footer —
// and no thumbnail grid.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import BrowserHomePage, { type BrowserHomePageProps } from "./BrowserHomePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = new Date(2026, 9, 27, 1, 52).getTime();
const MIN = 60_000;
let host: HTMLDivElement, root: Root;
const page = { id: "new", browseId: "b-new", title: "New tab", url: "redline:newtab" };
const tabs = [
  page,
  { id: "rl", browseId: "b-rl", title: "Plan · Durable background jobs", url: "http://localhost:5173/plan" },
  { id: "pr", browseId: "b-pr", title: "PR #412", url: "https://github.com/x/y/pull/412" },
];
const feed = {
  recent: [
    { url: "http://localhost:5173/plan", title: "Plan", at: NOW - 20 * MIN },
    { url: "https://github.com/x/y/pull/412", title: "PR", at: NOW - 60 * MIN },
    { url: "https://arxiv.org/abs/1", title: "LiDAR-GS", at: new Date(2026, 9, 9).getTime() },
    { url: "https://github.com/kiss-icp", title: "KISS-ICP", at: new Date(2026, 9, 22).getTime() },
  ],
  frequent: [],
  tasks: [{ url: "https://docs.test/queue", title: "Queue docs", count: 2 }],
  missions: [{ missionId: "m1", title: "Agent harness landscape" }],
};
let results: Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  results = {
    browser_home_feed: feed,
    dev_servers_scan: { running: [{ pid: 7, port: 5173, extraPorts: [], url: "http://localhost:5173", comm: "node", args: "", projectPath: "/r", projectName: "Redline", stack: "Vite", runCommand: "", thumbPath: null }], recent: [], others: [] },
    shots_get_policy: { denylist: "# never\nmail.google.com\nbank.test\nchat.test", enabled: true },
    // Candidate tabs read missions and their pages.
    mission_list: [{ missionId: "m2", title: "LiDAR GS research", goal: "", status: "active", createdAt: 1, updatedAt: 2 }],
  };
  invoke.mockReset().mockImplementation(async (command: string, args?: { workspaceId?: string }) => {
    if (command === "browser_workspace_read") return args?.workspaceId === "m2" ? { tabs: [{ browseId: "x1", url: "https://arxiv.org/abs/1", title: "LiDAR-GS" }, { browseId: "x2", url: "https://github.com/kiss-icp", title: "KISS-ICP" }] } : null;
    return command in results ? results[command] : null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount(props: Partial<BrowserHomePageProps> = {}) {
  const handlers = { onBrowse: vi.fn(), onAgentSearch: vi.fn(), onOpen: vi.fn(), onSelectTab: vi.fn(), onMission: vi.fn(), onOpenMemory: vi.fn() };
  await act(async () => root.render(<BrowserHomePage page={page} tabs={tabs} now={NOW} {...handlers} {...props}/>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return handlers;
}
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const section = (label: string) => q(`section[aria-label="${label}"]`)!;
const buttonNamed = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

describe("the new-tab page", () => {
  it("draws the kicker, the title and the omnibox with its two verbs", async () => {
    await mount();
    expect(q(".rb-nt-kicker")!.textContent).toBe("Tuesday · 1:52 AM · 2 pages open");
    expect(q(".rb-nt-head h1")!.textContent).toBe("A place to pick up where you left off.");
    const omnibox = q('form[aria-label="Browse or search"]')!;
    expect(omnibox.querySelector<HTMLInputElement>("input")!.placeholder).toBe("Address, or something to find…");
    expect([...omnibox.querySelectorAll(".rb-nt-verb")].map((b) => b.textContent)).toEqual(["Browse⏎", "Agent search⌥⏎"]);
    expect(omnibox.querySelector('[aria-label="Go"]')).not.toBeNull();
  });

  it("Browse on ⏎ and Agent search on ⌥⏎ or its button; an empty box does neither", async () => {
    const h = await mount();
    const input = q('[aria-label="Address, or something to find"]') as HTMLInputElement;
    await act(async () => buttonNamed(host, "Browse").click());
    expect(h.onBrowse).not.toHaveBeenCalled();
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("tauri resize events");
    await act(async () => input.form!.requestSubmit());
    expect(h.onBrowse).toHaveBeenCalledWith("tauri resize events");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true })); });
    expect(h.onAgentSearch).toHaveBeenCalledWith("tauri resize events");
    await act(async () => buttonNamed(host, "Agent search").click());
    expect(h.onAgentSearch).toHaveBeenCalledTimes(2);
  });

  it("shows what is live: dev servers, pages the agent is working on, research missions", async () => {
    const h = await mount({ acting: new Set(["pr"]) });
    const live = q('[aria-label="Live now"]')!;
    const chips = [...live.querySelectorAll<HTMLButtonElement>(".rb-nt-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["localhost:5173Redline · Vite", "PR #412agent working", "Agent harness landscaperesearch"]);
    expect(chips[0].querySelector('.rb-nt-dot[data-tone="up"]')).not.toBeNull();
    expect(chips[1].querySelector(".rl-spinner")).not.toBeNull();
    await act(async () => chips[0].click()); expect(h.onOpen).toHaveBeenCalledWith("http://localhost:5173");
    await act(async () => chips[1].click()); expect(h.onSelectTab).toHaveBeenCalledWith("pr");
    await act(async () => chips[2].click()); expect(h.onMission).toHaveBeenCalledWith("m1");
  });

  it("Pick back up lists this workspace's pages and task lists, and Recently closed opens its list", async () => {
    const h = await mount({ closed: [{ url: "https://gone.test/a", title: "Gone page", at: NOW - 5 * MIN }] });
    const pick = section("Pick back up");
    const rows = () => [...pick.querySelectorAll<HTMLButtonElement>(".rb-nt-row")];
    expect(rows().map((r) => [r.querySelector(".rb-nt-row-title")!.textContent, r.querySelector(".rb-nt-row-age")?.textContent ?? ""])).toEqual([
      ["Plan · Durable background jobs · localhost", "20m"],
      ["PR #412 · github.com", "1h"],
      ["Queue docs · 2 unfinished tasks", ""],
      ["Recently closed · 1", ""],
    ]);
    await act(async () => rows()[0].click()); expect(h.onSelectTab).toHaveBeenCalledWith("rl");
    await act(async () => rows()[2].click()); expect(h.onOpen).toHaveBeenCalledWith("https://docs.test/queue");
    expect(rows()[3].getAttribute("aria-expanded")).toBe("false");
    await act(async () => rows()[3].click());
    expect(rows()[3].getAttribute("aria-expanded")).toBe("true");
    await act(async () => rows()[4].click()); expect(h.onOpen).toHaveBeenLastCalledWith("https://gone.test/a");
  });

  it("Reading, by subject groups what is not open by mission, and Memory's links open Memory", async () => {
    const h = await mount();
    const reading = section("Reading, by subject");
    expect([...reading.querySelectorAll(".rb-nt-subject-head")].map((g) => g.textContent)).toEqual(["LiDAR GS research· 2 pages · Oct 9–22"]);
    expect([...reading.querySelectorAll(".rb-nt-row-title")].map((t) => t.textContent)).toEqual(["KISS-ICP", "LiDAR-GS"]);
    await act(async () => buttonNamed(reading, "Ask Memory").click());
    const foot = q(".rb-nt-foot")!;
    expect(foot.textContent).toContain("Every page you read is filed in Memory, by subject, never by tab.");
    expect(foot.textContent).toContain("Never capture · 3 domains");
    await act(async () => buttonNamed(foot, "What did I read on…").click());
    await act(async () => buttonNamed(foot, "Never capture").click());
    expect(h.onOpenMemory).toHaveBeenCalledTimes(3);
  });

  it("draws no thumbnail grid and reads no screenshots", async () => {
    await mount();
    expect(host.querySelector("img")).toBeNull();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("shots_list");
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("read_file_base64");
  });

  it("says what each column will hold on first run, but only once history has loaded", async () => {
    results.browser_home_feed = { recent: [], frequent: [], tasks: [], missions: [] };
    results.dev_servers_scan = { running: [], recent: [], others: [] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    invoke.mockImplementation(async (command: string) => { if (command === "browser_home_feed") await gate; return command in results ? results[command] : null; });
    await act(async () => root.render(<BrowserHomePage page={page} tabs={[page]} now={NOW} onBrowse={vi.fn()} onAgentSearch={vi.fn()} onOpen={vi.fn()} onSelectTab={vi.fn()} onMission={vi.fn()}/>));
    expect(host.querySelector(".rb-nt-empty")).toBeNull();
    await act(async () => { release(); await gate; await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([...host.querySelectorAll(".rb-nt-empty")].map((p) => p.textContent)).toEqual([
      "Pages you open here stay in reach while you work.",
      "Pages you read are gathered here by subject.",
    ]);
    expect(q('[aria-label="Live now"]')).toBeNull();
    expect(q(".rb-nt-kicker")!.textContent).toBe("Tuesday · 1:52 AM");
    // Without a way to open Memory its links are plain words.
    expect(buttonNamed(host, "Ask Memory")).toBeUndefined();
  });
});
