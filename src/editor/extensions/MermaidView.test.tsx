// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { MermaidView } from "./MermaidView";

// mermaid itself is far too heavy for the unit graph. The stand-in does what
// mermaid 11 does with a source it can't parse when error rendering is on:
// it measures inside a `d`-prefixed wrapper appended to <body>, draws into it,
// and throws before removing it.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => {
    const wrapper = document.createElement("div");
    wrapper.id = `d${id}`;
    wrapper.innerHTML = `<svg id="${id}"></svg>`;
    document.body.append(wrapper);
    throw new Error("No diagram type detected");
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

it("a diagram that fails to render leaves nothing behind in <body>", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MermaidView code="this is not a diagram {" />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(host.textContent).toContain("Diagram error");
    expect(document.querySelectorAll('[id^="drl-mermaid-"], [id^="rl-mermaid-"]')).toHaveLength(0);
    // And mermaid is told not to draw its own error diagram in the first place.
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ suppressErrorRendering: true }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
