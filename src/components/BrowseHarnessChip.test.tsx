// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A page chat's provider/model/effort pick: what "Default" means comes from
// the `browse` seat, a pick is stored per chat through the backend, Codex is
// pickable only when the preflight probe says this machine can run it, and a
// chat that never picked inherits the last pick made in any page chat and
// stores it before its first turn.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, stored, seats, codexProbe } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  stored: { current: null as unknown },
  seats: { current: {} as Record<string, { model?: string; effort?: string }> },
  codexProbe: { current: null as unknown },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { BrowseHarnessChip, LAST_HARNESS_KEY, codexBlocker, useBrowseHarness, type BrowseHarness } from "./BrowseHarnessChip";
import { integrationHealth } from "../lib/integrationHealth";
import type { CodexProbe } from "../lib/readiness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE_MODELS = ["opus", "sonnet", "haiku"].map(slug => ({ slug, displayName: slug, description: "", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh"] }));
const CODEX_MODELS = [{ slug: "gpt-5.5", displayName: "GPT-5.5", description: "", defaultEffort: "medium", efforts: ["low", "medium", "high"] }];
const READY: CodexProbe = { found: true, path: "/opt/homebrew/bin/codex", source: "path", usable: true, signedIn: true, authState: "signed-in", version: "0.160.1", configuredModel: "gpt-6-astra" };

let host: HTMLDivElement, root: Root, latest: BrowseHarness;
function Host({ browseId = "tab-1" }: { browseId?: string }) {
  latest = useBrowseHarness(browseId);
  return <BrowseHarnessChip harness={latest}/>;
}
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Chat model and effort"]')!;
const sets = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "browse_thread_set_harness");
const providers = () => {
  const group = document.querySelector('[role="group"][aria-label="Provider"]')!;
  const [claude, codex] = [...group.querySelectorAll<HTMLButtonElement>("button")];
  return { claude, codex };
};
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
  integrationHealth.invalidate();
  stored.current = { backend: null, model: null, effort: null };
  seats.current = { browse: { model: "sonnet", effort: "medium" } };
  codexProbe.current = READY;
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "browse_thread_harness") return stored.current;
    if (cmd === "get_agent_seats") return { seats: seats.current };
    if (cmd === "model_catalog_snapshot") return { models: args?.backend === "claude-code" ? CLAUDE_MODELS : CODEX_MODELS, checkedAt: 1, source: "harness", warning: null };
    if (cmd === "preflight_status") return { codex: codexProbe.current, hook: {}, skill: {} };
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

  it("keeps Codex disabled when this machine can't run it, with the reason", async () => {
    codexProbe.current = { ...READY, signedIn: false, authState: "signed-out" };
    await mount();
    await open();
    expect(invokeMock).toHaveBeenCalledWith("preflight_status", { backend: "codex", extension: false });
    const { claude, codex } = providers();
    expect(claude.textContent).toBe("Claude");
    expect(claude.getAttribute("aria-checked")).toBe("true");
    expect(codex.textContent).toBe("Codex");
    expect(codex.disabled).toBe(true);
    expect(codex.title).toContain("codex login");
    await act(async () => codex.click());
    expect(sets()).toEqual([]);
  });

  it("names why Codex is unavailable", () => {
    expect(codexBlocker(READY)).toBeNull();
    expect(codexBlocker({ ...READY, found: false, usable: false })).toContain("isn't installed");
    expect(codexBlocker({ ...READY, usable: false, version: "0.24.0" })).toContain("(0.24.0) is too old");
    expect(codexBlocker({ ...READY, signedIn: false, authState: "signed-out" })).toContain("isn't signed in");
    // An unverified sign-in (the probe timed out) never reads as signed out.
    expect(codexBlocker({ ...READY, signedIn: false, authState: "unknown" })).toBeNull();
    expect(codexBlocker(null)).toContain("Couldn't check");
  });

  it("holds Codex until the probe answers, and a failed probe keeps it off", async () => {
    let answer: (value: unknown) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "preflight_status" ? new Promise((resolve, reject) => { answer = resolve; fail = reject; }) : fallback(cmd, args));
    await mount();
    await open();
    expect(providers().codex.disabled).toBe(true);
    expect(providers().codex.title).toBe("Checking Codex…");
    await act(async () => answer({ codex: READY, hook: {}, skill: {} }));
    await flush();
    expect(providers().codex.disabled).toBe(false);
    expect(providers().codex.title).toBe("");

    await act(async () => root.unmount());
    integrationHealth.invalidate();
    root = createRoot(host);
    await mount();
    await open();
    await act(async () => fail(new Error("ipc down")));
    await flush();
    expect(providers().codex.disabled).toBe(true);
    expect(providers().codex.title).toContain("Couldn't check");
  });

  it("picks Codex when it is ready, dropping the Claude model, and says so on the chip", async () => {
    stored.current = { backend: "claude-code", model: "opus", effort: "high" };
    await mount();
    await open();
    expect(providers().codex.disabled).toBe(false);
    await act(async () => providers().codex.click());
    await flush();
    expect(sets()).toEqual([["browse_thread_set_harness", { browseId: "tab-1", backend: "codex", model: null, effort: null }]]);
    expect(trigger().textContent).toContain("Codex · Default");
    expect(JSON.parse(localStorage.getItem(LAST_HARNESS_KEY)!)).toEqual({ backend: "codex", model: null, effort: null });
    // Codex's default is its own configured model, not the browse seat's.
    const reset = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent?.startsWith("Default"))!;
    expect(reset.textContent).toBe("Default (gpt-6-astra)");
    await choose("Chat model", "gpt-5.5");
    expect(sets()[1]).toEqual(["browse_thread_set_harness", { browseId: "tab-1", backend: "codex", model: "gpt-5.5", effort: null }]);
    await choose("Chat effort", "high");
    expect(trigger().textContent).toContain("Codex · GPT-5.5 · high");
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

  it("inherits a Codex pick while this machine can run Codex", async () => {
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "codex", model: "gpt-5.5", effort: null }));
    await mount();
    expect(latest.pick).toEqual({ backend: "codex", model: "gpt-5.5", effort: null });
    expect(trigger().textContent).toContain("Codex · gpt-5.5");
    await act(() => latest.commit());
    expect(sets()).toEqual([["browse_thread_set_harness", { browseId: "tab-1", backend: "codex", model: "gpt-5.5", effort: null }]]);
  });

  it.each([
    ["uninstalled", { ...READY, found: false }],
    ["signed out", { ...READY, signedIn: false, authState: "signed-out" }],
  ])("leaves a Codex pick behind once Codex is %s, so the first send runs", async (_why, probe) => {
    codexProbe.current = probe;
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "codex", model: "gpt-5.5", effort: null }));
    await mount("tab-new");
    expect(latest.pick.backend).toBe("claude-code");
    expect(trigger().textContent).not.toContain("Codex");
    await act(() => latest.commit());
    expect(sets()).toEqual([]);
  });

  it("stores no Codex pick that the probe hasn't cleared yet", async () => {
    let answer: (value: unknown) => void = () => {};
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "preflight_status" ? new Promise(resolve => { answer = resolve; }) : fallback(cmd, args));
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify({ backend: "codex", model: null, effort: null }));
    await mount();
    expect(trigger().textContent, "no Codex on the chip before the probe").not.toContain("Codex");
    let committed = false;
    const send = act(() => latest.commit().then(() => { committed = true; }));
    await flush();
    expect(committed, "the first send waits for the probe").toBe(false);
    await act(async () => answer({ codex: { ...READY, found: false }, hook: {}, skill: {} }));
    await send;
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
