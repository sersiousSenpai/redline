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
const planRow = (title: string) =>
  [...host.querySelectorAll<HTMLElement>("li.rl-session-row")].find((li) => li.querySelector(".truncate")?.textContent === title)!;
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
    const rows = host.querySelectorAll<HTMLButtonElement>("li.rl-session-row > button.hover-elevated");
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
    await act(async () => host.querySelector<HTMLButtonElement>(".rl-row-menu-trigger")!.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>(".rl-row-menu-item")];
    expect(items.map((b) => b.querySelector(".rl-row-menu-label")!.textContent)).toEqual(["Open plan", "Rename", "Archive", "Delete plan"]);
    expect(items.every((b) => b.querySelector("svg"))).toBe(true);
    expect(items[3].dataset.danger).toBe("true");
    expect(items[3].previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(items[3].querySelector("kbd")!.textContent).toBe("⌫");
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".rl-row-menu-item")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".rl-row-menu-trigger"));
  });

  it("renames over the row's own title: Enter saves and focus returns to the row", async () => {
    await renderWith([summary("a", 1)]);
    await act(async () => host.querySelector<HTMLButtonElement>(".rl-row-menu-trigger")!.click());
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
    expect(document.activeElement).toBe(host.querySelector("li.rl-session-row > button.hover-elevated"));
  });

  it("⌫ on a focused row asks in place; Cancel backs out, Delete deletes, and a held plan says it releases Claude", async () => {
    await renderWith([summary("a", 2), summary("h", 1, 0, { held: true })]);
    await press(planRow("Plan a").querySelector("button.hover-elevated")!, "Backspace");
    expect(planRow("Plan a").querySelector(".rl-session-confirm-yes")!.textContent).toBe("Delete");
    await click(planRow("Plan a").querySelector(".rl-session-confirm-no"));
    expect(planRow("Plan a").querySelector(".rl-session-confirm")).toBeNull();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    await press(planRow("Plan h").querySelector("button.hover-elevated")!, "Delete");
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

  it("Home alone without onSelectPlace, calling onNewPlan (else onNewSession); a project's + starts a session there", async () => {
    await renderWith({ sessions: [summary("a", 1)] });
    expect([...host.querySelectorAll(".rl-sb-place")].map((b) => b.textContent)).toEqual(["Home"]);
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
    // Home and Localhost: the Runs place went with the run feature.
    expect(places.map((b) => b.dataset.place)).toEqual(["home", "servers"]);
    expect(places.map((b) => b.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(places[1].querySelector(".rl-sb-place-ports")!.textContent).toBe(":5173 · :7676 · :3000 +1");
    // Another Place owns the stage: no session row reads as open.
    expect(host.querySelector("li.rl-session-row button[aria-current]")).toBeNull();
    await click(places[1]);
    expect(onSelectPlace).toHaveBeenCalledWith("servers");
    await click(places[0]);
    expect(onSelectPlace).toHaveBeenCalledWith("home");
    expect(full.onNewSession).not.toHaveBeenCalled();
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
    expect(planRow("Plan a").querySelector("button.hover-elevated .rl-sb-need")).not.toBeNull();
    expect(planRow("Plan b").querySelector(".rl-sb-term, .rl-sb-need")).toBeNull();
    expect(host.querySelector(".rl-sb-section[data-kind='needs']")).toBeNull();
    await click(terms[2].querySelector(".rl-sb-term-row"));
    expect(onSelectTerminal).toHaveBeenCalledWith("a", "t3");
  });

  it("a row the engine says needs you leads in Needs you, with the amber dot and the reason", async () => {
    await renderWith({ sessions: [summary("a", 2), summary("b", 1)], needs: { "plan:b": "Question" }, working: new Set(["plan:a"]) });
    const labels = [...host.querySelectorAll(".rl-sb-label span[id]")].map((l) => l.textContent);
    expect(labels).toEqual(["Needs you", "redline"]);
    expect(host.querySelector(".rl-sb-section[data-kind='needs'] .rl-session-row .truncate")!.textContent).toBe("Plan b");
    expect(planRow("Plan b").querySelector(".rl-sb-need")).not.toBeNull();
    expect(planRow("Plan b").querySelector(".rl-sb-needword")!.textContent).toBe("Question for you");
    expect(planRow("Plan a").querySelector(".rl-spinner")).not.toBeNull();
  });

  it("a chat row: opens the chat, and its menu archives and deletes the chat", async () => {
    await renderWith({ sessions: [], chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/repo/redline" }] });
    await click(lightRow("Status check").querySelector(".rl-sb-row"));
    expect(full.onSelectChat).toHaveBeenCalledWith("c");
    await click(lightRow("Status check").querySelector(".rl-sb-dots"));
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
      await click(lightRow("Status check").querySelector(".rl-sb-dots"));
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

  it("a launch row lands under its project: spinning, italic, tagged launching, offering only Open", async () => {
    const onSelectLaunch = vi.fn();
    await renderWith({
      sessions: [summary("a", 2)],
      launches: [{ terminalId: "t", title: "Plan the roadmap\nwith details", startedAt: 1, projectPath: "/repo/redline", working: true }],
      activeLaunchId: "t",
      onSelectLaunch,
    });
    const section = host.querySelector(".rl-sb-section[data-kind='project']")!;
    expect(section.querySelector(".rl-sb-label span[id]")!.textContent).toBe("redline");
    expect(section.querySelector(".rl-session-row .truncate")!.textContent).toBe("Plan a");
    const launch = lightRow("Plan the roadmap");
    expect(section.contains(launch)).toBe(true);
    expect(launch.dataset.kind).toBe("launch");
    expect(launch.hasAttribute("data-active")).toBe(true);
    expect(launch.querySelector(".rl-sb-spin")).not.toBeNull();
    expect(launch.querySelector(".rl-sb-tag")!.textContent).toBe("launching");
    await click(launch.querySelector(".rl-sb-row"));
    expect(onSelectLaunch).toHaveBeenCalledWith("t");
    await click(launch.querySelector(".rl-sb-dots"));
    expect([...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent)).toEqual(["Open session"]);
  });

  it("the open launch hands its row to the plan that arrives from its terminal", async () => {
    await renderWith({
      sessions: [summary("p", 2, 0, { held: true, heldTerminalId: "t", planTitle: "The plan" })],
      launches: [{ terminalId: "t", title: "Plan the roadmap", startedAt: 1, projectPath: "/repo/redline", working: true }],
      activeLaunchId: "t",
    });
    expect(host.querySelectorAll(".rl-sb-item")).toHaveLength(0);
    expect(planRow("The plan").querySelector("button.hover-elevated")!.getAttribute("aria-current")).toBe("page");
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
    await click(planRow("Plan c").querySelector("button.hover-elevated"));
    await click(planRow("Plan a").querySelector("button.hover-elevated"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(planRow("Plan c").querySelector(".rl-cmb-node")!.textContent).toBe("1");
    await click(host.querySelector(".rl-cmb-go"));
    expect(onCombine).toHaveBeenCalledWith(["c", "a"]);
    expect(host.querySelector(".rl-cmb-bar")).toBeNull();
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
