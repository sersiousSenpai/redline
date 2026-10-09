// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type DropEvent = { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } };
const { invokeMock, dropListeners } = vi.hoisted(() => ({
  invokeMock: vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null)),
  dropListeners: new Set<(event: DropEvent) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: DropEvent) => void) => {
      dropListeners.add(handler);
      return Promise.resolve(() => dropListeners.delete(handler));
    },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentComposer } from "./CommentComposer";
import type { CommentType } from "../types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(null));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(
  type: CommentType,
  onSubmit = vi.fn((_req: unknown, _opts: { discuss: boolean }) => Promise.resolve()),
  onCancel = vi.fn(),
) {
  await act(async () => {
    root.render(
      createElement(CommentComposer, {
        type,
        sessionId: "s",
        anchorId: "A.1",
        selectedText: "the old words",
        charStart: 0,
        charEnd: 13,
        onCancel,
        onSubmit,
      }),
    );
  });
  return onSubmit;
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = (opts: KeyboardEventInit) =>
  act(async () => {
    host.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...opts }));
  });

const buttons = () => [...host.querySelectorAll("button")];
/** The filled primary button: the last control in the footer. */
const primary = () => {
  const all = buttons();
  return all[all.length - 1];
};
/** The footer row: the primary button's parent. */
const footer = () => primary().parentElement!;
/** The quiet secondary "Save" a question or feedback carries. */
const quietSave = () => buttons().find((b) => b.textContent === "Save");

describe("CommentComposer — Send vs Save", () => {
  it.each(["question", "feedback"] as const)("%s: ⌘⏎ sends (save + discuss)", async (type) => {
    const onSubmit = await mount(type);
    await typeInto(host.querySelector("textarea")!, "Why this order?");
    await press({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: true });
  });

  it("Ctrl+Enter sends too", async () => {
    const onSubmit = await mount("question");
    await typeInto(host.querySelector("textarea")!, "Why this order?");
    await press({ ctrlKey: true });
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: true });
  });

  it.each(["question", "feedback"] as const)("%s: ⌥⌘⏎ and the quiet Save save only", async (type) => {
    const onSubmit = await mount(type);
    await typeInto(host.querySelector("textarea")!, "Batch this one");
    await press({ metaKey: true, altKey: true });
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: false });
    await act(async () => quietSave()!.click());
    expect(onSubmit.mock.calls[1][1]).toEqual({ discuss: false });
  });

  it("an edit just saves — the edit is the whole message", async () => {
    const onSubmit = await mount("edit");
    const areas = host.querySelectorAll("textarea");
    await typeInto(areas[0], "the new words");
    await press({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: false });
    const labels = buttons().map((b) => b.textContent);
    expect(labels).not.toContain("Send⌘⏎");
    expect(quietSave()).toBeUndefined();
  });

  it("Esc and the ✕ cancel without submitting", async () => {
    const onCancel = vi.fn();
    const onSubmit = await mount("question", undefined, onCancel);
    await typeInto(host.querySelector("textarea")!, "Never mind");
    await press({ key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.click());
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// The footer used to spell every shortcut out in a sentence that wrapped onto
// three lines in the sidebar. Each shortcut now lives on the control it
// triggers, and the footer is only the buttons.
describe("CommentComposer — shortcuts live on their controls", () => {
  it.each(["question", "feedback", "edit"] as const)("%s: the footer is just the buttons, right-aligned", async (type) => {
    await mount(type);
    expect(host.textContent).not.toMatch(/Enter to|Esc to cancel|drop or ⌘V/);
    expect(footer().className).toContain("justify-end");
    expect([...footer().children].every((c) => c.tagName === "BUTTON")).toBe(true);
    expect(footer().children).toHaveLength(type === "edit" ? 1 : 2);
  });

  it.each([
    ["question", "Send"],
    ["feedback", "Send"],
    ["edit", "Save"],
  ] as const)("%s: the primary reads %s with a dimmed ⌘⏎ glyph", async (type, verb) => {
    await mount(type);
    const button = primary();
    expect(button.textContent).toBe(`${verb}⌘⏎`);
    expect(button.firstChild?.textContent).toBe(verb);
    const glyph = button.querySelector("span")!;
    expect(glyph.textContent).toBe("⌘⏎");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.style.opacity).toBe("0.6");
    expect(parseFloat(glyph.style.fontSize)).toBeLessThan(parseFloat(button.style.fontSize));
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
    expect(button.className).toContain("whitespace-nowrap");
  });

  it.each([
    ["question", "Sending…"],
    ["edit", "Saving…"],
  ] as const)("%s: %s drops the glyph", async (type, busyLabel) => {
    let finish!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await mount(type, onSubmit);
    await typeInto(host.querySelector("textarea")!, type === "edit" ? "the new words" : "Why?");
    await press({ metaKey: true });
    expect(primary().textContent).toBe(busyLabel);
    expect(primary().querySelector("span")).toBeNull();
    await act(async () => finish());
    expect(primary().textContent).toMatch(/⌘⏎$/);
  });

  it("Save is a quiet one-line text button carrying ⌥⌘⏎ in its tooltip", async () => {
    await mount("feedback");
    const save = quietSave()!;
    expect(save.title).toBe("Save it for the next Revise without starting a discussion (⌥⌘⏎)");
    expect(save.getAttribute("aria-keyshortcuts")).toBe("Alt+Meta+Enter");
    expect(save.className).toContain("whitespace-nowrap");
    // Muted ink that turns to full ink on hover, never underlined.
    expect(save.className).toContain("text-ink-muted");
    expect(save.className).toContain("hover:text-ink");
    expect(save.style.textDecoration).toBe("");
    expect(buttons().some((b) => b.textContent === "Save only")).toBe(false);
  });

  it("Esc is named on the ✕", async () => {
    await mount("question");
    const cancel = host.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!;
    expect(cancel.textContent).toBe("✕");
    expect(cancel.title).toBe("Cancel (Esc)");
    expect(cancel.getAttribute("aria-keyshortcuts")).toBe("Escape");
  });
});

describe("CommentComposer — attachments without a hint line", () => {
  const shot = { path: "/data/attachments/s/shot.png", name: "shot.png", mime: "image/png", bytes: 2048 };

  it("a dragged file shows the Drop to attach overlay, and the drop attaches it", async () => {
    invokeMock.mockImplementation((cmd) => Promise.resolve(cmd === "import_attachment" ? shot : null));
    const onSubmit = await mount("feedback");
    // jsdom lays everything out at 0×0, so the origin is inside the composer.
    const fire = (payload: DropEvent["payload"]) =>
      act(async () => dropListeners.forEach((listener) => listener({ payload })));
    await fire({ type: "over", position: { x: 0, y: 0 } });
    expect(host.textContent).toContain("Drop to attach");
    await fire({ type: "drop", paths: ["/Users/me/Desktop/shot.png"], position: { x: 0, y: 0 } });
    expect(host.textContent).not.toContain("Drop to attach");
    expect(invokeMock).toHaveBeenCalledWith("import_attachment", { sessionId: "s", srcPath: "/Users/me/Desktop/shot.png" });
    expect(host.textContent).toContain("shot.png");
    await typeInto(host.querySelector("textarea")!, "Make it look like this");
    await press({ metaKey: true });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ attachments: [shot] });
  });

  it("⌘V of a screenshot attaches it", async () => {
    invokeMock.mockImplementation((cmd) => Promise.resolve(cmd === "save_attachment" ? shot : null));
    await mount("question");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", getAsFile: () => file }] },
    });
    // The base64 read is async; stay inside act until the copy is requested.
    await act(async () => {
      host.querySelector("textarea")!.dispatchEvent(paste);
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith(
          "save_attachment",
          expect.objectContaining({ sessionId: "s", filename: "pasted-image.png" }),
        ),
      );
    });
    await act(async () => {}); // the chip's thumbnail read settles
    expect(paste.defaultPrevented).toBe(true);
    expect(host.textContent).toContain("shot.png");
  });
});
