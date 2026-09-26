// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionStartDialog } from "./MissionStartDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, trigger: HTMLButtonElement;
beforeEach(() => {
  host = document.createElement("div"); trigger = document.createElement("button"); trigger.textContent = "New research";
  document.body.append(trigger, host); trigger.focus(); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); trigger.remove(); });
async function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const startButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Start research")!;

describe("new research dialog", () => {
  it("requires a goal and starts with the original optional title and goal values", async () => {
    const start = vi.fn();
    await act(async () => root.render(<MissionStartDialog onStart={start} onCancel={() => {}} />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("New research");
    expect(dialog.textContent).not.toContain("Done");
    const goal = dialog.querySelector("textarea")!;
    expect(document.activeElement).toBe(goal);
    expect(goal.style.maxHeight).toBe("220px");
    expect(goal.style.overflowY).toBe("auto");
    expect(startButton().disabled).toBe(true);
    await fill(goal, "   "); expect(startButton().disabled).toBe(true);
    await fill(dialog.querySelector("input")!, "  Page comparison  ");
    await fill(goal, "Compare these pages.\nKeep the sources.");
    await act(async () => startButton().click());
    expect(start).toHaveBeenCalledWith("  Page comparison  ", "Compare these pages.\nKeep the sources.");
  });

  it.each(["metaKey", "ctrlKey"])("keeps %s+Enter and leaves plain Enter to the goal editor", async (modifier) => {
    const start = vi.fn();
    await act(async () => root.render(<MissionStartDialog onStart={start} onCancel={() => {}} />));
    const goal = document.querySelector("textarea")!;
    await fill(goal, "Research a topic");
    await act(async () => goal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(start).not.toHaveBeenCalled();
    await act(async () => goal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true })));
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("", "Research a topic");
  });

  it("cancels without starting and restores the invoking control", async () => {
    const cancel = vi.fn(), start = vi.fn();
    await act(async () => root.render(<MissionStartDialog onStart={start} onCancel={cancel} />));
    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
    await act(async () => cancelButton.click());
    expect(cancel).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
  });
});
