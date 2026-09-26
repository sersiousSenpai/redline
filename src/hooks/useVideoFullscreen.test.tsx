// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fullscreen: false, set: vi.fn(), invoke: vi.fn(), focus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getCurrent: () => ({ isFullscreen: async () => mocks.fullscreen, setFullscreen: mocks.set }) } }));
vi.mock("@tauri-apps/api/webview", () => ({ Webview: { getByLabel: async () => ({ setFocus: mocks.focus }) } }));
import { useVideoFullscreen } from "./useVideoFullscreen";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, video: ReturnType<typeof useVideoFullscreen>;
const onError = vi.fn();
function Fixture() { video = useVideoFullscreen("one", true, onError); return <span>{video.stage}</span>; }
beforeEach(async () => {
  vi.useFakeTimers(); mocks.fullscreen = false; mocks.set.mockReset(); mocks.invoke.mockReset().mockResolvedValue(null); onError.mockClear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Fixture/>));
  await act(async () => video.dispatch({ type: "page", tabId: "one", on: true }));
});
afterEach(async () => { await act(async () => root.unmount()); await vi.runOnlyPendingTimersAsync(); host.remove(); vi.useRealTimers(); });
it("ignores intermediate native observations during its own animation, then restores on exit", async () => {
  mocks.set.mockImplementation(async (value: boolean) => { if (!value) mocks.fullscreen = false; });
  await act(async () => video.requestScreen());
  await act(async () => video.observeWindow());
  expect(video.stage).toBe("screen"); expect(video.state.ownsWindow).toBe(true);
  mocks.fullscreen = true;
  await act(async () => video.observeWindow());
  expect(video.state.ownsWindow).toBe(true);
  await act(async () => video.dispatch({ type: "exit" }));
  expect(mocks.set.mock.calls).toEqual([[true], [false]]); expect(video.stage).toBe("off");
});
it("serializes an exit after an unresolved enter instead of letting the late enter win", async () => {
  let finish!: () => void;
  mocks.set.mockImplementation((value: boolean) => value ? new Promise<void>(resolve => { finish = () => { mocks.fullscreen = true; resolve(); }; }) : Promise.resolve().then(() => { mocks.fullscreen = false; }));
  await act(async () => video.requestScreen());
  await act(async () => video.dispatch({ type: "exit" }));
  expect(mocks.set.mock.calls).toEqual([[true]]);
  await act(async () => finish());
  expect(mocks.set.mock.calls).toEqual([[true], [false]]); expect(mocks.fullscreen).toBe(false); expect(video.stage).toBe("off");
});
it("retries one stalled window request, reports failure, and restores the in-pane exit controls", async () => {
  mocks.set.mockResolvedValue(undefined);
  await act(async () => video.requestScreen());
  await act(async () => vi.advanceTimersByTimeAsync(3100));
  expect(mocks.set.mock.calls).toEqual([[true], [true]]);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("did not finish"));
  expect(video.stage).toBe("browser"); expect(video.state.ownsWindow).toBe(false);
});
