import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./ProjectPicker", () => ({ ProjectPicker: () => <button>Choose project</button> }));
import { SendToRedlineDialog } from "./SendToRedlineDialog";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("keeps the edited brief reviewable after a save failure and allows retry", async () => {
  const confirm = vi.fn(), cancel = vi.fn();
  await act(async () => root.render(<SendToRedlineDialog markdown="# My edited brief\nKeep this requirement." options={[]} initialProject="/repo" onConfirm={confirm} onCancel={cancel} onMarkdownChange={() => {}} destination="drafter" error="Database is read-only"/>));
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("Keep this requirement.");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Database is read-only");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Save and open brief")!.click());
  expect(confirm).toHaveBeenCalledWith("/repo"); expect(cancel).not.toHaveBeenCalled();
});

it("prevents duplicate confirmation, edits and dismissal while durable preparation is pending", async () => {
  const confirm = vi.fn(), cancel = vi.fn();
  await act(async () => root.render(<SendToRedlineDialog markdown="Edited brief" options={[]} initialProject="/repo" onConfirm={confirm} onCancel={cancel} onMarkdownChange={() => {}} destination="drafter" pending/>));
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Saving and preparing…")!.click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); (host.firstElementChild as HTMLElement).click(); });
  expect(confirm).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it("rejects an oversized multibyte edited brief before sending it to persistence", async () => {
  await act(async () => root.render(<SendToRedlineDialog markdown={"🙂".repeat(65_000)} options={[]} initialProject="/repo" onConfirm={() => {}} onCancel={() => {}}/>));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("256 KB");
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Save and launch plan")?.disabled).toBe(true);
});
