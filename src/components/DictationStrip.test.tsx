// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationStrip, STRIP_BARS, levelHeight, strip, stripBox } from "./DictationStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
const viewport = { width: 1200, height: 800 };

describe("stripBox", () => {
  it("sits just above the composer, as wide as it up to 420 px", () => {
    expect(stripBox(rect(100, 500, 600, 80), viewport)).toEqual({ left: 100, top: 464, width: 420 });
    expect(stripBox(rect(100, 500, 300, 80), viewport)).toEqual({ left: 100, top: 464, width: 300 });
  });

  it("lies over the composer's top edge where there is no room above, and stays in the window", () => {
    expect(stripBox(rect(1100, 10, 300, 40), viewport)).toEqual({ left: 892, top: 14, width: 300 });
    // A document taller than the window: its visible top.
    expect(stripBox(rect(0, -2000, 900, 5000), viewport)).toEqual({ left: 8, top: 4, width: 420 });
  });

  it("goes to the window's foot with nothing to sit on", () => {
    expect(stripBox(null, viewport)).toEqual({ left: 390, top: 746, width: 420 });
  });
});

describe("levelHeight", () => {
  it("draws the top 54 dB, never a bar of nothing", () => {
    expect(levelHeight(-100)).toBe(0.08);
    expect(levelHeight(-6)).toBe(1);
    expect(levelHeight(-33)).toBeCloseTo(0.5);
  });
});

describe("DictationStrip", () => {
  let root: Root;
  let mount: HTMLDivElement;
  beforeEach(() => {
    mount = document.createElement("div");
    document.body.appendChild(mount);
    root = createRoot(mount);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    act(() => strip.set(null));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("shows the words heard and the waveform, outside the composer's flow", async () => {
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(100, 500, 600, 80));
    await act(async () => root.render(<DictationStrip />));
    expect(mount.querySelector(".rl-dictation-strip")).toBeNull();
    act(() => strip.set({ phase: "listening", text: "", levels: [0.2, 0.9], anchor: composer, hint: "release to insert" }));
    const el = mount.querySelector<HTMLElement>(".rl-dictation-strip")!;
    expect(el.textContent).toContain("Listening…");
    expect(el.textContent).toContain("release to insert");
    expect(el.querySelectorAll(".rl-dictation-wave i")).toHaveLength(STRIP_BARS);
    expect(el.querySelector<HTMLElement>(".rl-dictation-wave i:last-child")!.style.transform).toBe("scaleY(0.9)");
    // Mounted in its own root: never inside the composer.
    expect(composer.contains(el)).toBe(false);
    act(() => strip.update({ text: "the kokoro sidecar" }));
    expect(el.querySelector(".rl-dictation-text")!.textContent).toBe("the kokoro sidecar");
    // A screen reader hears that it listens, not each changing word.
    expect(el.querySelector(".sr-only")!.textContent).toBe("Listening");
    expect(el.querySelector(".rl-dictation-text")!.getAttribute("aria-hidden")).toBe("true");
    act(() => strip.set({ phase: "notice", text: "Didn't catch that", levels: [], anchor: null, hint: "" }));
    expect(mount.querySelector(".sr-only")!.textContent).toBe("Didn't catch that");
  });

  it("gives a narrow strip's room to the words, not the hint", async () => {
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(100, 500, 240, 32));
    await act(async () => root.render(<DictationStrip />));
    act(() => strip.set({ phase: "listening", text: "is the replay safe", levels: [], anchor: composer, hint: "release to send" }));
    expect(mount.querySelector(".rl-dictation-hint")).toBeNull();
    expect(mount.querySelector(".rl-dictation-text")!.textContent).toBe("is the replay safe");
  });

  it("lets a notice fade, and offers homeless words to copy without taking focus", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    await act(async () => root.render(<DictationStrip />));
    act(() => strip.set({ phase: "notice", text: "No text box", levels: [], anchor: null, hint: "", copy: "rerun the size check" }));
    const copy = mount.querySelector<HTMLButtonElement>(".rl-dictation-copy")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    copy.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => copy.click());
    expect(write).toHaveBeenCalledWith("rerun the size check");
    expect(document.activeElement).toBe(field);
    expect(strip.get()).toBeNull();
    act(() => strip.set({ phase: "notice", text: "Didn't catch that", levels: [], anchor: null, hint: "" }));
    act(() => vi.advanceTimersByTime(2400));
    expect(strip.get()).toBeNull();
  });
});
