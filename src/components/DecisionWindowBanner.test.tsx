// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DecisionWindowBanner, RAISED_Z } from "./DecisionWindowBanner";

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

  it("rises over the open door and the pill's card, pressable and without taking the caret", () => {
    const event = { sessionId: "s", version: 3, deadlineMs: Date.now() + 20_000, windowSecs: 20 };
    const region = () => host.querySelector<HTMLElement>('[role="region"]')!;
    act(() => root.render(<DecisionWindowBanner event={event} onOpen={() => {}} onApprove={() => {}} onExpire={() => {}} />));
    // At rest it is a strip in the flow under the header, under any menu.
    expect(region().style.zIndex).toBe("");
    // The door's inert sweep spares it (MonochatIsland), raised or not.
    expect(region().hasAttribute("data-rl-over-door")).toBe(true);
    const before = document.activeElement;
    act(() => root.render(<DecisionWindowBanner event={event} onOpen={() => {}} onApprove={() => {}} onExpire={() => {}} raised />));
    expect(region().style.position).toBe("relative");
    expect(Number(region().style.zIndex)).toBe(RAISED_Z);
    expect(document.activeElement).toBe(before);
    // Above both: the door's layer and the dock the card springs from.
    const island = readFileSync(join(process.cwd(), "src/components/MonochatIsland.css"), "utf8");
    for (const selector of [".rl-frontdoor-focus", ".rl-frontdoor-dock"]) {
      const rule = new RegExp(`^\\${selector} \\{[^}]*z-index: (\\d+)`, "m").exec(island);
      expect(rule, selector).not.toBeNull();
      expect(RAISED_Z).toBeGreaterThan(Number(rule![1]));
    }
  });
});
