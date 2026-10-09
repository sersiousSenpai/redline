// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A page chat's provider/model/effort pick: what "Default" means comes from
// the `browse` seat, a pick is stored per chat through the backend, Codex is
// offered but cannot be picked yet, and a chat that never picked inherits the
// last pick made in any page chat and stores it before its first turn.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, stored, seats } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  stored: { current: null as unknown },
  seats: { current: {} as Record<string, { model?: string; effort?: string }> },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { BrowseHarnessChip, LAST_HARNESS_KEY, useBrowseHarness, type BrowseHarness } from "./BrowseHarnessChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE_MODELS = ["opus", "sonnet", "haiku"].map(slug => ({ slug, displayName: slug, description: "", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh"] }));

let host: HTMLDivElement, root: Root, latest: BrowseHarness;
function Host({ browseId = "tab-1" }: { browseId?: string }) {
  latest = useBrowseHarness(browseId);
  return <BrowseHarnessChip harness={latest}/>;
}
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Chat model and effort"]')!;
const sets = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "browse_thread_set_harness");
async function mount(browseId?: string) {
  await act(async () => root.render(<Host browseId={browseId}/>));
  await flush();
}
async function open() {
  await act(async () => trigger().click());
  await flush();
}
async function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  stored.current = { backend: null, model: null, effort: null };
  seats.current = { browse: { model: "sonnet", effort: "medium" } };
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "browse_thread_harness") return stored.current;
    if (cmd === "get_agent_seats") return { seats: seats.current };
    if (cmd === "model_catalog_snapshot") return { models: args?.backend === "claude-code" ? CLAUDE_MODELS : [], checkedAt: 1, source: "harness", warning: null };
    return undefined;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("page chat model picker", () => {
  it("names the browse seat's model and effort as the default", async () => {
    await mount();
    expect(invokeMock).toHaveBeenCalledWith("browse_thread_harness", { browseId: "tab-1" });
    expect(trigger().textContent).toContain("Default (sonnet · medium)");
    expect(trigger().title).toBe("Applies to the next message");
    await act(async () => root.unmount());
    seats.current = {};
    root = createRoot(host);
    await mount();
    expect(trigger().textContent).toContain("Default (CLI default)");
  });

  it("stores a pick for this chat and remembers it for the next new one", async () => {
    await mount();
    await open();
    await choose("Chat model", "opus");
    expect(sets()).toEqual([["browse_thread_set_harness", { browseId: "tab-1", backend: "claude-code", model: "opus", effort: null }]]);
    await choose("Chat effort", "xhigh");
    expect(sets()[1]).toEqual(["browse_thread_set_harness", { browseId: "tab-1", backend: "claude-code", model: "opus", effort: "xhigh" }]);
    expect(trigger().textContent).toContain("opus · xhigh");
    expect(JSON.parse(localStorage.getItem(LAST_HARNESS_KEY)!)).toEqual({ backend: "claude-code", model: "opus", effort: "xhigh" });
    // Default is a pick too: it clears model and effort, not the provider.
    const reset = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent?.startsWith("Default"))!;
    expect(reset.getAttribute("aria-checked")).toBe("false");
    await act(async () => reset.click());
    await flush();
    expect(sets()[2]).toEqual(["browse_thread_set_harness", { browseId: "tab-1", backend: "claude-code", model: null, effort: null }]);
    expect(trigger().textContent).toContain("Default (sonnet · medium)");
  });

  it("shows a stored pick and leaves it alone on send", async () => {
    stored.current = { backend: "claude-code", model: "haiku", effort: null };
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "claude-code", model: "opus", effort: "high" }));
    await mount();
    expect(trigger().textContent).toContain("haiku");
    await act(() => latest.commit());
    expect(sets()).toEqual([]);
  });

  it("offers Codex but keeps it disabled with the reason", async () => {
    await mount();
    await open();
    const provider = document.querySelector('[role="group"][aria-label="Provider"]')!;
    const [claude, codex] = [...provider.querySelectorAll<HTMLButtonElement>("button")];
    expect(claude.textContent).toBe("Claude");
    expect(claude.getAttribute("aria-checked")).toBe("true");
    expect(codex.textContent).toBe("Codex");
    expect(codex.disabled).toBe(true);
    expect(codex.title).toContain("coming next");
    await act(async () => codex.click());
    expect(sets()).toEqual([]);
  });

  it("is never disabled, so a pick can change while a reply streams", async () => {
    await mount();
    expect(trigger().disabled).toBe(false);
  });

  it("inherits the last pick on a new chat and stores it on the first send only", async () => {
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "claude-code", model: "opus", effort: "high" }));
    await mount("tab-new");
    expect(trigger().textContent).toContain("opus · high");
    expect(sets()).toEqual([]);
    await act(() => latest.commit());
    expect(sets()).toEqual([["browse_thread_set_harness", { browseId: "tab-new", backend: "claude-code", model: "opus", effort: "high" }]]);
    await act(() => latest.commit());
    expect(sets()).toHaveLength(1);
    // Clear history drops the row: the chat is unpicked again.
    await act(async () => latest.forget());
    await act(() => latest.commit());
    expect(sets()).toHaveLength(2);
  });

  it("does not inherit a Codex pick it cannot run", async () => {
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "codex", model: "gpt-5", effort: null }));
    await mount();
    expect(trigger().textContent).toContain("Default (sonnet · medium)");
    await act(() => latest.commit());
    expect(sets()).toEqual([]);
  });

  it("never writes over a pick it failed to read", async () => {
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "claude-code", model: "opus", effort: null }));
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "browse_thread_harness") throw new Error("ipc down");
      return fallback(cmd, args);
    });
    await mount();
    await act(() => latest.commit());
    expect(sets()).toEqual([]);
  });

  it("surfaces a refused save without changing the pick", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "browse_thread_set_harness") throw "unknown Claude model `opus`";
      return fallback(cmd, args);
    });
    await mount();
    await open();
    await choose("Chat model", "opus");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("unknown Claude model");
    expect(trigger().textContent).toContain("Default (sonnet · medium)");
    expect(localStorage.getItem(LAST_HARNESS_KEY)).toBeNull();
  });
});
