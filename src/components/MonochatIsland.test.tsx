import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonochatIsland, type IslandPose, type IslandSize, type SummonVia } from "./MonochatIsland";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const nativeInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => nativeInvoke(...args) }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  nativeInvoke.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Harness({ pose = "compose", busy = false, onChange, onNewChat, chips, children }: {
  pose?: IslandPose; busy?: boolean; onChange?: (open: boolean, via?: SummonVia) => void;
  onNewChat?: () => void; chips?: ReactNode; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState("document");
  const [size, setSize] = useState<IslandSize>("regular");
  return <>
    <article><button id="document-focus">Document</button><button id="navigate" onClick={() => setSurface("browser")}>Browser</button>
      {/* ⌘J: the owner flips the card itself, never through the island. */}
      <button id="owner-toggle" onClick={() => setOpen(value => !value)}>Toggle</button>
      {/* A recent: the owner closes the card and goes there in one batch. */}
      <button id="open-recent" onClick={() => { setOpen(false); setSurface("plan"); }}>Recent</button></article>
    <MonochatIsland surfaceKey={surface} open={open} onOpenChange={(next, via) => { onChange?.(next, via); setOpen(next); }}
      pose={pose} size={size} onSizeChange={setSize} onNewChat={onNewChat} context="Auth rewrite" busy={busy} chips={chips}>
      {children ?? <textarea aria-label="Main reply" defaultValue=""/>}
    </MonochatIsland>
  </>;
}
const render = (node: ReactNode = <Harness/>) => act(async () => root.render(node));
const card = () => host.querySelector<HTMLElement>(".rl-monochat-card")!;
const isOpen = () => !card().hidden;
const pill = () => host.querySelector<HTMLButtonElement>(".rl-monochat-notch")!;
const draft = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const pointer = (node: Element, type: string, relatedTarget: EventTarget | null = null) =>
  act(async () => { node.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget })); });
const key = (target: EventTarget, init: KeyboardEventInit) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const hoverOpen = async () => { await pointer(pill(), "pointerover"); await advance(120); };
const leave = () => pointer(card(), "pointerout", document.body);
const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());

describe("the hover peek", () => {
  it("opens after a deliberate hover without stealing focus or making the page inert", async () => {
    await render();
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await pointer(pill(), "pointerover"); await advance(119);
    expect(isOpen()).toBe(false);
    await advance(1);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(page);
    expect(host.querySelector("article")!.hasAttribute("inert")).toBe(false);
    expect(card().getAttribute("role")).toBe("region");
    expect(card().hasAttribute("aria-modal")).toBe(false);
    // Not modal, but a file dropped on its chrome must not fall through to
    // the terminal under it (lib/nativeFileDrop).
    expect(card().hasAttribute("data-drop-cover")).toBe(true);
    await leave(); await advance(399);
    expect(isOpen()).toBe(true);
    await advance(1);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(page);
  });

  it("never opens for a pointer passing through, or for keyboard focus on the pill", async () => {
    await render();
    await pointer(pill(), "pointerover"); await advance(60);
    await pointer(pill(), "pointerout", document.body); await advance(500);
    expect(isOpen()).toBe(false);
    await act(async () => pill().focus());
    await advance(500);
    expect(isOpen()).toBe(false);
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("re-entering the card cancels the leave", async () => {
    await render(); await hoverOpen();
    await leave(); await advance(300);
    await pointer(card(), "pointerover"); await advance(500);
    expect(isOpen()).toBe(true);
  });

  it("stays open while it holds a draft, while busy, or under a menu", async () => {
    await render(); await hoverOpen();
    draft().value = "Keep this draft";
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
    draft().value = "";
    await render(<Harness busy/>);
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
    await render(<Harness/>);
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    try {
      await leave(); await advance(800);
      expect(isOpen()).toBe(true);
    } finally { menu.remove(); }
    await leave(); await advance(400);
    expect(isOpen()).toBe(false);
  });

  it("the chat pose never collapses on pointer leave", async () => {
    await render(<Harness pose="chat"/>); await hoverOpen();
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
  });
});

describe("an engaged card stays until it is closed on purpose", () => {
  it("opened by the pill, it survives blur and the pointer leaving; ⌄ closes it", async () => {
    await render();
    await click(".rl-monochat-notch");
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(draft());
    await act(async () => draft().blur());
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
    await click('[aria-label="Collapse Redline"]');
    expect(isOpen()).toBe(false);
  });

  it("a hover peek pressed inside becomes engaged; Esc closes it", async () => {
    await render(); await hoverOpen();
    await pointer(draft(), "pointerdown");
    await act(async () => { draft().focus(); draft().blur(); });
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
    await key(document.body, { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("a press inside a peek engages it even when nothing takes focus", async () => {
    // WebKit never focuses a clicked button, so pressing a chip is a
    // pointer-down and nothing else.
    const chips = <div className="rl-context-chips"><button id="chip" aria-pressed="true">This page</button></div>;
    await render(<Harness chips={chips}/>); await hoverOpen();
    await pointer(host.querySelector("#chip")!, "pointerdown");
    expect(card().contains(document.activeElement)).toBe(false);
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
  });

  it("opened by the owner (⌘J) mid-hover, it is engaged, not a peek", async () => {
    const onChange = vi.fn();
    await render(<Harness onChange={onChange}/>);
    await pointer(pill(), "pointerover"); await advance(60);
    await click("#owner-toggle");
    expect(isOpen()).toBe(true);
    // The hover that was about to open it is moot, and must not re-label it.
    await advance(200);
    expect(onChange).not.toHaveBeenCalled();
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
  });

  it("a pointer-down outside does not collapse an engaged card or the chat pose", async () => {
    await render();
    await click(".rl-monochat-notch");
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!;
    await pointer(page, "pointerdown"); await act(async () => { page.click(); page.focus(); });
    await pointer(page, "pointerout", document.body); await advance(800);
    expect(isOpen()).toBe(true);
    await render(<Harness pose="chat"/>);
    await pointer(document.body, "pointerdown"); await advance(800);
    expect(isOpen()).toBe(true);
  });
});

describe("keys", () => {
  it.each(["input", "textarea", "contenteditable"])("Shift+Enter summons from a workspace %s before its own key handler", async (kind) => {
    await render();
    const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
    editor.setAttribute("tabindex", "0");
    if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
    if (kind === "textarea") editor.className = "xterm-helper-textarea";
    document.body.append(editor);
    const localKey = vi.fn(); editor.addEventListener("keydown", localKey);
    try {
      editor.focus();
      const chord = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => editor.dispatchEvent(chord));
      expect(isOpen()).toBe(true);
      expect(chord.defaultPrevented).toBe(true);
      expect(localKey).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(draft());
      // Inside the card the chord is a newline.
      const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => draft().dispatchEvent(newline));
      expect(newline.defaultPrevented).toBe(false);
      expect(isOpen()).toBe(true);
      await key(draft(), { key: "Escape" });
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(editor);
    } finally { editor.remove(); }
  });

  it("Shift+Enter from outside an open card toggles it shut", async () => {
    await render();
    await click(".rl-monochat-notch");
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await key(page, { key: "Enter", shiftKey: true });
    expect(isOpen()).toBe(false);
  });

  it("Shift+Enter over a hover peek takes you into it rather than shutting it", async () => {
    const onChange = vi.fn();
    await render(<Harness onChange={onChange}/>);
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await hoverOpen();
    expect(document.activeElement).toBe(page);
    await key(page, { key: "Enter", shiftKey: true });
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(draft());
    expect(onChange).toHaveBeenLastCalledWith(true, "key");
    // Engaged now: leaving no longer closes it, and the chord does.
    await act(async () => page.focus());
    await leave(); await advance(800);
    expect(isOpen()).toBe(true);
    await key(page, { key: "Enter", shiftKey: true });
    expect(isOpen()).toBe(false);
  });

  it("does not summon during text composition or on key repeat", async () => {
    await render();
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      await key(window, { key: "Enter", shiftKey: true, ...extra });
      expect(isOpen()).toBe(false);
    }
  });

  it("leaves Esc to an editor outside the card, and to a menu over it", async () => {
    await render();
    await click(".rl-monochat-notch");
    const editor = document.createElement("textarea"); document.body.append(editor);
    try {
      await key(editor, { key: "Escape" });
      expect(isOpen()).toBe(true);
    } finally { editor.remove(); }
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    try {
      await key(draft(), { key: "Escape" });
      expect(isOpen()).toBe(true);
    } finally { menu.remove(); }
    await key(draft(), { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("a summon message opens without toggling an already open card", async () => {
    await render();
    await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(draft());
    await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
    expect(isOpen()).toBe(true);
  });

  it("tells the owner how it was summoned", async () => {
    const onChange = vi.fn();
    await render(<Harness onChange={onChange}/>);
    await hoverOpen();
    expect(onChange).toHaveBeenLastCalledWith(true, "hover");
    await click('[aria-label="Collapse Redline"]');
    await click(".rl-monochat-notch");
    expect(onChange).toHaveBeenLastCalledWith(true, "click");
    await key(draft(), { key: "Escape" });
    await key(window, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(true, "key");
  });
});

describe("the card", () => {
  it("closes in one Escape, restores focus and keeps the same draft node mounted", async () => {
    await render();
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    const node = draft();
    await click(".rl-monochat-notch");
    node.value = "Keep this draft";
    await key(node, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(page);
    expect(draft()).toBe(node);
    expect(node.value).toBe("Keep this draft");
    expect(card().hasAttribute("inert")).toBe(true);
  });

  it("keeps an App-owned portal mounted while closed, so a live chat keeps its node", async () => {
    function SavedChat() {
      const [open, setOpen] = useState(false);
      const [slot, setSlot] = useState<HTMLDivElement | null>(null);
      return <><button id="saved-chat-source">History source</button>
        <MonochatIsland open={open} onOpenChange={setOpen} pose="chat" context="Pricing" busy={false}><div ref={setSlot}/></MonochatIsland>
        {slot && createPortal(<div data-chat-composer><textarea aria-label="Saved reply"/></div>, slot)}
      </>;
    }
    await render(<SavedChat/>);
    const reply = draft();
    host.querySelector<HTMLButtonElement>("#saved-chat-source")!.focus();
    await click(".rl-monochat-notch");
    expect(document.activeElement).toBe(reply);
    await key(reply, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement?.id).toBe("saved-chat-source");
    expect(draft()).toBe(reply);
    expect(card().contains(reply)).toBe(true);
  });

  it("closes on surface navigation without losing the draft or stealing new focus", async () => {
    await render();
    const node = draft();
    await click(".rl-monochat-notch");
    await act(async () => { const nav = host.querySelector<HTMLButtonElement>("#navigate")!; nav.focus(); nav.click(); });
    expect(isOpen()).toBe(false);
    expect(document.activeElement?.id).toBe("navigate");
    expect(draft()).toBe(node);
  });

  it("navigation with the caret inside lets go of it rather than parking it on the pill", async () => {
    await render();
    await click(".rl-monochat-notch");
    expect(document.activeElement).toBe(draft());
    // A recent in the card navigates without moving focus out of it first.
    await act(async () => host.querySelector<HTMLButtonElement>("#navigate")!.click());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("an owner that closes the card and navigates in one go is navigation too", async () => {
    await render();
    await click(".rl-monochat-notch");
    expect(document.activeElement).toBe(draft());
    // The recents swallow mousedown, so the caret is still in the composer.
    await click("#open-recent");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("names where it is and carries the surface's chips in both poses", async () => {
    const chips = <div className="rl-context-chips"><button aria-pressed="true">This plan · v3</button></div>;
    await render(<Harness chips={chips}/>);
    await click(".rl-monochat-notch");
    expect(host.querySelector(".rl-monochat-heading")?.textContent).toContain("Redline · Auth rewrite");
    expect(card().querySelector(".rl-context-chips")).not.toBeNull();
    await render(<Harness pose="chat" chips={chips}/>);
    expect(card().querySelector(".rl-context-chips")).not.toBeNull();
  });

  it("New and ⤢ exist only in the chat pose: New hands back, ⤢ toggles the size", async () => {
    const onNewChat = vi.fn();
    await render(<Harness onNewChat={onNewChat}/>);
    await click(".rl-monochat-notch");
    expect(host.querySelector(".rl-monochat-new")).toBeNull();
    expect(host.querySelector('[aria-label="Enlarge the card"]')).toBeNull();
    await render(<Harness pose="chat" onNewChat={onNewChat}/>);
    expect(card().dataset.pose).toBe("chat");
    expect(card().dataset.size).toBe("regular");
    await click(".rl-monochat-new");
    expect(onNewChat).toHaveBeenCalledOnce();
    await click('[aria-label="Enlarge the card"]');
    expect(card().dataset.size).toBe("tall");
    expect(host.querySelector('[aria-label="Shrink the card"]')?.getAttribute("aria-pressed")).toBe("true");
    await click('[aria-label="Shrink the card"]');
    expect(card().dataset.size).toBe("regular");
  });
});

describe("the pill", () => {
  it("keeps a stable hit target while attracting the membrane, without native overlay work", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    await render();
    await advance(20);
    nativeInvoke.mockClear();
    const skin = host.querySelector<HTMLElement>(".rl-portal-membrane")!;
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 8, clientY: 12 })); vi.advanceTimersByTime(20); });
    expect(Number(skin.style.getPropertyValue("--portal-pull"))).toBeGreaterThan(.5);
    expect(pill().style.transform).toBe("");
    expect(isOpen()).toBe(false);
    expect(nativeInvoke).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event("blur")); vi.advanceTimersByTime(20); });
    expect(skin.style.getPropertyValue("--portal-pull")).toBe("0.000");
  });

  it("says when Redline is working", async () => {
    await render(<Harness busy/>);
    expect(pill().getAttribute("aria-label")).toBe("Open Redline, working");
    expect(pill().textContent).toContain("Working");
  });

  it("respects reduced motion and still opens by click", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    await render();
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 8, clientY: 12 })); vi.advanceTimersByTime(20); });
    expect(host.querySelector<HTMLElement>(".rl-portal-membrane")!.style.length).toBe(0);
    await click(".rl-monochat-notch");
    expect(isOpen()).toBe(true);
  });
});
