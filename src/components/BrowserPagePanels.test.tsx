// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBookmarksDialog, BrowserLayoutDialog, BrowserPreferencesDialog } from "./BrowserPagePanels";
import { DEFAULT_BROWSER_LAYOUT } from "../lib/browserLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => (item.querySelector(":scope > span:last-child")?.textContent ?? item.textContent) === label)!;

it("presents four visual page counts and preserves a legacy one-page preference", async () => {
  const choose = vi.fn(), save = vi.fn();
  await act(async () => root.render(<BrowserLayoutDialog layout={{ ...DEFAULT_BROWSER_LAYOUT, preset: "discuss" }} available={2} onChoose={choose} onSaveDefault={save} onClose={() => {}}/>));
  expect(button("One page").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelectorAll(".rb-layout-choice")).toHaveLength(4);
  await act(async () => button("Three pages").click());
  expect(choose).toHaveBeenCalledWith("research", 3);
  expect(document.body.textContent).toContain("Chat stays where you left it");
  await act(async () => button("Use as default").click());
  expect(save).toHaveBeenCalledOnce();
  expect(button("Default saved")).toBeDefined();
});

it("offers independent browsing preferences with plain labels", async () => {
  const selections = vi.fn();
  await act(async () => root.render(<BrowserPreferencesDialog selectionActions={true} onSelectionActions={selections} onClose={() => {}}/>));
  const checks = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => checks[0].click());
  expect(selections).toHaveBeenCalledWith(false);
  expect(checks).toHaveLength(1);
});

it("opens a saved page by its durable URL and closes the dialog", async () => {
  const open = vi.fn(), close = vi.fn(), remove = vi.fn();
  await act(async () => root.render(<BrowserBookmarksDialog bookmarks={[{ title: "Source", url: "https://source.test/path" }]} title="Current" url="https://current.test" onSave={() => {}} onRemove={remove} onOpen={open} onClose={close}/>));
  const saved = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith("Sourcehttps://"))!;
  await act(async () => saved.click());
  expect(open).toHaveBeenCalledWith("https://source.test/path"); expect(close).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});
