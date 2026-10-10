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

describe("reads through the shared poll", () => {
  const events = new Map<string, (event: { payload: unknown }) => void>();
  let visibility: DocumentVisibilityState;
  let renders = 0;
  function CountedList() { renders++; list = useRunGraphList(true); return null; }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const setVisibility = (next: DocumentVisibilityState) => act(async () => { visibility = next; document.dispatchEvent(new Event("visibilitychange")); });
  beforeEach(() => {
    events.clear(); renders = 0; visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    listenMock.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => { events.set(name, handler); return vi.fn(); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("runs one view read at a time, and a refresh asked mid-read once it lands", async () => {
    const first = deferred<ReturnType<typeof view>>();
    invokeMock.mockReturnValueOnce(first.promise).mockImplementation(async () => view(fixture));
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    for (const rev of [7, 8, 9]) await act(async () => events.get("run-graph")!({ payload: { runId: fixture.runId, rev } }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(view(fixture)));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("stops the clock while the window is hidden and reads the moment it is shown", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(async () => view(fixture));
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await advance(4000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await setVisibility("hidden");
    await advance(12_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await setVisibility("visible");
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("shows a failed read, but not one from a run it has left", async () => {
    const left = deferred<never>();
    let fail = true;
    invokeMock.mockImplementation((_command: string, args: { runId: string }) =>
      args.runId === fixture.runId ? left.promise : fail ? Promise.reject(new Error("view unavailable")) : Promise.resolve(view({ ...fixture, runId: "run-other" })));
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    await act(async () => root.render(createElement(Probe, { runId: "run-other" })));
    expect(state.error).toBe("Error: view unavailable");
    fail = false;
    await act(async () => state.refresh());
    expect(state.error).toBeNull();
    await act(async () => { left.resolve(undefined as never); });
    expect(state.error).toBeNull();
  });

  it("a run list that didn't change costs the surface no render", async () => {
    vi.useFakeTimers();
    let rows = [fixture];
    invokeMock.mockImplementation(async () => rows.map((row) => ({ ...row })));
    await act(async () => root.render(createElement(CountedList)));
    expect(list.runs).toHaveLength(1);
    const settled = renders;
    await advance(8000);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(renders).toBe(settled);
    rows = [fixture, { ...fixture, runId: "run-other" }];
    await act(async () => events.get("run-finished")!({ payload: {} }));
    expect(list.runs.map((run) => run.runId)).toEqual([fixture.runId, "run-other"]);
    expect(renders).toBe(settled + 1);
  });
});
