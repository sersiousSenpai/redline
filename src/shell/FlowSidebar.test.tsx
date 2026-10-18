// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";
import type { SessionSidebarProps } from "../components/SessionSidebar";

// Every row renders one ⋯ menu, so its renders count row renders.
const { rowRenders } = vi.hoisted(() => ({ rowRenders: vi.fn() }));
vi.mock("../components/RowMenu", async (importOriginal) => {
  const real = await importOriginal<typeof import("../components/RowMenu")>();
  return {
    ...real,
    RowMenu: (props: Parameters<typeof real.RowMenu>[0]) => {
      rowRenders(props.label);
      return real.RowMenu(props);
    },
  };
});

import FlowSidebar from "./FlowSidebar";
import { SessionSidebar } from "../components/SessionSidebar";
import { keepEqualRows } from "../lib/keepEqual";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (id: string, updatedAt: number, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectName: "din",
  projectPath: "/code/din",
  planTitle: `Plan ${id}`,
  latestVersion: 1,
  revisions: [{ versionNumber: 1, receivedAt: updatedAt, threadStart: true, restored: false }],
  createdAt: 1,
  updatedAt,
  status: "approved",
  pendingCount: 0,
  awaitingReview: false,
  held: false,
  attachState: "idle",
  ...over,
});
// Module-stable, as App's `useStableHandlers` makes them.
const handlers = {
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onArchive: vi.fn(),
  onExport: vi.fn(),
  onSelectRevision: vi.fn(),
  onNewSession: vi.fn(),
  onNewSessionIn: vi.fn(),
  onSelectChat: vi.fn(),
  onRenameChat: vi.fn(),
  onArchiveChat: vi.fn(),
  onDeleteChat: vi.fn(),
};
const pendingCounts = {};

let root: Root;
let host: HTMLDivElement;
const render = (props: Partial<SessionSidebarProps> & { sessions: SessionSummary[] }) =>
  act(async () =>
    root.render(<FlowSidebar {...handlers} activeId={null} pendingCounts={pendingCounts} viewedVersionNumber={null} {...props} />),
  );
const row = (title: string) =>
  [...host.querySelectorAll<HTMLElement>(".rl-fs-item")].find((li) => li.querySelector(".rl-fs-title")?.textContent === title)!;
const press = (el: Element, key: string) =>
  act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  rowRenders.mockClear();
  for (const fn of Object.values(handlers)) fn.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the flow sidebar", () => {
  it("is what SessionSidebar renders for layout=flow, and the classic list otherwise", async () => {
    const sessions = [summary("a", 2)];
    await act(async () => root.render(<SessionSidebar {...handlers} layout="flow" sessions={sessions} activeId={null} pendingCounts={pendingCounts} viewedVersionNumber={null} />));
    await vi.waitFor(() => expect(host.querySelector("nav.rl-fs")).not.toBeNull());
    expect(host.querySelector(".rl-session-row")).toBeNull();
    await act(async () => root.render(<SessionSidebar {...handlers} sessions={sessions} activeId={null} pendingCounts={pendingCounts} viewedVersionNumber={null} />));
    expect(host.querySelector("nav.rl-fs")).toBeNull();
    expect(host.querySelector(".rl-session-row")).not.toBeNull();
  });

  it("renders only the rows that changed when a summaries read bumps one", async () => {
    let sessions = [summary("a", 30), summary("b", 20), summary("c", 10)];
    await render({ sessions });
    expect(rowRenders.mock.calls.map(([label]) => label)).toEqual(["Plan a", "Plan b", "Plan c"]);
    rowRenders.mockClear();
    sessions = keepEqualRows(sessions, [summary("c", 40, { status: "in_review" }), summary("a", 30), summary("b", 20)], (s) => s.sessionId);
    await render({ sessions });
    expect(rowRenders.mock.calls.map(([label]) => label)).toEqual(["Plan c"]);
    rowRenders.mockClear();
    await render({ sessions, activeId: "b" });
    expect(rowRenders.mock.calls.map(([label]) => label)).toEqual(["Plan b"]);
  });

  it("starts a session from New session and in a project from its +", async () => {
    await render({ sessions: [summary("a", 1)] });
    await click(host.querySelector(".rl-fs-new")!);
    await click(host.querySelector(".rl-fs-add")!);
    expect(handlers.onNewSession).toHaveBeenCalledWith();
    expect(handlers.onNewSessionIn).toHaveBeenCalledWith("/code/din");
    expect(host.querySelector(".rl-fs-add")!.getAttribute("aria-label")).toBe("New session in din");
  });

  it("⌫ on a focused row asks in place; Escape backs out, Delete deletes", async () => {
    await render({ sessions: [summary("a", 2), summary("b", 1)] });
    await press(row("Plan b").querySelector(".rl-fs-row")!, "Backspace");
    const yes = row("Plan b").querySelector<HTMLButtonElement>(".rl-fs-confirm-yes")!;
    expect(document.activeElement).toBe(yes);
    await press(yes, "Escape");
    expect(row("Plan b").querySelector(".rl-fs-confirm")).toBeNull();
    expect(document.activeElement).toBe(row("Plan b").querySelector(".rl-fs-row"));
    expect(handlers.onDelete).not.toHaveBeenCalled();
    await press(row("Plan b").querySelector(".rl-fs-row")!, "Delete");
    await click(row("Plan b").querySelector(".rl-fs-confirm-yes")!);
    expect(handlers.onDelete).toHaveBeenCalledWith("b");
  });

  it("⌫ on the row's ⋯ asks too", async () => {
    await render({ sessions: [summary("a", 1)] });
    await press(row("Plan a").querySelector(".rl-fs-dots")!, "Backspace");
    expect(row("Plan a").querySelector(".rl-fs-confirm")).not.toBeNull();
  });

  it("a held plan's delete says it releases Claude", async () => {
    await render({ sessions: [summary("h", 1, { held: true, status: "in_review" })] });
    await press(row("Plan h").querySelector(".rl-fs-row")!, "Backspace");
    expect(row("Plan h").querySelector(".rl-fs-confirm-yes")!.textContent).toBe("Release & delete");
  });

  it("renames in place: Enter saves, Escape writes nothing, and an unchanged title is no write", async () => {
    await render({ sessions: [summary("a", 1)] });
    const open = async () => {
      await click(row("Plan a").querySelector(".rl-fs-dots")!);
      await click([...document.querySelectorAll(".rl-row-menu-item")].find((b) => b.textContent === "Rename")!);
      // The field stands in for the title, in the same row.
      return host.querySelector<HTMLInputElement>(".rl-fs-item .rl-fs-rename")!;
    };
    let input = await open();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Plan a");
    await press(input, "Enter");
    expect(handlers.onRename).not.toHaveBeenCalled();
    input = await open();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(input, "Escape");
    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row("Plan a").querySelector(".rl-fs-row"));
    input = await open();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  Renamed  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(input, "Enter");
    expect(handlers.onRename).toHaveBeenCalledWith("a", "Renamed");
  });

  it("a chat row: opens the chat, and its menu archives and deletes the chat", async () => {
    await render({ sessions: [], chats: [{ companionId: "c", title: "Status check", updatedAt: 1, projectPath: "/code/din" }] });
    await click(row("Status check").querySelector(".rl-fs-row")!);
    expect(handlers.onSelectChat).toHaveBeenCalledWith("c");
    await click(row("Status check").querySelector(".rl-fs-dots")!);
    expect([...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent)).toEqual(["Open chat", "Rename", "Archive", "Delete chat"]);
    await click([...document.querySelectorAll(".rl-row-menu-item")].find((b) => b.textContent === "Archive")!);
    expect(handlers.onArchiveChat).toHaveBeenCalledWith("c", true);
  });

  it("a launch row opens its session and offers nothing it cannot do yet", async () => {
    const onSelectLaunch = vi.fn();
    await render({ sessions: [], launches: [{ terminalId: "t", title: "Plan the roadmap", startedAt: 1, projectPath: "/code/din", working: true }], activeLaunchId: "t", onSelectLaunch });
    expect(row("Plan the roadmap").hasAttribute("data-active")).toBe(true);
    expect(row("Plan the roadmap").querySelector(".rl-fs-spin")).not.toBeNull();
    await click(row("Plan the roadmap").querySelector(".rl-fs-row")!);
    expect(onSelectLaunch).toHaveBeenCalledWith("t");
    await click(row("Plan the roadmap").querySelector(".rl-fs-dots")!);
    expect([...document.querySelectorAll(".rl-row-menu-label")].map((l) => l.textContent)).toEqual(["Open session"]);
  });

  it("the open launch hands its row to the plan that arrives from its terminal", async () => {
    await render({
      sessions: [summary("p", 2, { held: true, heldTerminalId: "t", status: "in_review", planTitle: "The plan" })],
      launches: [{ terminalId: "t", title: "Plan the roadmap", startedAt: 1, projectPath: "/code/din", working: true }],
      activeLaunchId: "t",
    });
    expect(host.querySelectorAll(".rl-fs-item")).toHaveLength(1);
    expect(row("The plan").hasAttribute("data-active")).toBe(true);
  });

  it("the open plan's versions nest under it and show the revision clicked", async () => {
    const revisions = [1, 2, 3].map((n) => ({ versionNumber: n, receivedAt: n, threadStart: n === 1, restored: false }));
    await render({ sessions: [summary("a", 3, { revisions, latestVersion: 3 })], activeId: "a", viewedVersionNumber: 1 });
    expect(row("Plan a").hasAttribute("data-nest")).toBe(true);
    const versions = [...row("Plan a").querySelectorAll<HTMLButtonElement>(".rl-fs-version")];
    expect(versions.map((v) => [v.firstChild!.textContent, v.getAttribute("aria-current")])).toEqual([["v1", "true"], ["v2", null], ["v3 · latest", null]]);
    await click(versions[2]);
    expect(handlers.onSelectRevision).toHaveBeenCalledWith("a", null);
  });

  it("the start screen fills New session and leaves every row unselected", async () => {
    await render({ sessions: [summary("a", 1)], activeId: "a", startActive: true });
    expect(host.querySelector(".rl-fs-new")!.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector("[data-active]")).toBeNull();
  });
});
