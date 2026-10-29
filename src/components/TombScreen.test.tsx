// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { TombScreen } from "./TombScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  invokeMock.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a terminal that exited while Redline was closed", () => {
  it("shows its last screen read-only, and Dismiss and Esc do what they say", async () => {
    invokeMock.mockResolvedValue("$ npm run dev\n\n\n\nready on :5173\nKilled: 9\n");
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(<TombScreen id="t1" title="web" onDismiss={onDismiss} onClose={onClose} />));
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledWith("pty_screen_tail", { id: "t1" });
    const screen = host.querySelector("[data-tomb-screen]")!;
    expect(screen.textContent).toBe("$ npm run dev\n\nready on :5173\nKilled: 9\n");
    expect(host.textContent).toContain("Exited while Redline was closed");
    expect(host.querySelector("input, textarea")).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("speaks Redline's palette", () => {
    expect(readFileSync("src/components/TombScreen.tsx", "utf8")).not.toMatch(/--color-(danger|error|red)|#e8553d|\bred\b/i);
  });
});
