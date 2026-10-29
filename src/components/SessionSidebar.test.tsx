// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";

// Every plan row computes its revision display once per render, so the calls
// count plan-row renders.
const { rowRenders, menuRenders } = vi.hoisted(() => ({ rowRenders: vi.fn(), menuRenders: vi.fn() }));
vi.mock("../lib/revisionVersions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/revisionVersions")>();
  return {
    ...real,
    computeRevisionDisplay: (revisions: Parameters<typeof real.computeRevisionDisplay>[0]) => {
      rowRenders(revisions);
      return real.computeRevisionDisplay(revisions);
    },
  };
});
// Every row (plan or chat) renders one ⋯ menu, so its renders count rows of
// every kind.
vi.mock("./RowMenu", async (importOriginal) => {
  const real = await importOriginal<typeof import("./RowMenu")>();
  return {
    ...real,
    RowMenu: (props: Parameters<typeof real.RowMenu>[0]) => {
      menuRenders(props.label);
      return real.RowMenu(props);
    },
  };
});

import { SessionSidebar, type SessionSidebarProps } from "./SessionSidebar";
import { keepEqualRows } from "../lib/keepEqual";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const summary = (id: string, updatedAt: number, pendingCount = 0, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectName: "redline",
  projectPath: "/repo/redline",
  planTitle: `Plan ${id}`,
  latestVersion: 1,
  revisions: [{ versionNumber: 1, receivedAt: updatedAt, threadStart: true, restored: false }],
  createdAt: 1,
  updatedAt,
  status: "in_review",
  pendingCount,
  awaitingReview: true,
  held: false,
  attachState: "idle",
  ...over,
});
// Module-stable, as App's `sidebarHandlers` are.
const handlers = {
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onExport: vi.fn(),
  onSelectRevision: vi.fn(),
};
const render = (sessions: SessionSummary[], activeId: string | null = "a") =>
  act(async () =>
    root.render(
      <SessionSidebar
        {...handlers}
        sessions={sessions}
        activeId={activeId}
        pendingCounts={Object.fromEntries(sessions.map((s) => [s.sessionId, s.pendingCount]))}
        viewedVersionNumber={null}
      />,
    ),
  );
const rendered = () => rowRenders.mock.calls.map(([revisions]) => revisions[0].receivedAt);
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const press = (el: Element, key: string) =>
  act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
// A row's ⋯ is out only while the row is hovered or focused (D37).
const focus = (el: Element | null) => act(async () => { (el as HTMLElement).focus(); });
const dots = async (row: HTMLElement) => {
  await focus(row.querySelector("button.rl-sb-plan, .rl-sb-row"));
  return row.querySelector<HTMLButtonElement>(".rl-sb-dots")!;
};
const planRow = (title: string) =>
  [...host.querySelectorAll<HTMLElement>("li.rl-session-row")].find((li) => li.querySelector(".rl-sb-plan-title")?.textContent === title)!;
const lightRow = (title: string) =>
  [...host.querySelectorAll<HTMLElement>(".rl-sb-item")].find((li) => li.querySelector(".rl-sb-title")?.textContent === title)!;

beforeEach(() => {
  rowRenders.mockClear();
  menuRenders.mockClear();
  for (const fn of Object.values(handlers)) fn.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the sessions list renders only the rows that changed", () => {
  it("a summaries read that bumps one session renders that row alone, even as it re-sorts", async () => {
    let list = [summary("a", 30), summary("b", 20), summary("c", 10)];
    await render(list);
    expect(rendered()).toEqual([30, 20, 10]);
    rowRenders.mockClear();
    // A fresh read: every object new, "c" bumped to the top with a comment.
    list = keepEqualRows(list, [summary("c", 40, 1), summary("a", 30), summary("b", 20)], (s) => s.sessionId);
    await render(list);
    expect(rendered()).toEqual([40]);
  });

  it("a read that changed nothing renders no row, and selecting renders the two rows it touched", async () => {
    let list = [summary("a", 30), summary("b", 20), summary("c", 10)];
    await render(list);
    rowRenders.mockClear();
    list = keepEqualRows(list, [summary("a", 30), summary("b", 20), summary("c", 10)], (s) => s.sessionId);
    await render(list);
    expect(rendered()).toEqual([]);
    // "b" renders twice: selected, then auto-expanded.
    await render(list, "b");
    expect([...new Set(rendered())].sort()).toEqual([20, 30]);
  });

  it("row clicks still reach the right session", async () => {
    const list = [summary("a", 30), summary("b", 20)];
    await render(list);
    const rows = host.querySelectorAll<HTMLButtonElement>("li.rl-session-row > button.rl-sb-plan");
    await act(async () => rows[1].click());
    expect(handlers.onSelect).toHaveBeenLastCalledWith("b");
  });

  it("counted by their ⋯ too: a bumped session renders its row alone, and selecting renders the one row", async () => {
    let sessions = [summary("a", 30), summary("b", 20), summary("c", 10)];
    await render(sessions, null);
    expect(menuRenders.mock.calls.map(([label]) => label)).toEqual(["Plan a", "Plan b", "Plan c"]);
    menuRenders.mockClear();
    sessions = keepEqualRows(sessions, [summary("c", 40, 0, { status: "approved" }), summary("a", 30), summary("b", 20)], (s) => s.sessionId);
    await render(sessions, null);
    expect(menuRenders.mock.calls.map(([label]) => label)).toEqual(["Plan c"]);
    menuRenders.mockClear();
    // "b" renders twice: selected, then auto-expanded. No other row does.
    await render(sessions, "b");
    expect([...new Set(menuRenders.mock.calls.map(([label]) => label))]).toEqual(["Plan b"]);
  });
});

describe("the classic row's ⋯ menu", () => {
  const withRename = { onRename: vi.fn(), onArchive: vi.fn() };
  const renderWith = (sessions: SessionSummary[]) =>
    act(async () =>
      root.render(
        <SessionSidebar
          {...handlers}
          {...withRename}
          sessions={sessions}
          activeId={null}
          pendingCounts={{}}
          viewedVersionNumber={null}
        />,
      ),
    );

  it("lists Open plan · Rename · Archive, then Delete plan below a rule with its ⌫", async () => {
    await renderWith([summary("a", 1)]);
    await click(await dots(planRow("Plan a")));
    const items = [...document.querySelectorAll<HTMLButtonElement>(".rl-row-menu-item")];
    expect(items.map((b) => b.querySelector(".rl-row-menu-label")!.textContent)).toEqual(["Open plan", "Rename", "Archive", "Delete plan"]);
    expect(items.every((b) => b.querySelector("svg"))).toBe(true);
    expect(items[3].dataset.danger).toBe("true");
    expect(items[3].previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(items[3].querySelector("kbd")!.textContent).toBe("⌫");
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".rl-row-menu-item")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".rl-sb-dots"));
  });

  it("renames over the row's own title: Enter saves and focus returns to the row", async () => {
    await renderWith([summary("a", 1)]);
    await click(await dots(planRow("Plan a")));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".rl-row-menu-item")][1].click());
    const input = host.querySelector<HTMLInputElement>("li.rl-session-row > input.rl-row-rename")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mine");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(withRename.onRename).toHaveBeenCalledWith("a", "Mine");
    expect(host.querySelector(".rl-row-rename")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("li.rl-session-row > button.rl-sb-plan"));
  });

  it("⌫ on a focused row asks in place; Cancel backs out, Delete deletes, and a held plan says it releases Claude", async () => {
    await renderWith([summary("a", 2), summary("h", 1, 0, { held: true })]);
    await press(planRow("Plan a").querySelector("button.rl-sb-plan")!, "Backspace");
    expect(planRow("Plan a").querySelector(".rl-session-confirm-yes")!.textContent).toBe("Delete");
    await click(planRow("Plan a").querySelector(".rl-session-confirm-no"));
    expect(planRow("Plan a").querySelector(".rl-session-confirm")).toBeNull();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    await press(planRow("Plan h").querySelector("button.rl-sb-plan")!, "Delete");
    expect(planRow("Plan h").querySelector(".rl-session-confirm-yes")!.textContent).toBe("Delete (release Claude)");
    await click(planRow("Plan h").querySelector(".rl-session-confirm-yes"));
    expect(handlers.onDelete).toHaveBeenCalledWith("h");
  });
});

// The grouped list: projects, chats, launches, the Places and the nested
// terminals. Rendered with the full handler set, as App's flow data is.
describe("the grouped sidebar", () => {
  const full = {
    ...handlers,
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onNewSession: vi.fn(),
    onNewSessionIn: vi.fn(),
    onSelectChat: vi.fn(),
    onRenameChat: vi.fn(),
    onArchiveChat: vi.fn(),
    onDeleteChat: vi.fn(),
  };
  const pendingCounts = {};
  const renderWith = (props: Partial<SessionSidebarProps> & { sessions: SessionSummary[] }) =>
    act(async () =>
      root.render(<SessionSidebar {...full} activeId={null} pendingCounts={pendingCounts} viewedVersionNumber={null} {...props} />),
    );
  beforeEach(() => { for (const fn of Object.values(full)) fn.mockClear(); });

  it("has no layout modes: one nav, with the Places above the grouped plan rows", async () => {
    await renderWith({ sessions: [summary("a", 2)] });
    expect(host.querySelector("nav.rl-sb")).not.toBeNull();
    expect(host.querySelector(".rl-sb-places")).not.toBeNull();
    expect(host.querySelector(".rl-session-row")).not.toBeNull();
    expect([...host.querySelectorAll(".rl-sb-label span[id]")].map((l) => l.textContent)).toEqual(["redline"]);
  });

  it("splits a project into Plans and Chats, each folding away on its header, its count kept (D31)", async () => {
    localStorage.removeItem("redline.sidebar.collapsedGroups");
    await renderWith({
      sessions: [summary("a", 2), summary("b", 1)],
      chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }],
      working: new Set(["chat:c"]),
    });
    const heads = () => [...host.querySelectorAll<HTMLButtonElement>(".rl-sb-group-head")];
    expect(heads().map((h) => [h.querySelector(".rl-sb-group-label")?.textContent, h.querySelector(".rl-sb-group-count")?.textContent, h.getAttribute("aria-expanded")])).toEqual([
      ["Plans", "2", "true"],
      ["Chats", "1", "true"],
    ]);
    // A group with an agent at work wears the shared Spinner, and says so.
    expect(heads()[1].querySelector(".rl-sb-group-working .rl-spinner")).not.toBeNull();
    expect(heads()[0].querySelector(".rl-sb-group-working")).toBeNull();
    const group = (kind: string) => host.querySelector(`.rl-sb-group[data-group="${kind}"]`)!;
    expect(group("plans").querySelectorAll("li.rl-session-row")).toHaveLength(2);
    expect(group("chats").textContent).toContain("Status check");
    await click(heads()[1]);
    expect(heads()[1].getAttribute("aria-expanded")).toBe("false");
    expect(group("chats").textContent).not.toContain("Status check");
    expect(heads()[1].querySelector(".rl-sb-group-count")?.textContent).toBe("1");
    // Kept for the next launch, per viewer.
    expect(JSON.parse(localStorage.getItem("redline.sidebar.collapsedGroups") ?? "[]")).toEqual(["project:/repo/redline|chats"]);
    await click(heads()[1]);
    expect(group("chats").textContent).toContain("Status check");
    localStorage.removeItem("redline.sidebar.collapsedGroups");
  });

  it("a plan row's menu opens it as a workspace (D29)", async () => {
    const onOpenWorkspace = vi.fn();
    await renderWith({ sessions: [summary("a", 1)], onOpenWorkspace });
    await click(await dots(planRow("Plan a")));
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Open as workspace"));
    expect(item).toBeDefined();
    await click(item!);
    expect(onOpenWorkspace).toHaveBeenCalledWith("a");
    expect(full.onSelect).not.toHaveBeenCalled();
  });

  it("Home alone without onSelectPlace, calling onNewPlan (else onNewSession); a project's + starts a session there", async () => {
    await renderWith({ sessions: [summary("a", 1)] });
    expect([...host.querySelectorAll(".rl-sb-place")].map((b) => b.getAttribute("aria-label"))).toEqual(["Home"]);
    // Nothing open: Home reads selected.
    expect(host.querySelector(".rl-sb-place")!.getAttribute("aria-current")).toBe("page");
    await click(host.querySelector(".rl-sb-place"));
    expect(full.onNewSession).toHaveBeenCalledWith();
    const onNewPlan = vi.fn();
    await renderWith({ sessions: [summary("a", 1)], onNewPlan, activeId: "a" });
    expect(host.querySelector(".rl-sb-place")!.getAttribute("aria-current")).toBeNull();
    await click(host.querySelector(".rl-sb-place"));
    expect(onNewPlan).toHaveBeenCalledWith();
    expect(full.onNewSession).toHaveBeenCalledTimes(1);
    await click(host.querySelector(".rl-sb-add"));
    expect(full.onNewSessionIn).toHaveBeenCalledWith("/repo/redline");
    expect(host.querySelector(".rl-sb-add")!.getAttribute("aria-label")).toBe("New session in redline");
  });

  it("the Places render with onSelectPlace, mark the current one, and say what is live", async () => {
    const onSelectPlace = vi.fn();
    await renderWith({ sessions: [summary("a", 1)], activeId: "a", place: "servers", onSelectPlace, localhostPorts: [":5173", ":7676", ":3000", ":8080"] });
    const places = [...host.querySelectorAll<HTMLButtonElement>(".rl-sb-place")];
    // Home, Browser and Localhost (D30); the Runs place went with the run feature.
    expect(places.map((b) => b.dataset.place)).toEqual(["home", "browser", "servers"]);
    // One row of icons (D39): each a 16px glyph, its name the label and the
    // tooltip, Localhost's tooltip listing what is live.
    expect(places.every((b) => b.parentElement === places[0].parentElement && b.textContent === "")).toBe(true);
    expect(places.map((b) => b.querySelector("svg")?.getAttribute("width"))).toEqual(["16", "16", "16"]);
    expect(places.map((b) => b.getAttribute("aria-label"))).toEqual(["Home", "Browser", "Localhost"]);
    expect(places.map((b) => b.title)).toEqual(["Home", "Browser", "Localhost · :5173 · :7676 · :3000 · :8080"]);
    expect(places.map((b) => b.getAttribute("aria-current"))).toEqual([null, null, "page"]);
    // Another Place owns the stage: no session row reads as open.
    expect(host.querySelector("li.rl-session-row button[aria-current]")).toBeNull();
    await click(places[2]);
    expect(onSelectPlace).toHaveBeenCalledWith("servers");
    await click(places[1]);
    expect(onSelectPlace).toHaveBeenCalledWith("browser");
    await click(places[0]);
    expect(onSelectPlace).toHaveBeenCalledWith("home");
    expect(full.onNewSession).not.toHaveBeenCalled();
  });

  it("the Places row is one tab stop, the current Place, and the arrows walk it (D39)", async () => {
    const onSelectPlace = vi.fn();
    await renderWith({ sessions: [summary("a", 1)], activeId: "a", place: "browser", onSelectPlace });
    const bar = host.querySelector<HTMLElement>(".rl-sb-places [role=toolbar]")!;
    expect(bar.getAttribute("aria-label")).toBe("Places");
    const places = [...bar.querySelectorAll<HTMLButtonElement>(".rl-sb-place")];
    expect(places.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    const key = (k: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await act(async () => places[1].focus());
    await key("ArrowRight");
    expect(document.activeElement).toBe(places[2]);
    await key("ArrowRight");
    expect(document.activeElement).toBe(places[0]);
    await key("ArrowLeft");
    expect(document.activeElement).toBe(places[2]);
    await key("Home");
    expect(document.activeElement).toBe(places[0]);
    await key("End");
    expect(document.activeElement).toBe(places[2]);
    await act(async () => places[2].click());
    expect(onSelectPlace).toHaveBeenCalledWith("servers");
    // Nothing current: the row is entered at Home.
    await renderWith({ sessions: [summary("a", 1)], activeId: "a", place: null, onSelectPlace });
    expect([...host.querySelectorAll<HTMLButtonElement>(".rl-sb-place")].map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  // D44: one dev server in qwallah put ":3000" on every qwallah plan.
  it("a project's servers are one chip on its header; a row wears one only for a server under its own terminal", async () => {
    const onOpenPort = vi.fn();
    const servers = [
      { port: 6006, url: "http://localhost:6006", projectPath: "/Users/me/web", projectName: "web", runCommand: "storybook" },
      { port: 5173, url: "http://localhost:5173", projectPath: "/Users/me/web/app", projectName: "app", runCommand: "npm run dev" },
    ];
    await renderWith({
      sessions: [
        summary("a", 3, 0, { projectPath: "/Users/me/web", projectName: "web" }),
        summary("b", 2, 0, { projectPath: "/Users/me/web", projectName: "web" }),
        summary("c", 1, 0, { projectPath: "/Users/me/api", projectName: "api" }),
      ],
      servers,
      terminals: {
        a: [{ id: "t1", title: "claude", status: "idle", ports: [] }, { id: "t2", title: "npm run dev", status: "idle", ports: [5173] }],
        b: [{ id: "t3", title: "claude", status: "idle", ports: [] }],
      },
      onOpenPort,
    });
    const header = (name: string) => [...host.querySelectorAll<HTMLElement>(".rl-sb-label")].find((l) => l.querySelector("span[id]")?.textContent === name)!;
    const head = header("web").querySelector<HTMLButtonElement>("button.rl-sb-port")!;
    expect(head.textContent).toBe(":5173 +1");
    expect(head.title).toBe(":5173 · npm run dev\n:6006 · storybook");
    expect(header("api").querySelector(".rl-sb-port")).toBeNull();
    // Only "a" runs one of them, under its own terminal; "b" shares the
    // folder and nothing more.
    const own = planRow("Plan a").querySelector<HTMLElement>(".rl-sb-port")!;
    expect(own.textContent).toBe(":5173");
    expect(own.getAttribute("role")).toBe("button");
    expect(planRow("Plan b").querySelector(".rl-sb-port")).toBeNull();
    expect(planRow("Plan c").querySelector(".rl-sb-port")).toBeNull();
    expect(host.querySelectorAll(".rl-sb-port")).toHaveLength(2);
    await click(own);
    expect(onOpenPort).toHaveBeenCalledWith("http://localhost:5173");
    expect(full.onSelect).not.toHaveBeenCalled();
    await click(head);
    expect(onOpenPort).toHaveBeenLastCalledWith("http://localhost:5173");
  });

  it("a summaries read that moved no server re-renders no row for its chip", async () => {
    const sessions = [summary("a", 2, 0, { projectPath: "/Users/me/web" }), summary("b", 1, 0, { projectPath: "/Users/me/api" })];
    const servers = () => [{ port: 5173, url: "http://localhost:5173", projectPath: "/Users/me/web", projectName: "web", runCommand: "vite" }];
    const terminals = { a: [{ id: "t1", title: "vite", status: "idle" as const, ports: [5173] }] };
    const onOpenPort = vi.fn();
    await renderWith({ sessions, servers: servers(), terminals, onOpenPort });
    expect(planRow("Plan a").querySelector(".rl-sb-port")).not.toBeNull();
    rowRenders.mockClear();
    // A fresh session list (same rows) and a fresh, equal server list.
    await renderWith({ sessions: [...sessions], servers: servers(), terminals, onOpenPort });
    expect(rowRenders).not.toHaveBeenCalled();
  });

  it("a terminal kept running after its wall closed stays under its session, says so, and a click brings it back; Home's sit under Home", async () => {
    const onSelectTerminal = vi.fn();
    await renderWith({
      sessions: [summary("a", 1)],
      terminals: { a: [{ id: "k1", title: "npm run dev", status: "idle", kept: true }, { id: "k2", title: "claude", status: "working", kept: true }] },
      homeTerminals: [{ id: "h1", title: "zsh 1", status: "needs" }],
      onSelectTerminal,
    });
    const kept = [...planRow("Plan a").querySelectorAll<HTMLElement>(".rl-sb-term")];
    expect(kept.map((t) => t.dataset.kept)).toEqual(["", ""]);
    expect(kept[0].querySelector(".rl-sb-term-state")!.textContent).toBe("kept");
    // A working one says working: its status wins over the hint.
    expect(kept[1].querySelector(".rl-sb-term-state")!.textContent).toBe("working");
    await click(kept[0].querySelector(".rl-sb-term-row"));
    expect(onSelectTerminal).toHaveBeenCalledWith("a", "k1");
    const home = host.querySelector(".rl-sb-places .rl-sb-term")!;
    expect(home.querySelector(".rl-sb-term-title")!.textContent).toBe("zsh 1");
    expect(home.querySelector(".rl-sb-need")).not.toBeNull();
    await click(home.querySelector(".rl-sb-term-row"));
    expect(onSelectTerminal).toHaveBeenCalledWith("", "h1");
  });

  it("nests a plan's terminals under its row, always, in the shared status vocabulary", async () => {
    const onSelectTerminal = vi.fn();
    await renderWith({
      sessions: [summary("a", 2), summary("b", 1)],
      terminals: {
        a: [
          { id: "t1", title: "claude", status: "working" },
          { id: "t2", title: "npm run dev", status: "idle" },
          { id: "t3", title: "codex", status: "needs" },
          { id: "t4", title: "old", status: "exited" },
        ],
      },
      onSelectTerminal,
    });
    const terms = [...planRow("Plan a").querySelectorAll<HTMLElement>(".rl-sb-term")];
    expect(terms.map((t) => t.querySelector(".rl-sb-term-title")!.textContent)).toEqual(["claude", "npm run dev", "codex", "old"]);
    expect(terms[0].querySelector(".rl-spinner")).not.toBeNull();
    expect(terms[0].querySelector(".rl-sb-term-state")!.textContent).toBe("working");
    expect(terms[1].querySelector(".rl-spinner, .rl-sb-need, .rl-sb-term-state")).toBeNull();
    expect(terms[2].querySelector(".rl-sb-need")).not.toBeNull();
    expect(terms[2].querySelector(".rl-spinner")).toBeNull();
    expect(terms[2].querySelector(".rl-sb-term-state")!.textContent).toBe("needs you");
    expect(terms[3].dataset.status).toBe("exited");
    expect(terms[3].querySelector(".rl-sb-term-state")!.textContent).toBe("exited");
    // The row itself wears the needs dot for its blocked terminal, outside
    // any Needs you section.
    expect(planRow("Plan a").querySelector("button.rl-sb-plan .rl-sb-need")).not.toBeNull();
    expect(planRow("Plan b").querySelector(".rl-sb-term, .rl-sb-need")).toBeNull();
    expect(host.querySelector(".rl-sb-section[data-kind='needs']")).toBeNull();
    await click(terms[2].querySelector(".rl-sb-term-row"));
    expect(onSelectTerminal).toHaveBeenCalledWith("a", "t3");
  });

  it("a row the engine says needs you leads in Needs you, with the amber dot and the reason", async () => {
    await renderWith({ sessions: [summary("a", 2), summary("b", 1)], needs: { "plan:b": "Question" }, working: new Set(["plan:a"]) });
    const labels = [...host.querySelectorAll(".rl-sb-label span[id]")].map((l) => l.textContent);
    expect(labels).toEqual(["Needs you", "redline"]);
    expect(host.querySelector(".rl-sb-section[data-kind='needs'] .rl-session-row .rl-sb-plan-title")!.textContent).toBe("Plan b");
    expect(planRow("Plan b").querySelector(".rl-sb-mark .rl-sb-need")).not.toBeNull();
    // Outside its project's group, the phrase names the project.
    expect(planRow("Plan b").querySelector(".rl-sb-phrase")!.textContent).toBe("redline · Waiting on you");
    expect(planRow("Plan b").querySelector(".rl-sb-phrase")!.getAttribute("title")).toBe("Claude asked you something and is waiting");
    expect(planRow("Plan a").querySelector(".rl-sb-mark .rl-spinner")).not.toBeNull();
    expect(planRow("Plan a").querySelector(".rl-sb-phrase")!.textContent).toBe("Revising");
  });

  it("a chat row: opens the chat, and its menu archives and deletes the chat", async () => {
    await renderWith({ sessions: [], chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }] });
    await click(lightRow("Status check").querySelector(".rl-sb-row"));
    expect(full.onSelectChat).toHaveBeenCalledWith("c");
    await click(await dots(lightRow("Status check")));
    expect([...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent)).toEqual(["Open chat", "Rename", "Archive", "Delete chat"]);
    await click([...document.querySelectorAll(".rl-row-menu-item")].find((b) => b.textContent === "Archive")!);
    expect(full.onArchiveChat).toHaveBeenCalledWith("c", true);
  });

  it("⌫ on a chat row asks in place; Escape backs out, Delete deletes", async () => {
    await renderWith({ sessions: [], chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }] });
    await press(lightRow("Status check").querySelector(".rl-sb-row")!, "Backspace");
    const yes = lightRow("Status check").querySelector<HTMLButtonElement>(".rl-sb-confirm-yes")!;
    expect(document.activeElement).toBe(yes);
    await press(yes, "Escape");
    expect(lightRow("Status check").querySelector(".rl-sb-confirm")).toBeNull();
    expect(document.activeElement).toBe(lightRow("Status check").querySelector(".rl-sb-row"));
    await press(lightRow("Status check").querySelector(".rl-sb-row")!, "Delete");
    await click(lightRow("Status check").querySelector(".rl-sb-confirm-yes"));
    expect(full.onDeleteChat).toHaveBeenCalledWith("c");
  });

  it("renames a chat in place: Enter saves, Escape writes nothing, an emptied field is a cancel", async () => {
    await renderWith({ sessions: [], chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }] });
    const open = async () => {
      await click(await dots(lightRow("Status check")));
      await click([...document.querySelectorAll(".rl-row-menu-item")].find((b) => b.textContent === "Rename")!);
      return host.querySelector<HTMLInputElement>(".rl-sb-item .rl-sb-rename")!;
    };
    const type = (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    let input = await open();
    expect(document.activeElement).toBe(input);
    await type(input, "Renamed");
    await press(input, "Escape");
    expect(full.onRenameChat).not.toHaveBeenCalled();
    input = await open();
    await type(input, "");
    await press(input, "Enter");
    expect(full.onRenameChat).not.toHaveBeenCalled();
    input = await open();
    await type(input, "  Renamed  ");
    await press(input, "Enter");
    expect(full.onRenameChat).toHaveBeenCalledWith("c", "Renamed");
  });

  it("a launch row lands under its project: spinning, italic, tagged launching, offering Open and Remove", async () => {
    const onSelectLaunch = vi.fn();
    await renderWith({
      sessions: [summary("a", 2)],
      launches: [{ terminalId: "t", title: "Plan the roadmap\nwith details", startedAt: 1, projectPath: "/repo/redline", working: true }],
      activeLaunchId: "t",
      onSelectLaunch,
    });
    const section = host.querySelector(".rl-sb-section[data-kind='project']")!;
    expect(section.querySelector(".rl-sb-label span[id]")!.textContent).toBe("redline");
    expect(section.querySelector(".rl-session-row .rl-sb-plan-title")!.textContent).toBe("Plan a");
    const launch = lightRow("Plan the roadmap");
    expect(section.contains(launch)).toBe(true);
    expect(launch.dataset.kind).toBe("launch");
    expect(launch.hasAttribute("data-active")).toBe(true);
    expect(launch.querySelector(".rl-sb-spin")).not.toBeNull();
    expect(launch.querySelector(".rl-sb-tag")!.textContent).toBe("launching");
    await click(launch.querySelector(".rl-sb-row"));
    expect(onSelectLaunch).toHaveBeenCalledWith("t");
    await click(await dots(launch));
    expect([...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent)).toEqual(["Open session", "Remove launch"]);
  });

  // LAST2 walk: a launch whose agent was killed before its plan read
  // "launching" for good and its row could not be removed.
  it("a launch stopped before its plan reads stopped, not launching, and its menu removes it", async () => {
    const onRemoveLaunch = vi.fn();
    await renderWith({
      sessions: [summary("a", 2)],
      launches: [{ terminalId: "t", title: "wb-last2-stop", startedAt: 1, projectPath: "/repo/redline", working: false, stopped: true }],
      onRemoveLaunch,
    });
    const launch = lightRow("wb-last2-stop");
    expect(launch.querySelector(".rl-sb-tag")!.textContent).toBe("Stopped");
    expect(launch.querySelector(".rl-sb-spin")).toBeNull();
    await click(await dots(launch));
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes("Remove launch"))!;
    await click(remove);
    expect(onRemoveLaunch).toHaveBeenCalledWith("t");
  });

  it("the open launch hands its row to the plan that arrives from its terminal", async () => {
    await renderWith({
      sessions: [summary("p", 2, 0, { held: true, heldTerminalId: "t", planTitle: "The plan" })],
      launches: [{ terminalId: "t", title: "Plan the roadmap", startedAt: 1, projectPath: "/repo/redline", working: true }],
      activeLaunchId: "t",
    });
    expect(host.querySelectorAll(".rl-sb-item")).toHaveLength(0);
    expect(planRow("The plan").querySelector("button.rl-sb-plan")!.getAttribute("aria-current")).toBe("page");
  });

  it("the open plan's versions nest under it and show the revision clicked", async () => {
    const revisions = [1, 2, 3].map((n) => ({ versionNumber: n, receivedAt: n, threadStart: n === 1, restored: false }));
    await renderWith({ sessions: [summary("a", 3, 0, { revisions, latestVersion: 3 })], activeId: "a", viewedVersionNumber: 1 });
    const versions = [...planRow("Plan a").querySelectorAll<HTMLButtonElement>("li.rl-revision-row > button")];
    expect(versions.map((v) => [v.querySelector(".font-mono")!.textContent, v.getAttribute("aria-current")])).toEqual([["v1", "true"], ["v2", null], ["v3", null]]);
    await click(versions[2]);
    expect(handlers.onSelectRevision).toHaveBeenCalledWith("a", null);
  });

  it("the start screen selects Home and leaves every row unselected", async () => {
    await renderWith({ sessions: [summary("a", 1)], activeId: "a", startActive: true });
    expect(host.querySelector(".rl-sb-place")!.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector("[aria-current='page']:not(.rl-sb-place)")).toBeNull();
  });

  it("folds archived rows at the end and projects past six", async () => {
    const sessions = [
      ...Array.from({ length: 8 }, (_, i) => summary(`s${i}`, 100 - i)),
      summary("old", 1, 0, { archivedAt: 5 }),
    ];
    await renderWith({ sessions });
    expect(host.querySelectorAll(".rl-session-row")).toHaveLength(6);
    const folds = [...host.querySelectorAll<HTMLButtonElement>(".rl-sb-fold")];
    expect(folds.map((f) => f.textContent)).toEqual(["Show 2 more", "Archived · 1"]);
    await click(folds[0]);
    expect(host.querySelectorAll(".rl-session-row")).toHaveLength(8);
    await click(host.querySelectorAll(".rl-sb-fold")[1]);
    expect(host.querySelectorAll(".rl-session-row")).toHaveLength(9);
  });

  it("the footer's New tab renders only when given and calls onNewTab", async () => {
    await renderWith({ sessions: [summary("a", 1)] });
    expect(host.querySelector(".rl-sb-newtab")).toBeNull();
    const onNewTab = vi.fn();
    await renderWith({ sessions: [summary("a", 1)], onNewTab });
    const tab = host.querySelector<HTMLButtonElement>(".rl-sb-newtab")!;
    expect(tab.querySelector("kbd")!.textContent).toBe("⌘T");
    await click(tab);
    expect(onNewTab).toHaveBeenCalledWith();
  });

  it("Combine picks rows in order and hands them over in pick order", async () => {
    const onCombine = vi.fn();
    await renderWith({ sessions: [summary("a", 3), summary("b", 2), summary("c", 1)], onCombine });
    await click(host.querySelector(".rl-cmb-enter"));
    await click(planRow("Plan c").querySelector("button.rl-sb-plan"));
    await click(planRow("Plan a").querySelector("button.rl-sb-plan"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(planRow("Plan c").querySelector(".rl-cmb-node")!.textContent).toBe("1");
    await click(host.querySelector(".rl-cmb-go"));
    expect(onCombine).toHaveBeenCalledWith(["c", "a"]);
    expect(host.querySelector(".rl-cmb-bar")).toBeNull();
  });
});

describe("a row's ⋯ (D37)", () => {
  const props = {
    ...handlers,
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onSelectChat: vi.fn(),
    onRenameChat: vi.fn(),
    onArchiveChat: vi.fn(),
    onDeleteChat: vi.fn(),
    activeId: null,
    pendingCounts: {},
    viewedVersionNumber: null,
    sessions: [summary("a", 2)],
    terminals: { a: [{ id: "t1", title: "claude", status: "idle" as const }] },
    chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }],
    launches: [{ terminalId: "l", title: "Plan the roadmap", startedAt: 1, projectPath: "/repo/redline", working: true }],
  };
  const renderAll = () => act(async () => root.render(<SessionSidebar {...props} />));
  const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
    act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });
  const key = (el: Element, init: KeyboardEventInit) =>
    act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const labels = () => [...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent);
  const rowButton = () => planRow("Plan a").querySelector<HTMLElement>("button.rl-sb-plan")!;

  it("a row at rest has none: not a plan, a chat, a launch or a terminal row", async () => {
    await renderAll();
    expect(host.querySelectorAll(".rl-session-row, .rl-sb-item, .rl-sb-term")).toHaveLength(4);
    expect(host.querySelector(".rl-sb-dots, [aria-label^='Actions for']")).toBeNull();
    // The version chip stands alone, and stays put under the pointer.
    const chip = [...rowButton().querySelectorAll("span")].find((el) => el.textContent === "v1")!;
    expect(chip.className).not.toMatch(/opacity|group-hover/);
  });

  it("hovering the row brings it at the far edge; a nested terminal row or leaving takes it away", async () => {
    await renderAll();
    await fire(rowButton().querySelector(".rl-sb-plan-title")!, "pointerover");
    expect(planRow("Plan a").querySelectorAll(".rl-sb-dots")).toHaveLength(1);
    expect(host.querySelectorAll(".rl-sb-dots")).toHaveLength(1);
    await fire(planRow("Plan a").querySelector(".rl-sb-term-row")!, "pointerover");
    expect(host.querySelector(".rl-sb-dots")).toBeNull();
    await fire(rowButton(), "pointerover");
    await fire(rowButton(), "pointerout", { relatedTarget: document.body });
    expect(host.querySelector(".rl-sb-dots")).toBeNull();
    await fire(lightRow("Status check").querySelector(".rl-sb-title")!, "pointerover");
    expect(lightRow("Status check").querySelector(".rl-sb-dots")).not.toBeNull();
  });

  it("focusing the row brings it next in the Tab order, and it stays while focused itself", async () => {
    await renderAll();
    await focus(rowButton());
    const dotsEl = planRow("Plan a").querySelector<HTMLButtonElement>(".rl-sb-dots")!;
    expect(rowButton().nextElementSibling).toBe(dotsEl);
    expect(dotsEl.getAttribute("aria-label")).toBe("Actions for Plan a");
    await focus(dotsEl);
    expect(document.activeElement).toBe(dotsEl);
    expect(planRow("Plan a").querySelector(".rl-sb-dots")).toBe(dotsEl);
    await focus(planRow("Plan a").querySelector(".rl-sb-term-row"));
    expect(host.querySelector(".rl-sb-dots")).toBeNull();
    const chatButton = lightRow("Status check").querySelector(".rl-sb-row")!;
    await focus(chatButton);
    expect(chatButton.nextElementSibling?.classList.contains("rl-sb-dots")).toBe(true);
  });

  it("right-click opens the row's menu at the pointer, its items unchanged", async () => {
    await renderAll();
    await fire(rowButton(), "contextmenu", { clientX: 120, clientY: 64 });
    expect(labels()).toEqual(["Open plan", "Rename", "Archive", "Delete plan"]);
    const layer = document.querySelector<HTMLElement>(".rl-row-menu-layer")!;
    expect([layer.style.left, layer.style.top]).toEqual(["120px", "64px"]);
    await key(document.activeElement!, { key: "Escape" });
    expect(document.querySelector(".rl-row-menu")).toBeNull();
    await fire(lightRow("Status check").querySelector(".rl-sb-row")!, "contextmenu", { clientX: 40, clientY: 200 });
    expect(labels()).toEqual(["Open chat", "Rename", "Archive", "Delete chat"]);
    await key(document.activeElement!, { key: "Escape" });
    await fire(lightRow("Plan the roadmap").querySelector(".rl-sb-row")!, "contextmenu", { clientX: 40, clientY: 240 });
    expect(labels()).toEqual(["Open session", "Remove launch"]);
  });

  // LAST2 walk: a terminal row's right-click showed WebKit's own menu.
  it("a terminal row's right-click opens its own menu, never WebKit's nor the plan row's", async () => {
    await renderAll();
    const term = planRow("Plan a").querySelector<HTMLElement>(".rl-sb-term .rl-sb-term-row")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 300 });
    await act(async () => { term.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(labels()).toEqual(["Show terminal"]);
  });

  it("⇧F10 and the menu key open the focused row's menu; Escape hands focus to its ⋯", async () => {
    await renderAll();
    await focus(rowButton());
    await key(rowButton(), { key: "F10", shiftKey: true });
    expect(labels()).toEqual(["Open plan", "Rename", "Archive", "Delete plan"]);
    expect(document.activeElement?.classList.contains("rl-row-menu-item")).toBe(true);
    await key(document.activeElement!, { key: "Escape" });
    expect(document.querySelector(".rl-row-menu")).toBeNull();
    expect(document.activeElement).toBe(planRow("Plan a").querySelector(".rl-sb-dots"));
    // F10 alone is not the menu key.
    await key(rowButton(), { key: "F10" });
    expect(document.querySelector(".rl-row-menu")).toBeNull();
    const chatButton = lightRow("Status check").querySelector<HTMLElement>(".rl-sb-row")!;
    await focus(chatButton);
    await key(chatButton, { key: "ContextMenu" });
    expect(labels()).toEqual(["Open chat", "Rename", "Archive", "Delete chat"]);
  });

  it("source pin: every sidebar row hands RowMenu its hover state, and RowMenu draws no ⋯ without it", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tsx = readFileSync("src/components/SessionSidebar.tsx", "utf8");
    const menus = tsx.split("<RowMenu").slice(1).map((tag) => tag.slice(0, tag.indexOf("/>")));
    // The plan and light rows' (⋯ while hot) and a terminal row's (no ⋯:
    // its menu is a right-click's, LAST2).
    expect(menus).toHaveLength(3);
    for (const tag of menus) expect(tag).toMatch(/trigger=\{(hot|false)\}/);
    // The plan row's version chip no longer steps aside for a ⋯.
    const planRowSource = tsx.slice(tsx.indexOf("function SessionRowBase("), tsx.indexOf("const SessionRow = memo("));
    expect(planRowSource).not.toContain("group-hover");
    const menu = readFileSync("src/components/RowMenu.tsx", "utf8");
    expect(menu).toContain("{(shown || open) && <button ref={anchor}");
    // The boxed chip is gone from every stylesheet and component.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const boxed = walk("src")
      .filter((p) => /\.(css|tsx?)$/.test(p) && !p.endsWith(".test.tsx"))
      .filter((p) => readFileSync(p, "utf8").includes("rl-row-menu-trigger"));
    expect(boxed).toEqual([]);
    // No opacity trick: at rest the ⋯ is not in the DOM at all.
    const css = readFileSync("src/components/SessionSidebar.css", "utf8");
    const rule = css.slice(css.indexOf(".rl-sb-dots {"), css.indexOf("}", css.indexOf(".rl-sb-dots {")));
    expect(rule).not.toContain("opacity");
  });
});

// D44: "more succinctly and aesthetically display the necessary information
// without everything being so cramped."
describe("a plan row (D44)", () => {
  const renderOne = (over: Partial<SessionSummary>, props: Partial<SessionSidebarProps> = {}) =>
    act(async () =>
      root.render(
        <SessionSidebar {...handlers} sessions={[summary("a", 1, over.pendingCount ?? 0, over)]} activeId={null}
          pendingCounts={{ a: over.pendingCount ?? 0 }} viewedVersionNumber={null} {...props} />,
      ),
    );
  const phrase = () => planRow("Plan a").querySelector(".rl-sb-phrase")!.textContent;
  const mark = () => {
    const m = planRow("Plan a").querySelector(".rl-sb-mark")!;
    return m.querySelector(".rl-sb-need") ? "needs" : m.querySelector(".rl-spinner") ? "working" : m.querySelector(".rl-sb-muted") ? "muted" : null;
  };

  it.each<[string, Partial<SessionSummary>, Partial<SessionSidebarProps>, string, string | null]>([
    ["in review", {}, {}, "In review", null],
    ["in review with comments", { pendingCount: 2 }, {}, "In review · 2 comments", null],
    ["one comment", { pendingCount: 1 }, {}, "In review · 1 comment", null],
    ["detached", { attachState: "detached" }, {}, "Detached", "muted"],
    ["detached with comments", { attachState: "detached", pendingCount: 3 }, {}, "Detached · 3 comments", "muted"],
    ["approved, not built", { status: "approved" }, {}, "Approved", null],
    ["handed to a builder", { status: "approved", runState: "building" }, {}, "Building", null],
    ["building right now", { status: "approved" }, { working: new Set(["plan:a"]) }, "Building", "working"],
    ["marked completed", { status: "approved", runState: "landed" }, {}, "Built", null],
    ["aborted", { status: "aborted" }, {}, "Aborted", "muted"],
    ["planned by Codex", { backend: "codex", model: "gpt-5" }, {}, "In review · Codex", null],
    ["detached Codex with a comment", { backend: "codex", attachState: "detached", pendingCount: 1 }, {}, "Detached · Codex · 1 comment", "muted"],
    ["a terminal waiting on you", {}, { terminals: { a: [{ id: "t", title: "claude", status: "needs" }] } }, "Waiting on you", "needs"],
    ["an unseen arrival", {}, { unseenIds: new Set(["a"]) }, "In review", "needs"],
  ])("%s: the phrase and the mark", async (_, over, props, text, want) => {
    await renderOne(over, props);
    expect(phrase()).toBe(text);
    expect(mark()).toBe(want);
    // No pills, no badge, no truncated status word: the phrase is the line.
    const row = planRow("Plan a");
    expect(row.querySelector(".rl-sb-pill, .rl-sb-statusword, .rl-sb-status-line, .rounded-full")).toBeNull();
    expect(row.querySelector(".rl-sb-plan-meta")!.textContent).toBe(text);
  });

  it("inside its project's group no project name; the title is the first line's, then the version chip", async () => {
    await renderOne({ projectName: "qwallah", projectPath: "/Users/me/qwallah" });
    const line = planRow("Plan a").querySelector(".rl-sb-plan-line")!;
    expect([...line.children].map((c) => c.className)).toEqual(["rl-sb-mark", "rl-sb-plan-title", "rl-sb-ver"]);
    expect(line.querySelector(".rl-sb-ver")!.textContent).toBe("v1");
    expect(planRow("Plan a").textContent).not.toContain("qwallah");
    // Two lines at most: nothing else in the row button.
    expect([...planRow("Plan a").querySelector("button.rl-sb-plan")!.children].map((c) => c.className)).toEqual(["rl-sb-plan-line", "rl-sb-plan-meta"]);
  });

  it("with revisions the chip reads v3 ▾ and toggles the tree, without opening the row; no left caret", async () => {
    const revisions = [1, 2, 3].map((n) => ({ versionNumber: n, receivedAt: n, threadStart: n === 1, restored: false }));
    await renderOne({ revisions, latestVersion: 3 });
    const chip = planRow("Plan a").querySelector<HTMLElement>(".rl-sb-ver")!;
    expect(chip.textContent).toBe("v3");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.getAttribute("role")).toBe("button");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(planRow("Plan a").querySelector("[aria-label='Expand revisions'], [aria-label='Collapse revisions']")).toBeNull();
    expect(planRow("Plan a").querySelectorAll("li.rl-revision-row")).toHaveLength(0);
    await click(chip);
    expect(planRow("Plan a").querySelectorAll("li.rl-revision-row")).toHaveLength(3);
    expect(planRow("Plan a").querySelector(".rl-sb-ver")!.getAttribute("aria-expanded")).toBe("true");
    expect(handlers.onSelect).not.toHaveBeenCalled();
    // The keyboard reaches it too.
    await press(planRow("Plan a").querySelector(".rl-sb-ver")!, "Enter");
    expect(planRow("Plan a").querySelectorAll("li.rl-revision-row")).toHaveLength(0);
    // A single revision: a plain chip, no toggle.
    await renderOne({});
    expect(planRow("Plan a").querySelector(".rl-sb-ver")!.getAttribute("role")).toBeNull();
  });

  it("the phrase stays the plan-state menu's trigger", async () => {
    await renderOne({}, { onSetPlanState: vi.fn() });
    const trigger = planRow("Plan a").querySelector<HTMLElement>("[aria-label='Change plan state']")!;
    expect(trigger.querySelector(".rl-sb-phrase")!.textContent).toBe("In review");
    await click(trigger);
    expect(document.querySelector("[role='menuitemradio']")).not.toBeNull();
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it("the stylesheet: a 28px first line, a 12px phrase, the ⋯ column kept clear", async () => {
    const { readFileSync } = await import("node:fs");
    const sheet = readFileSync("src/components/SessionSidebar.css", "utf8");
    const rule = (sel: string) => sheet.slice(sheet.indexOf(`${sel} {`), sheet.indexOf("}", sheet.indexOf(`${sel} {`)));
    expect(rule(".rl-sb-plan-line")).toContain("height: var(--rl-sb-row)");
    expect(sheet).toContain("--rl-sb-row: 28px");
    expect(rule(".rl-sb-plan-meta")).toContain("font-size: 12px");
    expect(rule(".rl-sb-plan-title")).toMatch(/flex: 1 1 auto;[\s\S]*text-overflow: ellipsis;/);
    // The ⋯ (24px at right: 4px) sits in the row's 32px right padding.
    expect(rule(".rl-sb-plan")).toContain("padding: 0 32px 6px 8px");
    expect(sheet).not.toMatch(/\.rl-sb-(pill|status-line|statusword)\b/);
  });
});

describe("the sidebar's class names", () => {
  it("are its own: no other stylesheet or component uses the rl-sb- prefix", async () => {
    // The start screen's `rl-fs-` names once collided with this sidebar's
    // (`.rl-fs-title` set its rows in the 36px welcome type).
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const users = walk("src")
      .filter((p) => /\.(css|tsx?)$/.test(p) && !/components\/SessionSidebar\.(css|tsx|test\.tsx)$/.test(p))
      .filter((p) => /\brl-sb-/.test(readFileSync(p, "utf8")));
    expect(users).toEqual([]);
  });
});

describe("the ports chip", () => {
  it("fits inside the phrase's line, so a server starting or stopping never grows the row", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/components/SessionSidebar.css", "utf8");
    const rule = css.slice(css.indexOf(".rl-sb-port {"), css.indexOf("}", css.indexOf(".rl-sb-port {")));
    const px = (prop: string) => Number(new RegExp(`[\\s;{]${prop}:\\s*(\\d+)px`).exec(rule)?.[1]);
    // The phrase's line: 16px.
    const meta = css.slice(css.indexOf(".rl-sb-plan-meta {"), css.indexOf("}", css.indexOf(".rl-sb-plan-meta {")));
    const line = Number(/line-height: (\d+)px/.exec(meta)?.[1]);
    expect(line).toBe(16);
    expect(rule).toContain("box-sizing: border-box");
    expect(px("height")).toBeLessThanOrEqual(line);
    // Its text line plus the 1px borders fit the box, and so does the globe.
    expect(px("line-height") + 2).toBeLessThanOrEqual(px("height"));
    const tsx = readFileSync("src/components/SessionSidebar.tsx", "utf8");
    const chip = tsx.slice(tsx.indexOf('className="rl-sb-port"'), tsx.indexOf("</span>", tsx.indexOf('className="rl-sb-port"')));
    const globe = Number(/<Globe size=\{(\d+)\}/.exec(chip)?.[1]);
    expect(globe).toBeLessThanOrEqual(px("line-height"));
  });
});

