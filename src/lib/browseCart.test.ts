import { beforeEach, expect, it, vi } from "vitest";
import { ensureCart } from "./browseCart";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
it("lazily creates a Cart once when simultaneous adds race", async () => {
  invoke.mockImplementation(async command => command === "browse_list_get" ? null : { list: { browseId: "cart:regular", template: "cart" }, items: [] });
  const [a, b] = await Promise.all([ensureCart("regular"), ensureCart("regular")]);
  expect(a).toBe(b);
  expect(invoke.mock.calls).toEqual([["browse_list_get", { browseId: "cart:regular" }], ["browse_list_start", { browseId: "cart:regular", template: "cart", title: "Cart" }]]);
});
it("keeps existing rows and never starts or reads a legacy page list", async () => {
  const existing = { list: { browseId: "cart:mission-1", template: "cart" }, items: [{ id: "saved" }] };
  invoke.mockResolvedValue(existing);
  expect(await ensureCart("mission-1")).toBe(existing);
  expect(invoke.mock.calls).toEqual([["browse_list_get", { browseId: "cart:mission-1" }]]);
});
