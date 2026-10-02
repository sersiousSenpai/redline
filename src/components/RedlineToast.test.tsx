// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  makeToast,
  RedlineToast,
  TOAST_LEAVE_MS,
  toastDuration,
  type ActiveToast,
  type ToastSpec,
} from "./RedlineToast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The slot exactly as App owns it: ids on the way in, an id-checked clear on
// the way out.
let show: (t: string | ToastSpec, durationMs?: number | null) => void = () => {};
function Slot() {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [seq, setSeq] = useState(0);
  show = (t, d) => {
    setSeq((n) => {
      setToast(makeToast(t, n + 1, d));
      return n + 1;
    });
  };
  void seq;
  const dismiss = useCallback((id: number) => setToast((cur) => (cur?.id === id ? null : cur)), []);
  return toast ? <RedlineToast key={toast.id} toast={toast} onDismiss={dismiss} /> : null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Slot />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const card = () => host.querySelector<HTMLElement>(".rl-toast");
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("RedlineToast", () => {
  it("dismisses itself after its duration, with a leave fade", () => {
    act(() => show("Saved"));
    expect(card()?.textContent).toContain("Saved");
    advance(3999);
    expect(card()).not.toBeNull();
    advance(1);
    expect(card()?.classList.contains("is-leaving")).toBe(true);
    advance(TOAST_LEAVE_MS);
    expect(card()).toBeNull();
  });

  it("pauses while hovered and resumes with the time that was left", () => {
    act(() => show("Hover me"));
    advance(3000);
    act(() => card()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    advance(10_000);
    expect(card()).not.toBeNull();
    act(() => card()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    advance(999);
    expect(card()?.classList.contains("is-leaving")).toBe(false);
    advance(1 + TOAST_LEAVE_MS);
    expect(card()).toBeNull();
  });

  it("a stale timer can't clear a newer toast", () => {
    act(() => show("First"));
    advance(3900);
    act(() => show("Second"));
    // The first toast's clock would have fired here.
    advance(200 + TOAST_LEAVE_MS);
    expect(card()?.textContent).toContain("Second");
    expect(card()?.classList.contains("is-leaving")).toBe(false);
  });

  it("closes on ✕ and after its action runs", () => {
    const onAction = vi.fn();
    act(() => show({ message: "New plan", action: { label: "Open", onAction } }));
    act(() => host.querySelector<HTMLButtonElement>(".rl-toast-action")!.click());
    expect(onAction).toHaveBeenCalledOnce();
    advance(TOAST_LEAVE_MS);
    expect(card()).toBeNull();
    act(() => show("Bye"));
    act(() => host.querySelector<HTMLButtonElement>(".rl-toast-x")!.click());
    advance(TOAST_LEAVE_MS);
    expect(card()).toBeNull();
  });

  it("renders a second action beside the first, and either one closes it", () => {
    const open = vi.fn();
    const reveal = vi.fn();
    act(() => show({ message: "a.zip saved to Downloads", placement: "top", action: { label: "Open", onAction: open }, secondaryAction: { label: "Show in Finder", onAction: reveal } }));
    expect(card()?.classList.contains("is-top")).toBe(true);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".rl-toast-action")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Open", "Show in Finder"]);
    act(() => buttons[1].click());
    expect(reveal).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    advance(TOAST_LEAVE_MS);
    expect(card()).toBeNull();
  });

  it("stays up when asked to, and an action buys more time", () => {
    expect(toastDuration({ message: "x" })).toBe(4000);
    expect(toastDuration({ message: "x", action: { label: "a", onAction() {} } })).toBe(8000);
    expect(toastDuration({ message: "x", durationMs: 6000 })).toBe(6000);
    act(() => show("Broken", null));
    advance(60_000);
    expect(card()).not.toBeNull();
  });
});

describe("toast call sites", () => {
  it("no call site schedules its own setToast(null) — the toast owns its timer", () => {
    for (const rel of [
      "src/App.tsx",
      "src/components/ActivationBar.tsx",
      "src/components/BuildRedlinePanel.tsx",
      "src/components/OrchestrationSurface.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*(setToast|onToast)\(null\)/);
    }
  });
});
