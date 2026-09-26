// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useElementPicker, PICKING_ERROR, PICKING_TIMEOUT_MS } from "./useElementPicker";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, picker: ReturnType<typeof useElementPicker>;
const onError = vi.fn();
function Harness() { picker = useElementPicker("browser-one", onError); return <span>{picker.picking ? "picking" : "idle"}</span>; }
beforeEach(async () => {
  vi.useFakeTimers(); invoke.mockReset(); onError.mockReset(); invoke.mockResolvedValue(null);
  host = document.createElement("div"); root = createRoot(host);
  await act(async () => root.render(<Harness/>));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it("rejects non-http pages visibly without injecting a script", async () => {
  await act(async () => picker.start("about:blank"));
  expect(onError).toHaveBeenCalledWith(PICKING_ERROR);
  expect(invoke).not.toHaveBeenCalledWith("browser_inspect", expect.anything());
});
it("times out after a clicked element fails to reach the pane", async () => {
  const clickedAt = Date.now();
  invoke.mockImplementation(async command => command === "browser_eval_result" ? JSON.stringify({ state: "sent", at: clickedAt }) : null);
  await act(async () => picker.start("https://example.org"));
  await act(async () => vi.advanceTimersByTimeAsync(PICKING_TIMEOUT_MS + 500));
  expect(onError).toHaveBeenCalledWith(PICKING_ERROR); expect(picker.picking).toBe(false);
});
it("does not time out while waiting for a user to choose an element", async () => {
  invoke.mockImplementation(async command => command === "browser_eval_result" ? JSON.stringify({ state: "picking", at: Date.now() }) : null);
  await act(async () => picker.start("https://example.org"));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(onError).not.toHaveBeenCalled(); expect(picker.picking).toBe(true);
});
it("accepts only the picking page and cancels its watchdog on delivery", async () => {
  await act(async () => picker.start("https://example.org"));
  expect(picker.accept("browser-other")).toBe(false);
  await act(async () => { expect(picker.accept("browser-one")).toBe(true); });
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(onError).not.toHaveBeenCalled(); expect(picker.picking).toBe(false);
});
it("surfaces page script errors and observes Esc cancellation", async () => {
  invoke.mockImplementation(async command => command === "browser_eval_result" ? JSON.stringify({ state: "error", at: Date.now() }) : null);
  await act(async () => picker.start("https://example.org"));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(onError).toHaveBeenCalledWith(PICKING_ERROR);
  onError.mockClear();
  invoke.mockImplementation(async command => command === "browser_eval_result" ? JSON.stringify({ state: "cancelled", at: Date.now() }) : null);
  await act(async () => picker.start("https://example.org"));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(onError).not.toHaveBeenCalled(); expect(picker.picking).toBe(false);
});
