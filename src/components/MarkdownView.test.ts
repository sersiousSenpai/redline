// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { splitMermaidSegments } from "./MarkdownView";

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
