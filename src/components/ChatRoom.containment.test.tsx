// SPDX-License-Identifier: Apache-2.0
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn } = vi.hoisted(() => ({ turn: { messages: [] as { id: string; role: string; body: string; status: string }[], liveText: "A long reply. ".repeat(500), status: "streaming", startedAt: 1_000, loaded: true,
  send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), meter: null, activity: [], meters: {} } }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingBubble", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
import { ChatRoom } from "./ChatRoom";
import { FrontDoor, type FrontDoorProps } from "./FrontDoor";
import { MonochatIsland } from "./MonochatIsland";

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
  await act(async () => root.render(<ChatRoom companionId="carried-chat" onSelectChat={() => {}} onEmpty={() => {}} cwd={null} dictationEnabled={false} onClose={() => {}} />));
}

describe("Home chat containment", () => {
  it("offers a direct New chat action without deleting history or starting another conversation", async () => {
    const onEmpty = vi.fn(), onSelectChat = vi.fn();
    await act(async () => root.render(<ChatRoom companionId="saved-chat" cwd={null}
      onSelectChat={onSelectChat} onEmpty={onEmpty} dictationEnabled={false} onClose={() => {}}
      composer={{ text: "Unsent draft", onTextChange: () => {}, render: actions => <div data-chat-composer>{actions}</div> }}/>));
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-chat-composer] button")).find(button => button.textContent === "New chat");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(onSelectChat).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("labels usage under More and does not navigate history when it opens", async () => {
    const onSelectChat = vi.fn();
    await act(async () => root.render(<ChatRoom companionId="saved-chat" cwd={null}
      onSelectChat={onSelectChat} onEmpty={() => {}} dictationEnabled={false} onClose={() => {}}
      composer={{ text: "", onTextChange: () => {}, render: actions => <div data-chat-composer>{actions}</div> }}/>));
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

  it("keeps the scrolling reply separate from the fixed composer and progress", async () => {
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
    expect(host.querySelector("[data-chat-progress]")?.parentElement).toBe(room);
    expect(messages.querySelector("textarea")).toBeNull();
    expect(composer.querySelector("textarea")?.style.maxHeight).toBe("160px");
  });

  it("resets Plan mode after sending and holds a streaming handoff until idle", async () => {
    turn.messages = [{ id: "reply", role: "assistant", body: "A complete reply", status: "complete" }];
    const onPlan = vi.fn();
    const renderPlanning = () => root.render(<ChatRoom companionId="carried-chat" onSelectChat={() => {}} onEmpty={() => {}} cwd={null} dictationEnabled={false} onClose={() => {}} onPlan={onPlan} />);
    await act(async () => renderPlanning());
    await act(async () => (host.querySelector('[aria-label="Composer mode"] button:last-child') as HTMLButtonElement).click());
    expect(host.querySelector('[aria-label="Composer mode"] button:last-child')?.getAttribute("aria-pressed")).toBe("true");
    const send = [...host.querySelectorAll<HTMLButtonElement>("[data-chat-composer] button")].slice(-1)[0]!;
    await act(async () => send.click());
    expect(host.querySelector('[aria-label="Composer mode"] button:first-child')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Will plan when this reply lands");
    expect(onPlan).not.toHaveBeenCalled();
    turn.status = "idle";
    await act(async () => renderPlanning());
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan.mock.calls[0][0]).toMatchObject({ companionId: "carried-chat", instruction: "" });
  });

  it("uses only the floating launch input, migrates the old chat draft, and preserves it across surfaces", async () => {
    turn.status = "idle";
    localStorage.setItem("rl.chatDraft.carried-chat", JSON.stringify("Previous chat draft"));
    const base: Omit<FrontDoorProps, "text" | "onTextChange"> = {
      floating: true, visible: true, choice: null, onChoiceChange() {}, projectOptions: [], resolvedProject: null,
      attachments: [], onAttachmentsChange() {}, readiness: [], onFix: async () => true, pending: null, onLaunch() {}, refusal: null,
      onDrafter() {}, onChat() {}, chatEnabled: true, destination: "chat", onDestinationChange() {},
      backend: { backend: "codex", model: null, effort: null }, onBackendChange() {}, modelCatalogs: {}, onNeedModels() {},
      onCancelPending() {}, onRevealPending() {}, onHowItWorks() {}, onCreateProject: async () => null, focusNonce: 0, consumeSeed: () => "", dictationEnabled: false,
    };
    function Workspace({ surface }: { surface: string }) {
      const [text, setText] = useState("Original launch draft"), [open, setOpen] = useState(true);
      return <><article>{surface}</article><MonochatIsland open={open} onOpenChange={setOpen} context={surface} busy={false}>
        <ChatRoom companionId="carried-chat" cwd={null} onSelectChat={() => {}} onEmpty={() => {}} dictationEnabled={false} onClose={() => {}}
          composer={{ text, onTextChange: setText, render: accessories => <FrontDoor {...base} accessories={accessories} text={text} onTextChange={setText}/> }}/>
      </MonochatIsland></>;
    }
    await act(async () => root.render(<Workspace surface="Document"/>));
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    const input = host.querySelector("textarea")!;
    expect(input.value).toBe("Original launch draft\n\nPrevious chat draft");
    expect(localStorage.getItem("rl.chatDraft.carried-chat")).toBe('""');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Return to workspace"]')!.click());
    await act(async () => root.render(<Workspace surface="Browser"/>));
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toContain("Previous chat draft");
    expect(host.querySelector('[data-chat-room] textarea')).toBe(input);
    expect(host.querySelector("article textarea")).toBeNull();
  });
});
