// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The contract under test is CodeBody's prepared overlay swap: the read view
// (CodeView) must stay mounted for the whole life of the file — through Edit,
// while the editor overlays it, and after Done — and the editor must never
// mount until its prepare (chunk + text + grammar) has resolved. No real
// CodeMirror in jsdom: ./CodeEditor is stubbed with a controllable deferred.

const prepared = vi.hoisted(() => ({
  resolve: null as null | ((v: { content: string; language: null }) => void),
  reject: null as null | ((e: unknown) => void),
}));

vi.mock("./CodeEditor", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ onDone }: { onDone: () => void }) =>
      h("div", { id: "editor-stub", onClick: onDone }),
    prepareEdit: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          prepared.resolve = resolve;
          prepared.reject = reject;
        }),
    ),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "open_doc") {
      return Promise.resolve({
        meta: {
          lineCount: 2,
          highlightable: true,
          tooLarge: false,
          isBinary: false,
          size: 24,
        },
        lines: [
          { tokens: [{ c: "hljs-keyword", t: "let" }] },
          { tokens: [{ c: null, t: "x" }] },
        ],
      });
    }
    return Promise.resolve(null);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;

// Required for async act() to actually flush Suspense/lazy commits — without
// it React treats the environment as non-test and act is a passthrough.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { FileViewer } from "./FileViewer";

// Settle one macrotask round inside act — enough for a resolved promise chain
// (mock invoke, deferred resolve) to land and re-render.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

// Poll until the tree reaches a state. Needed because the lazy CodeView chunk
// is real module I/O in vitest (cold transform takes tens of ms) — no fixed
// number of ticks is safe.
async function until(pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 5000) throw new Error("until(): timed out");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function mount(path: string): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(FileViewer, { path, onClose: () => {} }));
  });
  return { container, root };
}

const editBtn = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].find((b) =>
    /Edit|Opening…/.test(b.textContent ?? ""),
  )!;

beforeEach(() => {
  prepared.resolve = null;
  prepared.reject = null;
  document.body.innerHTML = "";
});

describe("CodeBody prepared overlay swap", () => {
  it("keeps CodeView mounted through Edit → editing → Done, same DOM node", async () => {
    const { container, root } = mount("/repo/main.rs");
    // CodeView chunk + open_doc landed, meta reported (Edit enabled).
    await until(() => !editBtn(container).disabled);
    const codeView = container.querySelector(".rl-code-view");
    expect(codeView).not.toBeNull();

    // Enter edit: prepare is in flight — no editor yet, view untouched.
    act(() => editBtn(container).click());
    await until(() => prepared.resolve !== null);
    expect(container.querySelector("#editor-stub")).toBeNull();
    expect(container.querySelector(".rl-code-view")).toBe(codeView);
    expect(editBtn(container).disabled).toBe(true);

    // Prepare resolves → overlay model: editor AND the still-mounted view.
    await act(async () => {
      prepared.resolve!({ content: "let x", language: null });
    });
    expect(container.querySelector("#editor-stub")).not.toBeNull();
    expect(container.querySelector(".rl-code-view")).toBe(codeView);
    // The covered read column is inert while the editor is up.
    expect(container.querySelector("[inert]")).not.toBeNull();

    // Done → overlay unmounts over the SAME painted view (no remount).
    act(() => {
      (container.querySelector("#editor-stub") as HTMLElement).click();
    });
    expect(container.querySelector("#editor-stub")).toBeNull();
    expect(container.querySelector(".rl-code-view")).toBe(codeView);
    expect(container.querySelector("[inert]")).toBeNull();

    act(() => root.unmount());
  });

  it("a prepare failure stays in the view and surfaces the error", async () => {
    const { container, root } = mount("/repo/main.rs");
    await until(() => !editBtn(container).disabled);
    const codeView = container.querySelector(".rl-code-view");
    expect(codeView).not.toBeNull();

    act(() => editBtn(container).click());
    await until(() => prepared.reject !== null);
    await act(async () => {
      prepared.reject!(new Error("grammar chunk failed"));
    });
    await flush();

    expect(container.querySelector("#editor-stub")).toBeNull();
    expect(container.querySelector(".rl-code-view")).toBe(codeView);
    expect(container.textContent).toContain("grammar chunk failed");
    // The button is usable again for a retry.
    expect(editBtn(container).disabled).toBe(false);

    act(() => root.unmount());
  });

  it("never mounts the editor when the file switches mid-prepare", async () => {
    const { container, root } = mount("/repo/main.rs");
    await until(() => !editBtn(container).disabled);

    act(() => editBtn(container).click());
    await until(() => prepared.resolve !== null);
    // Switch files while the prepare for main.rs is still in flight.
    act(() => {
      root.render(
        createElement(FileViewer, { path: "/repo/other.py", onClose: () => {} }),
      );
    });
    await flush();

    // The stale resolve lands after the switch — it must be dropped.
    await act(async () => {
      prepared.resolve!({ content: "let x", language: null });
    });
    expect(container.querySelector("#editor-stub")).toBeNull();
    expect(container.querySelector(".rl-code-view")).not.toBeNull();

    act(() => root.unmount());
  });
});
