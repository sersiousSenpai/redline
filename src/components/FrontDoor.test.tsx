// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The door's contract after ⏎, pinned as behaviour rather than as source
// text: the sentence LEAVES. Everything here fails if the composer is ever
// replaced by a card that echoes the prompt back, which is the shape of the
// report this file exists for — "I sent it and it's still sitting there".

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
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

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const PENDING = { prompt: "Ship the auth rewrite", startedAt: Date.now() - 3000 };

function baseProps(over: Partial<FrontDoorProps> = {}): FrontDoorProps {
  return {
    visible: true,
    text: "",
    onTextChange: () => {},
    choice: null,
    onChoiceChange: () => {},
    // Non-empty, so ⏎ launches instead of offering to create a folder first.
    projectOptions: [{ path: "/tmp/proj", name: "proj", source: "folder" }],
    resolvedProject: "/tmp/proj",
    attachments: [],
    onAttachmentsChange: () => {},
    readiness: [],
    onFix: () => Promise.resolve(true),
    pending: null,
    onLaunch: () => {},
    refusal: null,
    onDrafter: () => {},
    onChat: () => {},
    chatEnabled: true,
    destination: "plan",
    onDestinationChange: () => {},
    backend: { backend: "claude-code", model: null, effort: null },
    onBackendChange: () => {},
    codexModels: [],
    onNeedCodexModels: () => {},
    onCancelPending: () => {},
    onRevealPending: () => {},
    onHowItWorks: () => {},
    onCreateProject: () => Promise.resolve(null),
    focusNonce: 0,
    consumeSeed: () => "",
    dictationEnabled: false,
    ...over,
  };
}

/** The composer is controlled by App, so the test has to be the state owner
 *  too — otherwise typing is swallowed and ⏎ would sit on an empty box for a
 *  reason that has nothing to do with what is being tested. */
function Harness(props: Partial<FrontDoorProps>) {
  const [text, setText] = useState(props.text ?? "");
  return createElement(FrontDoor, {
    ...baseProps(props),
    text,
    onTextChange: (next) =>
      setText((prev) => (typeof next === "function" ? next(prev) : next)),
  });
}

async function mount(props: Partial<FrontDoorProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness, props) as ReactElement);
  });
  await flush();
}

const composer = () => host.querySelector<HTMLTextAreaElement>(".rl-fd-input");
const flight = () => host.querySelector<HTMLElement>(".rl-fd-flight");

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
