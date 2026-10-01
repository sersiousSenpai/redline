import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonochatIsland } from "./MonochatIsland";

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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function Harness({ landing = false }: { landing?: boolean }) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState("document");
  return <><article><button id="document-focus">Document</button><button id="navigate" onClick={() => setSurface("browser")}>Browser</button></article><MonochatIsland landing={landing} surfaceKey={surface} open={open} onOpenChange={setOpen} context="Plan" busy={false}><textarea aria-label="Main reply" defaultValue="Keep this draft"/></MonochatIsland></>;
}
const pose = () => host.querySelector<HTMLElement>(".rl-monochat")?.dataset.pose;
const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
it("moves the native window from every outer edge without dismissing the front door", async () => {
  await act(async () => root.render(<Harness/>));
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
  await act(async () => root.render(<Harness/>));
  await click('[aria-label="Open front door"]');
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    host.querySelector('[data-window-drag-edge="left"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
  });
  expect(windowDrag).not.toHaveBeenCalled();
});
it.each(["input", "textarea", "contenteditable"])("Shift+Enter summons from a workspace %s before its own key handler", async (kind) => {
  await act(async () => root.render(<Harness/>));
  const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
  editor.setAttribute("tabindex", "0");
  if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
  if (kind === "textarea") editor.className = "xterm-helper-textarea";
  document.body.append(editor);
  const localKey = vi.fn(); editor.addEventListener("keydown", localKey);
  try {
    editor.focus();
    const key = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => editor.dispatchEvent(key));
    expect(pose()).toBe("conversation");
    expect(key.defaultPrevented).toBe(true);
    expect(localKey).not.toHaveBeenCalled();
    const draft = host.querySelector("textarea")!;
    expect(document.activeElement).toBe(draft);
    const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => draft.dispatchEvent(newline));
    expect(newline.defaultPrevented).toBe(false);
    expect(pose()).toBe("conversation");
    await act(async () => draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(editor);
  } finally { editor.remove(); }
});
it("does not summon during text composition or on key repeat", async () => {
  await act(async () => root.render(<Harness/>));
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, ...extra })));
    expect(pose()).toBe("notch");
  }
});
it("browser shortcut messages open without toggling an already open front door", async () => {
  await act(async () => root.render(<Harness/>));
  await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
  expect(pose()).toBe("conversation");
  await act(async () => window.dispatchEvent(new Event("redline:open-front-door")));
  expect(pose()).toBe("conversation");
});
it("closes a saved chat mounted through an App-owned portal and restores workspace focus", async () => {
  function SavedChat() {
    const [open, setOpen] = useState(false);
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return <><button id="saved-chat-source">History source</button>
      <MonochatIsland open={open} onOpenChange={setOpen} context="Saved chat" busy={false}><div ref={setSlot}/></MonochatIsland>
      {slot && createPortal(<textarea aria-label="Saved reply"/>, slot)}
    </>;
  }
  await act(async () => root.render(<SavedChat/>));
  host.querySelector<HTMLButtonElement>("#saved-chat-source")!.focus();
  await click('[aria-label="Open front door"]');
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(pose()).toBe("notch");
  expect(document.activeElement?.id).toBe("saved-chat-source");
});
it("opens the title-free home input into a focused dialog on typing focus", async () => {
  await act(async () => root.render(<Harness landing/>));
  expect(pose()).toBe("entry");
  expect(host.querySelector("h1, h2, header")).toBeNull();
  const draft = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => draft.focus());
  expect(pose()).toBe("conversation");
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  await act(async () => draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(pose()).toBe("entry");
  expect(draft.value).toBe("Keep this draft");
});
it("hover and keyboard focus never open chat or move document focus", async () => {
  await act(async () => root.render(<Harness/>));
  const documentButton = host.querySelector<HTMLButtonElement>("#document-focus")!;
  documentButton.focus();
  const notch = host.querySelector<HTMLButtonElement>(".rl-monochat-notch")!;
  await act(async () => notch.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(pose()).toBe("notch");
  expect(document.activeElement).toBe(documentButton);
  await act(async () => notch.focus());
  expect(pose()).toBe("notch");
  expect(notch.getAttribute("aria-expanded")).toBe("false");
});
it("keeps a stable hit target while attracting the membrane, without native overlay work", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  await act(async () => root.render(<Harness/>));
  await act(async () => vi.advanceTimersByTime(20));
  nativeInvoke.mockClear();
  const button = host.querySelector<HTMLButtonElement>(".rl-monochat-notch")!;
  const skin = host.querySelector<HTMLElement>(".rl-portal-membrane")!;
  await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 8, clientY: 12 })); vi.advanceTimersByTime(20); });
  expect(Number(skin.style.getPropertyValue("--portal-pull"))).toBeGreaterThan(.5);
  expect(button.style.transform).toBe("");
  expect(pose()).toBe("notch");
  expect(nativeInvoke).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new Event("blur")); vi.advanceTimersByTime(20); });
  expect(skin.style.getPropertyValue("--portal-pull")).toBe("0.000");
});
it("closes in one Escape, restores focus and preserves the same draft node", async () => {
  await act(async () => root.render(<Harness/>));
  const documentButton = host.querySelector<HTMLButtonElement>("#document-focus")!;
  documentButton.focus();
  const draft = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await click('[aria-label="Open front door"]');
  expect(document.activeElement).toBe(draft);
  expect(host.querySelector("article")!.inert).toBe(true);
  await act(async () => draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(pose()).toBe("notch");
  expect(document.activeElement).toBe(documentButton);
  expect(host.querySelector("article")!.inert).toBeFalsy();
  expect(host.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(host.querySelector(".rl-frontdoor-focus")?.hasAttribute("inert")).toBe(true);
});
it("preserves the front door when a menu consumes Escape", async () => {
  await act(async () => root.render(<Harness/>));
  await click('[aria-label="Open front door"]');
  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
  try {
    await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(pose()).toBe("conversation");
  } finally { menu.remove(); }
  await click('[aria-label="Return to workspace"]');
  expect(pose()).toBe("notch");
});
it("closes on surface navigation without losing the draft or stealing new focus", async () => {
  await act(async () => root.render(<Harness/>));
  const draft = host.querySelector("textarea");
  await click('[aria-label="Open front door"]');
  await act(async () => { const nav = host.querySelector<HTMLButtonElement>("#navigate")!; nav.focus(); nav.click(); });
  expect(pose()).toBe("notch");
  expect(document.activeElement?.id).toBe("navigate");
  expect(host.querySelector("textarea")).toBe(draft);
});
it("respects reduced motion and still opens by click", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  await act(async () => root.render(<Harness/>));
  await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 8, clientY: 12 })); vi.advanceTimersByTime(20); });
  expect(host.querySelector<HTMLElement>(".rl-portal-membrane")!.style.length).toBe(0);
  await click('[aria-label="Open front door"]');
  expect(pose()).toBe("conversation");
});

it("dismisses on the space outside the composer, preserving the draft and returning focus", async () => {
  await act(async () => root.render(<Harness/>));
  host.querySelector<HTMLButtonElement>("#document-focus")!.focus();
  await click('[aria-label="Open front door"]');
  const draft = host.querySelector("textarea")!;
  const backdrop = host.querySelector<HTMLDivElement>(".rl-monochat-conversation")!;
  await act(async () => {
    draft.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    draft.click();
  });
  expect(pose()).toBe("conversation");
  await act(async () => {
    backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    backdrop.click();
  });
  expect(pose()).toBe("notch");
  expect(draft.value).toBe("Keep this draft");
  expect(document.activeElement?.id).toBe("document-focus");
});

it("does not dismiss for text selection ending outside or an outside click that belongs to a menu", async () => {
  await act(async () => root.render(<Harness/>));
  await click('[aria-label="Open front door"]');
  const backdrop = host.querySelector<HTMLDivElement>(".rl-frontdoor-focus")!;
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
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
