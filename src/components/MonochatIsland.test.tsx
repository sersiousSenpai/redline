import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MonochatIsland, landingFit } from "./MonochatIsland";
// The compact card is a lazy chunk; loaded up front, it resolves in a tick.
import "./MonochatCard";
import { writeSharedDraft } from "../hooks/useSharedDraft";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import { DOOR_CLOSE_MS, DOOR_GROW_MS, fadeOutKeyframes, inverseTransform, ISLAND_EASE_IN, ISLAND_FADE_MS, SWAP_OUT_EASING, SWAP_SPRING } from "../lib/springSwap";

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

function Harness({ landing = false, busy = false, announce, onOpen, onNewChat, children }: {
  landing?: boolean; busy?: boolean; announce?: string; onOpen?: (open: boolean) => void; onNewChat?: () => void; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [surface, setSurface] = useState("document");
  const [handoff, setHandoff] = useState(false);
  return <>
    <header className="rl-app-header"><button id="header-surface">Review</button></header>
    <article className="rl-doc-column"><button id="document-focus">Document</button><button id="navigate" onClick={() => setSurface("browser")}>Browser</button>
      {/* A recent: the owner closes the door and goes there in one batch. */}
      <button id="open-recent" onClick={() => { setOpen(false); setSurface("plan"); }}>Recent</button>
      {/* The plan the door launched has landed: the owner hands off into it. */}
      <button id="hand-off" onClick={() => { setHandoff(true); setOpen(false); }}>Plan landed</button></article>
    <MonochatIsland landing={landing} surfaceKey={surface} open={open} onOpenChange={(next) => { onOpen?.(next); setOpen(next); }} handoff={handoff}
      compactOpen={compact} onCompactChange={setCompact} compact={<div className="rl-fd-island"><textarea aria-label="Compact reply" defaultValue=""/></div>}
      context="Plan" busy={busy} announce={announce} onNewChat={onNewChat}>
      {children ?? <div className="rl-frontdoor has-welcome"><div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue="Keep this draft"/></div></div>}
    </MonochatIsland>
  </>;
}
const render = (node: ReactNode = <Harness/>) => act(async () => root.render(node));
const pose = () => host.querySelector<HTMLElement>(".rl-monochat")?.dataset.pose;
const pill = () => host.querySelector<HTMLButtonElement>(".rl-monochat-notch")!;
const card = () => host.querySelector<HTMLElement>(".rl-monochat-float");
const main = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Main reply"]')!;
const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
/** The pill pressed from the keyboard — Enter or Space on it, which is a
 *  click with no pointer behind it. */
const summon = () => act(async () => pill().click());
/** The pill clicked with a pointer. */
const point = () => act(async () => { pill().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
const layerOf = () => host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
const zoomed = () => layerOf().hasAttribute("data-zoom");
const roomBody = () => host.querySelector<HTMLElement>("#rl-monochat-content")!;
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
  type Recorded = { playState: AnimationPlayState; cancel(): void; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; onfinish: null };
  const calls: Array<{ element: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Recorded }> = [];
  (HTMLElement.prototype as { animate?: unknown }).animate = function (this: Element, frames: Keyframe[], options: number | KeyframeAnimationOptions) {
    const animation: Recorded = { playState: "running", cancel() { animation.playState = "idle"; }, pause: vi.fn(() => { animation.playState = "paused"; }), play: vi.fn(() => { animation.playState = "running"; }), onfinish: null };
    calls.push({ element: this, frames, options: typeof options === "number" ? { duration: options } : options, animation });
    return animation;
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
    await summon();
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
    await summon();
    await act(async () => {
      main().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      host.querySelector('[data-window-drag-edge="left"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    });
    expect(windowDrag).not.toHaveBeenCalled();
  });

  it("a pointer on the pill opens it quiet: the caret on the room, the welcome up", async () => {
    const onOpen = vi.fn();
    await render(<Harness onOpen={onOpen}/>);
    host.querySelector<HTMLButtonElement>("#document-focus")!.focus();
    await point();
    expect(onOpen).toHaveBeenLastCalledWith(true);
    expect(pose()).toBe("conversation");
    expect(document.activeElement).toBe(roomBody());
    expect(zoomed()).toBe(false);
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("article")!.inert).toBe(true);
  });

  it("from the keyboard it opens with the caret in the composer, zoomed", async () => {
    await render();
    await summon();
    expect(pose()).toBe("conversation");
    expect(document.activeElement).toBe(main());
    expect(zoomed()).toBe(true);
  });

  it("closes in one Escape, restores focus and preserves the same draft node", async () => {
    await render();
    const documentButton = host.querySelector<HTMLButtonElement>("#document-focus")!;
    documentButton.focus();
    const draft = main();
    await summon();
    await key(draft, { key: "Escape" });
    expect(pose()).toBe("notch");
    expect(document.activeElement).toBe(documentButton);
    expect(host.querySelector("article")!.inert).toBeFalsy();
    expect(main()).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
    expect(host.querySelector(".rl-frontdoor-focus")?.hasAttribute("inert")).toBe(true);
  });

  it("tabbing past the pill leaves no mark: a later click hands the caret back to where it was then", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>("#document-focus")!.focus());
    // Tabbed onto the pill, and on past it.
    await act(async () => pill().focus());
    const header = host.querySelector<HTMLButtonElement>("#header-surface")!;
    await act(async () => header.focus());
    // A click never focuses a button in the app's webview: the pill opens
    // the door with the caret still on the header.
    await summon();
    await key(main(), { key: "Escape" });
    expect(document.activeElement).toBe(header);
  });

  it("its ⌄ fades in behind the paper, and out as a stand-in that never takes the pointer", async () => {
    await render();
    const back = () => host.querySelector<HTMLElement>(".rl-frontdoor-return");
    expect(back()).toBeNull();
    await summon();
    expect(back()?.tagName).toBe("BUTTON");
    expect(back()?.getAttribute("aria-label")).toBe("Return to workspace");
    await act(async () => back()!.click());
    expect(pose()).toBe("notch");
    // The button went with the door — as it always has, so a pointer resting
    // where it was never hands the pill a hover it did not make — and a
    // stand-in fades out in its place: nothing to press, read or reach.
    const ghost = back()!;
    expect(ghost.tagName).toBe("SPAN");
    expect(ghost.hasAttribute("data-leaving")).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector('[aria-label="Return to workspace"]')).toBeNull();
    await advance(119);
    expect(back()).not.toBeNull();
    await advance(1);
    expect(back()).toBeNull();
    // Reopened while it fades: the button, at once.
    await summon();
    await key(main(), { key: "Escape" });
    expect(back()?.tagName).toBe("SPAN");
    await summon();
    expect(back()?.tagName).toBe("BUTTON");
    await advance(500);
    expect(back()?.tagName).toBe("BUTTON");
    // The fades are the stylesheet's: in 80 ms behind the paper, out in 120.
    const css = readFileSync(join(process.cwd(), "src/components/MonochatIsland.css"), "utf8");
    expect(css).toMatch(/\.rl-frontdoor-return \{[^}]*animation: rl-return-in 200ms ease-out 80ms backwards; \}/);
    expect(css).toMatch(/\.rl-frontdoor-return\[data-leaving\] \{ pointer-events: none; animation: rl-return-out 120ms ease-in forwards; \}/);
  });

  it("preserves the front door when a menu consumes Escape", async () => {
    await render();
    await summon();
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
    await summon();
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
    await summon();
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
    await summon();
    await act(async () => { const nav = host.querySelector<HTMLButtonElement>("#navigate")!; nav.focus(); nav.click(); });
    expect(pose()).toBe("notch");
    expect(document.activeElement?.id).toBe("navigate");
    expect(main()).toBe(draft);
  });

  it("an owner that closes the door and navigates in one go is navigation too: focus lands in the new surface's main area", async () => {
    await render();
    await summon();
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
    await summon();
    expect(host.querySelector("article")!.inert).toBe(true);
    expect(tour.inert).toBeFalsy();
  });

  it("leaves a notice that rises over it — the decision countdown — pressable", async () => {
    const banner = document.createElement("div"); banner.dataset.rlOverDoor = ""; host.prepend(banner);
    await render();
    await summon();
    expect(host.querySelector("header")!.inert).toBe(true);
    expect(banner.inert).toBeFalsy();
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
    await summon();
    // The caret goes into the chat's own composer.
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved reply"]'));
    await key(host.querySelector("textarea")!, { key: "Escape" });
    expect(pose()).toBe("notch");
    expect(document.activeElement?.id).toBe("saved-chat-source");
  });

  it("a chat in the room wears a heading with the one New", async () => {
    const onNewChat = vi.fn();
    await render(<Harness/>);
    await summon();
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
    await summon();
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

  it("a press in its composer or a keystroke into it engages it, zoomed", async () => {
    await render(<Harness landing/>);
    const layer = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    expect(layer.dataset.rest).toBe("full");
    expect(layer.hasAttribute("data-landed")).toBe(true);
    await pointer(main(), "pointerdown", { button: 0 });
    expect(pose()).toBe("conversation");
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    // Engaged, it lets go of the plate's insets for the window (the box
    // glides there, below) and stays landed: its paper spreads from the plate.
    expect(layer.hasAttribute("data-rest")).toBe(false);
    expect(layer.hasAttribute("data-landed")).toBe(true);
    expect(zoomed()).toBe(true);
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("entry");
    expect(layer.dataset.rest).toBe("full");
    expect(zoomed()).toBe(false);
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
      <div className="rl-frontdoor has-welcome">
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
      <div className="rl-frontdoor has-welcome">
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

describe("the flow shell", () => {
  /** The flow shell's stage: a start screen that names its own rect, and the
   *  pill held off it. */
  function Stage({ landing = true, pill = false }: { landing?: boolean; pill?: boolean }) {
    const [open, setOpen] = useState(false);
    const at = (rect: { left: number; top: number; right: number; bottom: number }) => (element: HTMLElement | null) => {
      if (element) element.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON() {} }) as DOMRect;
    };
    return <>
      <header className="rl-app-header" ref={at({ left: 0, top: 0, right: 1280, bottom: 47 })}/>
      <main data-rl-door-plate ref={at({ left: 253, top: 47, right: 1280, bottom: 800 })}><button id="stage-focus">Stage</button></main>
      <MonochatIsland landing={landing} pill={pill} surfaceKey="start" open={open} onOpenChange={setOpen} context="New session" busy={false}>
        <div className="rl-frontdoor has-welcome"><div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue=""/></div></div>
      </MonochatIsland>
    </>;
  }

  it("rests in the rect its stage names, whatever the header and the dock say", async () => {
    vi.stubGlobal("innerWidth", 1280); vi.stubGlobal("innerHeight", 800);
    await render(<Stage/>);
    const layer = layerOf();
    expect(layer.hasAttribute("data-landed")).toBe(true);
    expect(layer.style.getPropertyValue("--fd-rest-top")).toBe("47px");
    expect(layer.style.getPropertyValue("--fd-rest-left")).toBe("253px");
    expect(layer.style.getPropertyValue("--fd-rest-right")).toBe("0px");
    expect(layer.style.getPropertyValue("--fd-rest-bottom")).toBe("0px");
  });

  it("holds the pill off its stage: hidden, out of the tab order, and the keys still summon the door zoomed", async () => {
    await render(<Stage landing={false}/>);
    expect(pill().dataset.hidden).toBe("true");
    expect(pill().tabIndex).toBe(-1);
    expect(pill().getAttribute("aria-hidden")).toBe("true");
    const stage = host.querySelector<HTMLButtonElement>("#stage-focus")!; stage.focus();
    await key(stage, { key: "Enter", shiftKey: true });
    expect(pose()).toBe("conversation");
    expect(zoomed()).toBe(true);
    expect(document.activeElement).toBe(main());
    await key(main(), { key: "Escape" });
    // The caret goes back where it was — never to a pill no one can see.
    expect(document.activeElement).toBe(stage);
  });

  it("shows the pill on a Tools page", async () => {
    await render(<Stage landing={false} pill/>);
    expect(pill().dataset.hidden).toBe("false");
    expect(pill().tabIndex).toBe(0);
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
      await click('[aria-label="Collapse"]');
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

  it("a dialog that is part of the work never holds it back; a modal, a menu or its own picker does", async () => {
    // A review's inline annotation editor calls itself a dialog, and it is
    // not over anything: the pill still springs the card, and a press
    // elsewhere still closes it.
    await render(<>
      <Harness/>
      <section><div role="dialog" aria-label="Annotation"><textarea aria-label="Annotation body"/></div></section>
    </>);
    await rest();
    expect(card()).not.toBeNull();
    await pointer(host.querySelector("#document-focus")!, "pointerdown");
    expect(card()).toBeNull();
    for (const attributes of [{ role: "dialog", "aria-modal": "true" }, { role: "menu" }, { "data-rl-modal-layer": "" }]) {
      const overlay = document.createElement("div");
      for (const [name, value] of Object.entries(attributes)) overlay.setAttribute(name, value);
      document.body.append(overlay);
      try {
        await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(400);
        await rest();
        expect(card()).toBeNull();
      } finally { overlay.remove(); }
    }
    // The card's own picker (a mode or activity panel in its composer) is
    // dismissed before the card: the first press outside is the picker's.
    await pointer(pill(), "pointerout", { relatedTarget: document.body }); await advance(400);
    await rest();
    const picker = document.createElement("div"); picker.setAttribute("role", "dialog"); picker.setAttribute("data-rl-island-owned", ""); card()!.append(picker);
    await pointer(host.querySelector("#document-focus")!, "pointerdown");
    expect(card()).not.toBeNull();
    picker.remove();
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

  // 10/11: it says what it opens, in the door's one name, and carries the
  // brand as the mark — never the word "Redline", tricolour bars or a count.
  it("is named for what it opens, and its name starts with what it shows", async () => {
    await render();
    expect(pill().getAttribute("aria-label")).toBe("Plan a build");
    expect(pill().textContent).toBe("Plan a build");
    expect(pill().title).toBe("Plan a build (Shift+Enter)");
    expect(pill().getAttribute("aria-keyshortcuts")).toBe("Shift+Enter");
  });

  it("offers to continue a waiting draft", async () => {
    await render();
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Half a thought"));
    expect(pill().getAttribute("aria-label")).toBe("Continue draft");
    expect(pill().textContent).toBe("Continue draft");
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "  "));
    expect(pill().getAttribute("aria-label")).toBe("Plan a build");
  });

  it("says when Redline is working, and still what a press does", async () => {
    await render(<Harness busy/>);
    expect(pill().getAttribute("aria-label")).toBe("Working, plan a build");
    expect(pill().textContent).toBe("Working");
    // The mark's strike spins while it works.
    expect(pill().querySelector(".rl-pulse-blades")?.getAttribute("data-state")).toBe("thinking");
  });

  it("wears the mark and its label, and nothing else: no bars, no dot, no count", async () => {
    await render();
    const skin = host.querySelector<HTMLElement>(".rl-portal-membrane")!;
    const marks = skin.querySelectorAll("svg");
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute("aria-hidden")).toBe("true");
    expect(marks[0].hasAttribute("role")).toBe(false);
    expect(marks[0].querySelector(".rl-pulse-blades")?.getAttribute("data-state")).toBe("idle");
    expect(Array.from(skin.children).map(child => child.tagName.toLowerCase() + (child.className && typeof child.className === "string" ? `.${child.className}` : ""))).toEqual(["svg", "span.rl-pill-label"]);
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Half a thought"));
    expect(skin.querySelector(".rl-monochat-signal, .rl-monochat-draft, .rl-monochat-news")).toBeNull();
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
  const welcomeDoor = <div className="rl-frontdoor has-welcome"><div className="rl-fd-welcome"/><div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue="Keep this draft"/></div></div>;

  it("a summons from the keyboard puts the caret at the end of the draft", async () => {
    await render();
    main().setSelectionRange(0, 0);
    await summon();
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
    await summon();
    const flight = calls.filter(call => call.element === room());
    expect(flight[0].frames[0].transform).toBe(inverseTransform(rect(PILL), rect(COMPOSER)));
    expect(flight[1].frames).toEqual([{ opacity: 0.35 }, { opacity: 1, offset: 0.35 }]);
  });

  it("closing, it falls back toward the pill: still painted, already inert, until it is there", async () => {
    const calls = flights();
    boxes({ ".rl-frontdoor": COMPOSER, ".rl-portal-membrane": PILL });
    await render(<Harness>{welcomeDoor}</Harness>);
    await summon();
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

  it("handing off into the plan it launched, it fades where it is and gives the caret to the plan", async () => {
    const calls = flights();
    boxes({ ".rl-frontdoor": COMPOSER, ".rl-portal-membrane": PILL });
    await render(<Harness>{welcomeDoor}</Harness>);
    await summon();
    expect(document.activeElement).toBe(main());
    calls.length = 0;
    await click("#hand-off");
    const layer = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    expect(layer.hasAttribute("data-closing")).toBe(true);
    // Back and away under the plan springing out of its composer — not back
    // toward the pill.
    const flight = calls.filter(call => call.element === room());
    expect(flight).toHaveLength(1);
    expect(flight[0].frames).toEqual(fadeOutKeyframes());
    expect(flight[0].options).toEqual({ duration: DOOR_CLOSE_MS, easing: SWAP_OUT_EASING, fill: "forwards" });
    // The caret goes to the plan's main area, not back to where it was.
    expect(document.activeElement).toBe(main_());
    await advance(DOOR_CLOSE_MS);
    expect(layer.hasAttribute("data-closing")).toBe(false);
  });

  // The plate: a sidebar on the left, the header above; jsdom's window is
  // 1024 × 768, so the plate's free area is centred 130 px right of the
  // window's centre and 14 px below it.
  const PLATE = { ".rl-app-header": [0, 0, 1024, 28], ".rl-doc-column": [260, 28, 764, 740] } as Record<string, [number, number, number, number]>;

  it("engaged on the plate, the box glides to the window's centre once the press lets go — transform only", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    const layer = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    // The paper rests as the plate's rect, to spread from it.
    expect(layer.style.getPropertyValue("--fd-paper-from")).toBe(`translate(260px, 28px) scale(${764 / 1024}, ${740 / 768})`);
    await pointer(main(), "pointerdown", { button: 0 });
    const flight = calls.filter(call => call.element === room());
    expect(flight).toHaveLength(1);
    expect(flight[0].frames).toEqual([{ transform: "translate3d(130px, 14px, 0)" }, { transform: "none" }]);
    expect(flight[0].options).toEqual({ duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" });
    // Held at its start under the pressed pointer: the box never moves under it.
    const glide = flight[0].animation;
    expect(glide.pause).toHaveBeenCalledOnce();
    expect(glide.play).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); });
    // A double-click's beat after the release, so a second press lands in
    // the box, not on the paper.
    await advance(299);
    expect(glide.play).not.toHaveBeenCalled();
    await advance(1);
    expect(glide.play).toHaveBeenCalledOnce();
    // The caret rode along.
    expect(document.activeElement).toBe(main());
    // Back to the plate: the same path home.
    calls.length = 0;
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("entry");
    const home = calls.filter(call => call.element === room());
    expect(home.map(call => [call.frames, call.options])).toEqual([[[{ transform: "translate3d(-130px, -14px, 0)" }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" }]]);
    expect(layer.hasAttribute("data-closing")).toBe(false);
  });

  it("a press on one of the resting box's chips: the box waits under the menu it opened, and glides once it goes", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    const glide = calls.filter(call => call.element === room())[0].animation;
    // The release's click opens a menu, placed where its chip rests now.
    const menu = document.createElement("div"); menu.setAttribute("role", "menu");
    try {
      await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); document.body.append(menu); });
      await advance(1000);
      expect(glide.play).not.toHaveBeenCalled();
      // Picked from or dismissed — by the pointer or the keyboard — it goes,
      // and the box follows.
      await act(async () => { menu.remove(); window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" })); });
      await advance(0);
      expect(glide.play).toHaveBeenCalledOnce();
      // Once: what comes after the glide never replays it.
      await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); });
      await advance(1000);
      expect(glide.play).toHaveBeenCalledOnce();
    } finally { menu.remove(); }
  });

  it("a press the glide leaves behind on the paper — a slow double-click's second — never closes the door", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    const glide = calls.filter(call => call.element === room())[0].animation;
    await pointer(main(), "pointerup", { button: 0 });
    await advance(300);
    expect(glide.playState).toBe("running");
    const paper = host.querySelector<HTMLElement>(".rl-monochat-conversation")!;
    await pointer(paper, "pointerdown", { button: 0 });
    await pointer(paper, "click", { button: 0 });
    expect(pose()).toBe("conversation");
    // Arrived, a press on the paper closes it as ever.
    glide.playState = "finished";
    await pointer(paper, "pointerdown", { button: 0 });
    await pointer(paper, "click", { button: 0 });
    expect(pose()).toBe("entry");
  });

  it("a double-click in the resting box: the box waits for the second press, so it lands in the box and the door stays", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    const glide = calls.filter(call => call.element === room())[0].animation;
    await pointer(main(), "pointerup", { button: 0 });
    await advance(150);
    // The second press, held: still nothing moves.
    await pointer(main(), "pointerdown", { button: 0 });
    await pointer(main(), "click", { button: 0, detail: 2 });
    await advance(1000);
    expect(glide.play).not.toHaveBeenCalled();
    expect(pose()).toBe("conversation");
    await pointer(main(), "pointerup", { button: 0 });
    await advance(299);
    expect(glide.play).not.toHaveBeenCalled();
    await advance(1);
    expect(glide.play).toHaveBeenCalledOnce();
  });

  it("a key typed after the press glides the box at once: typing never minds it moving", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    const glide = calls.filter(call => call.element === room())[0].animation;
    await pointer(main(), "pointerup", { button: 0 });
    await act(async () => { main().dispatchEvent(new KeyboardEvent("keyup", { key: "w", bubbles: true })); });
    await advance(0);
    expect(glide.play).toHaveBeenCalledOnce();
  });

  it("shut while the press still holds it, the box never left the plate: nothing glides home", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    calls.length = 0;
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("entry");
    expect(calls.filter(call => call.element === room())).toEqual([]);
    // Its release later moves nothing either.
    await pointer(main(), "pointerup", { button: 0 });
    await advance(1000);
    expect(calls.filter(call => call.element === room())).toEqual([]);
  });

  it("summoned from the keyboard on the plate, it glides once its welcome has faded where it stood", async () => {
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await act(async () => main().focus());
    await key(main(), { key: "w" });
    const flight = calls.filter(call => call.element === room());
    expect(flight).toHaveLength(1);
    expect(flight[0].animation.pause).not.toHaveBeenCalled();
    // Not held: it plays — after the welcome's 160 ms fade is down to a
    // tenth, so the headline and recents recede in place rather than ride
    // along with the box. Held at its start meanwhile; 440 ms in all.
    expect(flight[0].frames).toEqual([{ transform: "translate3d(130px, 14px, 0)" }, { transform: "none" }]);
    expect(flight[0].options).toEqual({ duration: 340, easing: "cubic-bezier(.2,.8,.2,1)", delay: 100, fill: "backwards" });
    expect(zoomed()).toBe(true);
  });

  it("under reduced motion the engaged box snaps to the centre and fades in", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const calls = flights();
    boxes(PLATE);
    await render(<Harness landing/>);
    await pointer(main(), "pointerdown", { button: 0 });
    expect(calls.map(call => [call.frames, call.options.duration])).toEqual([[[{ opacity: 0 }, { opacity: 1 }], ISLAND_FADE_MS]]);
  });

  it("a room holding a chat rises, and leaves without carrying anything back", async () => {
    const calls = flights();
    await render(<Harness onNewChat={() => {}}/>);
    await summon();
    expect(calls[0].frames[0]).toMatchObject({ transform: "translate3d(0, 16px, 0) scale(.985)", opacity: 0 });
    expect(Number(calls[0].options.duration)).toBeLessThanOrEqual(300);
    await key(main(), { key: "Escape" });
    expect(last(calls).frames).toEqual([{ opacity: 0 }, { opacity: 0 }]);
  });

  it("under reduced motion it crossfades in 120 ms, both ways", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const calls = flights();
    await render();
    await summon();
    expect(calls.map(call => call.frames)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    expect(calls[0].options.duration).toBe(ISLAND_FADE_MS);
    await key(main(), { key: "Escape" });
    expect(last(calls).frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    await advance(ISLAND_FADE_MS);
    expect(host.querySelector(".rl-frontdoor-focus")!.hasAttribute("data-closing")).toBe(false);
  });

  it("the pill springs no card while the door is on its way back into it", async () => {
    await render();
    await summon();
    await key(main(), { key: "Escape" });
    await rest();
    expect(card()).toBeNull();
  });
});

// The zoom (10/11): when the USER puts the caret in the door's box, everything
// but the box recedes. Only the user's gestures set it; only the keyboard
// walking out of an empty box, or the door closing, clears it.
describe("the zoom", () => {
  const field = () => main();
  const tab = async (from: Element, to: HTMLElement) => {
    await key(from, { key: "Tab" });
    await act(async () => to.focus());
  };
  const returnPill = () => host.querySelector<HTMLButtonElement>('[aria-label="Return to workspace"]')!;

  it("a quiet door zooms on a press in its box", async () => {
    await render();
    await point();
    expect(zoomed()).toBe(false);
    await pointer(field(), "pointerdown", { button: 0 });
    expect(zoomed()).toBe(true);
  });

  it("a quiet door zooms when Tab brings the caret into its box", async () => {
    await render();
    await point();
    await tab(roomBody(), field());
    expect(zoomed()).toBe(true);
  });

  it("a character typed on the quiet room moves the caret into the box first, so it lands there", async () => {
    await render();
    await point();
    const typed = await key(roomBody(), { key: "P" });
    expect(document.activeElement).toBe(field());
    // Not swallowed: the character's own default is what types it.
    expect(typed.defaultPrevented).toBe(false);
    expect(zoomed()).toBe(true);
  });

  it("a shortcut, a modifier chord or a non-character key on the quiet room moves nothing", async () => {
    await render();
    await point();
    for (const init of [{ key: "k", metaKey: true }, { key: "k", ctrlKey: true }, { key: "™", altKey: true }, { key: "ArrowDown" }, { key: "Enter" }]) {
      await key(roomBody(), init);
      expect(document.activeElement).toBe(roomBody());
      expect(zoomed()).toBe(false);
    }
  });

  it("holds while the caret goes to one of the box's own menus or pickers", async () => {
    await render();
    await summon();
    // An empty box: a sentence in it would hold the zoom on its own.
    field().value = "";
    for (const attributes of [{ "data-rl-island-owned": "" }, { role: "menu" }]) {
      const owned = document.createElement("button");
      for (const [name, value] of Object.entries(attributes)) owned.setAttribute(name, value);
      document.body.append(owned);
      try {
        await act(async () => field().focus());
        await tab(field(), owned);
        expect(zoomed()).toBe(true);
      } finally { owned.remove(); }
    }
  });

  it("the keyboard walking out of an empty box brings the welcome back; with a sentence in it, it holds", async () => {
    await render();
    await summon();
    // A sentence: the box is still what you are in.
    field().value = "Half a thought";
    await tab(field(), returnPill());
    expect(zoomed()).toBe(true);
    await act(async () => field().focus());
    field().value = "  ";
    await tab(field(), returnPill());
    expect(zoomed()).toBe(false);
    // And back in.
    await tab(returnPill(), field());
    expect(zoomed()).toBe(true);
  });

  it("never clears on a press, the window losing focus, or focus the app moves", async () => {
    await render();
    await summon();
    field().value = "";
    // A press after a Tab: the Tab no longer counts.
    await key(field(), { key: "Tab" });
    await pointer(returnPill(), "pointerdown", { button: 0 });
    await act(async () => returnPill().focus());
    expect(zoomed()).toBe(true);
    // Focus moved by the app, the window going away.
    await act(async () => field().focus());
    await act(async () => returnPill().focus());
    await act(async () => { field().focus(); field().blur(); window.dispatchEvent(new Event("blur")); });
    expect(zoomed()).toBe(true);
  });

  it("Esc clears it, and the next quiet summons arrives unzoomed", async () => {
    await render();
    await summon();
    expect(zoomed()).toBe(true);
    await key(field(), { key: "Escape" });
    expect(pose()).toBe("notch");
    await advance(DOOR_CLOSE_MS);
    await point();
    expect(zoomed()).toBe(false);
  });

  it("is held on the door's way back into the pill, so its welcome never shows on the way out", async () => {
    await render();
    await summon();
    await key(field(), { key: "Escape" });
    expect(layerOf().hasAttribute("data-closing")).toBe(true);
    expect(zoomed()).toBe(true);
    await advance(DOOR_CLOSE_MS);
    expect(zoomed()).toBe(false);
  });

  it("nothing said to a screen reader — a launch, an arrival — sets or clears it", async () => {
    await render(<Harness announce=""/>);
    await point();
    await render(<Harness announce="New plan · Auth rewrite"/>);
    expect(zoomed()).toBe(false);
    expect(document.activeElement).toBe(roomBody());
    await pointer(field(), "pointerdown", { button: 0 });
    await render(<Harness announce="Plan launched."/>);
    expect(zoomed()).toBe(true);
  });

  it("a card that was only hovered grows into a quiet door; one whose field held the caret carries it in, zoomed", async () => {
    await render();
    await rest();
    await point();
    expect(document.activeElement).toBe(roomBody());
    expect(zoomed()).toBe(false);
    await key(roomBody(), { key: "Escape" });
    await advance(DOOR_CLOSE_MS);
    await rest();
    await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Compact reply"]')!.focus());
    await point();
    expect(document.activeElement).toBe(field());
    expect(zoomed()).toBe(true);
  });

  it("a chat's composer in the room is not the door's box: it never zooms", async () => {
    await render(<Harness onNewChat={() => {}}><div data-chat-composer><div className="rl-frontdoor"><div className="rl-fd-island"><textarea aria-label="Main reply"/></div></div></div></Harness>);
    await point();
    // The chat takes the caret even from a pointer: there is no welcome to keep.
    expect(document.activeElement).toBe(field());
    await pointer(field(), "pointerdown", { button: 0 });
    expect(zoomed()).toBe(false);
  });

  it("Tab never lands on what the welcome hid: past the last shown control it wraps to the first", async () => {
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    await render(<Harness>
      <div className="rl-frontdoor has-welcome">
        <div className="rl-fd-island"><textarea aria-label="Main reply" defaultValue=""/><button id="send">Send</button></div>
        <div className="rl-fd-welcome rl-fd-recents" style={{ visibility: "hidden" }}><button id="hidden-recent">Earlier plan</button></div>
      </div>
    </Harness>);
    await summon();
    const send = host.querySelector<HTMLButtonElement>("#send")!;
    await act(async () => send.focus());
    const walk = await key(send, { key: "Tab" });
    expect(walk.defaultPrevented).toBe(true);
    // The first control in the door: its ⌄ return.
    expect(document.activeElement).toBe(returnPill());
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
    await summon();
    expect(host.querySelector("section")!.inert).toBe(true);
    await key(main(), { key: "Escape" });
    expect(pose()).toBe("notch");
    await summon();
    const paper = host.querySelector<HTMLElement>(".rl-frontdoor-focus")!;
    await pointer(paper, "pointerdown", { button: 0 });
    await pointer(paper, "click", { button: 0 });
    expect(pose()).toBe("notch");
  });

  it("Esc closes the door with the caret nowhere at all", async () => {
    await render();
    await summon();
    await act(async () => main().blur());
    await key(document.body, { key: "Escape" });
    expect(pose()).toBe("notch");
  });

  it("a Space typed or pressed in the door never reaches a window listener behind it", async () => {
    const behind = vi.fn(), released = vi.fn();
    window.addEventListener("keydown", behind); window.addEventListener("keyup", released);
    try {
      await render();
      await summon();
      const space = await key(main(), { key: " ", code: "Space" });
      expect(behind).not.toHaveBeenCalled();
      // The space itself still goes in.
      expect(space.defaultPrevented).toBe(false);
      // Its release does reach the window: a talk held since before the door
      // opened ends there.
      await act(async () => { main().dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })); });
      expect(released).toHaveBeenCalledOnce();
      await key(main(), { key: "Escape" });
      await key(host.querySelector("#document-focus")!, { key: " ", code: "Space" });
      expect(behind).toHaveBeenCalledOnce();
    } finally { window.removeEventListener("keydown", behind); window.removeEventListener("keyup", released); }
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
    await summon();
    expect(status.inert).toBeFalsy();
    expect(host.querySelector("article")!.inert).toBe(true);
  });

  it("a chat in the room is titled by a heading", async () => {
    await render(<Harness onNewChat={() => {}}/>);
    await summon();
    expect(host.querySelector(".rl-monochat-heading h2")?.textContent).toBe("Plan");
  });

  it("a chat the room holds is marked, so the plate's rest-width pin (for the box's glide) spares it", async () => {
    await render(<Harness landing onNewChat={() => {}}/>);
    await summon();
    expect(host.querySelector(".rl-frontdoor-focus")!.hasAttribute("data-landed")).toBe(true);
    expect(host.querySelector(".rl-monochat")!.hasAttribute("data-chat")).toBe(true);
    await render(<Harness landing/>);
    expect(host.querySelector(".rl-monochat")!.hasAttribute("data-chat")).toBe(false);
    const css = readFileSync(join(process.cwd(), "src/components/MonochatIsland.css"), "utf8");
    expect(css).toMatch(/\.rl-frontdoor-focus\[data-landed\]\[data-open="true"\] \.rl-monochat:not\(\[data-chat\]\) \{ width:/);
  });
});
