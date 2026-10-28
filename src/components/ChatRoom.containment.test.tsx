// SPDX-License-Identifier: Apache-2.0
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn } = vi.hoisted(() => ({ turn: { messages: [] as { id: string; role: string; body: string; status: string }[], queue: [], liveText: "A long reply. ".repeat(500), status: "streaming", startedAt: 1_000, loaded: true,
  send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), meter: null, activity: [], meters: {} } }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingText", () => ({ StreamingText: ({ text }: { text: string }) => <div>{text}</div> }));
import { ChatRoom } from "./ChatRoom";
import { FrontDoor, type FrontDoorProps } from "./FrontDoor";
import { MonochatIsland } from "./MonochatIsland";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import { writeSharedDraft } from "../hooks/useSharedDraft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  turn.status = "streaming"; turn.messages = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<ChatRoom companionId="carried-chat" onSelectChat={() => {}} onEmpty={() => {}} cwd={null} onClose={() => {}} />));
}

describe("Home chat containment", () => {
  it("labels usage under More and does not navigate history when it opens", async () => {
    const onSelectChat = vi.fn();
    await act(async () => root.render(<ChatRoom companionId="saved-chat" cwd={null}
      onSelectChat={onSelectChat} onEmpty={() => {}} onClose={() => {}}
      composer={{ draftKey: "test.emptyDraft", render: actions => <div data-chat-composer>{actions}</div> }}/>));
    // The card's heading New is the one way back to compose.
    expect([...host.querySelectorAll("[data-chat-composer] button")].some(button => /New chat/.test(button.textContent ?? ""))).toBe(false);
    expect(host.querySelector(".rl-monochat-trace-toggle")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')!.click());
    const usage = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.includes("Activity & usage"))!;
    await act(async () => usage.click());
    expect(host.querySelector('[role="dialog"][aria-label="Activity and usage"]')).not.toBeNull();
    expect(host.textContent).toContain("operations in this conversation");
    expect(onSelectChat).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close activity"]')!.click());
    expect(host.querySelector('[role="dialog"][aria-label="Activity and usage"]')).toBeNull();
  });

  it("keeps the scrolling reply separate from the fixed composer, with no strip between them", async () => {
    await render();
    const room = host.querySelector<HTMLElement>("[data-chat-room]")!;
    const messages = host.querySelector<HTMLElement>("[data-chat-messages]")!;
    const composer = host.querySelector<HTMLElement>("[data-chat-composer]")!;
    expect(room.classList.contains("overflow-hidden")).toBe(true);
    expect(room.classList.contains("min-w-0")).toBe(true);
    expect(messages.style.overflowY).toBe("auto");
    expect(messages.style.minHeight).toBe("0");
    expect(messages.style.flexBasis).toBe("0%");
    expect(composer.classList.contains("shrink-0")).toBe(true);
    expect(composer.parentElement).toBe(room);
    // The turn's status is the reply's own tail, inside the scroller: nothing
    // between the thread and the composer takes height from the thread.
    expect(host.querySelector("[data-chat-progress]")).toBeNull();
    expect(messages.querySelector("[data-reply] [role=status]")).not.toBeNull();
    expect(composer.previousElementSibling).toBe(messages);
    expect(messages.querySelector("textarea")).toBeNull();
    expect(composer.querySelector("textarea")?.style.maxHeight).toBe("160px");
  });

  it("keeps the sticky Plan mode and holds a tray handoff until idle", async () => {
    turn.messages = [{ id: "reply", role: "assistant", body: "A complete reply", status: "complete" }];
    const onPlan = vi.fn();
    const renderPlanning = () => root.render(<ChatRoom companionId="carried-chat" onSelectChat={() => {}} onEmpty={() => {}} cwd={null} onClose={() => {}} onPlan={onPlan} />);
    await act(async () => renderPlanning());
    await act(async () => host.querySelector<HTMLButtonElement>(".rl-chat-mode-chip")!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".rl-chat-mode-menu button")].find(button => button.textContent === "Plan")!.click());
    expect(host.querySelector(".rl-chat-mode-chip")?.textContent).toContain("Plan");
    // With the box empty the one button is Stop; an instruction makes it
    // queue the plan behind the reply.
    const send = () => host.querySelector<HTMLButtonElement>("[data-chat-composer] .rl-send")!;
    expect(send().dataset.send).toBe("stop");
    await act(async () => writeSharedDraft("rl.chatDraft.carried-chat", "Keep it small"));
    expect(send().dataset.send).toBe("queue");
    await act(async () => send().click());
    expect(host.querySelector(".rl-chat-mode-chip")?.textContent).toContain("Plan");
    expect(host.querySelector('[aria-label="Queued messages"]')?.textContent).toContain("Keep it small");
    expect(onPlan).not.toHaveBeenCalled();
    turn.status = "idle";
    await act(async () => renderPlanning());
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan.mock.calls[0][0]).toMatchObject({ companionId: "carried-chat", instruction: "Keep it small" });
  });

  it("uses only the floating launch input, migrates the old chat draft, and preserves it across surfaces", async () => {
    turn.status = "idle";
    // A chat this file has never opened: the old draft is only on disk, as it
    // is on the first launch after an upgrade.
    localStorage.setItem("rl.chatDraft.upgraded-chat", JSON.stringify("Previous chat draft"));
    writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Original launch draft");
    const base: FrontDoorProps = {
      floating: true, visible: true, choice: null, onChoiceChange() {}, projectOptions: [], openFolder: null, lastLaunchProject: null, onResolvedProjectChange() {},
      attachments: [], onAttachmentsChange() {}, readiness: [], onFix: async () => true, pending: null, onLaunch() {}, refusal: null,
      onDrafter() {}, onChat() {}, chatEnabled: true, destination: "chat", onDestinationChange() {},
      backend: { backend: "codex", model: null, effort: null }, onBackendChange() {}, modelCatalogs: {}, onNeedModels() {},
      onCancelPending() {}, onRevealPending() {}, onCreateProject: async () => null, focusNonce: 0, consumeSeed: () => "",
    };
    function Workspace({ surface }: { surface: string }) {
      const [open, setOpen] = useState(true);
      return <><article>{surface}</article><MonochatIsland open={open} onOpenChange={setOpen} onNewChat={() => {}} context={surface}>
        <ChatRoom companionId="upgraded-chat" cwd={null} onSelectChat={() => {}} onEmpty={() => {}} onClose={() => {}}
          composer={{ draftKey: FRONT_DOOR_TEXT_KEY, render: accessories => <FrontDoor {...base} accessories={accessories}/> }}/>
      </MonochatIsland></>;
    }
    await act(async () => root.render(<Workspace surface="Document"/>));
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    // One way back to compose: the room's heading New, not a second composer chip.
    expect(host.querySelectorAll(".rl-monochat-new")).toHaveLength(1);
    expect([...host.querySelectorAll("button")].filter(button => /New chat/.test(button.textContent ?? ""))).toEqual([]);
    const input = host.querySelector("textarea")!;
    expect(input.value).toBe("Original launch draft\n\nPrevious chat draft");
    // Both drafts reach the disk on the debounce, or at the latest on pagehide.
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem("rl.chatDraft.upgraded-chat")).toBe('""');
    expect(localStorage.getItem(FRONT_DOOR_TEXT_KEY)).toBe(JSON.stringify("Original launch draft\n\nPrevious chat draft"));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Return to workspace"]')!.click());
    expect(host.querySelector<HTMLElement>(".rl-monochat")!.dataset.pose).toBe("notch");
    await act(async () => root.render(<Workspace surface="Browser"/>));
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toContain("Previous chat draft");
    expect(host.querySelector('[data-chat-room] textarea')).toBe(input);
    expect(host.querySelector("article textarea")).toBeNull();
  });
});
