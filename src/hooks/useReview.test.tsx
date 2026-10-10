// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
import { useReview, type UseReview } from "./useReview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let review: UseReview;
let fingerprint = "fp-1";
let visibility: DocumentVisibilityState;

function Probe() {
  review = useReview();
  return null;
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const checks = () => invoke.mock.calls.filter(([cmd]) => cmd === "review_fingerprint").length;
const show = (state: DocumentVisibilityState) =>
  act(async () => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  });

beforeEach(async () => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fingerprint = "fp-1";
  localStorage.clear();
  localStorage.setItem("redline.review.repo", JSON.stringify("/repo"));
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "review_diff") return [];
    if (command === "review_fingerprint") return fingerprint;
    if (command === "review_commits") return [];
    return null;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useReview's staleness poll", () => {
  it("checks every five seconds while a diff shows, and flags the diff once the tree drifts", async () => {
    const loaded = checks();
    await advance(10_000);
    expect(checks()).toBe(loaded + 2);
    expect(review.stale).toBe(false);
    fingerprint = "fp-2";
    await advance(5000);
    expect(review.stale).toBe(true);
    // Stale is terminal until a refresh: the poll stops.
    const stopped = checks();
    await advance(20_000);
    expect(checks()).toBe(stopped);
  });

  it("runs no git while the window is hidden, and checks the moment it is shown", async () => {
    await show("hidden");
    const hidden = checks();
    await advance(60_000);
    expect(checks()).toBe(hidden);
    fingerprint = "fp-2";
    await show("visible");
    expect(checks()).toBe(hidden + 1);
    expect(review.stale).toBe(true);
  });
});
