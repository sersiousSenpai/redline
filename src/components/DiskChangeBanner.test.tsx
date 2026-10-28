// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DiskChangeBanner, DiskCompare } from "./DiskChangeBanner";

describe("the changed-on-disk banner", () => {
  it("offers Compare · Keep editing · Reload · Overwrite, each its own act", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const acts = { onCompare: vi.fn(), onKeep: vi.fn(), onReload: vi.fn(), onOverwrite: vi.fn() };
    act(() => root.render(createElement(DiskChangeBanner, { change: { content: "x", at: Date.now() }, comparing: false, ...acts })));
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Compare", "Keep editing", "Reload", "Overwrite"]);
    buttons.forEach((b) => act(() => b.click()));
    for (const fn of Object.values(acts)) expect(fn).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("you have unsaved edits");
    act(() => root.unmount());
  });
  it("compares the disk against the buffer, folding what did not change", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const disk = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const buffer = ["a", "b", "c", "d", "e", "f", "g", "H"].join("\n");
    act(() => root.render(createElement(DiskCompare, { disk, buffer })));
    expect(host.textContent).toContain("⋯ 5 unchanged");
    expect(host.textContent).toContain("− h");
    expect(host.textContent).toContain("+ H");
    act(() => root.unmount());
  });
});
