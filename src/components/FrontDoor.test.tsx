// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, createElement, memo, useState, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";

// The door's contract after ⏎, pinned as behaviour rather than as source
// text: the sentence LEAVES. Everything here fails if the composer is ever
// replaced by a card that echoes the prompt back, which is the shape of the
// report this file exists for — "I sent it and it's still sitting there".

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));
const eventListeners = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (event: { payload: unknown }) => void) => {
    const set = eventListeners.get(name) ?? new Set();
    set.add(fn);
    eventListeners.set(name, set);
    return Promise.resolve(() => set.delete(fn));
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));
const dropListeners = vi.hoisted(() => new Set<(event: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void>());
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: (handler: (event: any) => void) => {
    dropListeners.add(handler);
    return Promise.resolve(() => dropListeners.delete(handler));
  } }),
}));

// jsdom has no ResizeObserver. The door measures itself to decide `compact` /
// `short`; unmeasured reads as roomy, which is the layout these assertions
// are written against.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { FrontDoor, type FrontDoorProps } from "./FrontDoor";
import { PROMISED_DROP_EVENT } from "../lib/nativeFileDrop";
import { FRONT_DOOR_TEXT_KEY } from "../lib/frontDoor";
import type { ReadinessItem } from "../lib/readiness";
import { readSharedDraft, writeSharedDraft } from "../hooks/useSharedDraft";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;
let quiet: MockInstance;

beforeEach(() => {
  // The drop router's dev breadcrumbs.
  quiet = vi.spyOn(console, "debug").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  // The sentence outlives the composer by design; the next test starts blank.
  writeSharedDraft(FRONT_DOOR_TEXT_KEY, "");
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  quiet.mockRestore();
});

const PENDING = { prompt: "Ship the auth rewrite", startedAt: Date.now() - 3000 };

function baseProps(over: Partial<FrontDoorProps> = {}): FrontDoorProps {
  return {
    visible: true,
    choice: null,
    onChoiceChange: () => {},
    // Non-empty, so ⏎ launches instead of offering to create a folder first.
    projectOptions: [{ path: "/tmp/proj", name: "proj", source: "folder" }],
    openFolder: null,
    lastLaunchProject: "/tmp/proj",
    onResolvedProjectChange: () => {},
    attachments: [],
    onAttachmentsChange: () => {},
    readiness: [],
    onFix: () => Promise.resolve(true),
    pending: null,
    onLaunch: () => {},
    refusal: null,
    onDrafter: () => {},
    onRun: () => {},
    onChat: () => {},
    chatEnabled: true,
    destination: "plan",
    onDestinationChange: () => {},
    backend: { backend: "claude-code", model: null, effort: null },
    onBackendChange: () => {},
    modelCatalogs: { codex: [] },
    onNeedModels: () => {},
    onCancelPending: () => {},
    onRevealPending: () => {},
    onCreateProject: () => Promise.resolve(null),
    focusNonce: 0,
    consumeSeed: () => "",
    dictationEnabled: false,
    ...over,
  };
}

/** App owns the backend choice, so the test owns it too. The sentence App
 *  does not own: it is the composer's shared draft, seeded where a reload or
 *  App's hand-back would put it. */
function Harness(props: Partial<FrontDoorProps>) {
  const [backend, setBackend] = useState(props.backend ?? baseProps().backend);
  return createElement(FrontDoor, {
    ...baseProps(props),
    backend,
    onBackendChange: next => { setBackend(next); props.onBackendChange?.(next); },
  });
}

async function mount({ text = "", ...props }: Partial<FrontDoorProps> & { text?: string } = {}): Promise<void> {
  writeSharedDraft(FRONT_DOOR_TEXT_KEY, text);
  await act(async () => {
    root.render(createElement(Harness, props) as ReactElement);
  });
  await flush();
}

const composer = () => host.querySelector<HTMLTextAreaElement>(".rl-fd-input");
const flight = () => host.querySelector<HTMLElement>(".rl-fd-flight");

it("attaches native drops once, merges paths, and highlights the topmost island", async () => {
  const onAttachmentsChange = vi.fn();
  await mount({ attachments: ["/a/x.md"], onAttachmentsChange });
  const original = document.elementsFromPoint;
  document.elementsFromPoint = () => [composer()!];
  try {
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "over", position: { x: 20, y: 30 } } })));
    expect(host.querySelector(".rl-fd-island.is-drop-target")).not.toBeNull();
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "drop", paths: ["/a/x.md", "/a/y.md"], position: { x: 20, y: 30 } } })));
    expect(onAttachmentsChange).toHaveBeenCalledOnce();
    expect(onAttachmentsChange).toHaveBeenCalledWith(["/a/x.md", "/a/y.md"]);
    expect(host.querySelector(".is-drop-target")).toBeNull();
    expect(document.activeElement).toBe(composer());
  } finally { document.elementsFromPoint = original; }
});

it("ignores native drops that miss the island or land on a dialog covering it", async () => {
  const onAttachmentsChange = vi.fn();
  await mount({ onAttachmentsChange });
  const original = document.elementsFromPoint;
  const dialog = document.body.appendChild(document.createElement("div"));
  dialog.setAttribute("aria-modal", "true");
  try {
    expect(dropListeners.size).toBe(1);
    document.elementsFromPoint = () => [document.body];
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "drop", paths: ["/a/x.md"], position: { x: 20, y: 30 } } })));
    document.elementsFromPoint = () => [dialog, composer()!];
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "drop", paths: ["/a/x.md"], position: { x: 20, y: 30 } } })));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  } finally { document.elementsFromPoint = original; dialog.remove(); }
});

it("takes native drops only while the door is visible", async () => {
  const onAttachmentsChange = vi.fn();
  await mount({ visible: false, onAttachmentsChange });
  const original = document.elementsFromPoint;
  document.elementsFromPoint = () => [composer()!];
  try {
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "drop", paths: ["/a/x.md"], position: { x: 20, y: 30 } } })));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    await mount({ visible: true, onAttachmentsChange });
    act(() => dropListeners.forEach(fn => fn({ payload: { type: "drop", paths: ["/a/x.md"], position: { x: 20, y: 30 } } })));
    expect(onAttachmentsChange).toHaveBeenCalledWith(["/a/x.md"]);
  } finally { document.elementsFromPoint = original; }
});

it("attaches a promised drop (a screenshot that hadn't settled) like a native one", async () => {
  const onAttachmentsChange = vi.fn();
  await mount({ onAttachmentsChange });
  const original = document.elementsFromPoint;
  document.elementsFromPoint = () => [composer()!];
  try {
    act(() => eventListeners.get(PROMISED_DROP_EVENT)?.forEach(fn => fn({ payload: { paths: ["/cache/drops/1/Screenshot.png"], position: { x: 20, y: 30 } } })));
    expect(onAttachmentsChange).toHaveBeenCalledWith(["/cache/drops/1/Screenshot.png"]);
  } finally { document.elementsFromPoint = original; }
});

it("lets a floating hover preview appear without taking focus from the document", async () => {
  const documentFocus = document.createElement("button");
  document.body.append(documentFocus); documentFocus.focus();
  try {
    await mount({ floating: true, visible: false, autoFocusOnShow: false });
    await act(async () => root.render(<Harness floating visible autoFocusOnShow={false}/>));
    expect(document.activeElement).toBe(documentFocus);
  } finally { documentFocus.remove(); }
});

it("returns the caret to the floating input when submitting with the send button", async () => {
  const onLaunch = vi.fn();
  await mount({ floating: true, autoFocusOnShow: false, text: "Build this", onLaunch });
  const send = host.querySelector<HTMLButtonElement>(".rl-fd-go")!;
  await act(async () => { send.focus(); send.click(); });
  expect(onLaunch).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(composer());
});

async function type(value: string) {
  const ta = composer();
  if (!ta) throw new Error("the composer never mounted");
  await act(async () => {
    // React's controlled-input path listens on the native setter, so the raw
    // assignment has to go through the prototype descriptor.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter() {
  const ta = composer();
  if (!ta) throw new Error("the composer never mounted");
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

describe("FrontDoor — a launch in flight leaves the door usable", () => {
  it("keeps the composer mounted and empty while a plan is planning", async () => {
    await mount({ pending: PENDING });
    const ta = composer();
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe("");
  });

  it("never re-renders the prompt as body text", async () => {
    await mount({ pending: PENDING });
    // The one assertion the whole change is about. The prompt may ride as a
    // tooltip (the pill's `title`), but text on this surface reads as "still
    // here, not sent yet".
    expect(host.textContent).not.toContain(PENDING.prompt);
    expect(flight()?.getAttribute("title")).toBe(PENDING.prompt);
  });

  it("shows a flight pill whose left half hails the terminal", async () => {
    const onRevealPending = vi.fn();
    await mount({ pending: PENDING, onRevealPending });
    const open = host.querySelector<HTMLButtonElement>(".rl-fd-flight-open");
    expect(open).not.toBeNull();
    await act(async () => open!.click());
    expect(onRevealPending).toHaveBeenCalledTimes(1);
  });

  it("dismisses the pill without touching the plan", async () => {
    const onCancelPending = vi.fn();
    await mount({ pending: PENDING, onCancelPending });
    const x = flight()?.querySelector<HTMLButtonElement>(".rl-fd-x");
    expect(x).not.toBeNull();
    await act(async () => x!.click());
    expect(onCancelPending).toHaveBeenCalledTimes(1);
  });

  it("never pulls the caret back on a re-render — only a new launch, into a door you are still in", async () => {
    // App rebuilds the in-flight object on renders; the composer must read
    // one launch as one launch (the card used to drag the caret out of the
    // terminal on every App render while a plan was planning).
    const terminal = document.createElement("textarea"); document.body.append(terminal);
    try {
      await mount({ pending: PENDING });
      terminal.focus();
      await act(async () => root.render(createElement(Harness, { pending: { ...PENDING } })));
      await act(async () => root.render(createElement(Harness, { pending: { ...PENDING } })));
      expect(document.activeElement).toBe(terminal);
      // A new launch while the caret is somewhere else entirely: still not ours.
      await act(async () => root.render(createElement(Harness, { pending: { ...PENDING, startedAt: PENDING.startedAt + 1 } })));
      expect(document.activeElement).toBe(terminal);
      // A new launch with the caret nowhere — the send button just took it
      // off the page — puts it back for the next sentence.
      terminal.blur();
      await act(async () => root.render(createElement(Harness, { pending: { ...PENDING, startedAt: PENDING.startedAt + 2 } })));
      expect(document.activeElement).toBe(composer());
    } finally { terminal.remove(); }
  });

  it("hides the pill when nothing is in flight", async () => {
    await mount({ pending: null });
    expect(flight()).toBeNull();
  });

  it("still launches on ⏎ while an earlier plan is in flight", async () => {
    // The old gate refused the second ⏎ ("A plan is already launching"). With
    // the card gone there is nothing left to protect: the second plan opens
    // its own terminal tile and the pill re-points at it.
    const onLaunch = vi.fn();
    await mount({ pending: PENDING, onLaunch });
    await type("and now the second one");
    await pressEnter();
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("an empty box is still refused", async () => {
    const onLaunch = vi.fn();
    await mount({ pending: PENDING, onLaunch });
    await pressEnter();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("the 90s hook nudge still lands, now from the readiness strip", async () => {
    // It used to be rendered by the Planning card. Deleting the card must not
    // delete the one failure mode with no other signal at all.
    await mount({
      pending: PENDING,
      readiness: [
        {
          id: "hook-unapproved",
          state: "blocked",
          label: "The plan hook may not be approved yet",
          detail: "Run /hooks in the terminal below and approve it.",
        },
      ],
    });
    expect(host.querySelector(".rl-fd-strip")).not.toBeNull();
    expect(host.textContent).toContain("The plan hook may not be approved yet");
  });
});

// Setup faults after the first run wait in the composer (10/10): one chip,
// never a dialog popping up mid-task. Its press is what opens the setup.
describe("the composer's fix-it chip", () => {
  const INTEGRATION: ReadinessItem = {
    id: "hook-missing",
    state: "blocked",
    label: "The plan hook was removed",
    detail: "Plans won't come back to Redline until it is installed again.",
    fix: { label: "Install integration", kind: "install-integration" },
  };
  const chip = () => host.querySelector<HTMLButtonElement>(".rl-fd-setup");

  it("shows the setup a launch needs as one chip, out of the strip, and its press runs the fix", async () => {
    const onFix = vi.fn(() => Promise.resolve(true));
    const other: ReadinessItem = { id: "mode-paused", state: "blocked", label: "Redline is paused", detail: "Nothing you launch would come back for review." };
    const skill: ReadinessItem = { id: "skill-stale", state: "blocked", label: "The review skill is out of date", detail: "", fix: { label: "Install integration", kind: "install-integration" } };
    await mount({ readiness: [INTEGRATION, skill, other], onFix });
    expect(host.querySelectorAll(".rl-fd-setup")).toHaveLength(1);
    expect(chip()?.textContent).toBe("Install integration");
    expect(chip()?.getAttribute("aria-label")).toBe("The plan hook was removed: Install integration");
    // Said once: the strip keeps the rest, not the setup — one setup installs
    // every piece of it.
    expect(host.querySelector(".rl-fd-strip")?.textContent).not.toContain("The plan hook was removed");
    expect(host.querySelector(".rl-fd-strip")?.textContent).not.toContain("The review skill is out of date");
    expect(host.querySelector(".rl-fd-strip")?.textContent).toContain("Redline is paused");
    await act(async () => chip()!.click());
    expect(onFix).toHaveBeenCalledWith(INTEGRATION);
  });

  it("is absent on a well machine", async () => {
    await mount({ readiness: [] });
    expect(chip()).toBeNull();
  });

  it("a ⏎ it blocks opens the setup, and a setup that completes carries the ⏎ through", async () => {
    const onLaunch = vi.fn();
    let finish: (ok: boolean) => void = () => {};
    const onFix = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await mount({ text: "Ship the auth rewrite", readiness: [INTEGRATION], onFix, onLaunch });
    await pressEnter();
    expect(onFix).toHaveBeenCalledWith(INTEGRATION);
    expect(onLaunch).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("set aside, the setup launches nothing, and other blockers never open it", async () => {
    const onLaunch = vi.fn(), onFix = vi.fn(() => Promise.resolve(false));
    await mount({ text: "Ship the auth rewrite", readiness: [INTEGRATION], onFix, onLaunch });
    await pressEnter();
    await flush();
    expect(onLaunch).not.toHaveBeenCalled();
    onFix.mockClear();
    await mount({ text: "Ship the auth rewrite", readiness: [{ id: "mode-paused", state: "blocked", label: "Redline is paused", detail: "", fix: { label: "Resume interception", kind: "resume-mode" } }], onFix, onLaunch });
    await pressEnter();
    expect(onFix).not.toHaveBeenCalled();
  });
});

describe("FrontDoor model and effort controls", () => {
  it("refreshes metadata explicitly while leaving the chosen model untouched", async () => {
    const onRefreshModels = vi.fn(), onBackendChange = vi.fn();
    await mount({ onRefreshModels, onBackendChange, modelStatus: { checkedAt: 123, refreshing: false }, modelError: "Couldn't refresh. Showing the last checked models." });
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="⏎ launches on Claude"]')!.click());
    const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Refresh models")!;
    expect(document.querySelector('[role="status"]')?.textContent).toContain("last checked");
    await act(async () => refresh.click());
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(onBackendChange).not.toHaveBeenCalled();
  });
  const modelCatalogs = { codex: [
    { slug: "gpt-6-astra", displayName: "GPT-6 Astra", description: "", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-5.5", displayName: "GPT-5.5", description: "", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
  ] };
  const options = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${name}"] button`)];
  const selected = (name: string) => options(name).find(button => button.getAttribute("aria-checked") === "true")?.textContent;
  async function choose(name: string, value: string) {
    const label = modelCatalogs.codex.find(model => model.slug === value)?.displayName ?? value;
    await act(async () => options(name).find(button => button.textContent?.trim() === label)!.click());
  }
  async function openPicker(onBackendChange = vi.fn()) {
    await mount({ backend: { backend: "codex", model: null, effort: null }, modelCatalogs, onBackendChange });
    const trigger = host.querySelector<HTMLButtonElement>('button[title="⏎ launches on Codex"]')!;
    await act(async () => trigger.click());
    return onBackendChange;
  }
  it("keeps effort reachable after picking a model in the same open panel", async () => {
    const changed = await openPicker();
    expect(options("Effort").every(button => button.disabled)).toBe(true);
    await choose("Model", "gpt-6-astra");
    expect(options("Effort").every(button => button.disabled)).toBe(false);
    expect(options("Effort").map(button => button.textContent)).toContain("ultra");
    await choose("Effort", "ultra");
    expect(changed).toHaveBeenLastCalledWith({ backend: "codex", model: "gpt-6-astra", effort: "ultra" });
    expect(document.querySelector('[role="menu"][aria-label="Harness"]')).not.toBeNull();
  });
  it("drops unsupported effort on model change and leaves supported effort selected", async () => {
    await openPicker();
    await choose("Model", "gpt-6-astra");
    await choose("Effort", "ultra");
    await choose("Model", "gpt-5.5");
    expect(selected("Effort")).toBe("Default");
    expect(options("Effort").map(button => button.textContent)).not.toContain("ultra");
    await choose("Effort", "high");
    await choose("Model", "gpt-6-astra");
    expect(selected("Effort")).toBe("high");
  });
  it("does not erase model and effort when the selected harness is clicked again", async () => {
    await openPicker();
    await choose("Model", "gpt-6-astra");
    await choose("Effort", "max");
    const codex = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(b => b.textContent === "Codex")!;
    await act(async () => codex.click());
    expect(selected("Model")).toBe("GPT-6 Astra");
    expect(selected("Effort")).toBe("max");
  });
  it("previews cumulative effort notches on hover and only commits a clicked level", async () => {
    const changed = await openPicker();
    expect(document.querySelector(".rl-effort-strip")).toBeNull();
    await choose("Model", "gpt-6-astra");
    expect(document.querySelector(".rl-effort-strip")).not.toBeNull();
    changed.mockClear();
    const notches = Array.from(document.querySelectorAll<HTMLButtonElement>(".rl-effort-notches button"));
    await act(async () => notches[4].dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(document.querySelectorAll('.rl-effort-notches [data-lit="true"]')).toHaveLength(5);
    expect(document.querySelector(".rl-effort-value")?.textContent).toBe("Max");
    expect(changed).not.toHaveBeenCalled();
    expect(selected("Effort")).toBe("Default");
    await act(async () => notches[4].click());
    expect(changed).toHaveBeenLastCalledWith({ backend: "codex", model: "gpt-6-astra", effort: "max" });
    expect(selected("Effort")).toBe("max");
  });
  it("supports keyboard preview of effort without silently changing the saved setting", async () => {
    const changed = await openPicker();
    await choose("Model", "gpt-6-astra");
    changed.mockClear();
    const low = document.querySelector<HTMLButtonElement>('.rl-effort-notches [aria-label="Low"]')!;
    await act(async () => low.focus());
    await act(async () => low.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Medium");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(changed).toHaveBeenLastCalledWith({ backend: "codex", model: "gpt-6-astra", effort: "medium" });
  });
  it("keeps effort hidden on reopen and reveals it only when a model is hovered or clicked", async () => {
    const changed = await openPicker();
    await choose("Model", "gpt-6-astra");
    await choose("Effort", "high");
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(document.querySelector(".rl-effort-strip")).toBeNull();
    changed.mockClear();
    const model = options("Model").find(button => button.textContent?.trim() === "GPT-6 Astra")!;
    await act(async () => model.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(selected("Effort")).toBe("high");
    expect(changed).not.toHaveBeenCalled();
    const otherModel = options("Model").find(button => button.textContent?.trim() === "GPT-5.5")!;
    await act(async () => otherModel.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(options("Effort").map(button => button.textContent)).not.toContain("ultra");
    expect(changed).not.toHaveBeenCalled();
    await choose("Effort", "medium");
    expect(changed).toHaveBeenLastCalledWith({ backend: "codex", model: "gpt-5.5", effort: "medium" });
  });
});

describe("the floating replacement composer", () => {
  it("preserves a second message while the conversation is opening instead of overwriting its first send", async () => {
    const onChat = vi.fn();
    await mount({ floating: true, destination: "chat", chatPending: true, onChat, text: "The next thought" });
    await pressEnter();
    expect(onChat).not.toHaveBeenCalled();
    expect(composer()?.value).toBe("The next thought");
    expect(host.textContent).toContain("Your message is saved");
  });
  it("the door's composer wears the headline above one input; the card's and a chat's do not", async () => {
    const onLaunch = vi.fn();
    await mount({ floating: true, welcome: true, onLaunch, text: "Build the next release" });
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe("Every build starts as a draft.");
    expect(host.textContent).toContain("Describe it. Redline the plan. Then build.");
    expect(host.querySelector("[data-chat-composer] textarea")).toBe(composer());
    await pressEnter();
    expect(onLaunch).toHaveBeenCalledOnce();
    await mount({ floating: true, welcome: false });
    expect(host.querySelector("h1, h2")).toBeNull();
  });

  it("carries the surface's context chips above the box", async () => {
    await mount({ floating: true, chips: createElement("div", { className: "rl-context-chips" }, createElement("button", { "aria-pressed": "true" }, "This page")) });
    const chips = host.querySelector(".rl-context-chips")!;
    expect(chips.textContent).toBe("This page");
    expect(chips.compareDocumentPosition(host.querySelector(".rl-fd-island")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("wears the way back into recent work below the composer, under the headline", async () => {
    await mount({
      floating: true,
      welcome: true,
      onOpenRecent: () => {},
      recents: [
        { kind: "plan", id: "s1", label: "Auth rewrite", detail: "Plan · npla — Auth rewrite" },
        { kind: "chat", id: "c1", label: "Pricing", detail: "Chat — Pricing" },
        { kind: "browse", id: "b1", label: "LiDAR-GS", detail: "LiDAR-GS", url: "https://github.com/x/lidar-gs" },
      ],
    });
    expect(host.querySelector("h1")?.textContent).toBe("Every build starts as a draft.");
    // Hung BELOW the box, out of flow, so the composer stays put while the
    // recents come and go.
    const group = host.querySelector('[role="group"][aria-label="Jump back in"]')!;
    expect(group.compareDocumentPosition(host.querySelector(".rl-fd-island")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const pills = Array.from(host.querySelectorAll<HTMLButtonElement>(".rl-fd-recent"));
    expect(pills.map((b) => [b.dataset.kind, b.textContent])).toEqual([
      ["plan", "Auth rewrite"],
      ["chat", "Pricing"],
    ]);
    // Pages stack as plain full-width rows: the title, nothing under it.
    const pages = Array.from(host.querySelectorAll<HTMLButtonElement>(".rl-fd-browse-list .rl-fd-browse"));
    expect(pages.map((b) => b.textContent)).toEqual(["LiDAR-GS"]);
    // Each kind is its own labelled row, so it is plain what a chip opens.
    expect(Array.from(host.querySelectorAll(".rl-fd-recent-head")).map((h) => h.textContent)).toEqual([
      "Plans",
      "Chats",
      "Searches",
    ]);
    // No harness row: the welcome is a way back, not a directory.
    expect(host.textContent).not.toContain("Your harnesses");
  });

  it("lays out only as many pages as fit below the composer — never a scroll", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ kind: "browse" as const, id: `b${i}`, label: `Page ${i}`, detail: "", url: `https://p${i}.dev` }));
    // A 300px layer whose composer ends at 100px: room for a few rows only.
    const layer = document.createElement("div");
    layer.className = "rl-frontdoor-focus";
    document.body.appendChild(layer);
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} });
    const proto = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === layer) return rect(0, 300) as DOMRect;
      if (this.classList.contains("rl-frontdoor")) return rect(0, 100) as DOMRect;
      // The page list starts under the chip rows.
      if (this.classList.contains("rl-fd-browse-list")) return rect(120, 120) as DOMRect;
      return proto.call(this);
    });
    try {
      layer.appendChild(host);
      await mount({ floating: true, welcome: true, onOpenRecent: () => {}, recents: pages });
      // (300 − 120 list top − 72 breathing room) / 36 per row → 3.
      expect(host.querySelectorAll(".rl-fd-browse").length).toBe(3);
    } finally {
      vi.restoreAllMocks();
      document.body.appendChild(host);
      layer.remove();
    }
  });

  it("a recent pill opens that place and never launches or steals focus", async () => {
    const onOpenRecent = vi.fn();
    const onLaunch = vi.fn();
    const chat = { kind: "chat" as const, id: "c1", label: "Pricing", detail: "Chat — Pricing" };
    await mount({ floating: true, welcome: true, onLaunch, onOpenRecent, recents: [chat] });
    const pill = host.querySelector<HTMLButtonElement>(".rl-fd-recent")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    pill.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => pill.click());
    expect(onOpenRecent).toHaveBeenCalledWith(chat);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("fades the welcome on a sentence, never on the caret arriving", async () => {
    const recents = [{ kind: "plan" as const, id: "s1", label: "Auth rewrite", detail: "" }];
    await mount({ floating: true, welcome: true, autoFocusOnShow: false, onOpenRecent: () => {}, recents });
    const door = host.querySelector(".rl-frontdoor")!;
    const group = host.querySelector('[aria-label="Jump back in"]')!;
    const shown = () => !door.classList.contains("is-engaged") && group.getAttribute("aria-hidden") === "false";
    expect(shown()).toBe(true);
    // A summoned door puts the caret in; its welcome stays until you type.
    await act(async () => composer()!.focus());
    expect(shown()).toBe(true);
    await type("Build");
    expect(door.classList.contains("is-engaged")).toBe(true);
    expect(group.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>(".rl-fd-recent")!.tabIndex).toBe(-1);
    await type("");
    expect(shown()).toBe(true);
  });

  it("keeps the recents to the door's composer, never the card's or a chat's", async () => {
    const recents = [{ kind: "plan" as const, id: "s1", label: "Auth rewrite", detail: "" }];
    await mount({ floating: true, welcome: false, onOpenRecent: () => {}, recents });
    expect(host.querySelector('[aria-label="Jump back in"]')).toBeNull();
  });

  it("portals the destination picker, supports keyboard choice, and never sends on selection", async () => {
    const destination = vi.fn(), launch = vi.fn();
    await mount({ floating: true, onDestinationChange: destination, onLaunch: launch, text: "Keep this draft" });
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Destination"]')!;
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Destination"]')!;
    expect(host.contains(menu)).toBe(false);
    expect(menu.querySelector("select")).toBeNull();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement?.textContent).toContain("Just run it");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(destination).toHaveBeenCalledWith("run");
    expect(launch).not.toHaveBeenCalled();
    expect(composer()?.value).toBe("Keep this draft");
    expect(document.activeElement).toBe(trigger);
  });
});

it("offers history as an explicit choice without selecting it when the blank composer mounts", async () => {
  const onOpenChat = vi.fn();
  writeSharedDraft(FRONT_DOOR_TEXT_KEY, "Keep my unfinished thought");
  await act(async () => root.render(<FrontDoor {...baseProps({ floating: true, chats: [{ id: "older-chat", title: "Unrelated earlier exchange" }], onOpenChat })}/>));
  expect(onOpenChat).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")!.value).toBe("Keep my unfinished thought");
  expect(host.textContent).not.toContain("Unrelated earlier exchange");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click());
  const entry = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(entry.textContent).toContain("Unrelated earlier exchange");
  await act(async () => entry.click());
  expect(onOpenChat).toHaveBeenCalledTimes(1);
  expect(onOpenChat).toHaveBeenCalledWith("older-chat");
});

describe("FrontDoor — Just run it", () => {
  it("restricts a compact browser composer to Plan and Run, including the modifier shortcut", async () => {
    const onRun = vi.fn(), onDrafter = vi.fn();
    await mount({ destination: "plan", allowedDestinations: ["plan", "run"], onRun, onDrafter, text: "Build this" });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Destination"]')!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Destination"]')!;
    expect(menu.textContent).toContain("Just run it"); expect(menu.textContent).not.toContain("Draft a document"); expect(menu.textContent).not.toContain("Talk it through");
    await act(async () => composer()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(onRun).toHaveBeenCalledOnce(); expect(onDrafter).not.toHaveBeenCalled();
  });
  it("sends ⏎ to the run path, never the plan launch", async () => {
    const onRun = vi.fn(), onLaunch = vi.fn();
    await mount({ destination: "run", onRun, onLaunch, text: "Bump the lockfile" });
    await pressEnter();
    expect(onRun).toHaveBeenCalledOnce();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("keeps ⌘⏎ one key away from a plan", async () => {
    const onRun = vi.fn(), onLaunch = vi.fn();
    await mount({ destination: "run", onRun, onLaunch, text: "Bump the lockfile" });
    await act(async () => {
      composer()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("says what a run skips: auto mode on Claude, no approvals and no sandbox on Codex", async () => {
    await mount({ destination: "run", text: "x" });
    expect(host.querySelector(".rl-fd-runmode")?.textContent).toBe("Auto mode");
    expect(host.querySelector(".rl-fd-runmode.is-unsafe")).toBeNull();
    // A fresh root: the harness owns `backend` as state from its first mount.
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ destination: "run", text: "x", backend: { backend: "codex", model: null, effort: null } });
    expect(host.querySelector(".rl-fd-runmode.is-unsafe")?.textContent).toBe("No approvals · no sandbox");
    await mount({ destination: "plan", text: "x" });
    expect(host.querySelector(".rl-fd-runmode")).toBeNull();
  });

  it("is hidden for harnesses whose non-plan flags are unverified, and a sticky run falls back to plan", async () => {
    const onRun = vi.fn(), onLaunch = vi.fn();
    await mount({ destination: "run", onRun, onLaunch, text: "x", backend: { backend: "cursor", model: null, effort: null } });
    expect(host.querySelector(".rl-fd-runmode")).toBeNull();
    await pressEnter();
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Destination"]')!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Destination"]')!;
    expect(menu.textContent).not.toContain("Just run it");
  });

  it("offers a folder with no $HOME escape when there is nowhere to run", async () => {
    const onRun = vi.fn();
    await mount({ destination: "run", onRun, text: "Make a todo app", projectOptions: [], lastLaunchProject: null });
    await pressEnter();
    expect(onRun).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Build this in a new folder");
    expect(host.textContent).toContain("Create & run");
    expect(host.textContent).not.toContain("just use Home");
  });

  it("labels a run's flight pill as running", async () => {
    await mount({ pending: { ...PENDING, kind: "run" } });
    expect(flight()?.textContent).toContain("Running");
    expect(flight()?.textContent).not.toContain("Planning");
  });
});

// Responsiveness, Phase 2: typing touches only the component being typed in.
// The sentence used to be App state, so every keystroke re-rendered the whole
// shell (every surface, the sidebar, the dock) and wrote localStorage before
// the character could paint.
describe("FrontDoor — a keystroke touches only the composer", () => {
  it("re-renders nothing around it, and reports a new launch target only when the target moves", async () => {
    const renders = { shell: 0, sibling: 0 };
    const Sibling = memo(function Sibling() {
      renders.sibling++;
      return <aside />;
    });
    const props = baseProps({
      projectOptions: [{ path: "/repos/ledger", name: "ledger", source: "folder" }],
      lastLaunchProject: null,
    });
    // App's wiring in miniature: the launch target is shell state, and the
    // composer is the one that reports it.
    function Shell() {
      renders.shell++;
      const [target, setTarget] = useState<string | null>(null);
      return (
        <>
          <Sibling />
          <output data-target>{target ?? "Home"}</output>
          <FrontDoor {...props} onResolvedProjectChange={setTarget} />
        </>
      );
    }
    await act(async () => root.render(<Shell />));
    await flush();
    const settled = { ...renders };

    for (const value of ["F", "Fix", "Fix the export button"]) await type(value);
    expect(composer()!.value).toBe("Fix the export button");
    expect(readSharedDraft(FRONT_DOOR_TEXT_KEY)).toBe("Fix the export button");
    expect(renders).toEqual(settled);

    // Naming a repo moves the target: the shell hears about THAT, once, and
    // its memoized children still sit it out.
    await type("Fix the export button in ledger");
    expect(host.querySelector("[data-target]")!.textContent).toBe("/repos/ledger");
    expect(renders).toEqual({ shell: settled.shell + 1, sibling: settled.sibling });
  });

  it("keeps the sentence through a remount and on disk for a reload", async () => {
    await mount();
    await type("half a thought");
    // A surface switch or a pane toggle takes the composer away…
    await act(async () => root.render(<div />));
    expect(composer()).toBeNull();
    // …and the next one comes back holding the sentence.
    await act(async () => root.render(createElement(Harness, {})));
    expect(composer()!.value).toBe("half a thought");
    // The write trails the typing; pagehide lands it before a reload.
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(FRONT_DOOR_TEXT_KEY)).toBe(JSON.stringify("half a thought"));
  });

  it("shows a sentence App hands back while the composer is on screen", async () => {
    await mount();
    await act(async () => writeSharedDraft(FRONT_DOOR_TEXT_KEY, "the sentence a dead launch owed"));
    expect(composer()!.value).toBe("the sentence a dead launch owed");
  });

  it("type-to-start drains the buffered keys into the composer's own draft", async () => {
    let buffered = "hel";
    const consumeSeed = () => {
      const seed = buffered;
      buffered = "";
      return seed;
    };
    await mount({ consumeSeed, autoFocusOnShow: false });
    await act(async () =>
      root.render(createElement(Harness, { consumeSeed, autoFocusOnShow: false, focusNonce: 1 })),
    );
    expect(document.activeElement).toBe(composer());
    expect(composer()!.value).toBe("hel");
    expect(readSharedDraft(FRONT_DOOR_TEXT_KEY)).toBe("hel");
  });
});

describe("FrontDoor — growing with the text", () => {
  /** Frames run when the test says, so "inside the keystroke" is observable. */
  function stubFrames() {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(++id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    const run = () =>
      act(() => {
        const due = [...frames.values()];
        frames.clear();
        due.forEach((cb) => cb(0));
      });
    return { frames, run };
  }

  it("measures once a frame, after the keystrokes, never inside one", async () => {
    const { frames, run } = stubFrames();
    await mount();
    run();
    const ta = composer()!;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 120 });
    for (const value of ["a", "ab", "abc"]) await type(value);
    expect(ta.style.height).not.toBe("120px");
    expect(frames.size).toBe(1);
    run();
    expect(ta.style.height).toBe("120px");
  });

  it("leaves it to the stylesheet where WebKit sizes fields to their content", async () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/@supports \(field-sizing: content\) \{\s*\.rl-fd-input \{ field-sizing: content; \}/);
    vi.stubGlobal("CSS", { supports: (property: string, value: string) => property === "field-sizing" && value === "content" });
    vi.resetModules();
    const { FrontDoor: Sized } = await import("./FrontDoor");
    const { run } = stubFrames();
    await act(async () => root.render(createElement(Sized, baseProps())));
    const ta = composer()!;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 120 });
    for (const value of ["a", "ab", "abc"]) await type(value);
    run();
    expect(ta.value).toBe("abc");
    expect(ta.style.height).toBe("");
  });
});
