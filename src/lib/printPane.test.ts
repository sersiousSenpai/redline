// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { fillPrintRoot, printPane, PRINT_ROOT_ID } from "./printPane";

afterEach(() => {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.body.innerHTML = "";
  invoke.mockClear();
});

describe("printing a pane that is not a page", () => {
  it("copies the plan document without its ids or controls, once, and prints the app's own webview", async () => {
    const article = document.createElement("article");
    article.id = "doc";
    article.innerHTML = `<h1 id="h">Plan</h1><p>Step one</p><button>Copy</button>`;
    document.body.append(article);
    await printPane({ kind: "plan", element: article });
    await printPane({ kind: "plan", element: article });
    const roots = document.querySelectorAll(`#${PRINT_ROOT_ID}`);
    expect(roots).toHaveLength(1);
    const root = roots[0] as HTMLElement;
    expect(root.dataset.kind).toBe("plan");
    expect(root.textContent).toBe("PlanStep one");
    expect(root.querySelector("[id]")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("browser_print", { label: "main" });
    // The live document is untouched.
    expect(article.querySelector("button")).not.toBeNull();
  });

  it("a file prints as its path and its text", () => {
    const root = fillPrintRoot({ kind: "file", path: "/repo/app.py", text: "print('hi')\n" });
    expect(root.dataset.kind).toBe("file");
    expect(root.querySelector("h1")?.textContent).toBe("/repo/app.py");
    expect(root.querySelector("pre")?.textContent).toBe("print('hi')\n");
    expect(root.hasAttribute("data-ready")).toBe(true);
  });
});
