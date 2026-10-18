// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stageInsets, useStageDock } from "./stageDock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("stageInsets", () => {
  it("puts the dock over the stage, measured from its positioned ancestor", () => {
    const main = { top: 46, left: 0, right: 1280, bottom: 800 };
    const stage = { top: 46, left: 232, right: 1280, bottom: 800 };
    expect(stageInsets(main, stage)).toEqual({ top: 0, left: 232, right: 0, bottom: 0 });
    expect(stageInsets({ top: 10, left: 10, right: 1270, bottom: 790 }, { top: 20, left: 300, right: 1200, bottom: 700 }))
      .toEqual({ top: 10, left: 290, right: 70, bottom: 90 });
  });
});

describe("useStageDock", () => {
  const rect = (r: { top: number; left: number; right: number; bottom: number }) => () => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() {} }) as DOMRect;
  afterEach(() => vi.unstubAllGlobals());

  it("pins the dock while active and clears every inset when it stops", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const main = document.createElement("div");
    const dock = document.createElement("div");
    const stage = document.createElement("div");
    main.append(dock, stage);
    document.body.append(main);
    main.getBoundingClientRect = rect({ top: 0, left: 0, right: 1000, bottom: 700 });
    stage.getBoundingClientRect = rect({ top: 0, left: 240, right: 1000, bottom: 700 });
    const dockRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    const stageRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    dockRef.current = dock;
    stageRef.current = stage;
    function Probe({ active }: { active: boolean }) {
      useStageDock(dockRef, stageRef, active);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe active />));
    expect([dock.style.top, dock.style.left, dock.style.right, dock.style.bottom]).toEqual(["0px", "240px", "0px", "0px"]);
    await act(async () => root.render(<Probe active={false} />));
    expect([dock.style.top, dock.style.left, dock.style.right, dock.style.bottom]).toEqual(["", "", "", ""]);
    await act(async () => root.unmount());
    main.remove();
  });
});
