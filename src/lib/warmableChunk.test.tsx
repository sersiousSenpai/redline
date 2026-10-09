// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, lazy, Suspense, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { warmableChunk } from "./warmableChunk";

const card = { default: () => createElement("b", null, "card") };
const tick = () => new Promise((r) => setTimeout(r, 0));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mounts an empty boundary, then synchronously renders `Lazy` into it and
 *  returns what the DOM shows straight after that one commit. */
function firstCommit(Lazy: ComponentType) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  const tree = (show: boolean) =>
    createElement(Suspense, { fallback: createElement("i", null, "fallback") }, show ? createElement(Lazy) : null);
  flushSync(() => r.render(tree(false)));
  flushSync(() => r.render(tree(true)));
  return host.innerHTML;
}

describe("warmableChunk", () => {
  it("fetches once, however often it is warmed or loaded", async () => {
    const fetch = vi.fn(() => Promise.resolve(card));
    const chunk = warmableChunk(fetch);
    chunk.warm();
    chunk.warm();
    await chunk.load();
    await tick();
    chunk.load();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves synchronously once warm", async () => {
    const chunk = warmableChunk(() => Promise.resolve(card));
    chunk.warm();
    await tick();
    let got: unknown = null;
    void chunk.load().then((m) => {
      got = m;
    });
    expect(got).toBe(card);
  });

  it("lets a warmed lazy component render in the same commit, without the fallback", async () => {
    const chunk = warmableChunk(() => Promise.resolve(card));
    chunk.warm();
    await tick();
    expect(firstCommit(lazy(chunk.load))).toBe("<b>card</b>");
  });

  it("is why warming matters: a cold lazy component suspends its first commit", () => {
    const chunk = warmableChunk(() => Promise.resolve(card));
    expect(firstCommit(lazy(chunk.load))).toBe("<i>fallback</i>");
  });

  it("does not cache a failed fetch", async () => {
    const fetch = vi
      .fn<() => Promise<typeof card>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(card);
    const chunk = warmableChunk(fetch);
    chunk.warm();
    await tick();
    await expect(chunk.load()).resolves.toBe(card);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
