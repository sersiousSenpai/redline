// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";

// Every row computes its revision display once per render, so the calls count
// row renders.
const { rowRenders } = vi.hoisted(() => ({ rowRenders: vi.fn() }));
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

import { SessionSidebar } from "./SessionSidebar";
import { keepEqualRows } from "../lib/keepEqual";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const summary = (id: string, updatedAt: number, pendingCount = 0): SessionSummary => ({
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

beforeEach(() => {
  rowRenders.mockClear();
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
});
