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
    invokeMock.mockImplementation(async (command: string) => command === "runner_list" ? [fixture] : command === "runner_preview" ? [] : fixture);
    await act(async () => root.render(kind === "list" ? createElement(ListProbe) : createElement(Probe, { runId: fixture.runId })));
    expect(kind === "list" ? list.runs[0]?.runId : state.graph?.runId).toBe(fixture.runId);
    await act(async () => root.render(null));
    for (let i = 0; i < index; i++) if (i !== 1) expect(unsubscribers[i]).toHaveBeenCalledOnce();
  });
  it("ignores an old selection's late graph snapshot", async () => {
    const first = deferred<RunGraph>();
    const second = normalizeGraph({ ...fixture, runId: "run-other" } as unknown as RunGraph);
    invokeMock.mockImplementation(async (command: string, args: { runId: string }) => {
      if (command === "runner_preview") return [];
      return args.runId === fixture.runId ? first.promise : second;
    });
    await act(async () => root.render(createElement(Probe, { runId: fixture.runId })));
    await act(async () => root.render(createElement(Probe, { runId: second.runId })));
    expect(state.graph?.runId).toBe(second.runId);
    await act(async () => first.resolve(normalizeGraph(fixture as unknown as RunGraph)));
    expect(state.graph?.runId).toBe(second.runId);
  });
});
