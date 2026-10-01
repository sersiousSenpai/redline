// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("src-tauri/src/browser_frontdoor_shortcut.js", "utf8");
function frame() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const postMessage = vi.fn();
  const window = { top: {}, webkit: { messageHandlers: { redlineBrowser: { postMessage } } }, addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener)) };
  const context = { window };
  runInNewContext(script, context);
  runInNewContext(script, context);
  return { window, postMessage, key: (extra = {}) => {
    const event = { key: "Enter", shiftKey: true, isTrusted: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra };
    listeners.get("keydown")!(event);
    return event;
  } };
}
describe("front door shortcut in embedded page frames", () => {
  it("installs once in an iframe and forwards a trusted Shift+Enter before page handlers", () => {
    const { window, postMessage, key } = frame();
    expect(window.addEventListener).toHaveBeenCalledTimes(1);
    expect(window.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    const event = key();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ kind: "shortcut", value: "open-front-door" });
  });
  it("leaves composition, ordinary Enter and modified shortcuts alone", () => {
    const { postMessage, key } = frame();
    for (const extra of [{ isTrusted: false }, { isComposing: true }, { keyCode: 229 }, { shiftKey: false }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key(extra).preventDefault).not.toHaveBeenCalled();
    }
    expect(postMessage).not.toHaveBeenCalled();
    const repeated = key({ repeat: true });
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
