// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The streaming bubble renders a reply in two halves — the closed blocks
// parsed once, the open block re-rendered alone — and that is only a perf
// change if nobody can see it. These tests stream real-shaped replies through
// it a few characters at a time and hold the markup to a single full render
// at every step, and pin that the closed half really is left alone.
import { act, createElement, memo, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renders } = vi.hoisted(() => ({ renders: [] as string[] }));

vi.mock("./MarkdownView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MarkdownView")>();
  // The real view behind the same memo boundary, counting its renders.
  const Counted = memo((props: ComponentProps<typeof actual.MarkdownView>) => {
    renders.push(props.body);
    return createElement(actual.MarkdownView, props);
  });
  return { ...actual, MarkdownView: Counted };
});

import StreamingBubble, { StreamingText } from "./StreamingBubble";
import { MarkdownView, renderLiveMarkdown, splitsCleanly } from "./MarkdownView";
import { splitAtClosedBlock } from "../lib/streamSplit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FENCE = "```";

const FIXTURES: Array<[string, string]> = [
  [
    "fenced code",
    [
      "Here is the change:",
      "",
      `${FENCE}ts`,
      "export function pace(text: string) {",
      "  const held: string[] = [];",
      "",
      "  // a blank line above, inside the fence",
      "  return held.join(text);",
      "}",
      FENCE,
      "",
      "Then the caller:",
      "",
      "~~~python",
      "def flush():",
      "",
      "    return held",
      "~~~",
      "",
      FENCE,
      "a fence with no language",
      FENCE,
      "",
      "Done.",
    ].join("\n"),
  ],
  [
    "lists",
    [
      "Three things:",
      "",
      "- a tight item",
      "- another, with `code`",
      "  continued on an indented line",
      "",
      "- the blank line above made this list loose",
      "- [ ] a task",
      "- [x] a finished task",
      "",
      "1. first",
      "2. second",
      "",
      "   a paragraph inside the second item",
      "",
      "3) a new list: a different delimiter",
      "",
      "After the lists.",
    ].join("\n"),
  ],
  [
    "tables and headings",
    [
      "# The plan",
      "",
      "## Costs",
      "",
      "| Surface | Before | After |",
      "|---|---:|:---|",
      "| fork | per token | 33 ms |",
      "| browse | per token | 33 ms |",
      "",
      "### Notes",
      "A paragraph right under a heading, with **bold** and a [link](https://example.com).",
      "",
      "---",
      "",
      "Setext title",
      "============",
      "",
      "Closing line.",
    ].join("\n"),
  ],
  [
    "blockquotes",
    [
      "> [!NOTE]",
      "> The meter keeps its own clock.",
      "",
      "> A plain quote",
      "lazily continued.",
      "",
      "> - a list in a quote",
      "> - and its second item",
      "",
      "> [!WARNING]",
      "> Two quotes in a row stay two quotes.",
      "",
      "After.",
    ].join("\n"),
  ],
  [
    "a mermaid block",
    [
      "The flow:",
      "",
      `${FENCE}mermaid`,
      "flowchart LR",
      "  A[delta] --> B{window passed?}",
      "",
      "  B -->|yes| C[emit]",
      "  B -->|no| D[hold]",
      FENCE,
      "",
      "That's it.",
    ].join("\n"),
  ],
];

/** One full render of `text`, treating the fence the split reports open the
 *  same way — the open fence is the one difference the split is allowed. */
function fullRender(text: string): string {
  const { head, openFence } = splitAtClosedBlock(text);
  const headLines = head.split("\n").length - 1;
  return renderLiveMarkdown(text, openFence < 0 ? -1 : openFence + headLines);
}

/** The halves rendered apart, as the bubble does. */
function splitRender(text: string): string {
  const { head, tail, openFence } = splitAtClosedBlock(text);
  return renderLiveMarkdown(head, -1) + renderLiveMarkdown(tail, openFence);
}

describe("the split render", () => {
  it.each(FIXTURES)("%s: is the full render at every character", (_, text) => {
    for (let n = 0; n <= text.length; n++) {
      const prefix = text.slice(0, n);
      expect(splitRender(prefix), `after ${n} chars`).toBe(fullRender(prefix));
    }
    // Finished, every fence closed: the plain full render, and the closed
    // half is most of it.
    const { head, openFence } = splitAtClosedBlock(text);
    expect(openFence).toBe(-1);
    expect(splitRender(text)).toBe(renderLiveMarkdown(text, -1));
    expect(head.length).toBeGreaterThan(text.length / 2);
  });

  it("leaves a fence unhighlighted while it is open, and colors it once it closes", () => {
    const open = `Intro\n\n${FENCE}ts\nconst a = 1;\n\nconst b = 2;`;
    const { tail, openFence } = splitAtClosedBlock(open);
    const live = renderLiveMarkdown(tail, openFence);
    expect(live).toContain('<pre><code class="language-ts">const a = 1;\n\nconst b = 2;</code></pre>');
    expect(live).not.toContain("hljs-");
    const closed = `${open}\n${FENCE}`;
    expect(splitRender(closed)).toBe(renderLiveMarkdown(closed, -1));
    expect(splitRender(closed)).toContain("hljs-keyword");
  });
});

describe("splitsCleanly", () => {
  it("is markdown-it's verdict on a boundary", () => {
    expect(splitsCleanly("One.\n\nTwo", "One.\n\n")).toBe(true);
    // Inside a fence, inside a list item, inside a paragraph: no.
    expect(splitsCleanly(`${FENCE}\na\n\nb`, `${FENCE}\na\n\n`)).toBe(false);
    expect(splitsCleanly("- a\n\n  b", "- a\n\n")).toBe(false);
    expect(splitsCleanly("One\n\u00a0\nTwo", "One\n\u00a0\n")).toBe(false);
    // A reference definition links the halves.
    expect(splitsCleanly("[a]\n\n[a]: https://example.com", "[a]\n\n")).toBe(false);
  });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  renders.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const bubble = (props: Partial<ComponentProps<typeof StreamingBubble>> & { text: string }) =>
  act(async () => root.render(<StreamingBubble agent="Claude" {...props} />));
const view = () => host.querySelector(".rl-md") as HTMLElement;
/** Markup as the DOM serializes it, so strings compare like rendered nodes. */
const serialized = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.innerHTML;
};

describe("StreamingBubble", () => {
  it.each(FIXTURES)("%s: streams to the markup of one full MarkdownView", async (_, text) => {
    for (let n = 5; n < text.length + 5; n += 5) {
      const prefix = text.slice(0, n);
      await bubble({ text: prefix });
      expect(view().innerHTML, `after ${n} chars`).toBe(serialized(fullRender(prefix)));
    }
    // The finished reply, against a real full render with the same props.
    const reference = document.createElement("div");
    const referenceRoot = createRoot(reference);
    await act(async () => referenceRoot.render(<MarkdownView body={text} compact />));
    expect(view().outerHTML).toBe(reference.firstElementChild?.outerHTML);
    await act(async () => referenceRoot.unmount());
  });

  it("re-renders the closed blocks only when another block closes", async () => {
    const text = FIXTURES[0][1];
    const heads: string[] = [];
    for (let n = 3; n < text.length + 3; n += 3) {
      const prefix = text.slice(0, n);
      const { head } = splitAtClosedBlock(prefix);
      const last = heads[heads.length - 1];
      const tailOnly = head !== "" && head === last;
      if (head !== last) heads.push(head);
      const before = view()?.firstChild ?? null;
      // A call site's inline link handler: a new function every render.
      await bubble({ text: prefix, onOpenLink: () => {} });
      // A tail-only delta leaves the closed blocks' nodes where they were.
      if (tailOnly) expect(view().firstChild).toBe(before);
    }
    expect(renders).toEqual(heads);
    expect(heads.length).toBeGreaterThan(3);
  });

  it("renders whole where the line scan misreads a block", async () => {
    // A fence opened on a list item's own line: the scan takes the item's
    // closing fence for an opener, then the bare fence below for its closer,
    // and would split inside that fence at the blank line.
    const text = ["- " + FENCE, "  npm i", "  " + FENCE, "", FENCE, "code", "", "more", FENCE, "", "End."].join(
      "\n",
    );
    const misread = splitAtClosedBlock(text.slice(0, text.indexOf("more") + 2));
    expect(misread.head).toMatch(/code\n\n$/);
    for (let n = 1; n <= text.length; n++) {
      const prefix = text.slice(0, n);
      await bubble({ text: prefix });
      expect(view().innerHTML, `after ${n} chars`).toBe(serialized(renderLiveMarkdown(prefix, -1)));
    }
    expect(renders).not.toContain(misread.head);
  });

  it("splits again at the next boundary markdown-it confirms", async () => {
    // A no-break space is a blank line to the scan, and text to markdown-it.
    const text = "Para\n\u00a0\nNext\n\nAfter";
    for (let n = 1; n <= text.length; n++) await bubble({ text: text.slice(0, n) });
    expect(view().innerHTML).toBe(serialized(renderLiveMarkdown(text, -1)));
    expect(renders).not.toContain("Para\n\u00a0\n");
    expect(renders).toContain("Para\n\u00a0\nNext\n\n");
  });

  it("routes a link in the open block through onOpenLink", async () => {
    const onOpenLink = vi.fn();
    await bubble({ text: "Closed.\n\nSee https://example.com/docs for", onOpenLink });
    expect(renders).toEqual(["Closed.\n\n"]);
    const link = view().querySelector("a")!;
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps the open block through a re-render that only restyles the reply", async () => {
    // The chat room going from docked to plate scale mid-stream: the closed
    // blocks' view re-renders with a new class, and React must not re-assign
    // its markup (which would take the open block's nodes with it).
    const text = "Closed.\n\nStill open";
    await bubble({ text });
    await bubble({ text, room: true });
    expect(view().className).toBe("rl-md rl-md-room");
    expect(view().innerHTML).toBe(serialized(renderLiveMarkdown(text, -1)));
  });

  it("keeps the room scale, the caret, and the lead paragraph's place", async () => {
    await bubble({ text: "Lead.\n\nNext", room: true });
    expect(view().className).toBe("rl-md rl-md-room");
    // The tail joins the same container, so `.rl-md > p:first-child` is
    // still the reply's first paragraph and nothing else.
    expect(Array.from(view().children).map((el) => el.outerHTML)).toEqual(["<p>Lead.</p>", "<p>Next</p>"]);
    expect(host.textContent).toMatch(/Next\s*▌$/);
    await bubble({ text: "Lead.\n\nNext", room: true, retrying: true });
    expect(host.textContent).not.toContain("▌");
  });
});

describe("StreamingText", () => {
  it("streams the same split render without the bubble around it", async () => {
    // The plan comment's chat and the review thread: a class on the
    // container, and no caret unless one is given.
    const text = "Closed.\n\nStill open";
    await act(async () => root.render(<StreamingText text={text} className="rl-chat-agent" />));
    const container = host.firstElementChild as HTMLElement;
    expect(container.className).toBe("rl-chat-agent");
    expect(Array.from(container.children)).toEqual([view()]);
    expect(view().innerHTML).toBe(serialized(renderLiveMarkdown(text, -1)));
    expect(renders).toEqual(["Closed.\n\n"]);
  });
});
