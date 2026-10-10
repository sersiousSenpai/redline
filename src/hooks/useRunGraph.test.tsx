// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../lib/runner/fixtures/basic.json";
import { normalizeGraph, type RunGraph } from "../lib/runner/schema";
const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
import { useRunGraph, useRunGraphList } from "./useRunGraph";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
let state: ReturnType<typeof useRunGraph>, list: ReturnType<typeof useRunGraphList>;
function Probe({ runId }: { runId: string }) { state = useRunGraph(runId, true); return null; }
function ListProbe() { list = useRunGraphList(true); return null; }
const view = (graph: unknown, extra: Record<string, unknown> = {}) => ({ graph, streams: {}, next: [], ...extra });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
beforeEach(() => {
  invokeMock.mockReset(); listenMock.mockReset(); listenMock.mockImplementation(async () => vi.fn());
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("native graph recovery and subscription lifetime", () => {
  it.each(["list", "graph"])("keeps %s readable after one subscription fails and cleans up successful listeners", async (kind) => {
    const unsubscribers = Array.from({ length: 5 }, () => vi.fn());
    let index = 0;
    listenMock.mockImplementation(() => {
      const call = index++;
      return call === 1 ? Promise.reject(new Error("event unavailable")) : Promise.resolve(unsubscribers[call]);
    });
    invokeMock.mockImplementation(async (command: string) => command === "runner_list" ? [fixture] : view(fixture));
    await act(async () => root.render(kind === "list" ? createElement(ListProbe) : createElement(Probe, { runId: fixture.runId })));
    expect(kind === "list" ? list.runs[0]?.runId : state.graph?.runId).toBe(fixture.runId);
    await act(async () => root.render(null));
    for (let i = 0; i < index; i++) if (i !== 1) expect(unsubscribers[i]).toHaveBeenCalledOnce();
  });
  it("ignores an old selection's late graph snapshot", async () => {
    const first = deferred<ReturnType<typeof view>>();
    const second = normalizeGraph({ ...fixture, runId: "run-other" } as unknown as RunGraph);
    invokeMock.mockImplementation(async (_command: string, args: { runId: string }) => args.runId === fixture.runId ? first.promise : view(second));
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    await act(async () => root.render(createElement(Probe, { runId: second.runId })));
    expect(state.graph?.runId).toBe(second.runId);
    await act(async () => first.resolve(view(normalizeGraph(fixture as unknown as RunGraph))));
    expect(state.graph?.runId).toBe(second.runId);
  });
});

describe("one view call per refresh", () => {
  const live = { ...fixture, status: "running", rev: 3, nodes: fixture.nodes.map((n) => n.id === "n-api" ? { ...n, status: "running", attempt: 1 } : n) };
  const stream = { streaming: true, partial: "half a reply", seq: 4, attempt: 1, meter: null, activity: [] };
  const events = new Map<string, (event: { payload: unknown }) => void>();
  beforeEach(() => {
    events.clear();
    listenMock.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => { events.set(name, handler); return vi.fn(); });
    invokeMock.mockImplementation(async () => view(live, { streams: { "n-api": stream }, next: ["n-ui"] }));
  });

  it("reads the graph, every live node's stream and the next nodes in one call", async () => {
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["runner_graph_view"]);
    expect(invokeMock).toHaveBeenCalledWith("runner_graph_view", { runId: fixture.runId });
    expect(state.graph?.rev).toBe(3);
    expect(state.streams["n-api"]?.partial).toBe("half a reply");
    expect(state.nextIds).toEqual(["n-ui"]);
  });

  it("keeps the last next nodes when the view could not read them", async () => {
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    invokeMock.mockImplementation(async () => view(live, { next: null }));
    await act(async () => state.refresh());
    expect(state.nextIds).toEqual(["n-ui"]);
  });

  it("fetches on a newer revision's event and skips one it already holds", async () => {
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    invokeMock.mockClear();
    await act(async () => events.get("run-graph")!({ payload: { runId: fixture.runId, rev: 3 } }));
    await act(async () => events.get("run-graph")!({ payload: { runId: "run-other", rev: 9 } }));
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => events.get("run-graph")!({ payload: { runId: fixture.runId, rev: 4 } }));
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["runner_graph_view"]);
  });
});
