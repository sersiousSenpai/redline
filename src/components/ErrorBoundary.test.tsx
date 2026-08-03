// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  it("contains a render throw, shows the fallback, and reset retries", () => {
    // React logs caught render errors loudly; keep the test output clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let armed = true;
    function Bomb() {
      if (armed) throw new Error("boom");
      return createElement("div", { id: "ok" }, "recovered");
    }

    let capturedReset: (() => void) | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          ErrorBoundary,
          {
            fallback: (err: Error, reset: () => void) => {
              capturedReset = reset;
              return createElement("div", { id: "fallback" }, err.message);
            },
          },
          createElement(Bomb),
        ),
      );
    });

    // The throw was contained: fallback in place of the child, not a blank
    // unmounted tree.
    expect(container.querySelector("#fallback")?.textContent).toBe("boom");
    expect(container.querySelector("#ok")).toBeNull();
    expect(capturedReset).not.toBeNull();

    // Reset retries the children (the underlying condition is fixed).
    armed = false;
    act(() => capturedReset!());
    expect(container.querySelector("#ok")?.textContent).toBe("recovered");
    expect(container.querySelector("#fallback")).toBeNull();

    act(() => root.unmount());
    container.remove();
    errSpy.mockRestore();
  });
});
