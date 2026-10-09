// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlanSearchBar, SelectionMenu } from "./SelectionMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const rect = new DOMRect(100, 200, 80, 16);

describe("Search from the plan", () => {
  it("offers Search beside the comment kinds", async () => {
    const onSearch = vi.fn();
    await act(async () => root.render(createElement(SelectionMenu, { rect, onPick: () => {}, onSearch })));
    const search = [...host.querySelectorAll("button")].find((b) => b.textContent === "Search")!;
    await act(async () => search.click());
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("submits the optional instruction and backs out on Esc", async () => {
    const onSubmit = vi.fn(), onCancel = vi.fn();
    await act(async () => root.render(createElement(PlanSearchBar, { rect, selectedText: "token  bucket\nper tenant", onSubmit, onCancel })));
    expect(host.textContent).toContain("token bucket per tenant");
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "vs sliding window");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.requestSubmit());
    expect(onSubmit).toHaveBeenCalledWith("vs sliding window");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("links the research comment to the tab the browser opened, and sends the tab's chat", () => {
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    const run = app.slice(app.indexOf("const runPlanSearch ="), app.indexOf("const viewResearch ="));
    expect(run).toContain('type: "question"');
    expect(run).toContain("research: { query, browseId: \"\", url }");
    expect(run).toContain("autoSend: true");
    const consumed = app.slice(app.indexOf("const onBrowserOpenConsumed ="), app.indexOf("const openUrlInBrowser ="));
    expect(consumed).toContain("research: { ...pending.request.research!, browseId }");
  });

  it("opens every search in a fresh tab whose chat is that tab's own", () => {
    const pane = readFileSync(join(process.cwd(), "src/components/BrowserPane.tsx"), "utf8");
    const effect = pane.slice(pane.indexOf("const lastOpenNonceRef = useRef(0);"), pane.indexOf("const selectTabRef = useRef(selectTab);"));
    expect(effect).toContain("openTabRef.current(openRequest.url, { fresh: !!openRequest.chat })");
    // Linked mode on means "shared unless flipped", so the new tab is flipped
    // to its own chat; off, it already is its own.
    expect(effect).toContain("setFlipFor(linkedModeRef.current ? browseId : null)");
    expect(effect).not.toContain("setOwnChatsByWorkspace");
    // The mode-wins effect must queue its update first when both run at once.
    expect(pane.indexOf("setFlipFor(f => f === discussionBrowseId ? f : null)")).toBeLessThan(pane.indexOf("const lastOpenNonceRef = useRef(0);"));
  });
});
