// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModel } from "../lib/backendChoice";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { useModelCatalogs } from "./useModelCatalogs";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type CatalogHook = ReturnType<typeof useModelCatalogs>;
let current: CatalogHook, root: Root, host: HTMLDivElement;
function Probe() { current = useModelCatalogs(); return null; }
const model = (slug: string): ProviderModel => ({ slug, displayName: slug, description: "", defaultEffort: null, efforts: ["low"] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(async () => { invokeMock.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(createElement(Probe))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("binary-keyed model catalog requests", () => {
  it("does not let an older installation replace the selected binary's models", async () => {
    const a = deferred<ProviderModel[]>(), b = deferred<ProviderModel[]>();
    invokeMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await act(async () => { current.request("codex", "path-a:1"); current.request("codex", "path-b:2"); });
    await act(async () => b.resolve([model("new")]));
    await act(async () => a.resolve([model("stale")]));
    expect(current.catalogs.codex?.map((m) => m.slug)).toEqual(["new"]);
  });
  it("keeps providers separate even when identity strings coincide", async () => {
    const codex = deferred<ProviderModel[]>(), cursor = deferred<ProviderModel[]>();
    invokeMock.mockReturnValueOnce(codex.promise).mockReturnValueOnce(cursor.promise);
    await act(async () => { current.request("codex", "same"); current.request("cursor", "same"); });
    await act(async () => { cursor.resolve([model("cursor-model")]); codex.resolve([model("codex-model")]); });
    expect(current.catalogs.cursor?.[0].slug).toBe("cursor-model");
    expect(current.catalogs.codex?.[0].slug).toBe("codex-model");
    expect(invokeMock).toHaveBeenCalledWith("provider_model_catalog", { backend: "cursor" });
  });
  it("can retry a failed request for the same identity", async () => {
    const failed = deferred<ProviderModel[]>(), retry = deferred<ProviderModel[]>();
    invokeMock.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await act(async () => current.request("codex", "same"));
    await act(async () => failed.reject(new Error("catalog offline")));
    expect(current.errors.codex).toContain("catalog offline");
    await act(async () => current.request("codex", "same"));
    await act(async () => retry.resolve([model("recovered")]));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(current.catalogs.codex?.[0].slug).toBe("recovered");
    expect(current.errors.codex).toBeUndefined();
  });
  it("guards request generation when the selection goes A → B → A", async () => {
    const firstA = deferred<ProviderModel[]>(), b = deferred<ProviderModel[]>(), secondA = deferred<ProviderModel[]>();
    invokeMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    await act(async () => { current.request("codex", "a"); current.request("codex", "b"); current.request("codex", "a"); });
    await act(async () => secondA.resolve([model("fresh-a")]));
    await act(async () => firstA.resolve([model("old-a")]));
    expect(current.catalogs.codex?.[0].slug).toBe("fresh-a");
    await act(async () => b.resolve([model("b")]));
  });
  it("does not let an old A failure clear a newer pending A request", async () => {
    const firstA = deferred<ProviderModel[]>(), b = deferred<ProviderModel[]>(), secondA = deferred<ProviderModel[]>();
    invokeMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    await act(async () => { current.request("codex", "a"); current.request("codex", "b"); current.request("codex", "a"); });
    await act(async () => firstA.reject(new Error("old failure")));
    expect(current.errors.codex).toBeUndefined();
    await act(async () => current.request("codex", "a"));
    expect(invokeMock).toHaveBeenCalledTimes(3);
    await act(async () => { secondA.resolve([model("fresh-a")]); b.resolve([]); });
  });
  it("projects Claude aliases into the shared picker shape", async () => {
    invokeMock.mockResolvedValue([{ id: "opus", label: "Opus 5", alias: true, note: "Latest installed Opus" }]);
    await act(async () => current.request("claude-code", "claude:mtime:length"));
    expect(current.catalogs["claude-code"]?.[0]).toMatchObject({ slug: "opus", displayName: "Opus 5", description: "Latest installed Opus" });
  });
});
