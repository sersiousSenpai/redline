// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloseWallDialog } from "./CloseWallDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("closing a wall with something still running", () => {
  it("names what is running and offers Keep running (the default), Terminate and Cancel", async () => {
    const onKeep = vi.fn();
    const onTerminate = vi.fn();
    const onCancel = vi.fn();
    await act(async () => root.render(<CloseWallDialog running={["claude 1", "web 2"]} total={3} onKeep={onKeep} onTerminate={onTerminate} onCancel={onCancel} />));
    expect(host.textContent).toContain("2 terminals are still running");
    expect(host.textContent).toContain("claude 1, web 2");
    expect(document.activeElement?.textContent).toBe("Keep running");
    const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => button("Terminate").click());
    expect(onTerminate).toHaveBeenCalledTimes(1);
    await act(async () => button("Keep running").click());
    expect(onKeep).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("speaks Redline's palette: no red anywhere in the dialog", () => {
    const source = readFileSync("src/workbench/CloseWallDialog.tsx", "utf8");
    expect(source).not.toMatch(/--color-(danger|error|red)|#e8553d|\bred\b/i);
  });
});

describe("every way a wall closes goes through the one prompt", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  it("the strip's × and ⌘W ask; a kept terminal is stowed, a terminated one is killed", () => {
    expect(app).toContain("onCloseTab={closeTabRequest}");
    const inside = app.slice(app.indexOf("const closeFromInside = useCallback("), app.indexOf("/** Close the active tab's pane of `kind`"));
    expect(inside).toContain("requestClose(");
    const finish = app.slice(app.indexOf("const finishWallClose = useCallback("), app.indexOf("const requestClose = useCallback("));
    expect(finish).toContain('wb.dispatch({ type: "closeWall", key: close.key, paneId, keep })');
    expect(finish).toContain("if (!keep) terminalsRef.current?.closeTerminals(close.tiles)");
  });
});
