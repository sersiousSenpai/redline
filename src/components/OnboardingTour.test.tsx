// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveHoldKey } from "../audio/holdKey";
import { OnboardingTour } from "./OnboardingTour";

// The first-run tour rides over the live app, so it must never take what the
// app's own keys mean (10/10, "never interrupt the user's flow"): a ⏎ in the
// composer it points at sends the sentence, it does not turn the page.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onAnchorChange = vi.fn();
const status = () => host.querySelector('[role="status"]')!.textContent;
const key = (target: EventTarget, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
  onClose.mockReset();
  onAnchorChange.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<OnboardingTour onClose={onClose} onAnchorChange={onAnchorChange} />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the onboarding tour", () => {
  it("tells a screen reader each step as it comes up", () => {
    expect(status()).toMatch(/^Getting started, step 1 of \d+: Welcome to Redline$/);
    key(document.body, "Enter");
    expect(status()).toMatch(/^Getting started, step 2 of \d+: Type what you want to build$/);
    expect(host.querySelector('[role="dialog"]')!.getAttribute("aria-label")).toBe("Getting started: Type what you want to build");
  });

  it("leaves ⏎ and the arrows to a text field: the caret's, not the tour's", () => {
    key(document.body, "Enter");
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    for (const name of ["Enter", "ArrowRight", "ArrowLeft"]) {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      act(() => { composer.dispatchEvent(event); });
      expect(event.defaultPrevented, name).toBe(false);
    }
    expect(status()).toMatch(/step 2 of \d+:/);
    // Esc still skips the tour from anywhere.
    key(composer, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still pages on the arrows from anywhere else", () => {
    key(document.body, "ArrowRight");
    key(document.body, "ArrowRight");
    expect(status()).toMatch(/step 3 of \d+:/);
    key(document.body, "ArrowLeft");
    expect(status()).toMatch(/step 2 of \d+:/);
  });

  it("names the dictation key chosen by the time the tour opens, not when it first loaded", () => {
    const shortcuts = () => {
      act(() => root.unmount());
      root = createRoot(host);
      act(() => root.render(<OnboardingTour onClose={onClose} onAnchorChange={onAnchorChange} />));
      for (let i = 0; i < 30 && !/Keyboard shortcuts$/.test(status() ?? ""); i++) key(document.body, "ArrowRight");
      return host.querySelector('[role="dialog"]')!.textContent!;
    };
    try {
      saveHoldKey("MetaRight");
      expect(shortcuts()).toContain("right ⌘");
      saveHoldKey("off");
      const off = shortcuts();
      expect(off).toContain("Snap the layout back");
      expect(off).not.toContain("Dictate");
    } finally {
      saveHoldKey("AltRight");
    }
  });

  it("lets the pointer through to the region it lights, and nowhere else", () => {
    const layer = host.querySelector<HTMLElement>("[data-rl-modal-layer]")!;
    expect(layer.style.pointerEvents).toBe("none");
    // The scrim and the card take presses; the lit hole between them is the app.
    const scrim = layer.firstElementChild as HTMLElement;
    expect(scrim.style.pointerEvents).toBe("auto");
    expect(host.querySelector<HTMLElement>('[role="dialog"]')!.style.pointerEvents).toBe("auto");
  });
});
