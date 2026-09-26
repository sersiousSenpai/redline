import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MosaicEditDialog, MosaicManagerDialog } from "./MosaicDialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (label: string) => [...dialog().querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label)!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("keeps addresses through a grid shrink, focuses what is invalid, and saves with ⌘ Enter", async () => {
  const onSave = vi.fn(async () => {});
  let n = 0;
  await act(async () => root.render(<MosaicEditDialog draft={{ id: "mosaic:new", name: "", grid: { rows: 2, cols: 2 }, entries: [{ url: "wsj.com", label: "WSJ" }, { url: "", label: "" }, { url: "", label: "" }, { url: "ft.com", label: "" }] }}
    previous={null} onSave={onSave} onCancel={() => {}} createId={() => `id-${++n}`}/>));
  const name = dialog().querySelector<HTMLInputElement>("input")!;
  expect(document.activeElement).toBe(name);
  await act(async () => button("Fewer rows").click());
  expect(dialog().querySelectorAll('[aria-label$="address (row 1, column 1)"], [aria-label$="address (row 1, column 2)"]')).toHaveLength(2);
  expect(dialog().querySelector('[aria-label^="Page 4 address"]')).toBeNull();
  await act(async () => button("More rows").click());
  expect(dialog().querySelector<HTMLInputElement>('[aria-label^="Page 4 address"]')!.value).toBe("ft.com");

  await act(async () => button("Save mosaic").click());
  expect(onSave).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Give this mosaic a name.");
  expect(document.activeElement).toBe(name);

  await type(name, "Stock News");
  const second = dialog().querySelector<HTMLInputElement>('[aria-label^="Page 2 address"]')!;
  await type(second, "not an address");
  await act(async () => { second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
  expect(onSave).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-invalid")).toBe("true");

  await type(second, "");
  await act(async () => { name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
  expect(onSave).toHaveBeenCalledWith({ id: "mosaic:new", name: "Stock News", grid: { rows: 2, cols: 2 }, cells: [
    { browseId: "id-1", url: "https://wsj.com/", label: "WSJ" }, { browseId: "id-2", url: "https://ft.com/" },
  ] });
});

it("confirms a delete inline and offers the startup choice", async () => {
  const onDelete = vi.fn(), onStartup = vi.fn(), onOpen = vi.fn();
  await act(async () => root.render(<MosaicManagerDialog mosaics={[{ id: "mosaic:a", name: "Stock News", grid: { rows: 3, cols: 3 }, tabCount: 9, updatedAt: Date.now() - 2 * 3_600_000 }]}
    error={null} activeId={null} activeName={null} startupId={null} canSaveCurrent onOpen={onOpen} onEdit={() => {}} onNew={() => {}} onSaveCurrent={() => {}}
    onDelete={onDelete} onStartup={onStartup} onLeave={() => {}} onClose={() => {}}/>));
  expect(dialog().textContent).toContain("3 × 3 · 9 pages · Used 2 h ago");
  await act(async () => button("Delete Stock News").click());
  await act(async () => button("Keep mosaic").click());
  expect(onDelete).not.toHaveBeenCalled();
  await act(async () => button("Delete Stock News").click());
  await act(async () => button("Delete mosaic").click());
  expect(onDelete).toHaveBeenCalledWith("mosaic:a");
  const radios = dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect([...radios].map((radio) => radio.checked)).toEqual([true, false]);
  await act(async () => radios[1].click());
  expect(onStartup).toHaveBeenCalledWith("mosaic:a");
});
