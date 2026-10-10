// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("src-tauri/src/browser_frontdoor_shortcut.js", "utf8");
function frame({ main = false } = {}) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const postMessage = vi.fn();
  const window: Record<string, unknown> = { top: {}, webkit: { messageHandlers: { redlineBrowser: { postMessage } } }, addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener)) };
  if (main) window.top = window;
  const context = { window };
  runInNewContext(script, context);
  runInNewContext(script, context);
  return { window: window as { addEventListener: ReturnType<typeof vi.fn> }, postMessage, listeners, key: (extra = {}) => {
    const event = { key: "Enter", shiftKey: true, isTrusted: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra };
    listeners.get("keydown")!(event);
    return event;
  } };
}
describe("front door shortcut in embedded page frames", () => {
  it("installs once in an iframe and forwards a trusted Shift+Enter before page handlers", () => {
    const { window, postMessage, key } = frame();
    expect(window.addEventListener.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(1);
    expect(window.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    const event = key();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ kind: "shortcut", value: "open-front-door" });
  });
  it("leaves a text field's Shift+Enter to the page: it is the newline there", () => {
    const { postMessage, key } = frame();
    for (const target of [{ tagName: "TEXTAREA" }, { tagName: "INPUT" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(key({ target }).preventDefault).not.toHaveBeenCalled();
    }
    expect(postMessage).not.toHaveBeenCalled();
    // Anywhere else in the page the chord is still Redline's.
    expect(key({ target: { tagName: "BODY" } }).preventDefault).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
  });
  it("finds the field inside a web component, and a custom editor that calls itself a text box", () => {
    const { postMessage, key } = frame();
    // At the window a shadow-DOM field retargets to its host; the composed
    // path still starts at the field.
    const host = { tagName: "CHAT-COMPOSER", closest: () => null };
    expect(key({ target: host, composedPath: () => [{ tagName: "TEXTAREA" }, host] }).preventDefault).not.toHaveBeenCalled();
    const editor = { tagName: "DIV", closest: (selector: string) => (selector === '[role="textbox"]' ? editor : null) };
    expect(key({ target: editor }).preventDefault).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(key({ target: host, composedPath: () => [host] }).preventDefault).toHaveBeenCalledOnce();
  });
  it("says a sub-frame was pressed, which the page's own signals never hear — and only a real press", () => {
    const { postMessage, listeners } = frame();
    listeners.get("pointerdown")!({ isTrusted: true });
    listeners.get("touchstart")!({ isTrusted: true });
    listeners.get("pointerdown")!({ isTrusted: false });
    expect(postMessage.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { kind: "interaction", value: "pointerdown" },
      { kind: "interaction", value: "touchstart" },
    ]);
    // The main frame has the page's own signals for that.
    const main = frame({ main: true });
    expect(main.listeners.has("pointerdown")).toBe(false);
    expect(main.window.addEventListener).toHaveBeenCalledTimes(1);
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
