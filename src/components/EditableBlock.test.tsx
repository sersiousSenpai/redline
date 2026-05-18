import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it } from "vitest";

import { EditableBlock, type RegisteredHandle } from "./EditableBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: HTMLDivElement[] = [];

afterEach(() => {
  for (const c of mounted.splice(0)) c.remove();
});

function mount(props: Partial<Parameters<typeof EditableBlock>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  const handles: RegisteredHandle[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      <EditableBlock
        blockId="blk-1"
        anchorId="A.p1"
        sourceMarkdown={"A paragraph with **bold**."}
        structured={false}
        hasComment={false}
        register={(h) => handles.push(h)}
        unregister={() => {}}
        onInput={() => {}}
        {...props}
      />,
    );
  });
  return { root, handles, el: container.querySelector("div.md-block") as HTMLDivElement };
}

describe("EditableBlock", () => {
  it("renders byte-identical HTML to the read-only ReactMarkdown path", () => {
    const md = "A paragraph with **bold** and `code`.";
    const { el } = mount({ sourceMarkdown: md });
    const expected = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>,
    );
    expect(el.innerHTML).toBe(expected);
    // It is editable and carries the styling class.
    expect(el.getAttribute("contenteditable")).toBe("true");
    expect(el.className).toContain("md-block");
  });

  it("registers a handle whose getMarkdown reflects DOM edits", () => {
    const { handles, el } = mount();
    expect(handles).toHaveLength(1);
    const h = handles[0];
    expect(h.blockId).toBe("blk-1");
    expect(h.getMarkdown()).toBe(h.baseline); // untouched ⇒ baseline

    el.innerText = "Edited text.";
    expect(h.getMarkdown()).toBe("Edited text.");
  });

  it("setMarkdown is guarded: idempotent, and a no-op for structured blocks", () => {
    // Prose: writes when different, no-op when equal.
    const { handles, el } = mount();
    const h = handles[0];
    h.setMarkdown("Reconciled.", { source: "rl-sync" });
    expect(el.innerText).toBe("Reconciled.");
    el.innerText = "Reconciled.";
    h.setMarkdown("Reconciled.", { source: "rl-sync" }); // equal ⇒ skip
    expect(el.innerText).toBe("Reconciled.");

    // Structured: never imperatively rewritten (keeps rich DOM).
    const s = mount({ blockId: "blk-2", structured: true });
    const before = s.el.innerHTML;
    s.handles[0].setMarkdown("flattened", { source: "rl-sync" });
    expect(s.el.innerHTML).toBe(before);
  });
});
