// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModel } from "../lib/backendChoice";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { useModelCatalogs, type ModelCatalogSnapshot } from "./useModelCatalogs";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type CatalogHook = ReturnType<typeof useModelCatalogs>;
let current: CatalogHook, root: Root, host: HTMLDivElement;
function Probe() { current = useModelCatalogs(); return null; }
const model = (slug: string): ProviderModel => ({ slug, displayName: slug, description: "", defaultEffort: null, efforts: ["low"] });
const snapshot = (slug: string, warning: string | null = null): ModelCatalogSnapshot => ({ models: [model(slug)], checkedAt: 123, source: "harness", warning });
function deferred() { let resolve!: (value: ModelCatalogSnapshot) => void, reject!: (error: unknown) => void; const promise = new Promise<ModelCatalogSnapshot>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(async () => { invokeMock.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(createElement(Probe))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("revalidating model catalogs", () => {
  it("does not let an older installation replace the selected binary's models", async () => {
    const a = deferred(), b = deferred();
    invokeMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await act(async () => { current.request("codex", "path-a:1"); current.request("codex", "path-b:2"); });
    await act(async () => b.resolve(snapshot("new")));
    await act(async () => a.resolve(snapshot("stale")));
    expect(current.catalogs.codex?.map(m => m.slug)).toEqual(["new"]);
  });
  it("keeps providers separate even when identity strings coincide", async () => {
    const codex = deferred(), cursor = deferred();
    invokeMock.mockReturnValueOnce(codex.promise).mockReturnValueOnce(cursor.promise);
    await act(async () => { current.request("codex", "same"); current.request("cursor", "same"); });
    await act(async () => { cursor.resolve(snapshot("cursor-model")); codex.resolve(snapshot("codex-model")); });
    expect(current.catalogs.cursor?.[0].slug).toBe("cursor-model");
    expect(current.catalogs.codex?.[0].slug).toBe("codex-model");
    expect(invokeMock).toHaveBeenCalledWith("model_catalog_snapshot", { backend: "cursor", force: false });
  });
  it("retains usable rows while refreshing and after an IPC failure", async () => {
    invokeMock.mockResolvedValueOnce(snapshot("saved"));
    await act(async () => current.request("codex", "same"));
    const refresh = deferred(); invokeMock.mockReturnValueOnce(refresh.promise);
    await act(async () => current.request("codex", "same"));
    expect(current.catalogs.codex?.[0].slug).toBe("saved");
    expect(current.status.codex).toMatchObject({ refreshing: true, checkedAt: 123 });
    await act(async () => refresh.reject(new Error("offline")));
    expect(current.catalogs.codex?.[0].slug).toBe("saved");
    expect(current.errors.codex).toContain("Couldn't refresh");
    expect(current.status.codex?.refreshing).toBe(false);
    invokeMock.mockResolvedValueOnce(snapshot("recovered"));
    await act(async () => current.request("codex", "same", true));
    expect(current.catalogs.codex?.[0].slug).toBe("recovered");
    expect(current.errors.codex).toBeUndefined();
  });
  it("collapses concurrent requests, including manual refresh", async () => {
    const load = deferred(); invokeMock.mockReturnValue(load.promise);
    await act(async () => { current.request("codex", "same"); current.request("codex", "same", true); current.request("codex", "same"); });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => load.resolve(snapshot("new")));
  });
  it("guards request generation when the selection goes A → B → A", async () => {
    const firstA = deferred(), b = deferred(), secondA = deferred();
    invokeMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    await act(async () => { current.request("codex", "a"); current.request("codex", "b"); current.request("codex", "a"); });
    await act(async () => secondA.resolve(snapshot("fresh-a")));
    await act(async () => firstA.resolve(snapshot("old-a")));
    expect(current.catalogs.codex?.[0].slug).toBe("fresh-a");
    await act(async () => b.resolve(snapshot("b")));
  });
  it("does not let an old failure clear a newer pending request", async () => {
    const firstA = deferred(), b = deferred(), secondA = deferred();
    invokeMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    await act(async () => { current.request("codex", "a"); current.request("codex", "b"); current.request("codex", "a"); });
    await act(async () => firstA.reject(new Error("old failure")));
    expect(current.errors.codex).toBeUndefined();
    await act(async () => current.request("codex", "a"));
    expect(invokeMock).toHaveBeenCalledTimes(3);
    await act(async () => { secondA.resolve(snapshot("fresh-a")); b.resolve(snapshot("b")); });
  });
  it("uses the native checked time and stale warning rather than claiming a fresh success", async () => {
    invokeMock.mockResolvedValue(snapshot("saved", "Couldn't refresh. Showing the last checked models."));
    await act(async () => current.request("claude-code", "same", true));
    expect(invokeMock).toHaveBeenCalledWith("model_catalog_snapshot", { backend: "claude-code", force: true });
    expect(current.status["claude-code"]?.checkedAt).toBe(123);
    expect(current.errors["claude-code"]).toContain("last checked");
  });
});
