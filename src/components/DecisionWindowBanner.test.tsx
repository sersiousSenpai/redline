// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionWindowBanner } from "./DecisionWindowBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the decision countdown", () => {
  it("is said once, politely, and the ticking count is left to the eye", () => {
    const onExpire = vi.fn();
    act(() => root.render(<DecisionWindowBanner event={{ sessionId: "s", version: 3, deadlineMs: Date.now() + 20_000, windowSecs: 20 }} onOpen={() => {}} onApprove={() => {}} onExpire={onExpire} />));
    const status = host.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    // Empty at birth: a live region speaks what changes in it.
    expect(status.textContent).toBe("");
    act(() => { vi.advanceTimersByTime(150); });
    expect(status.textContent).toBe("Plan version 3 is ready. Auto-approving in 20 seconds unless you open it for review.");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(host.textContent).toContain("auto-approving in 15s");
    // The count ticked; what is read out did not.
    expect(status.textContent).toContain("in 20 seconds");
    expect(host.querySelector('[role="region"]')!.getAttribute("aria-label")).toBe("Plan decision");
    act(() => { vi.advanceTimersByTime(16_000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
