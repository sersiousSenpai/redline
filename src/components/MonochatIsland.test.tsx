import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MonochatIsland, landingFit } from "./MonochatIsland";
// The compact card is a lazy chunk; loaded up front, it resolves in a tick.
import "./MonochatCard";
import { writeSharedDraft } from "../hooks/useSharedDraft";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import { DOOR_CLOSE_MS, DOOR_GROW_MS, inverseTransform, ISLAND_EASE_IN, ISLAND_FADE_MS, SWAP_SPRING } from "../lib/springSwap";

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
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  vi.restoreAllMocks();
});

function Harness({ landing = false, busy = false, arrivals, announce, onOpen, onNewChat, children }: {
  landing?: boolean; busy?: boolean; arrivals?: number; announce?: string; onOpen?: (open: boolean) => void; onNewChat?: () => void; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [surface, setSurface] = useState("document");
  return <>
    <header className="rl-app-header"><button id="header-surface">Review</button></header>
    <article className="rl-doc-column"><button id="document-focus">Document</button><button id="navigate" onClick={() => setSurface("browser")}>Browser</button>
      {/* A recent: the owner closes the door and goes there in one batch. */}
      <button id="open-recent" onClick={() => { setOpen(false); setSurface("plan"); }}>Recent</button></article>
    <MonochatIsland landing={landing} surfaceKey={surface} open={open} onOpenChange={(next) => { onOpen?.(next); setOpen(next); }}
      compactOpen={compact} onCompactChange={setCompact} compact={<div className="rl-fd-island"><textarea aria-label="Compact reply" defaultValue=""/></div>}
      context="Plan" busy={busy} arrivals={arrivals} announce={announce} onNewChat={onNewChat}>
      {children ?? <div className="rl-frontdoor"><div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue="Keep this draft"/></div></div>}
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
const main_ = () => host.querySelector<HTMLElement>(".rl-doc-column")!;
const last = <T,>(list: T[]) => list[list.length - 1];
/** Web Animations, recorded: who animated what, and how. */
function flights() {
  const calls: Array<{ element: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  (HTMLElement.prototype as { animate?: unknown }).animate = function (this: Element, frames: Keyframe[], options: number | KeyframeAnimationOptions) {
    calls.push({ element: this, frames, options: typeof options === "number" ? { duration: options } : options });
    return { cancel() {}, onfinish: null };
  };
  return calls;
}
/** Boxes for the elements that fly, since jsdom lays nothing out. */
function boxes(rects: Record<string, [number, number, number, number]>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const hit = Object.entries(rects).find(([selector]) => this.matches(selector));
    const [left, top, width, height] = hit?.[1] ?? [0, 0, 0, 0];
    return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON() {} } as DOMRect;
  });
}

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

  it("an owner that closes the door and navigates in one go is navigation too: focus lands in the new surface's main area", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    expect(document.activeElement).toBe(main());
    // The recents swallow mousedown, so the caret is still in the composer.
    await click("#open-recent");
    expect(pose()).toBe("notch");
    expect(document.activeElement).toBe(main_());
    // Focusable only for as long as it holds focus: a later click on the
    // page's plain text focuses nothing.
    expect(main_().getAttribute("tabindex")).toBe("-1");
    await act(async () => host.querySelector<HTMLButtonElement>("#document-focus")!.focus());
    expect(main_().hasAttribute("tabindex")).toBe(false);
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

  it("a key on one of its recents goes where the recent goes: it engages nothing", async () => {
    const onOpen = vi.fn();
    await render(<Harness landing onOpen={onOpen}>
      <div className="rl-frontdoor">
        <div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue=""/></div>
        <div className="rl-fd-welcome rl-fd-recents"><button id="recent-plan">Earlier plan</button></div>
      </div>
    </Harness>);
    const recent = host.querySelector<HTMLButtonElement>("#recent-plan")!;
    await act(async () => recent.focus());
    for (const name of ["Enter", " ", "w"]) await key(recent, { key: name });
    expect(onOpen).not.toHaveBeenCalled();
    expect(pose()).toBe("entry");
    // The box itself still engages on its first key.
    await act(async () => main().focus());
    await key(main(), { key: "w" });
    expect(pose()).toBe("conversation");
  });

  it("a recent taken from it by keyboard hands the caret to the new place's main area", async () => {
    await render(<Harness landing>
      <div className="rl-frontdoor">
        <div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue=""/></div>
        <div className="rl-fd-welcome rl-fd-recents"><button id="recent-page" onClick={() => host.querySelector<HTMLButtonElement>("#navigate")!.click()}>A page</button></div>
      </div>
    </Harness>);
    const recent = host.querySelector<HTMLButtonElement>("#recent-page")!;
    await act(async () => recent.focus());
    await click("#recent-page");
    expect(document.activeElement).toBe(main_());
    expect(pose()).toBe("entry");
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

  it("navigation closes it and hands the caret to the new surface's main area, never to nothing", async () => {
    await render(); await rest();
    await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!.focus());
    await act(async () => host.querySelector<HTMLButtonElement>("#navigate")!.click());
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(main_());
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

  it("counts the plans that arrived while you were busy, and opens nothing for them", async () => {
    await render(<Harness arrivals={0}/>);
    expect(host.querySelector(".rl-monochat-news")).toBeNull();
    await render(<Harness arrivals={2}/>);
    expect(host.querySelector(".rl-monochat-news")?.textContent).toBe("2");
    expect(pill().getAttribute("aria-label")).toBe("Open front door, 2 new plans");
    expect(pose()).toBe("notch");
    expect(card()).toBeNull();
    await render(<Harness arrivals={1}/>);
    expect(pill().getAttribute("aria-label")).toBe("Open front door, 1 new plan");
  });
});

// The motion spec and the focus rules that ride on it (10/10): the door comes
// out of the card or the pill and goes back toward the pill; on the plate the
// composer never moves; the paper and the caret follow.
describe("the door's flights", () => {
  const CARD: [number, number, number, number] = [400, 700, 640, 180];
  const COMPOSER: [number, number, number, number] = [320, 300, 800, 140];
  const PILL: [number, number, number, number] = [648, 900, 144, 32];
  const rect = ([left, top, width, height]: number[]) => ({ left, top, width, height });
  const room = () => host.querySelector<HTMLElement>(".rl-monochat")!;
  const welcomeDoor = <div className="rl-frontdoor"><div className="rl-fd-welcome"/><div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue="Keep this draft"/></div></div>;

  it("a click puts the caret at the end of the draft", async () => {
    await render();
    main().setSelectionRange(0, 0);
    await click('[aria-label="Open front door"]');
    expect(document.activeElement).toBe(main());
    expect([main().selectionStart, main().selectionEnd]).toEqual([15, 15]);
  });

  it("grows out of the card: from the card's own box, solid, with its field's selection", async () => {
    const calls = flights();
    boxes({ ".rl-monochat-float": CARD, ".rl-frontdoor": COMPOSER, ".rl-monochat": [320, 100, 800, 760], ".rl-portal-membrane": PILL });
    await render(<Harness>{welcomeDoor}</Harness>);
    await rest();
    const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!;
    await act(async () => { field.value = "Keep this draft"; field.focus(); field.setSelectionRange(5, 9); });
    calls.length = 0;
    await click(".rl-monochat-notch");
    expect(pose()).toBe("conversation");
    const flight = calls.filter(call => call.element === room());
    expect(flight).toHaveLength(1);
    expect(flight[0].frames[0].transform).toBe(inverseTransform(rect(CARD), rect(COMPOSER)));
    expect(flight[0].options).toEqual({ duration: DOOR_GROW_MS, easing: SWAP_SPRING });
    // The FLIP is aimed at the composer: the box you type in is what flies.
    expect(room().style.transformOrigin).toBe("0px 200px");
    // The headline and recents follow once it is under way.
    const welcome = calls.find(call => call.element.classList.contains("rl-fd-welcome"));
    // One keyframe at 0: from nothing up to whatever the stylesheet rests it at.
    expect(welcome?.frames).toEqual([{ opacity: 0, offset: 0 }]);
    expect(welcome?.options).toMatchObject({ delay: 120, fill: "backwards" });
    expect(document.activeElement).toBe(main());
    expect([main().selectionStart, main().selectionEnd]).toEqual([5, 9]);
  });

  it("out of the pill it springs from the membrane, its squeezed text a blur until the shape is mostly there", async () => {
    const calls = flights();
    boxes({ ".rl-frontdoor": COMPOSER, ".rl-portal-membrane": PILL });
    await render();
    await click('[aria-label="Open front door"]');
    const flight = calls.filter(call => call.element === room());
    expect(flight[0].frames[0].transform).toBe(inverseTransform(rect(PILL), rect(COMPOSER)));
    expect(flight[1].frames).toEqual([{ opacity: 0.35 }, { opacity: 1, offset: 0.35 }]);
  });

  it("closing, it falls back toward the pill: still painted, already inert, until it is there", async () => {
    const calls = flights();
    boxes({ ".rl-frontdoor": COMPOSER, ".rl-portal-membrane": PILL });
    await render(<Harness>{welcomeDoor}</Harness>);
    await click('[aria-label="Open front door"]');
    calls.length = 0;
    await key(main(), { key: "Escape" });
    const layer = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    expect(pose()).toBe("notch");
    expect(layer.hasAttribute("data-closing")).toBe(true);
    expect(layer.hasAttribute("inert")).toBe(true);
    expect(calls[0].element).toBe(room());
    expect(last(calls[0].frames)).toEqual({ transform: inverseTransform(rect(PILL), rect(COMPOSER)), opacity: 0 });
    expect(calls[0].options).toEqual({ duration: DOOR_CLOSE_MS, easing: ISLAND_EASE_IN, fill: "forwards" });
    expect(DOOR_CLOSE_MS).toBe(260);
    // The welcome is out of the way first, not shrinking over the work.
    const welcome = calls.find(call => call.element.classList.contains("rl-fd-welcome"));
    expect(welcome?.frames).toEqual([{ opacity: 0, offset: 1 }]);
    expect(welcome?.options).toMatchObject({ duration: 100, fill: "forwards" });
    // The pill is already back under it, to land on.
    expect(pill().dataset.hidden).toBe("false");
    await advance(DOOR_CLOSE_MS);
    expect(layer.hasAttribute("data-closing")).toBe(false);
  });

  it("on the empty plate the composer never moves: engaging and leaving only bring the paper", async () => {
    const calls = flights();
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    expect(pose()).toBe("conversation");
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("entry");
    expect(calls.filter(call => call.element === room())).toEqual([]);
    expect(host.querySelector(".rl-frontdoor-focus")!.hasAttribute("data-closing")).toBe(false);
  });

  it("a room holding a chat rises, and leaves without carrying anything back", async () => {
    const calls = flights();
    await render(<Harness onNewChat={() => {}}/>);
    await click('[aria-label="Open front door"]');
    expect(calls[0].frames[0]).toMatchObject({ transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 });
    expect(Number(calls[0].options.duration)).toBeLessThanOrEqual(300);
    await key(main(), { key: "Escape" });
    expect(last(calls).frames).toEqual([{ opacity: 0 }, { opacity: 0 }]);
  });

  it("under reduced motion it crossfades in 120 ms, both ways", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const calls = flights();
    await render();
    await click('[aria-label="Open front door"]');
    expect(calls.map(call => call.frames)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    expect(calls[0].options.duration).toBe(ISLAND_FADE_MS);
    await key(main(), { key: "Escape" });
    expect(last(calls).frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    await advance(ISLAND_FADE_MS);
    expect(host.querySelector(".rl-frontdoor-focus")!.hasAttribute("data-closing")).toBe(false);
  });

  it("the pill springs no card while the door is on its way back into it", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    await key(main(), { key: "Escape" });
    await rest();
    expect(card()).toBeNull();
  });
});

describe("modal manners", () => {
  it("a dialog left open behind the door is under it, not over it: Esc and the paper stay the door's", async () => {
    // `inert` as a browser has it: reflected to the attribute (jsdom lacks it).
    Object.defineProperty(HTMLElement.prototype, "inert", { configurable: true,
      get(this: HTMLElement) { return this.hasAttribute("inert"); },
      set(this: HTMLElement, value: boolean) { this.toggleAttribute("inert", value); } });
    onTestFinished(() => { delete (HTMLElement.prototype as { inert?: boolean }).inert; });
    await render(<>
      <Harness/>
      {/* An inline editor that calls itself a dialog, open in the work behind. */}
      <section><div role="dialog" aria-label="Annotation"><textarea aria-label="Annotation body"/></div></section>
    </>);
    await click('[aria-label="Open front door"]');
    expect(host.querySelector("section")!.inert).toBe(true);
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("notch");
    await click('[aria-label="Open front door"]');
    const paper = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    await pointer(paper, "pointerdown", { button: 0 });
    await pointer(paper, "click", { button: 0 });
    expect(pose()).toBe("notch");
  });

  it("Esc closes the door with the caret nowhere at all", async () => {
    await render();
    await click('[aria-label="Open front door"]');
    await act(async () => main().blur());
    await key(document.body, { key: "Escape" });
    expect(pose()).toBe("notch");
  });

  it("a Space typed or pressed in the door never reaches a window listener behind it", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind); window.addEventListener("keyup", behind);
    try {
      await render();
      await click('[aria-label="Open front door"]');
      const space = await key(main(), { key: " ", code: "Space" });
      await act(async () => { main().dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })); });
      expect(behind).not.toHaveBeenCalled();
      // The space itself still goes in.
      expect(space.defaultPrevented).toBe(false);
      await key(main(), { key: "Escape" });
      await key(host.querySelector("#document-focus")!, { key: " ", code: "Space" });
      expect(behind).toHaveBeenCalledOnce();
    } finally { window.removeEventListener("keydown", behind); window.removeEventListener("keyup", behind); }
  });

  it("a press on bare title bar is a window drag, not a dismissal — a press on its controls is", async () => {
    await render(); await rest();
    await pointer(host.querySelector(".rl-app-header")!, "pointerdown");
    expect(card()).not.toBeNull();
    await pointer(host.querySelector("#header-surface")!, "pointerdown");
    expect(card()).toBeNull();
  });

  it("says a launch or an arrival politely, and the door's inert sweep leaves it heard", async () => {
    await render(<Harness announce="Plan launched. Redline is planning it in the terminal."/>);
    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Plan launched. Redline is planning it in the terminal.");
    await click('[aria-label="Open front door"]');
    expect(status.inert).toBeFalsy();
    expect(host.querySelector("article")!.inert).toBe(true);
  });

  it("a chat in the room is titled by a heading", async () => {
    await render(<Harness onNewChat={() => {}}/>);
    await click('[aria-label="Open front door"]');
    expect(host.querySelector(".rl-monochat-heading h2")?.textContent).toBe("Plan");
  });
});
