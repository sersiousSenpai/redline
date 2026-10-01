// SPDX-License-Identifier: Apache-2.0
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Companion } from "../types";
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
import { useFrontDoorConversation } from "./useFrontDoorConversation";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const old = { companionId: "old-chat", title: "An unrelated earlier conversation" } as Companion;
function Harness() {
  const { chatId, setChatId, chats, refreshChats } = useFrontDoorConversation();
  const [open, setOpen] = useState(false);
  return <><button id="door" onClick={() => setOpen(value => !value)}>Front door</button><button id="refresh" onClick={refreshChats}>Refresh history</button>
    <div hidden={!open} data-selected={chatId ?? "composer"}>{chatId ? "Selected conversation" : <textarea placeholder="What are we working on?"/>}</div>
    {chats.map(chat => <button key={chat.companionId} data-history onClick={() => setChatId(chat.companionId)}>{chat.title}</button>)}
    <button id="clear" onClick={() => setChatId(null)}>Return to composer</button></>;
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem("redline.chat.id", JSON.stringify(old.companionId));
  invoke.mockResolvedValue([old]); listen.mockResolvedValue(() => {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });
const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
const selected = () => host.querySelector<HTMLElement>("[data-selected]")!.dataset.selected;
it("ignores the legacy saved chat and newest history when opening the front door", async () => {
  await act(async () => root.render(<Harness/>));
  await click("#door");
  expect(selected()).toBe("composer");
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector("[data-history]")?.textContent).toBe(old.title);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(["companion_list"]);
});
it("opens history only on selection, retains that exchange across tuck/reopen, and does not reselect after clearing", async () => {
  await act(async () => root.render(<Harness/>));
  await click("#door"); await click("[data-history]");
  expect(selected()).toBe(old.companionId);
  await click("#door"); await click("#door");
  expect(selected()).toBe(old.companionId);
  await click("#clear"); await click("#refresh");
  expect(selected()).toBe("composer");
});
it("a late history response never chooses a chat", async () => {
  let resolve!: (rows: Companion[]) => void;
  invoke.mockReturnValueOnce(new Promise<Companion[]>(done => { resolve = done; }));
  await act(async () => root.render(<Harness/>));
  await click("#door");
  await act(async () => resolve([old]));
  expect(selected()).toBe("composer");
});
it("a new app mount starts at the composer even after a previous explicit selection", async () => {
  await act(async () => root.render(<Harness/>));
  await click("[data-history]");
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness/>));
  await click("#door");
  expect(selected()).toBe("composer");
});
