// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll, type PollOptions } from "./usePoll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let now: () => void;
let visibility: DocumentVisibilityState;

interface PollerProps<T> {
  fn: () => T | Promise<T>;
  ms: number | null;
  options?: PollOptions<T>;
  deps?: unknown[];
}
function Poller<T>({ fn, ms, options, deps }: PollerProps<T>) {
  now = usePoll(fn, ms, options, deps);
  return null;
}
const render = <T,>(props: PollerProps<T>) =>
  act(async () => root.render(<Poller {...props} />));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setVisibility = (state: DocumentVisibilityState) =>
  act(async () => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  });

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("usePoll", () => {
  it("ticks at once and then every period, with the latest closure, without restarting on render", async () => {
    const seen: string[] = [];
    await render({ fn: () => { seen.push("a"); }, ms: 1000 });
    expect(seen).toEqual(["a"]);
    await advance(600);
    await render({ fn: () => { seen.push("b"); }, ms: 1000 });
    await advance(400);
    expect(seen).toEqual(["a", "b"]);
    await advance(1000);
    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("waits a full period first when not leading, and a null period stops it", async () => {
    const fn = vi.fn();
    await render({ fn, ms: 1000, options: { leading: false } });
    expect(fn).not.toHaveBeenCalled();
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await render({ fn, ms: null, options: { leading: false } });
    await advance(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("restarts, and ticks, when a dep changes", async () => {
    const fn = vi.fn();
    await render({ fn, ms: 1000, deps: ["/repo-a"] });
    await advance(900);
    await render({ fn, ms: 1000, deps: ["/repo-b"] });
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(900);
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("pauses while the window is hidden and ticks the moment it is shown", async () => {
    const fn = vi.fn();
    await render({ fn, ms: 1000, options: { pauseWhenHidden: true } });
    expect(fn).toHaveBeenCalledTimes(1);
    await setVisibility("hidden");
    await advance(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not start a hidden window's clock, and a poll without the option ignores visibility", async () => {
    visibility = "hidden";
    const paused = vi.fn();
    await render({ fn: paused, ms: 1000, options: { pauseWhenHidden: true } });
    await advance(3000);
    expect(paused).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    const plain = vi.fn();
    await render({ fn: plain, ms: 1000 });
    await advance(3000);
    expect(plain).toHaveBeenCalledTimes(4);
  });

  it("never runs two ticks at once: a slow tick drops the ones behind it", async () => {
    let release: () => void = () => {};
    const fn = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    await render({ fn, ms: 1000 });
    await advance(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ticks now on request, and once more after a tick that was already out", async () => {
    let release: () => void = () => {};
    const fn = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    await render({ fn, ms: 10_000 });
    await act(async () => { now(); now(); });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(fn).toHaveBeenCalledTimes(2);
    await act(async () => release());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("hands each result on, skipping one equal to the last when asked", async () => {
    let status = { branch: "main", ahead: 1 };
    const results: unknown[] = [];
    await render({
      fn: () => ({ ...status }),
      ms: 1000,
      options: { onResult: (v) => results.push(v), skipIfUnchanged: true },
    });
    await advance(3000);
    expect(results).toEqual([{ branch: "main", ahead: 1 }]);
    status = { branch: "main", ahead: 0 };
    await advance(1000);
    expect(results).toEqual([{ branch: "main", ahead: 1 }, { branch: "main", ahead: 0 }]);
    // Without the option every result goes through.
    await render({ fn: () => ({ ...status }), ms: 1000, options: { onResult: (v) => results.push(v) } });
    await advance(2000);
    expect(results).toHaveLength(5);
  });

  it("forgets the last result when its deps change, and drops a stale generation's result", async () => {
    let release: (value: string) => void = () => {};
    const results: string[] = [];
    const options = { onResult: (v: string) => results.push(v), skipIfUnchanged: true };
    await render({ fn: () => "clean", ms: 1000, options, deps: ["a"] });
    expect(results).toEqual(["clean"]);
    await render({ fn: () => "clean", ms: 1000, options, deps: ["b"] });
    expect(results).toEqual(["clean", "clean"]);
    await render({ fn: () => new Promise<string>((resolve) => { release = resolve; }), ms: 1000, options, deps: ["c"] });
    await render({ fn: () => "dirty", ms: 1000, options, deps: ["d"] });
    await act(async () => release("stale"));
    expect(results).toEqual(["clean", "clean", "dirty"]);
  });

  it("keeps polling after a failed tick, and stops at unmount", async () => {
    let fail = true;
    const results: string[] = [];
    await render({
      fn: async () => { if (fail) throw new Error("lsof"); return "ok"; },
      ms: 1000,
      options: { onResult: (v) => results.push(v) },
    });
    fail = false;
    await advance(1000);
    expect(results).toEqual(["ok"]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await advance(5000);
    expect(results).toEqual(["ok"]);
  });
});
