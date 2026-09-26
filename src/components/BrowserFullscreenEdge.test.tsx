// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserFullscreenEdge } from "./BrowserFullscreenEdge";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("reveals reliable exit controls on hover or keyboard focus and delays collapse", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  const onExit = vi.fn(), onScreen = vi.fn();
  try {
    await act(async () => root.render(<BrowserFullscreenEdge title="A video" onExit={onExit} onScreen={onScreen}/>));
    const edge = host.querySelector<HTMLElement>('[role="toolbar"]')!;
    expect(edge.dataset.expanded).toBeUndefined();
    await act(async () => edge.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(edge.dataset.expanded).toBe("true");
    await act(async () => { host.querySelectorAll("button")[0].click(); host.querySelectorAll("button")[1].click(); });
    expect(onScreen).toHaveBeenCalledOnce(); expect(onExit).toHaveBeenCalledOnce();
    await act(async () => edge.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(699)); expect(edge.dataset.expanded).toBe("true");
    await act(async () => vi.advanceTimersByTime(1)); expect(edge.dataset.expanded).toBeUndefined();
    await act(async () => edge.focus()); expect(edge.dataset.expanded).toBe("true");
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});
