// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import { MarkdownView, splitMermaidSegments } from "./MarkdownView";

// The diagram itself is not under test here, only where it sits.
vi.mock("../editor/extensions/MermaidView", () => ({
  MermaidView: ({ code }: { code: string }) => createElement("div", { className: "rl-mermaid" }, code),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("splitMermaidSegments", () => {
  it("returns a single md segment when there is no mermaid fence", () => {
    const body = "Just some **prose** and a list:\n\n- a\n- b";
    const segs = splitMermaidSegments(body);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: "md", text: body });
  });

  it("splits text, a mermaid fence, and a trailing code fence in order", () => {
    const body = [
      "Here is the flow:",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "And the code:",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const segs = splitMermaidSegments(body);

    expect(segs.map((s) => s.kind)).toEqual(["md", "mermaid", "md"]);
    const mermaid = segs[1];
    expect(mermaid.kind === "mermaid" && mermaid.code).toContain("flowchart LR");
    expect(mermaid.kind === "mermaid" && mermaid.code).toContain("A --> B");
    // The trailing ```ts block stays markdown (only mermaid is extracted).
    const tail = segs[2];
    expect(tail.kind === "md" && tail.text).toContain("```ts");
  });

  it("handles a body that is only a mermaid diagram", () => {
    const body = "```mermaid\npie title Pets\n  \"Dogs\" : 3\n```";
    const segs = splitMermaidSegments(body);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("mermaid");
    expect(segs[0].kind === "mermaid" && segs[0].code).toContain("pie title");
  });

  it("keeps multiple diagrams as separate segments", () => {
    const body = [
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "middle",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
    ].join("\n");
    const segs = splitMermaidSegments(body);
    expect(segs.map((s) => s.kind)).toEqual(["mermaid", "md", "mermaid"]);
  });

  // The split keys on the fence info string being exactly "mermaid", so every
  // diagram *type* the sidecar skill recommends extracts the same way. These
  // cases document and guard that supported set.
  it.each([
    ["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Draft"],
    ["erDiagram", "erDiagram\n  A ||--o{ B : has"],
    ["C4Context", 'C4Context\n  Person(a, "Reviewer")'],
    ["xychart-beta", 'xychart-beta\n  x-axis [v1, v2]\n  bar [1, 2]'],
  ])("extracts a %s diagram as a mermaid segment", (marker, code) => {
    const body = ["intro", "", "```mermaid", code, "```"].join("\n");
    const segs = splitMermaidSegments(body);
    expect(segs.map((s) => s.kind)).toEqual(["md", "mermaid"]);
    expect(segs[1].kind === "mermaid" && segs[1].code).toContain(marker);
  });
});

/** The view's root element, rendered alone. */
async function rendered(props: Parameters<typeof MarkdownView>[0]): Promise<HTMLElement> {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(MarkdownView, props)));
  const view = host.firstElementChild as HTMLElement;
  await act(async () => root.unmount());
  return view;
}

// A settled reply renders `rich`; the same reply streamed without it. Any
// difference in their markup is a jump the reader sees the moment it settles.
const REPLIES: Array<[string, string]> = [
  ["a lead paragraph", "The seat table already has the columns.\n\nThe rest follows."],
  ["a heading first", "## Meter\n\nThe meter rides with the row."],
  ["tight and loose lists", "- one\n- two\n\n1. first\n\n2. second"],
  ["fenced code", "Run it:\n\n```ts\nconst recap = summarize(thread);\n```"],
  ["a table", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["a callout", "> [!NOTE]\n> Kept as a note."],
];

describe("MarkdownView", () => {
  it.each(REPLIES)("%s: a rich body with no diagram renders the plain markup, byte for byte", async (_, body) => {
    for (const style of [{ compact: true }, { room: true }]) {
      const plain = await rendered({ body, ...style });
      const rich = await rendered({ body, ...style, rich: true });
      expect(rich.outerHTML).toBe(plain.outerHTML);
      // No wrapper between `.rl-md` and its first block.
      expect(rich.firstElementChild?.tagName).not.toBe("DIV");
    }
  });

  it("highlights a fence in a common language or its alias, and leaves an unknown one plain", async () => {
    const code = async (lang: string, src: string) =>
      (await rendered({ body: "```" + lang + "\n" + src + "\n```", compact: true })).querySelector("code")!.innerHTML;
    expect(await code("ts", "const a = 1;")).toBe(
      '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n',
    );
    expect(await code("sh", 'echo "hi"')).toBe('<span class="hljs-built_in">echo</span> <span class="hljs-string">"hi"</span>\n');
    expect(await code("html", "<b>x</b>")).toBe(
      '<span class="hljs-tag">&lt;<span class="hljs-name">b</span>&gt;</span>x<span class="hljs-tag">&lt;/<span class="hljs-name">b</span>&gt;</span>\n',
    );
    expect(await code("Rust", "fn main() {}")).toContain('<span class="hljs-keyword">fn</span>');
    expect(await code("nolang", "<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;\n");
  });

  it("wraps each markdown run of a body with a diagram, around the diagram", async () => {
    const view = await rendered({ body: "Lead.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.", compact: true, rich: true });
    expect(Array.from(view.children).map((el) => el.outerHTML)).toEqual([
      "<div><p>Lead.</p>\n</div>",
      expect.stringContaining('class="rl-mermaid"'),
      "<div><p>After.</p>\n</div>",
    ]);
  });
});

describe("the reply stylesheet", () => {
  const css = readFileSync("src/styles.css", "utf8");
  /** The declarations of the rule whose selector list is exactly `selector`
   *  — not one that merely ends with it (`.rl-md ul,\n.rl-md ol {`). */
  const rule = (selector: string) => {
    let at = css.indexOf(`\n${selector} {`);
    while (at > -1 && css.slice(0, at).trimEnd().endsWith(",")) at = css.indexOf(`\n${selector} {`, at + 1);
    expect(at, selector).toBeGreaterThan(-1);
    return { at, body: css.slice(at, css.indexOf("}", at)) };
  };

  it("frames a code block once: the <pre> is the box, the wrapper only spaces it", () => {
    const wrapper = rule(".rl-md .rl-codeblock").body;
    for (const decl of ["border: 0;", "background: none;", "border-radius: 0;"]) expect(wrapper).toContain(decl);
    expect(rule(".rl-md .rl-codeblock > pre").body).toContain("margin: 0;");
    expect(rule(".rl-md pre").body).toContain("border:");
  });

  it("keeps list markers through the base reset", () => {
    expect(rule(".rl-md ul").body).toContain("list-style: disc;");
    expect(rule(".rl-md ol").body).toContain("list-style: decimal;");
  });

  it("starts and ends a reply flush, through a diagram body's wrappers, after every rule it ties with", () => {
    const first = rule(".rl-md > :first-child,\n.rl-md > div:first-child > :first-child");
    const last = rule(".rl-md > :last-child,\n.rl-md > div:last-child > :last-child");
    expect(first.body).toContain("margin-top: 0;");
    expect(last.body).toContain("margin-bottom: 0;");
    // Same specificity, so the later rule wins: a reply opening on code or a
    // callout would otherwise keep that block's top margin.
    for (const tie of [".rl-md .rl-codeblock", ".rl-md .rl-callout"]) {
      expect(first.at, tie).toBeGreaterThan(rule(tie).at);
      expect(last.at, tie).toBeGreaterThan(rule(tie).at);
    }
    const room = rule(".rl-md-room > :first-child,\n.rl-md-room > div:first-child > :first-child");
    expect(room.at).toBeGreaterThan(rule(".rl-md-room .rl-codeblock").at);
  });

  it("gives a diagram body's first paragraph the lead weight, and the room its own", () => {
    expect(css).toContain(".rl-md > p:first-child,\n.rl-md > div:first-child > p:first-child {");
    expect(css).toContain(".rl-md-room > p:first-child,\n.rl-md-room > div:first-child > p:first-child {");
  });

  it("scales a discussion's lead with its text size, after the base lead rule it ties with", () => {
    // Settled replies take the lead rule now that their markup is the
    // streamed markup; a fixed size would read smaller than the body at A+.
    const base = rule(".rl-md > p:first-child,\n.rl-md > div:first-child > p:first-child");
    const compact = rule(".rl-md-compact > p:first-child,\n.rl-md-compact > div:first-child > p:first-child");
    expect(compact.body).toContain("font-size: calc(13.5px * var(--rl-discussion-zoom, 1));");
    expect(compact.at).toBeGreaterThan(base.at);
  });
});
