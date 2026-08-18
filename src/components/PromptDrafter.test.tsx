// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createElement,
  Profiler,
  useState,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor, JSONContent } from "@tiptap/react";

// 3,363 lines of Drafter had zero component coverage.
//
// The pair at the top is the whole safety of the jank fix, and it fails from
// OPPOSITE directions: drop the selector and the render count climbs (the
// jank); stop the host re-rendering without giving the ribbon its own
// subscription and the ribbon FREEZES (strictly worse than the jank). Neither
// test passes if you only fix one side.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no ResizeObserver. The ribbon's overflow fit degrades gracefully
// without one (everything stays visible), but stubbing it means these tests
// exercise the real measured path rather than the fallback.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  StubResizeObserver;

import { PromptDrafter } from "./PromptDrafter";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const DOC: JSONContent = { type: "doc", content: [paragraph("Ship auth")] };

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

type Props = Parameters<typeof PromptDrafter>[0];

/** The live editor, reached through the node ProseMirror owns — TipTap parks
 *  the instance on it, and the component rightly doesn't export it. */
function editorFrom(): Editor {
  const pm = host.querySelector(".ProseMirror") as
    | (HTMLElement & { editor?: Editor })
    | null;
  if (!pm?.editor) throw new Error("the drafter's editor never mounted");
  return pm.editor;
}

async function mountDrafter(
  props: Partial<Props> = {},
  wrap?: (el: ReactElement) => ReactElement,
) {
  const el = createElement(PromptDrafter, {
    draftId: "d1",
    doc: DOC,
    onPersist: () => {},
    projectOptions: [],
    selectedProject: null,
    onSelectedProjectChange: () => {},
    onLaunch: () => {},
    ...props,
  } as Props);
  await act(async () => {
    root.render(wrap ? wrap(el) : el);
  });
  await flush();
  return editorFrom();
}

describe("PromptDrafter — the jank, and its opposite", () => {
  it("typing inside one word does not re-render the surface", async () => {
    // `shouldRerenderOnTransaction: false` plus a deepEqual-compared selector
    // means N single-character transactions inside one word cost ZERO renders
    // of this ~2,800-line tree. Before, every keystroke re-rendered it AND
    // walked the document three times.
    // A `Profiler`, not a wrapper component: a parent wrapper never re-renders
    // when its child updates from its own hooks, so a wrapper-based counter
    // would sit at 1 whatever the child does — and pass even with the jank
    // fully reinstated. The Profiler commits once per subtree render, which is
    // the number that matters.
    let renders = 0;
    const editor = await mountDrafter({}, (el) =>
      createElement(Profiler, { id: "drafter", onRender: () => void renders++ }, el),
    );

    const type = (ch: string) =>
      act(async () => {
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, ch);
      });

    // One keystroke to settle whatever the caret's arrival changes (the
    // instructable-block probe flips as the caret lands in a paragraph). From
    // there the selector's answer is stable.
    await type("a");
    const at = renders;

    // Each keystroke runs in its OWN act(): batching them into one would
    // collapse to a single commit and the test would pass with the jank fully
    // reinstated.
    const KEYSTROKES = "bcdefghijklmnop".split("");
    for (const ch of KEYSTROKES) await type(ch);
    await flush();

    // The claim is "not a render per keystroke", not "exactly zero": under a
    // loaded full-suite run a couple of unrelated async settles (a debounce
    // landing, a selectionchange) land inside the loop, and pinning 0 would
    // make this flaky rather than strict. The margin is what makes it sharp —
    // with the jank reinstated this is ONE PER KEYSTROKE, four times the bound.
    expect(
      renders - at,
      "typing is costing a re-render of the whole drafter per keystroke",
    ).toBeLessThan(KEYSTROKES.length / 4);
  });

  it("the ribbon still tracks Bold as the selection changes", async () => {
    // The freeze regression, from the other side: `DrafterToolbar` reads its
    // active states through its OWN `useEditorState`. Without that, stopping
    // the host's per-transaction render leaves Bold permanently unlit.
    const editor = await mountDrafter();
    const bold = () =>
      host.querySelector('button[aria-label^="Bold"]') as HTMLButtonElement;
    expect(bold()).not.toBeNull();
    expect(bold().getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      editor.chain().selectAll().toggleBold().run();
    });
    await flush();
    expect(
      bold().getAttribute("aria-pressed"),
      "the ribbon lost its subscription — Bold no longer lights up",
    ).toBe("true");
  });

  it("a real content change still reaches the word count", async () => {
    // The other half of the render claim: eliminating renders must not
    // eliminate the ones that matter. Adding a word is a change the surface
    // reflects, so it must land.
    const editor = await mountDrafter();
    expect(host.textContent).toContain("2 words");
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " now");
    });
    await flush();
    expect(host.textContent).toContain("3 words");
  });
});

describe("PromptDrafter — the launch bar", () => {
  const READY = { readiness: [], onFix: async () => true };

  it("⌘⇧⏎ launches; ⏎ and ⌘⏎ never do", async () => {
    // This is a document. ⏎ must stay a newline, and ⌘⏎ is already owned by
    // ✦ Generate — no design elegance is worth Return spawning a subprocess.
    const onLaunch = vi.fn();
    await mountDrafter({ ...READY, onLaunch });

    const press = (init: KeyboardEventInit) =>
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ...init }),
        );
      });

    await press({});
    await press({ metaKey: true });
    await press({ shiftKey: true });
    expect(onLaunch).not.toHaveBeenCalled();

    await press({ metaKey: true, shiftKey: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("a blocker refuses the launch and renders its fix in the bar", async () => {
    const onLaunch = vi.fn();
    await mountDrafter({
      onLaunch,
      onFix: async () => true,
      readiness: [
        {
          id: "mode-paused",
          state: "blocked",
          label: "Redline is paused",
          detail: "Nothing you launch would come back for review.",
          fix: { label: "Resume interception", kind: "resume-mode" },
        },
      ],
    });
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          shiftKey: true,
        }),
      );
    });
    await flush();
    expect(onLaunch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Redline is paused");
    expect(host.textContent).toContain("Resume interception");
  });

  it("while a launch is pending the document stays editable and the CTA is gone", async () => {
    // Decision 3, in the DOM. The card is a receipt of transaction, not a
    // modal: the document it describes is still on screen and still typeable.
    const editor = await mountLive();
    await fireLaunch();
    expect(host.querySelector(".ProseMirror")).not.toBeNull();
    expect(editor.isEditable).toBe(true);
    expect(host.textContent).toContain("watch it in the terminal below");
    // "keep drafting", never "start something else" — nothing was taken away.
    expect(host.textContent).toContain("keep drafting");
    // A relaunch is legal but must cost a deliberate click, not a stray ⌘⇧⏎.
    expect(host.querySelector(".rl-fd-go")).toBeNull();
    // ...and the document is still the document.
    expect(host.textContent).toContain("Ship auth");
  });

  it("the receipt describes what was SENT, not what you typed after", async () => {
    // The document stays editable under the card, so a receipt read from the
    // live document would drift — describing a shape nobody sent.
    const editor = await mountLive();
    await fireLaunch();
    expect(host.textContent).toContain("2 words");
    await act(async () => {
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        " and more words here",
      );
    });
    await flush();
    expect(host.textContent).toContain("2 words");
  });

  it("names the aids that stayed behind, and only when there are any", async () => {
    const AIDS = "Font, colour and alignment stayed here";

    await mountLive();
    await fireLaunch();
    expect(host.textContent).not.toContain(AIDS);

    // A fresh surface, this time with a highlight in the document.
    act(() => root.unmount());
    root = createRoot(host);
    const editor = await mountLive();
    await act(async () => {
      editor.chain().selectAll().setHighlight({ color: "#ff0" }).run();
    });
    await fireLaunch();
    expect(host.textContent).toContain(AIDS);
  });
});

/** ⌘⇧⏎. */
const fireLaunch = async () => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        shiftKey: true,
      }),
    );
  });
  await flush();
};

/** The drafter wired the way App wires it: `onLaunch` sets the pending state
 *  that comes back down as the card. Without the round trip these tests would
 *  be asserting against a prop they hand-made. */
function LiveHost() {
  const [pending, setPending] = useState<Props["pending"]>(null);
  return createElement(PromptDrafter, {
    draftId: "d1",
    doc: DOC,
    onPersist: () => {},
    projectOptions: [],
    selectedProject: null,
    onSelectedProjectChange: () => {},
    readiness: [],
    onFix: async () => true,
    pending,
    onDismissPending: () => setPending(null),
    onLaunch: (prompt: string) =>
      setPending({
        origin: "drafter",
        prompt,
        startedAt: Date.now(),
        terminalId: "t1",
        draftId: "d1",
        restore: { kind: "none" },
      }),
  } as Props);
}

async function mountLive() {
  await act(async () => {
    root.render(createElement(LiveHost));
  });
  await flush();
  return editorFrom();
}

