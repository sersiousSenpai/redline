// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";

// The real CodeMirror editor over a fake disk: the debounce, the leave path
// and the changed-on-disk pause, end to end through the component.

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  calls: [] as { cmd: string; path: string; content?: string }[],
  failSave: false,
  reload: null as null | (() => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { path: string; content?: string }) => {
    disk.calls.push({ cmd, ...args });
    if (cmd === "read_text_file") {
      const content = disk.files.get(args.path);
      if (content == null) return Promise.reject("No such file");
      return Promise.resolve({ content, isBinary: false, tooLarge: false, size: content.length });
    }
    if (cmd === "save_text_file") {
      if (disk.failSave) return Promise.reject("Permission denied");
      disk.files.set(args.path, args.content ?? "");
      return Promise.resolve(args.path);
    }
    return Promise.resolve(null);
  }),
}));

vi.mock("../hooks/useFsWatch", () => ({
  useLiveFile: (_path: string, reload: () => void) => {
    disk.reload = reload;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: CodeMirror's measure pass asks a Range for rects.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

import CodeEditor from "./CodeEditor";
import { AUTO_SAVE_DELAY_MS, AUTO_SAVE_KEY, type AutoSaveMode } from "../lib/autoSave";

const PATH = "/repo/src/a.ts";
let host: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();
const onDone = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  disk.files.clear();
  disk.calls.length = 0;
  disk.failSave = false;
  disk.files.set(PATH, "let x = 1;\n");
  onSaved.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.useRealTimers();
});

async function mount(mode: AutoSaveMode) {
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(mode));
  await act(async () =>
    root.render(
      createElement(CodeEditor, {
        path: PATH,
        prepared: { content: disk.files.get(PATH)!, language: null },
        onDone,
        onSaved,
      }),
    ),
  );
}

const view = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
const type = (text: string) =>
  act(() => {
    const v = view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: text } });
  });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const saves = () => disk.calls.filter((c) => c.cmd === "save_text_file");
const text = () => host.textContent ?? "";

describe("CodeEditor auto-save", () => {
  it("After delay: writes a second after the last keystroke, re-reading the disk first, with no toast", async () => {
    await mount("delay");
    await type("a");
    await advance(AUTO_SAVE_DELAY_MS - 100);
    await type("b");
    await advance(AUTO_SAVE_DELAY_MS - 100);
    expect(saves()).toHaveLength(0);
    await advance(200);
    expect(saves()).toEqual([{ cmd: "save_text_file", path: PATH, content: "let x = 1;\nab" }]);
    const order = disk.calls.map((c) => c.cmd);
    expect(order.slice(-2)).toEqual(["read_text_file", "save_text_file"]);
    expect(onSaved).not.toHaveBeenCalled();
    const flash = host.querySelector<HTMLElement>("[data-autosave-flash]")!;
    expect(flash.style.opacity).toBe("1");
    await advance(1500);
    expect(flash.style.opacity).toBe("0");
  });

  it("Off: nothing writes on its own; ⌘S still does, and toasts", async () => {
    await mount("off");
    await type("a");
    await advance(5000);
    act(() => window.dispatchEvent(new Event("blur")));
    await advance(10);
    expect(saves()).toHaveLength(0);
    expect(text()).toContain("Discard & close");
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Save (⌘S)"]')!.click());
    await advance(10);
    expect(saves()).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith(PATH);
  });

  it("On focus change: no timer write, but leaving the editor or the window saves", async () => {
    await mount("focus");
    await type("a");
    await advance(5000);
    expect(saves()).toHaveLength(0);
    await act(async () => {
      view().contentDOM.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    await advance(10);
    expect(saves()).toHaveLength(1);
    await type("b");
    act(() => window.dispatchEvent(new Event("blur")));
    await advance(10);
    expect(saves()).toHaveLength(2);
    expect(disk.files.get(PATH)).toBe("let x = 1;\nab");
  });

  it("closing the editor with edits pending is a leave-save", async () => {
    await mount("focus");
    await type("z");
    expect(text()).toContain("Done");
    await act(async () => root.render(createElement("div")));
    await advance(10);
    expect(disk.files.get(PATH)).toBe("let x = 1;\nz");
  });

  it("a disk change under the buffer raises the banner, and nothing auto-saves — not even after Keep editing", async () => {
    await mount("delay");
    await type("mine");
    disk.files.set(PATH, "theirs\n");
    await act(async () => disk.reload!());
    await advance(10);
    expect(text()).toContain("Changed on disk");
    await advance(AUTO_SAVE_DELAY_MS * 3);
    await type("more");
    await advance(AUTO_SAVE_DELAY_MS * 3);
    act(() => window.dispatchEvent(new Event("blur")));
    await advance(10);
    expect(saves()).toHaveLength(0);
    // Keep editing hides the banner; the pause holds until a deliberate save.
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Keep editing")!.click());
    expect(text()).toContain("auto-save paused");
    await type("!");
    await advance(AUTO_SAVE_DELAY_MS * 3);
    expect(saves()).toHaveLength(0);
    expect(disk.files.get(PATH)).toBe("theirs\n");
    // ⌘S writes, and auto-save resumes.
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Save (⌘S)"]')!.click());
    await advance(10);
    expect(saves()).toHaveLength(1);
    await type("?");
    await advance(AUTO_SAVE_DELAY_MS + 10);
    expect(saves()).toHaveLength(2);
  });

  it("a disk change the watcher has not reported yet: the pre-save read raises the banner instead of writing", async () => {
    await mount("delay");
    await type("mine");
    disk.files.set(PATH, "theirs\n");
    await advance(AUTO_SAVE_DELAY_MS + 10);
    expect(saves()).toHaveLength(0);
    expect(text()).toContain("Changed on disk");
    expect(disk.files.get(PATH)).toBe("theirs\n");
  });

  it("a failed auto-save shows the one-liner and keeps the buffer dirty", async () => {
    await mount("delay");
    disk.failSave = true;
    await type("a");
    await advance(AUTO_SAVE_DELAY_MS + 10);
    expect(text()).toContain("Permission denied");
    const err = [...host.querySelectorAll("span")].find((s) => s.textContent === "Permission denied")!;
    expect(err.style.color).toBe("var(--color-warning)");
    // Still dirty: leaving now would discard, so it says so once the error clears.
    disk.failSave = false;
    await type("b");
    await advance(AUTO_SAVE_DELAY_MS + 10);
    expect(disk.files.get(PATH)).toBe("let x = 1;\nab");
    expect(text()).not.toContain("Permission denied");
  });
});

describe("CodeEditor auto-save across a file switch", () => {
  it("the old file's leave-save lands without holding up the next file's auto-save", async () => {
    const B = "/repo/src/b.ts";
    disk.files.set(B, "b\n");
    await mount("delay");
    await type("a");
    await act(async () =>
      root.render(createElement(CodeEditor, { path: B, prepared: { content: "b\n", language: null }, onDone, onSaved })),
    );
    await advance(10);
    expect(disk.files.get(PATH)).toBe("let x = 1;\na");
    await type("b");
    await advance(AUTO_SAVE_DELAY_MS + 10);
    expect(disk.files.get(B)).toBe("b\nb");
  });
});
