// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, Record<string, unknown> | undefined][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push([cmd, args]);
    return null;
  }),
}));

import { drafterExtensions } from "../editor/extensions/drafterExtensions";
import { pageInsertScript, placeText, resolveTarget, submitAfter, targetFor, type DictationTarget } from "./dictationTarget";
import { APP_KEYS } from "./voiceHotkey";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const editors: Editor[] = [];
beforeEach(() => {
  invoked.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const e of editors.splice(0)) e.destroy();
  document.body.innerHTML = "";
});

/** A chat composer as the app writes one: React owns the value, Enter sends. */
function Composer({ initial = "", onSend }: { initial?: string; onSend?: (text: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div data-dictation-send>
      <textarea
        aria-label="composer"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend?.(draft);
          }
        }}
      />
      <output>{draft}</output>
    </div>
  );
}

function Field({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />
      <output>{value}</output>
    </>
  );
}

const shown = () => host.querySelector("output")!.textContent;

describe("a text box", () => {
  it("takes the words at its caret, and React's state follows", async () => {
    await act(async () => root.render(<Composer initial="Fix the tray" />));
    const ta = host.querySelector("textarea")!;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const target = resolveTarget(document, APP_KEYS);
    expect(target).toMatchObject({ kind: "field", el: ta, send: true });
    await act(async () => void placeText(target, "and the scroll pin."));
    expect(ta.value).toBe("Fix the tray and the scroll pin.");
    expect(shown()).toBe("Fix the tray and the scroll pin.");
    // Focus stayed where it was.
    expect(document.activeElement).toBe(ta);
  });

  it("writes where the caret was when the key went down, without taking focus back", async () => {
    await act(async () => root.render(<Field initial="Hello world" />));
    const input = host.querySelector("input")!;
    input.focus();
    input.setSelectionRange(5, 5);
    const target = resolveTarget(document, APP_KEYS);
    input.blur();
    await act(async () => void placeText(target, "there"));
    expect(shown()).toBe("Hello there world");
    expect(document.activeElement).not.toBe(input);
  });

  it("keeps a one-line field on one line", async () => {
    await act(async () => root.render(<Field />));
    host.querySelector("input")!.focus();
    await act(async () => void placeText(resolveTarget(document, APP_KEYS), "- Fix the tray\n- Fix the pin"));
    expect(shown()).toBe("Fix the tray Fix the pin");
  });

  it("takes back the last phrase, then the rest, while nobody has touched it", async () => {
    await act(async () => root.render(<Composer initial="Note:" />));
    const ta = host.querySelector("textarea")!;
    ta.focus();
    ta.setSelectionRange(5, 5);
    let placed = null as ReturnType<typeof placeText>;
    await act(async () => void (placed = placeText(resolveTarget(document, APP_KEYS), "Make it 300 ms. Then ship it.")));
    expect(shown()).toBe("Note: make it 300 ms. Then ship it.");
    await act(async () => void placed!.takeBack(false));
    expect(shown()).toBe("Note: make it 300 ms.");
    await act(async () => void placed!.takeBack(true));
    expect(shown()).toBe("Note:");
    // Typed over: nothing to take back.
    await act(async () => void (placed = placeText(resolveTarget(document, APP_KEYS), "again")));
    ta.setRangeText("A", 6, 7);
    expect(placed!.takeBack(true)).toBe(false);
  });

  it("is sent the way its own Enter sends it, with the dictated words in", async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Composer onSend={onSend} />));
    host.querySelector("textarea")!.focus();
    const target = resolveTarget(document, APP_KEYS);
    await act(async () => {
      placeText(target, "compare the plans");
      await submitAfter(target);
    });
    expect(onSend).toHaveBeenCalledWith("Compare the plans");
  });

  it("is passed over when it takes no text", () => {
    for (const html of ['<input type="checkbox">', "<textarea readonly></textarea>", "<input disabled>", "<button>Go</button>"]) {
      host.innerHTML = html;
      expect(targetFor(host.firstElementChild)).toBeNull();
    }
  });
});

describe("the rich-text editor", () => {
  function makeEditor(html: string): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({ element: el, extensions: drafterExtensions(), content: html });
    editors.push(editor);
    return editor;
  }

  it("takes the words as its own content at the cursor", () => {
    const editor = makeEditor("<p>Rename the hook</p>");
    editor.commands.setTextSelection(16);
    const target = targetFor(editor.view.dom);
    expect(target?.kind).toBe("rich");
    const placed = placeText(target!, "and keep the <b> tag");
    expect(editor.getText()).toBe("Rename the hook and keep the <b> tag");
    // Undo while untouched.
    expect(placed!.takeBack(true)).toBe(true);
    expect(editor.getText()).toBe("Rename the hook");
  });

  it("makes paragraphs and list items of breaks and bullets", () => {
    const editor = makeEditor("<p>Plan</p>");
    editor.commands.setTextSelection(5);
    placeText(targetFor(editor.view.dom)!, "- Fix the queue tray\n- Fix the scroll pin");
    const list = editor.getJSON().content!.find((n) => n.type === "bulletList")!;
    expect(list.content!.map((item) => item.content![0].content![0].text)).toEqual(["Fix the queue tray", "Fix the scroll pin"]);
  });

  it("takes nothing back once the document has changed", () => {
    const editor = makeEditor("<p>One</p>");
    editor.commands.setTextSelection(4);
    const placed = placeText(targetFor(editor.view.dom)!, "two");
    editor.commands.insertContent("!");
    expect(placed!.takeBack(true)).toBe(false);
    expect(editor.getText()).toBe("One two!");
  });
});

describe("another editable area", () => {
  it("uses the browser's insertText command where the caret is", () => {
    host.innerHTML = '<div contenteditable="true">Hello</div>';
    const el = host.firstElementChild as HTMLElement;
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 5);
    range.collapse(true);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const target = resolveTarget(document, APP_KEYS);
    expect(target.kind).toBe("editable");
    const exec = vi.fn(() => true);
    const real = document.execCommand;
    document.execCommand = exec;
    try {
      placeText(target, "world");
    } finally {
      document.execCommand = real;
    }
    expect(exec).toHaveBeenCalledWith("insertText", false, " world");
  });

  it("falls back to the saved caret, and says so with an input event", () => {
    host.innerHTML = '<div contenteditable="true">Hello</div>';
    const el = host.firstElementChild as HTMLElement;
    const heard = vi.fn();
    el.addEventListener("input", heard);
    const target: DictationTarget = { kind: "editable", el, range: null, send: false };
    const placed = placeText(target, "world.");
    expect(el.textContent).toBe("Hello world.");
    expect(heard).toHaveBeenCalledOnce();
    placed!.takeBack(true);
    expect(el.textContent).toBe("Hello");
  });
});

describe("the terminal and web pages", () => {
  it("types one line into the terminal, never a return", () => {
    host.innerHTML = '<textarea class="xterm-helper-textarea"></textarea>';
    const ta = host.querySelector("textarea")!;
    ta.focus();
    const typed: (string | null)[] = [];
    ta.addEventListener("input", (e) => typed.push((e as InputEvent).data));
    const target = resolveTarget(document, APP_KEYS);
    expect(target.kind).toBe("terminal");
    placeText(target, "run the tests\nnow");
    expect(typed).toEqual(["Run the tests now"]);
    expect(ta.value).toBe("");
  });

  it("types into a web page's focused field from inside the page", () => {
    expect(resolveTarget(document, { page: "browser-t1", field: true })).toEqual({ kind: "page", label: "browser-t1" });
    placeText({ kind: "page", label: "browser-t1" }, "search for kokoro");
    expect(invoked).toEqual([["browser_eval", { label: "browser-t1", script: pageInsertScript("Search for kokoro") }]]);
    // The script, run in a page.
    host.innerHTML = '<input value="find">';
    const input = host.querySelector("input")!;
    input.focus();
    input.setSelectionRange(4, 4);
    // (A DOM without editing commands: the field's own way in.)
    document.execCommand = () => false;
    new Function(pageInsertScript("cats"))();
    expect(input.value).toBe("find cats");
  });

  it("sends a page without a field to the page chat's composer, or makes a turn", async () => {
    expect(resolveTarget(document, { page: "browser-t1", field: false })).toEqual({ kind: "turn" });
    host.innerHTML = '<div data-browser-chat-composer><textarea></textarea></div>';
    const target = resolveTarget(document, { page: "browser-t1", field: false });
    expect(target).toMatchObject({ kind: "field", el: host.querySelector("textarea") });
  });
});

describe("resolveTarget", () => {
  it("makes a turn with nothing that takes text focused, or focus in the voice panel", () => {
    expect(resolveTarget(document, APP_KEYS)).toEqual({ kind: "turn" });
    host.innerHTML = '<div data-dictation-turn><input aria-label="Type a message"></div>';
    host.querySelector("input")!.focus();
    expect(resolveTarget(document, APP_KEYS)).toEqual({ kind: "turn" });
  });

  it("puts words said with nothing focused into the open door's box, as typing does", () => {
    host.innerHTML = "<textarea data-dictation-default></textarea>";
    expect(resolveTarget(document, APP_KEYS)).toMatchObject({ kind: "field", el: host.querySelector("textarea") });
    // Never from a web page, and never instead of the voice panel.
    expect(resolveTarget(document, { page: "browser-t1", field: false })).toEqual({ kind: "turn" });
    host.insertAdjacentHTML("beforeend", "<div data-dictation-turn><button>Talk</button></div>");
    host.querySelector("button")!.focus();
    expect(resolveTarget(document, APP_KEYS)).toEqual({ kind: "turn" });
  });
});
