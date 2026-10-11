// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Capture is on while any raw-stream pane is open. A pane handed from a live
// reply to the reply it settled into closes and opens in one go, and the ring
// it was reading must outlive the move: turning capture off frees it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (cmd: string, _args?: unknown) => (cmd === "inspect_read" ? { on: true, init: null, lines: [], dropped: 0 } : true)));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Through import(), as every other module reaches it (boot.test.ts).
const { default: StreamInspector } = await import("./StreamInspector");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const pane = (key: string) => <StreamInspector key={key} surface="companion" turnKey="chat-1" onClose={() => {}} />;
const switched = (on: boolean) => invoke.mock.calls.filter(([cmd, args]) => cmd === "inspect_set" && (args as { on: boolean }).on === on).length;
const tick = () => act(async () => { vi.advanceTimersByTime(1); });

it("keeps capture on through a pane handed from one reply to the next, and off once the last pane goes", async () => {
  await act(async () => root.render(pane("live")));
  expect(switched(true)).toBe(1);
  // The live reply settles: its pane closes as the settled row's opens.
  await act(async () => root.render(pane("settled")));
  await tick();
  expect(switched(false)).toBe(0);
  // Two panes on screen: closing one leaves the other reading.
  await act(async () => root.render(<>{pane("settled")}{pane("older")}</>));
  await act(async () => root.render(pane("settled")));
  await tick();
  expect(switched(false)).toBe(0);
  await act(async () => root.render(null));
  expect(switched(false)).toBe(0);
  await tick();
  expect(switched(false)).toBe(1);
});
