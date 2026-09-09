// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Footer } from "./Footer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(backend?: string, waiting = false, waitingAsk = false) {
  await act(async () => root.render(createElement(Footer, {
    comments: [], sessionReady: true, canSubmit: true, canApprove: true,
    canOrchestrate: true, waiting, waitingAsk, backend,
    onSubmit: () => {}, onApprove: () => {}, onOrchestrate: () => {},
    termCollapsed: false, termTabCount: 0, termHasUnseen: false, onExpandTerminal: () => {},
  })));
}
describe("plan footer provider and execution labels", () => {
  it.each([["claude-code", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"], ["antigravity", "Antigravity"]])(
    "routes %s feedback labels to the plan author", async (backend, author) => {
      await mount(backend, true, true);
      expect(host.textContent).toContain(`Send to ${author}`);
      expect(host.textContent).toContain(`${author} is working — answering in the terminal`);
      await mount(backend, true, false);
      expect(host.textContent).toContain(`${author} is working — revising in the terminal`);
    },
  );
  it("explains that orchestration prepares a graph for review before execution", async () => {
    await mount("cursor");
    const button = Array.from(host.querySelectorAll("button")).find((element) => element.textContent?.includes("Orchestrate"));
    expect(button?.textContent).toContain("approve + review run graph");
    expect(button?.title).toContain("before starting execution");
    expect(button?.title).not.toContain("terminal");
  });
});
