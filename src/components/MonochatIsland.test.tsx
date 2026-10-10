import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonochatIsland, landingFit } from "./MonochatIsland";
// The compact card is a lazy chunk; loaded up front, it resolves in a tick.
import "./MonochatCard";
import { writeSharedDraft } from "../hooks/useSharedDraft";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const nativeInvoke = vi.fn();
const windowDrag = vi.fn(), windowMaximize = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => nativeInvoke(...args) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: windowDrag, toggleMaximize: windowMaximize }) }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  nativeInvoke.mockClear();
  windowDrag.mockClear(); windowMaximize.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  writeSharedDraft(FRONT_DOOR_TEXT_KEY, "");
});

function Harness({ landing = false, busy = false, onOpen, onNewChat, children }: {
  landing?: boolean; busy?: boolean; onOpen?: (open: boolean) => void; onNewChat?: () => void; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [surface, setSurface] = useState("document");
  return <>
    <article><button id="document-focus">Document</button><button id="navigate" onClick={() => setSurface("browser")}>Browser</button>
      {/* A recent: the owner closes the door and goes there in one batch. */}
      <button id="open-recent" onClick={() => { setOpen(false); setSurface("plan"); }}>Recent</button></article>
    <MonochatIsland landing={landing} surfaceKey={surface} open={open} onOpenChange={(next) => { onOpen?.(next); setOpen(next); }}
      compactOpen={compact} onCompactChange={setCompact} compact={<div className="rl-fd-island"><textarea aria-label="Compact reply" defaultValue=""/></div>}
      context="Plan" busy={busy} onNewChat={onNewChat}>
      {children ?? <div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue="Keep this draft"/></div>}
    </MonochatIsland>
  </>;
}
const render = (node: ReactNode = <Harness/>) => act(async () => root.render(node));
const pose = () => host.querySelector<HTMLElement>(".rl-monochat")?.dataset.pose;
const pill = () => host.querySelector<HTMLButtonElement>(".rl-monochat-notch")!;
const card = () => host.querySelector<HTMLElement>(".rl-monochat-float");
const main = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Main reply"]')!;
const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const pointer = (node: Element, type: string, init: MouseEventInit = {}) =>
  act(async () => { node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });
const key = async (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event;
};
// A pointer resting on the pill for the dwell, then the card's chunk.
const rest = async () => { await pointer(pill(), "pointerover"); await advance(150); await act(async () => { await Promise.resolve(); }); };

describe("the door", () => {
  it("moves the native window from every outer edge without dismissing the front door", async () => {
    await render();
    expect(host.querySelector('[data-window-drag-edge]')).toBeNull();
    await click('[aria-label="Open front door"]');
    for (const edge of ["top", "left", "right", "bottom"]) {
      const handle = host.querySelector<HTMLElement>(`[data-window-drag-edge="${edge}"]`)!;
      await act(async () => {
        handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        handle.click();
      });
      expect(pose()).toBe("conversation");
    }
    expect(windowDrag).toHaveBeenCalledTimes(4);
    const top = host.querySelector<HTMLElement>('[data-window-drag-edge="top"]')!;
    await act(async () => top.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(windowMaximize).toHaveBeenCalledOnce();
  });

  it("leaves typing, text selection and secondary clicks outside the window-drag behavior", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    await act(async () => {
      main().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      host.querySelector('[data-window-drag-edge="left"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    });
    expect(windowDrag).not.toHaveBeenCalled();
  });

  it("a click puts the caret straight into the composer, on the full welcome", async () => {
    const onOpen = vi.fn();
    await render(<Harness onOpen={onOpen}/>);
    host.querySelector<HTMLButtonElement>("#document-focus")!.focus();
    await click('[aria-label="Open front door"]');
    expect(onOpen).toHaveBeenLastCalledWith(true);
    expect(pose()).toBe("conversation");
    expect(document.activeElement).toBe(main());
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("article")!.inert).toBe(true);
  });

  it("closes in one Escape, restores focus and preserves the same draft node", async () => {
    await render();
    const documentButton = host.querySelector<HTMLButtonElement>("#document-focus")!;
    documentButton.focus();
    const draft = main();
    await click('[aria-label="Open front door"]');
    await key(draft, { key: "Escape" });
    expect(pose()).toBe("notch");
    expect(document.activeElement).toBe(documentButton);
    expect(host.querySelector("article")!.inert).toBeFalsy();
    expect(main()).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
    expect(host.querySelector(".rl-frontdoor-focus")?.hasAttribute("inert")).toBe(true);
  });

  it("preserves the front door when a menu consumes Escape", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    try {
      await key(main(), { key: "Escape" });
      expect(pose()).toBe("conversation");
    } finally { menu.remove(); }
    await click('[aria-label="Return to workspace"]');
    expect(pose()).toBe("notch");
  });

  it("dismisses on a full press and release on the empty paper, preserving the draft and returning focus", async () => {
    await render();
    host.querySelector<HTMLButtonElement>("#document-focus")!.focus();
    await click('[aria-label="Open front door"]');
    const backdrop = host.querySelector<HTMLDivElement>(".rl-monochat-conversation")!;
    await act(async () => {
      main().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      main().click();
    });
    expect(pose()).toBe("conversation");
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      backdrop.click();
    });
    expect(pose()).toBe("notch");
    expect(main().value).toBe("Keep this draft");
    expect(document.activeElement?.id).toBe("document-focus");
  });

  it("does not dismiss for text selection ending outside or an outside click that belongs to a menu", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    const backdrop = host.querySelector<HTMLDivElement>(".rl-frontdoor-focus")!;
    await act(async () => {
      main().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      backdrop.click();
    });
    expect(pose()).toBe("conversation");
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      menu.remove();
      backdrop.click();
    });
    expect(pose()).toBe("conversation");
  });

  it("closes on surface navigation without losing the draft or stealing new focus", async () => {
    await render();
    const draft = main();
    await click('[aria-label="Open front door"]');
    await act(async () => { const nav = host.querySelector<HTMLButtonElement>("#navigate")!; nav.focus(); nav.click(); });
    expect(pose()).toBe("notch");
    expect(document.activeElement?.id).toBe("navigate");
    expect(main()).toBe(draft);
  });

  it("an owner that closes the door and navigates in one go is navigation too", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    expect(document.activeElement).toBe(main());
    // The recents swallow mousedown, so the caret is still in the composer.
    await click("#open-recent");
    expect(pose()).toBe("notch");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps a live layer of its own — the tour — out of the inert sweep", async () => {
    const tour = document.createElement("div"); tour.dataset.rlModalLayer = ""; host.append(tour);
    await render();
    await click('[aria-label="Open front door"]');
    expect(host.querySelector("article")!.inert).toBe(true);
    expect(tour.inert).toBeFalsy();
  });

  it("closes a saved chat mounted through an App-owned portal and restores workspace focus", async () => {
    function SavedChat() {
      const [open, setOpen] = useState(false);
      const [slot, setSlot] = useState<HTMLDivElement | null>(null);
      return <><button id="saved-chat-source">History source</button>
        <MonochatIsland open={open} onOpenChange={setOpen} context="Saved chat" busy={false} onNewChat={() => {}}><div ref={setSlot}/></MonochatIsland>
        {slot && createPortal(<div data-chat-composer><textarea aria-label="Saved reply"/></div>, slot)}
      </>;
    }
    await render(<SavedChat/>);
    host.querySelector<HTMLButtonElement>("#saved-chat-source")!.focus();
    await click('[aria-label="Open front door"]');
    // The caret goes into the chat's own composer.
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved reply"]'));
    await key(host.querySelector("textarea")!, { key: "Escape" });
    expect(pose()).toBe("notch");
    expect(document.activeElement?.id).toBe("saved-chat-source");
  });

  it("a chat in the room wears a heading with the one New", async () => {
    const onNewChat = vi.fn();
    await render(<Harness/>);
    await click('[aria-label="Open front door"]');
    expect(host.querySelector(".rl-monochat-new")).toBeNull();
    await render(<Harness onNewChat={onNewChat}/>);
    expect(host.querySelector(".rl-monochat-heading")?.textContent).toContain("Plan");
    expect(host.querySelectorAll(".rl-monochat-new")).toHaveLength(1);
    await click(".rl-monochat-new");
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("respects reduced motion and still opens by click", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    await render();
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 8, clientY: 12 })); vi.advanceTimersByTime(20); });
    expect(host.querySelector<HTMLElement>(".rl-portal-membrane")!.style.length).toBe(0);
    await click('[aria-label="Open front door"]');
    expect(pose()).toBe("conversation");
  });
});

describe("the resting door", () => {
  it("rests on the empty plate with no pill, and focus alone never opens it", async () => {
    await render(<Harness landing/>);
    expect(pose()).toBe("entry");
    expect(pill().dataset.hidden).toBe("true");
    expect(pill().tabIndex).toBe(-1);
    // Tabbing across the plate is not a request to be taken anywhere (WCAG 3.2.1).
    await act(async () => main().focus());
    expect(pose()).toBe("entry");
    expect(host.querySelector("article")!.inert).toBeFalsy();
  });

  it("a press in its composer or a keystroke into it engages it — and the box stays put", async () => {
    await render(<Harness landing/>);
    const layer = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    expect(layer.dataset.rest).toBe("full");
    await pointer(main(), "pointerdown", { button: 0 });
    expect(pose()).toBe("conversation");
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    // Engaging spreads the backdrop, never the box: the plate's insets hold.
    expect(layer.dataset.rest).toBe("full");
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("entry");
    expect(main().value).toBe("Keep this draft");
    await act(async () => main().focus());
    await key(main(), { key: "Tab" });
    expect(pose()).toBe("entry");
    await key(main(), { key: "w" });
    expect(pose()).toBe("conversation");
  });

  it("a chat lets go of the plate's insets: it needs the whole room", async () => {
    await render(<Harness landing onNewChat={() => {}}/>);
    await pointer(main(), "pointerdown", { button: 0 });
    expect(host.querySelector<HTMLElement>(".rl-frontdoor-focus")!.dataset.rest).toBeUndefined();
  });

  it("sheds the resting door's furniture before it would overflow a short plate", () => {
    expect(landingFit(600)).toBe("full");
    expect(landingFit(400)).toBe("pills");
    expect(landingFit(200)).toBe("bare");
    // Below a bare composer it does not land on the terminals at all.
    expect(landingFit(120)).toBe("none");
  });
});

describe("keys", () => {
  it.each(["input", "textarea", "contenteditable"])("Shift+Enter in a %s is that field's newline, never a summons", async (kind) => {
    await render();
    const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
    editor.setAttribute("tabindex", "0");
    // jsdom has no `isContentEditable`; WebKit does.
    if (kind === "contenteditable") { editor.setAttribute("contenteditable", "true"); Object.defineProperty(editor, "isContentEditable", { value: true }); }
    if (kind === "textarea") editor.className = "xterm-helper-textarea";
    document.body.append(editor);
    const localKey = vi.fn(); editor.addEventListener("keydown", localKey);
    try {
      editor.focus();
      const chord = await key(editor, { key: "Enter", shiftKey: true });
      expect(pose()).toBe("notch");
      expect(chord.defaultPrevented).toBe(false);
      expect(localKey).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(editor);
    } finally { editor.remove(); }
  });

  it("Shift+Enter from anywhere else summons the door with the caret; inside it, it is a newline", async () => {
    await render();
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    const chord = await key(page, { key: "Enter", shiftKey: true });
    expect(chord.defaultPrevented).toBe(true);
    expect(pose()).toBe("conversation");
    expect(document.activeElement).toBe(main());
    const newline = await key(main(), { key: "Enter", shiftKey: true });
    expect(newline.defaultPrevented).toBe(false);
    expect(pose()).toBe("conversation");
    await key(main(), { key: "Escape" });
    expect(document.activeElement).toBe(page);
  });

  it("Shift+Enter with the pointer on the pill is aimed at the pill, whatever has focus", async () => {
    await render();
    const editor = document.createElement("textarea"); document.body.append(editor);
    try {
      editor.focus();
      await pointer(pill(), "pointerover");
      const chord = await key(editor, { key: "Enter", shiftKey: true });
      expect(chord.defaultPrevented).toBe(true);
      expect(pose()).toBe("conversation");
    } finally { editor.remove(); }
  });

  it("does not summon during text composition or on key repeat", async () => {
    await render();
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      await key(window, { key: "Enter", shiftKey: true, ...extra });
      expect(pose()).toBe("notch");
    }
  });

  it("browser shortcut messages open without toggling an already open front door", async () => {
    await render();
    await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
    expect(pose()).toBe("conversation");
    await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
    expect(pose()).toBe("conversation");
  });
});

describe("the compact card", () => {
  it("springs out of a resting pointer without stealing focus or making the page inert", async () => {
    await render();
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await pointer(pill(), "pointerover"); await advance(149);
    expect(card()).toBeNull();
    await advance(1); await act(async () => { await Promise.resolve(); });
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(page);
    expect(host.querySelector("article")!.inert).toBeFalsy();
    expect(card()!.getAttribute("role")).toBe("region");
    expect(card()!.hasAttribute("aria-modal")).toBe(false);
    // Not modal, but a file dropped on its chrome must not fall through to
    // the terminal under it (lib/nativeFileDrop).
    expect(card()!.hasAttribute("data-drop-cover")).toBe(true);
    // The pill stays a live target while the card is out.
    expect(pill().dataset.hidden).toBe("false");
    await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(349);
    expect(card()).not.toBeNull();
    await advance(1);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(page);
  });

  it("never opens for a pointer passing through, a touch, a held button, or keyboard focus on the pill", async () => {
    await render();
    await pointer(pill(), "pointerover"); await advance(60);
    await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(500);
    expect(card()).toBeNull();
    await pointer(pill(), "pointerover", { buttons: 1 }); await advance(500);
    await pointer(pill(), "pointerout", { relatedTarget: document.body });
    expect(card()).toBeNull();
    await act(async () => pill().focus());
    await advance(500);
    expect(card()).toBeNull();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("re-entering the card cancels the leave", async () => {
    await render(); await rest();
    await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(300);
    await pointer(card()!, "pointerover"); await advance(500);
    expect(card()).not.toBeNull();
  });

  it("an old draft never pins it; a press, focus or keystroke inside this opening does", async () => {
    writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Keep this draft");
    await render(); await rest();
    host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!.value = "Keep this draft";
    await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(400);
    expect(card()).toBeNull();
    for (const engage of [
      (field: HTMLElement) => pointer(field, "pointerdown"),
      (field: HTMLElement) => act(async () => field.focus()),
      (field: HTMLElement) => key(field, { key: "a" }),
    ]) {
      await rest();
      const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!;
      await engage(field);
      await act(async () => field.blur());
      await pointer(card()!, "pointerout", { relatedTarget: document.body }); await advance(800);
      expect(card()).not.toBeNull();
      await click('[aria-label="Collapse Redline"]');
      expect(card()).toBeNull();
    }
  });

  it("a press anywhere outside closes it, pinned or not, and still lands where it was aimed", async () => {
    await render(); await rest();
    await pointer(host.querySelector('[aria-label="Compact reply"]')!, "pointerdown");
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!;
    const pressed = vi.fn(); page.addEventListener("pointerdown", pressed);
    await pointer(page, "pointerdown");
    expect(card()).toBeNull();
    expect(pressed).toHaveBeenCalledOnce();
    expect(pressed.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it("a press inside the web page closes it", async () => {
    await render(); await rest();
    await act(async () => window.dispatchEvent(new Event("redline:page-press")));
    expect(card()).toBeNull();
  });

  it("with one of its menus open, the first press outside is the menu's", async () => {
    await render(); await rest();
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    try {
      await pointer(host.querySelector("#document-focus")!, "pointerdown");
      expect(card()).not.toBeNull();
    } finally { menu.remove(); }
    await pointer(host.querySelector("#document-focus")!, "pointerdown");
    expect(card()).toBeNull();
  });

  it("Esc closes it with the caret inside, or the pointer on it — and the terminal under it never hears that Esc", async () => {
    await render();
    const terminal = document.createElement("textarea"); terminal.className = "xterm-helper-textarea"; document.body.append(terminal);
    const heard = vi.fn(); terminal.addEventListener("keydown", heard);
    try {
      terminal.focus();
      await rest();
      // The pointer left: Esc is the terminal's.
      await pointer(pill(), "pointerout", { relatedTarget: card() });
      await pointer(card()!, "pointerout", { relatedTarget: document.body });
      await key(terminal, { key: "Escape" });
      expect(heard).toHaveBeenCalledOnce();
      await pointer(card()!, "pointerover");
      const escape = await key(terminal, { key: "Escape" });
      expect(card()).toBeNull();
      expect(escape.defaultPrevented).toBe(true);
      expect(heard).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(terminal);
    } finally { terminal.remove(); }
  });

  it("Esc from inside goes to its open menu first, then closes it and hands the caret back", async () => {
    await render();
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await rest();
    const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!;
    await act(async () => field.focus());
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    try {
      await key(field, { key: "Escape" });
      expect(card()).not.toBeNull();
    } finally { menu.remove(); }
    await key(field, { key: "Escape" });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(page);
  });

  it("a click on the pill while it is out grows it into the door, caret and all", async () => {
    const onOpen = vi.fn();
    await render(<Harness onOpen={onOpen}/>);
    const page = host.querySelector<HTMLButtonElement>("#document-focus")!; page.focus();
    await rest();
    await click(".rl-monochat-notch");
    expect(onOpen).toHaveBeenLastCalledWith(true);
    expect(card()).toBeNull();
    expect(pose()).toBe("conversation");
    expect(document.activeElement).toBe(main());
    // Out of the door, the caret goes back to where it was before the card.
    await key(main(), { key: "Escape" });
    expect(document.activeElement).toBe(page);
  });

  it("navigation closes it and lets go of the caret", async () => {
    await render(); await rest();
    await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!.focus());
    await act(async () => host.querySelector<HTMLButtonElement>("#navigate")!.click());
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(document.body);
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
    expect(pose()).toBe("notch");
    expect(nativeInvoke).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event("blur")); vi.advanceTimersByTime(20); });
    expect(skin.style.getPropertyValue("--portal-pull")).toBe("0.000");
  });

  it("says when Redline is working", async () => {
    await render(<Harness busy/>);
    expect(pill().getAttribute("aria-label")).toBe("Open front door, working");
    expect(pill().textContent).toContain("Working");
  });

  it("wears a dot while a draft is waiting", async () => {
    await render();
    expect(host.querySelector(".rl-monochat-draft")).toBeNull();
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Half a thought"));
    expect(host.querySelector(".rl-monochat-draft")).not.toBeNull();
    expect(pill().getAttribute("aria-label")).toBe("Open front door, draft saved");
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "  "));
    expect(host.querySelector(".rl-monochat-draft")).toBeNull();
  });
});
