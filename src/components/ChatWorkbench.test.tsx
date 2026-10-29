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
  const onSteer = vi.fn(), onRemove = vi.fn(), onPromote = vi.fn();
  await act(async () => root.render(<QueueTray rows={[{id:"a",text:"First",mode:"chat"},{id:"b",text:"Second",mode:"plan"},{id:"c",text:"Third",mode:"build",assignee:"agent"}]} {...{onSteer,onRemove,onPromote}} />));
  // Collapsed, the pill says how many wait and which goes next.
  const pill = host.querySelector<HTMLButtonElement>(".rl-queue-pill")!;
  expect(pill.textContent).toBe("3 queuedFirst");
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".rl-queue-row")).toBeNull();
  await act(async () => pill.click());
  const steer = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "↪ Steer");
  expect(steer.map(button => button.disabled)).toEqual([false,true,true]);
  await act(async () => steer[0].click()); expect(onSteer).toHaveBeenCalledWith("a");
  // The first row already sends next.
  expect([...host.querySelectorAll(".rl-queue-row")].map(row => [...row.querySelectorAll("button")].some(b => b.textContent === "↑ Next"))).toEqual([false,true,true]);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent === "↑ Next")[0].click()); expect(onPromote).toHaveBeenCalledWith("b");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unqueue First"]')!.click()); expect(onRemove).toHaveBeenCalledWith("a");
});
it("tray offers no steering where the surface has none, and leaves when the queue empties", async () => {
  const onRemove = vi.fn();
  await act(async () => root.render(<QueueTray rows={[{id:"a",text:"Only"}]} onRemove={onRemove} />));
  await act(async () => host.querySelector<HTMLButtonElement>(".rl-queue-pill")!.click());
  expect([...host.querySelectorAll(".rl-queue-row button")].map(b => b.textContent)).toEqual(["×"]);
  await act(async () => root.render(<QueueTray rows={[]} onRemove={onRemove} />));
  expect(host.innerHTML).toBe("");
  // Back with a new queue, it starts collapsed.
  await act(async () => root.render(<QueueTray rows={[{id:"b",text:"Next one"}]} onRemove={onRemove} />));
  expect(host.querySelector(".rl-queue-pill")?.getAttribute("aria-expanded")).toBe("false");
});
it("the mode chip is a composer menu: a popover out of the card, a pick applies and closes, no Done", async () => {
  const onModeChange = vi.fn(), onAssigneeChange = vi.fn(), onHarnessChange = vi.fn();
  await act(async () => root.render(<div className="rl-compact-composer" style={{ overflow: "hidden" }}><ChatModePicker mode="chat" assignee="chat" harness={{backend:"claude-code",model:null,effort:null}} {...{onModeChange,onAssigneeChange,onHarnessChange}} /></div>));
  const chip = host.querySelector<HTMLButtonElement>(".rl-chat-mode-chip")!;
  expect(chip.getAttribute("aria-haspopup")).toBe("menu");
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  await act(async () => chip.click());
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  // Portalled to the body, never inside the card that clipped it.
  const menu = document.body.querySelector<HTMLElement>(':scope > [role="menu"]')!;
  expect(menu).not.toBeNull();
  expect(host.contains(menu)).toBe(false);
  expect(menu.style.position).toBe("fixed");
  const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(rows.map(row => row.querySelector("strong")!.textContent)).toEqual(["Chat", "Plan", "Build · this chat", "Build · new agent"]);
  expect(rows.map(row => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
  expect(rows[0].querySelector(".rl-composer-check")).not.toBeNull();
  expect([...menu.querySelectorAll("button")].some(b => b.textContent === "Done")).toBe(false);
  // The current row takes the focus; the arrows walk the rows.
  expect(document.activeElement).toBe(rows[0]);
  await act(async () => { rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement).toBe(rows[1]);
  // A pick applies and closes, the focus back on the chip.
  await act(async () => rows[3].click());
  expect(onAssigneeChange).toHaveBeenCalledWith("agent");
  expect(onModeChange).toHaveBeenCalledWith("build");
  expect(document.body.querySelector(':scope > [role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(chip);
  // Esc closes it too.
  await act(async () => chip.click());
  expect(document.body.querySelector(':scope > [role="menu"]')).not.toBeNull();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.body.querySelector(':scope > [role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(chip);
});
it("Plan and a new agent's build bring the harness chip into the row, on the provider catalogs", async () => {
  const onModeChange = vi.fn(), onAssigneeChange = vi.fn(), onHarnessChange = vi.fn();
  const catalogs = {codex:[{slug:"test-model",displayName:"Test model",description:"",defaultEffort:"high",efforts:["high"]}]};
  await act(async () => root.render(<ChatModePicker mode="chat" assignee="chat" harness={{backend:"codex",model:"test-model",effort:"high"}} catalogs={catalogs} {...{onModeChange,onAssigneeChange,onHarnessChange}} />));
  expect(host.querySelectorAll(".rl-composer-chip")).toHaveLength(1);
  await act(async () => root.render(<ChatModePicker mode="build" assignee="agent" harness={{backend:"codex",model:"test-model",effort:"high"}} catalogs={catalogs} {...{onModeChange,onAssigneeChange,onHarnessChange}} />));
  const chips = [...host.querySelectorAll<HTMLButtonElement>(".rl-composer-chip")];
  expect(chips[0].textContent).toContain("Build · new agent");
  await act(async () => chips[1].click());
  expect(document.body.textContent).toContain("Test model");
  expect([nextChatMode("chat"),nextChatMode("plan"),nextChatMode("build")]).toEqual(["plan","build","chat"]);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
});
it("changes with only preexisting edits never offer Undo", async () => {
  const base = {messageId:"m",projectPath:"/repo",head:"head",undone:false};
  await act(async () => root.render(<ChangesCard companionId="chat" onUndone={() => {}} changes={{...base,files:[{path:"existing.ts",added:2,removed:1,wasDirty:true,newFile:false}]}} />));
  expect(button("Undo")).toBeUndefined();
  await act(async () => root.render(<ChangesCard companionId="chat" onUndone={() => {}} changes={{...base,files:[{path:"clean.ts",added:2,removed:1,wasDirty:false,newFile:false}]}} />));
  expect(button("Undo")).toBeDefined();
  await act(async () => button("Undo").click()); expect(button("Confirm undo")).toBeDefined();
});
