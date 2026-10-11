// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A sent screenshot draws from memory when its card remounts. A full-window
// screenshot is megabytes as a data URL, so the memory keeps the newest few
// by size as well as by count.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TurnChip } from "../lib/browserChat/transcript";

/** Each picture's file is 4 MB as base64. */
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args: { path: string }) => ({ data: "A".repeat(4_000_000) })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { TurnContext } from "./BrowserChatParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const shot = (n: number): Extract<TurnChip, { path: string }> => ({ kind: "screenshot", label: `tab ${n}`, body: `shot ${n}`, path: `/thumbs/chat-${n}.png`, width: 2400, height: 1500 });
const show = (n: number) => act(async () => root.render(<TurnContext key={n} chips={[shot(n)]} pictures />));
const reads = (n: number) => invoke.mock.calls.filter(([, args]) => args.path === shot(n).path).length;

it("keeps the newest screenshots in memory up to a size, and reads an older one again", async () => {
  for (let n = 1; n <= 5; n++) await show(n);
  expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,A/);
  expect(invoke).toHaveBeenCalledTimes(5);
  // The newest draw from memory; the oldest, past the size, is read again.
  await show(5);
  await show(4);
  expect([reads(4), reads(5)]).toEqual([1, 1]);
  await show(1);
  expect(reads(1)).toBe(2);
});
