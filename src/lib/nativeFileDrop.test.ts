// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NativeHandler = (event: { payload: unknown }) => void;
type EventHandler = (event: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({
  native: new Set<NativeHandler>(),
  events: new Map<string, Set<EventHandler>>(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (fn: NativeHandler) => {
      mocks.native.add(fn);
      return () => mocks.native.delete(fn);
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: EventHandler) => {
    const set = mocks.events.get(name) ?? new Set();
    set.add(fn);
    mocks.events.set(name, set);
    return () => set.delete(fn);
  },
}));

import { fileDropTargetAt, PROMISED_DROP_EVENT, registerFileDropTarget } from "./nativeFileDrop";

const native = (payload: unknown) => mocks.native.forEach((fn) => fn({ payload }));
const promised = (payload: unknown) => mocks.events.get(PROMISED_DROP_EVENT)?.forEach((fn) => fn({ payload }));
const at = { x: 40, y: 50 };
const subscriptions = () => mocks.native.size + (mocks.events.get(PROMISED_DROP_EVENT)?.size ?? 0);
/** Let the router's deferred subscriptions resolve. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** What `elementsFromPoint` reports for the next lookups: every layer under
 *  the pointer, topmost first. jsdom has no layout, so the test says. */
let stack: Element[] = [];
const original = document.elementsFromPoint;
const unregister: (() => void)[] = [];

function target(className: string, parent: HTMLElement = document.body) {
  const el = document.createElement("div");
  el.className = className;
  parent.appendChild(el);
  const onDrop = vi.fn();
  const onHover = vi.fn();
  unregister.push(registerFileDropTarget(el, onDrop, onHover));
  return { el, onDrop, onHover };
}

beforeEach(() => {
  stack = [];
  document.elementsFromPoint = () => stack;
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  unregister.splice(0).forEach((un) => un());
  document.body.replaceChildren();
  document.elementsFromPoint = original;
  vi.restoreAllMocks();
});

describe("native file drop router", () => {
  it("gives the drop to the topmost registered target under the pointer", async () => {
    const terminal = target("terminal");
    const composer = target("composer");
    const field = composer.el.appendChild(document.createElement("textarea"));
    await settle();
    stack = [field, composer.el, terminal.el, document.body];
    native({ type: "drop", paths: ["/a b.png"], position: at });
    expect(composer.onDrop).toHaveBeenCalledWith(["/a b.png"]);
    expect(terminal.onDrop).not.toHaveBeenCalled();
  });

  it("looks through an overlay that is not a target", async () => {
    const terminal = target("terminal");
    const canvas = terminal.el.appendChild(document.createElement("canvas"));
    const notch = document.body.appendChild(document.createElement("div"));
    await settle();
    stack = [notch.appendChild(document.createElement("span")), notch, canvas, terminal.el, document.body];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(terminal.onDrop).toHaveBeenCalledWith(["/tmp/x"]);
  });

  it("ignores a drop that lands on no target", async () => {
    const terminal = target("terminal");
    await settle();
    stack = [document.body, document.documentElement];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(terminal.onDrop).not.toHaveBeenCalled();
    expect(fileDropTargetAt(at.x, at.y)).toBeNull();
  });

  it("never lets a drop through a modal dialog into what it covers", async () => {
    const terminal = target("terminal");
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = dialog.appendChild(document.createElement("button"));
    await settle();
    stack = [button, dialog, terminal.el, document.body];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(terminal.onDrop).not.toHaveBeenCalled();
  });

  it("still delivers to a target inside a modal dialog", async () => {
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("aria-modal", "true");
    const door = target("door", dialog);
    await settle();
    stack = [door.el, dialog, document.body];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(door.onDrop).toHaveBeenCalledWith(["/tmp/x"]);
  });

  it("skips a registered target that has left the document", async () => {
    const stale = target("stale");
    const live = target("live");
    await settle();
    stale.el.remove();
    stack = [stale.el, live.el];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(stale.onDrop).not.toHaveBeenCalled();
    expect(live.onDrop).toHaveBeenCalledWith(["/tmp/x"]);
  });

  it("routes a promised drop by its position, like a native one", async () => {
    const terminal = target("terminal");
    const composer = target("composer");
    await settle();
    stack = [terminal.el];
    promised({ paths: ["/cache/drops/1/Screenshot.png"], position: at });
    expect(terminal.onDrop).toHaveBeenCalledWith(["/cache/drops/1/Screenshot.png"]);
    expect(composer.onDrop).not.toHaveBeenCalled();
  });

  it("treats a pathless drop (a pending file promise) as no drop, but ends the hover", async () => {
    const terminal = target("terminal");
    await settle();
    stack = [terminal.el];
    native({ type: "over", position: at });
    expect(terminal.onHover).toHaveBeenLastCalledWith(true);
    native({ type: "drop", paths: [], position: at });
    expect(terminal.onDrop).not.toHaveBeenCalled();
    expect(terminal.onHover).toHaveBeenLastCalledWith(false);
  });

  it("moves the hover between targets once per change and clears it on leave", async () => {
    const a = target("a");
    const b = target("b");
    await settle();
    stack = [a.el];
    native({ type: "enter", paths: ["/tmp/x"], position: at });
    native({ type: "over", position: at });
    expect(a.onHover.mock.calls).toEqual([[true]]);
    stack = [b.el, a.el];
    native({ type: "over", position: at });
    expect(a.onHover.mock.calls).toEqual([[true], [false]]);
    expect(b.onHover.mock.calls).toEqual([[true]]);
    native({ type: "leave" });
    expect(b.onHover.mock.calls).toEqual([[true], [false]]);
  });

  it("clears a target's hover when it unregisters mid-drag", async () => {
    const a = target("a");
    await settle();
    stack = [a.el];
    native({ type: "over", position: at });
    unregister.splice(0).forEach((un) => un());
    expect(a.onHover).toHaveBeenLastCalledWith(false);
  });

  it("subscribes while any target is registered and unsubscribes after the last", async () => {
    const a = target("a");
    target("b");
    await settle();
    expect(subscriptions()).toBe(2);
    unregister.splice(0).forEach((un) => un());
    expect(subscriptions()).toBe(0);
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(a.onDrop).not.toHaveBeenCalled();

    // Unregistered before the subscriptions even resolved: none may leak.
    unregister.push(registerFileDropTarget(document.createElement("div"), () => {}));
    unregister.splice(0).forEach((un) => un());
    await settle();
    expect(subscriptions()).toBe(0);
  });

  it("keeps the newer handlers when the same element registers twice", async () => {
    const el = document.body.appendChild(document.createElement("div"));
    const first = vi.fn();
    const second = vi.fn();
    const unFirst = registerFileDropTarget(el, first);
    unregister.push(registerFileDropTarget(el, second));
    unFirst();
    await settle();
    stack = [el];
    native({ type: "drop", paths: ["/tmp/x"], position: at });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(["/tmp/x"]);
  });

  it("leaves a dev breadcrumb for every drop: source, path count and target", async () => {
    const a = target("a");
    await settle();
    stack = [a.el];
    native({ type: "drop", paths: ["/tmp/x", "/tmp/y"], position: at });
    expect(console.debug).toHaveBeenCalledWith("[redline:drop]", "drop", { paths: 2, target: "div.a" });
    stack = [];
    promised({ paths: ["/tmp/z"], position: at });
    expect(console.debug).toHaveBeenCalledWith("[redline:drop]", "promised-drop", { paths: 1, target: "none" });
  });
});
