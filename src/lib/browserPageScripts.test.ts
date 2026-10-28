// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
const actions = readFileSync("src-tauri/src/browser_action.js", "utf8");
const signals = readFileSync("src-tauri/src/browser_signals.js", "utf8");
const inspector = readFileSync("src-tauri/src/browser_inspector.js", "utf8");
const run = (op: Record<string, unknown>) => JSON.parse(window.eval(`${actions}(${JSON.stringify(op)})`));
afterEach(() => { (window as unknown as Record<string, any>).__redline_inspect_stop?.(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("native page action fixtures", () => {
  it("fills framework-owned inputs through the setter and reports the observed value", () => {
    document.body.innerHTML = '<input id="name"><select id="choice"><option value="a">A</option><option value="b">B</option></select>';
    const input = document.querySelector("input")!;
    const change = vi.fn(); input.addEventListener("input", change);
    const attack = "');document.body.innerHTML='oops';//";
    expect(run({ kind: "fill", selector: "#name", value: attack })).toMatchObject({ ok: true, value: attack });
    expect(change).toHaveBeenCalledOnce(); expect(document.querySelector("select")).not.toBeNull();
    expect(run({ kind: "select", selector: "#choice", value: "b" })).toMatchObject({ ok: true, value: "b" });
    expect(run({ kind: "select", selector: "#choice", value: "missing" }).ok).toBe(false);
    expect(document.querySelector("select")!.value).toBe("b");
  });
  it("names the target the way the chat's row reads it, never by what was typed into it", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 100, height: 20 } as DOMRect);
    document.body.innerHTML = '<button id="buy"> Buy   now </button><button id="icon" aria-label="Close dialog">×</button><input id="go" type="submit" value="Search"><label for="email">Email</label><input id="email"><input id="q" placeholder="Search docs"><div id="note" contenteditable="true">secret draft</div><select id="plan"><option value="p">Pro plan</option></select>';
    expect(run({ kind: "click", selector: "#buy" })).toMatchObject({ ok: true, name: "Buy now" });
    expect(run({ kind: "click", selector: "#icon" }).name).toBe("Close dialog");
    expect(run({ kind: "click", selector: "#go" }).name).toBe("Search");
    expect(run({ kind: "fill", selector: "#email", value: "ada@example.test" })).toMatchObject({ ok: true, name: "Email" });
    expect(run({ kind: "fill", selector: "#q", value: "rate limits" }).name).toBe("Search docs");
    // A typed field or an editable region is named by nothing it contains.
    expect(run({ kind: "click", selector: "#email" }).name).toBe("");
    expect(run({ kind: "click", selector: "#note" }).name).toBe("");
    expect(run({ kind: "select", selector: "#plan", value: "p" })).toMatchObject({ ok: true, name: "Pro plan" });
  });
  it("does not report a missing, disabled, or hidden click target as completed", () => {
    document.body.innerHTML = '<button disabled id="off">No</button>';
    expect(run({ kind: "click", selector: "#gone" }).ok).toBe(false);
    expect(run({ kind: "click", selector: "#off" }).ok).toBe(false);
    expect(run({ kind: "wait", selector: "#gone" }).ready).toBe(false);
  });
  it("waits for observable page content", () => {
    document.body.innerHTML = '<p id="dynamic">Loading</p>';
    expect(run({ kind: "wait", selector: "#dynamic", text: "Ready" }).ready).toBe(false);
    document.querySelector("p")!.textContent = "Ready";
    expect(run({ kind: "wait", selector: "#dynamic", text: "Ready" }).ready).toBe(true);
    expect(run({ kind: "wait", selector: "#gone", visible: false })).toMatchObject({ ok: true, ready: true });
    expect(run({ kind: "wait", selector: "[invalid" }).ok).toBe(false);
  });
  it("performs observable keyboard defaults and refuses unsupported or canceled input", () => {
    document.body.innerHTML = '<input id="name" value="ab😀c"><textarea id="notes"></textarea>';
    const input = document.querySelector("input")!;
    input.setSelectionRange(4, 4);
    expect(run({ kind: "key", selector: "#name", key: "Backspace" })).toMatchObject({ ok: true, value: "abc", selectionStart: 2 });
    expect(run({ kind: "key", selector: "#name", key: "Delete" })).toMatchObject({ ok: true, value: "ab" });
    expect(run({ kind: "key", selector: "#name", key: "Q" })).toMatchObject({ ok: true, value: "abQ" });
    expect(run({ kind: "key", selector: "#name", key: "ArrowLeft" })).toMatchObject({ ok: true, selectionStart: 2 });
    expect(run({ kind: "key", selector: "#notes", key: "Enter" })).toMatchObject({ ok: true, value: "\n" });
    expect(run({ kind: "key", selector: "#name", key: "F5" }).ok).toBe(false);
    input.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    expect(run({ kind: "key", selector: "#name", key: "Z" }).ok).toBe(false);
    expect(input.value).toBe("abQ");
    input.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
    expect(run({ kind: "key", selector: "#name", key: "Z" }).ok).toBe(false);
    expect(input.value).toBe("abQ");
    input.readOnly = true;
    expect(run({ kind: "key", selector: "#name", key: "Backspace" }).ok).toBe(false);
  });
  it("moves Tab focus and respects disabled form ancestors", () => {
    document.body.innerHTML = '<input id="first"><fieldset disabled><button id="disabled">Disabled</button></fieldset><button id="next">Next</button>';
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 100, height: 20 } as DOMRect);
    expect(run({ kind: "key", selector: "#first", key: "Tab" })).toMatchObject({ ok: true, outcome: "focus-next" });
    expect(document.activeElement?.id).toBe("next");
    expect(run({ kind: "click", selector: "#disabled" }).ok).toBe(false);
    expect(run({ kind: "key", selector: "#disabled", key: "Enter" }).ok).toBe(false);
  });
});
describe("inspection capture safeguards", () => {
  function inspect(element: Element) {
    const events: Record<string, any>[] = [], page = window as unknown as Record<string, any>;
    page.__redline_signal = (event: Record<string, any>) => { events.push(event); return true; };
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(1); return 1; });
    page.CSS ??= {}; page.CSS.escape ??= (text: string) => text;
    page.visualViewport = { scale: 1 };
    window.eval(inspector);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return events.find((event) => event.kind === "inspect")?.value;
  }
  it("excludes editable contents from names and markup, including selected descendants", () => {
    document.body.innerHTML = '<section id="capture">Public<textarea>secret-note</textarea><input value="secret-password"><div contenteditable="true"><span>secret-edit</span></div></section>';
    const capture = inspect(document.querySelector("section")!);
    expect(capture.accessibleName).toBe("Public");
    expect(capture.markup).not.toContain("secret-");
    const inner = inspect(document.querySelector("span")!);
    expect(inner.accessibleName).toBe("span");
    expect(inner.markup).not.toContain("secret-edit");
  });
  it("captures a unique selector when a page repeats IDs", () => {
    document.body.innerHTML = '<button id="duplicate">A</button><button id="duplicate">B</button>';
    const target = document.querySelectorAll("button")[1];
    const capture = inspect(target);
    expect(document.querySelectorAll(capture.selectors[0])).toHaveLength(1);
    expect(document.querySelector(capture.selectors[0])).toBe(target);
  });
  it("Escape closes inspection without triggering underlying page shortcuts", () => {
    const page = window as unknown as Record<string, any>;
    page.CSS ??= {}; page.CSS.escape ??= (text: string) => text;
    window.eval(inspector);
    const handler = vi.fn(); document.addEventListener("keydown", handler);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", handler);
    expect(handler).not.toHaveBeenCalled();
    expect(page.__redline_inspect_stop).toBeNull();
  });
});
describe("page signals and inspector", () => {
  it("says which input a page interaction was, so only a press reads as one outside the island", () => {
    const page = window as unknown as Record<string, any>;
    const events: Record<string, any>[] = [];
    page.webkit = { messageHandlers: { redlineBrowser: { postMessage: (raw: string) => events.push(JSON.parse(raw)) } } };
    page.__redline_signals_installed = false;
    // Page input is trusted input; a test's synthetic event is not, so the
    // listener is called the way the page would call it.
    const listen = vi.spyOn(document, "addEventListener");
    window.eval(signals);
    const press = listen.mock.calls.find(([name]) => name === "pointerdown")![1] as (event: unknown) => void;
    listen.mockRestore();
    press({ isTrusted: true });
    expect(events.filter((event) => event.kind === "interaction").map((event) => event.value)).toEqual(["pointerdown"]);
  });
  it("forwards the app's globals and the browser's own ⌃Tab from a focused page, and leaves the rest to the page", () => {
    const page = window as unknown as Record<string, any>;
    const events: Record<string, any>[] = [];
    page.webkit = { messageHandlers: { redlineBrowser: { postMessage: (raw: string) => events.push(JSON.parse(raw)) } } };
    page.__redline_signals_installed = false;
    const listen = vi.spyOn(document, "addEventListener");
    window.eval(signals);
    const keydown = listen.mock.calls.find(([name, , capture]) => name === "keydown" && capture === true)![1] as (event: unknown) => void;
    listen.mockRestore();
    const press = (init: Record<string, unknown>) => {
      const event = { isTrusted: true, target: document.body, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...init };
      keydown(event);
      return event;
    };
    const shortcuts = () => events.filter((e) => e.kind === "shortcut").map((e) => e.value);
    // ⌘K is the palette everywhere, over the page's own ⌘K.
    const k = press({ metaKey: true, key: "k", code: "KeyK" });
    expect(k.preventDefault).toHaveBeenCalled();
    press({ metaKey: true, shiftKey: true, key: "J", code: "KeyJ" });
    press({ metaKey: true, shiftKey: true, key: "N", code: "KeyN" });
    press({ metaKey: true, shiftKey: true, key: ")", code: "Digit0" });
    press({ ctrlKey: true, key: "Tab", code: "Tab" });
    press({ ctrlKey: true, shiftKey: true, key: "Tab", code: "Tab" });
    expect(shortcuts()).toEqual(["palette", "needs-you", "new-plan", "snap-back", "next-page", "previous-page"]);
    // The page keeps what is not the app's: Ctrl+K (a field's kill-line),
    // ⌘⇧K, ⌘D and plain typing.
    events.length = 0;
    for (const init of [{ ctrlKey: true, key: "k", code: "KeyK" }, { metaKey: true, shiftKey: true, key: "K", code: "KeyK" }, { metaKey: true, key: "d", code: "KeyD" }, { key: "k", code: "KeyK" }]) {
      expect(press(init).preventDefault).not.toHaveBeenCalled();
    }
    expect(shortcuts()).toEqual([]);
  });
  it("emits bounded new-tab actions without host polling and refuses page activation during inspection", () => {
    const page = window as unknown as Record<string, any>;
    const events: Record<string, any>[] = [];
    page.webkit = { messageHandlers: { redlineBrowser: { postMessage: (raw: string) => events.push(JSON.parse(raw)) } } };
    page.__redline_signals_installed = false;
    window.eval(signals);
    page.__redline_newtabs.push("https://example.org/new");
    expect(events).toContainEqual({ kind: "tabs", value: "https://example.org/new" });
    document.body.innerHTML = '<button id="target" aria-label="Create item">Create</button>';
    const button = document.querySelector("button")!;
    const clicked = vi.fn(); button.addEventListener("click", clicked);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => button });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(1); return 1; });
    page.CSS ??= {}; page.CSS.escape ??= (text: string) => text;
    page.visualViewport = { scale: 1 };
    window.eval(inspector);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    button.click();
    expect(clicked).not.toHaveBeenCalled();
    expect(events.find((event) => event.kind === "inspect")?.value).toMatchObject({ tag: "button", accessibleName: "Create item", selectors: ["#target"], frame: "top" });
    expect(page.__redline_inspect_stop).toBeNull();
    vi.unstubAllGlobals();
  });
});

it("captures a click without a preceding pointer move and exposes send failures", () => {
  const page = window as unknown as Record<string, any>;
  page.CSS ??= {}; page.CSS.escape ??= (text: string) => text;
  page.visualViewport = { scale: 1 };
  document.body.innerHTML = '<h1 id="heading">Heading</h1>';
  page.__redline_signal = vi.fn(() => true);
  window.eval(inspector);
  document.querySelector<HTMLElement>("h1")!.click();
  expect(page.__redline_signal).toHaveBeenCalledWith(expect.objectContaining({ kind: "inspect", value: expect.objectContaining({ tag: "h1" }) }));
  expect(page.__redline_inspect_status.state).toBe("sent");
  page.__redline_signal = () => false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.eval(inspector); document.querySelector<HTMLElement>("h1")!.click();
  expect(page.__redline_inspect_status.state).toBe("error");
});
