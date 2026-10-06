// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueueTray } from "./QueueTray";
import { ChatModePicker, nextChatMode } from "./ChatModePicker";
import { ChangesCard } from "./ChangesCard";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
it("tray actions deliver stable message identities and disable steering for plan/new-agent rows", async () => {
  const onSteer = vi.fn(), onDelete = vi.fn(), onEdit = vi.fn(), onPromote = vi.fn();
  await act(async () => root.render(<QueueTray rows={[{id:"a",text:"First",mode:"chat"},{id:"b",text:"Second",mode:"plan"},{id:"c",text:"Third",mode:"build",assignee:"agent"}]} {...{onSteer,onDelete,onEdit,onPromote}} />));
  const steer = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "↪ Steer");
  expect(steer.map(button => button.disabled)).toEqual([false,true,true]);
  await act(async () => steer[0].click()); expect(onSteer).toHaveBeenCalledWith("a");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More actions for First"]')!.click());
  await act(async () => button("Edit").click()); expect(onEdit).toHaveBeenCalledWith("a");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More actions for First"]')!.click());
  await act(async () => button("Send next").click()); expect(onPromote).toHaveBeenCalledWith("a");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete First"]')!.click()); expect(onDelete).toHaveBeenCalledWith("a");
});
it("mode picker exposes Build assignee and reuses provider model catalogs", async () => {
  const onModeChange = vi.fn(), onAssigneeChange = vi.fn(), onHarnessChange = vi.fn();
  await act(async () => root.render(<ChatModePicker mode="build" assignee="agent" harness={{backend:"codex",model:"test-model",effort:"high"}} catalogs={{codex:[{slug:"test-model",displayName:"Test model",description:"",defaultEffort:"high",efforts:["high"]}]}} {...{onModeChange,onAssigneeChange,onHarnessChange}} />));
  await act(async () => host.querySelector<HTMLButtonElement>(".rl-chat-mode-chip")!.click());
  expect(host.textContent).toContain("Test model");
  await act(async () => button("This chat").click()); expect(onAssigneeChange).toHaveBeenCalledWith("chat");
  expect([nextChatMode("chat"),nextChatMode("plan"),nextChatMode("build")]).toEqual(["plan","build","chat"]);
});
it("changes with only preexisting edits never offer Undo", async () => {
  const base = {messageId:"m",projectPath:"/repo",head:"head",undone:false};
  await act(async () => root.render(<ChangesCard companionId="chat" onUndone={() => {}} changes={{...base,files:[{path:"existing.ts",added:2,removed:1,wasDirty:true,newFile:false}]}} />));
  expect(button("Undo")).toBeUndefined();
  await act(async () => root.render(<ChangesCard companionId="chat" onUndone={() => {}} changes={{...base,files:[{path:"clean.ts",added:2,removed:1,wasDirty:false,newFile:false}]}} />));
  expect(button("Undo")).toBeDefined();
  await act(async () => button("Undo").click()); expect(button("Confirm undo")).toBeDefined();
});
