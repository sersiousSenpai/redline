// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Where dictated words go: the cursor decides. Resolved when the key goes
// down (where the cursor was when you started speaking), written when it
// comes up, and never by moving focus:
//
// - a text box (input, textarea): `setRangeText` plus a native `input` event,
//   so a React-controlled field's onChange sees the new value;
// - the rich-text editor (the Drafter, the plan editor): its `insertContent`,
//   so the words become its own transaction (tracked, undoable);
// - any other editable area: the browser's `insertText` command;
// - the terminal: typed into it, one line, never with a return;
// - a web page in the browser pane: its focused field, through the page;
// - nothing that takes text: the open Front Door's box (where typing with
//   nothing focused goes, too), else a turn in the conversation (the session
//   decides which).
//
// What a field is for comes from the composer it is in
// (lib/dictationComposer.ts): in a chat composer "send it" submits, as its own
// Enter does; in the voice panel what is said is a turn.

import { invoke } from "@tauri-apps/api/core";

import { composers, type ComposerEntry, type ComposerSpec } from "../lib/dictationComposer";
import { fitToContext } from "./dictationCleanup";
import type { AroundText } from "./vocabLearn";
import { lastPhraseStart } from "./voiceIntents";
import type { KeySource } from "./voiceHotkey";

/** The part of a TipTap editor used here (`.ProseMirror` carries it). */
export interface RichEditor {
  isDestroyed: boolean;
  state: {
    doc: { textBetween(from: number, to: number, block?: string, leaf?: string): string; content: { size: number } };
    selection: { from: number; to: number };
  };
  commands: {
    insertContent(value: unknown): boolean;
    insertContentAt(range: { from: number; to: number }, value: unknown): boolean;
    deleteRange(range: { from: number; to: number }): boolean;
  };
  view: { coordsAtPos(pos: number): { left: number; top: number; bottom: number } };
  on(event: "update", fn: () => void): unknown;
  off(event: "update", fn: () => void): unknown;
}

export type DictationTarget =
  | { kind: "field"; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number; send: boolean }
  | { kind: "rich"; el: HTMLElement; editor: RichEditor; send: boolean }
  | { kind: "editable"; el: HTMLElement; range: Range | null; send: boolean }
  | { kind: "terminal"; el: HTMLTextAreaElement }
  | { kind: "page"; label: string }
  | { kind: "turn" };

const TEXT_INPUTS = new Set(["", "text", "search", "url", "email", "tel"]);
/** An editable area by its attribute, where `isContentEditable` isn't
 *  computed (a DOM without layout). */
const EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

/** The page chat's composer: where words said over a web page go when the
 *  page's own focus takes no text. */
const PAGE_CHAT_FIELD = "[data-browser-chat-composer] textarea";

/** A registered composer as it stands: its frame, how it takes dictation,
 *  and the field its mic and the fallback write into. */
export interface Composer {
  frame: HTMLElement;
  spec: ComposerSpec;
  field: HTMLElement | null;
}

const view = (e: ComposerEntry): Composer => ({
  frame: e.frame,
  spec: e.spec.current ?? {},
  field: e.field?.current ?? e.frame.querySelector<HTMLElement>("textarea, input"),
});

/** The composer `el` is in, if any. */
export function composerAt(el: Element | null): Composer | null {
  for (let n = el; n; n = n.parentElement) {
    const e = composers.get(n as HTMLElement);
    if (e) return view(e);
  }
  return null;
}

/** The composer that takes what is said with nothing focused, if one shows. */
export function fallbackComposer(): Composer | null {
  for (const e of composers.values()) if (e.spec.current?.fallback && e.frame.isConnected) return view(e);
  return null;
}

/** What `el` takes text as, if anything. */
export function targetFor(el: Element | null): DictationTarget | null {
  if (!el) return null;
  const send = !!composerAt(el)?.spec.send;
  if (el instanceof HTMLTextAreaElement) {
    if (el.classList.contains("xterm-helper-textarea")) return { kind: "terminal", el };
    if (el.disabled || el.readOnly) return null;
    return { kind: "field", el, start: el.selectionStart, end: el.selectionEnd, send };
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly || !TEXT_INPUTS.has(el.getAttribute("type") ?? "")) return null;
    const end = el.value.length;
    return { kind: "field", el, start: el.selectionStart ?? end, end: el.selectionEnd ?? end, send };
  }
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest(EDITABLE))) {
    const host = el.closest<HTMLElement & { editor?: RichEditor }>(".ProseMirror");
    if (host?.editor && !host.editor.isDestroyed) return { kind: "rich", el: host, editor: host.editor, send };
    const sel = el.ownerDocument.getSelection();
    const range = sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    return { kind: "editable", el, range, send };
  }
  return null;
}

/** Where the words of a capture that began with this key press go. */
export function resolveTarget(doc: Document, source: KeySource): DictationTarget {
  if (source.page !== null) {
    if (source.field) return { kind: "page", label: source.page };
    return targetFor(doc.querySelector(PAGE_CHAT_FIELD)) ?? { kind: "turn" };
  }
  const active = doc.activeElement;
  if (composerAt(active)?.spec.turn) return { kind: "turn" };
  // Nothing that takes text focused: the open door's box, where typing with
  // nothing focused goes too; otherwise a turn.
  return targetFor(active) ?? targetFor(fallbackComposer()?.field ?? null) ?? { kind: "turn" };
}

/** The element a target writes into, for the strip to sit on. */
export function targetElement(t: DictationTarget): HTMLElement | null {
  return "el" in t ? t.el : null;
}

/** Whether "send it" has something to submit. */
export function canSend(t: DictationTarget): boolean {
  return "send" in t && t.send;
}

/** A dictation written into its target, which can take itself back while
 *  nobody has touched it: all of it ("undo"), or its last phrase ("scratch
 *  that"). Each takes back what is left after the one before. */
export interface Placed {
  el: HTMLElement;
  /** Its words as they stand: what was written, or a polish put in place. */
  text(): string;
  /** Nobody has changed the field (or the document) since they were. */
  untouched(): boolean;
  takeBack(all: boolean): boolean;
  /** Put `next` in place of the words while untouched; ⌘Z puts them back —
   *  the field's, or the editor's own undo. Absent where words can't be
   *  swapped: an editable area, a rich-text dictation of several lines. */
  replace?(next: string): boolean;
  /** The text the words sit in, for learning the corrections made to them. */
  around?: AroundText;
}

/** True while a change is the dictation's own, so the input listeners that
 *  learn corrections can tell it from the user's. */
let writing = false;
const announce = (el: Element, inputType: string, data: string | null) => {
  writing = true;
  try {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  } finally {
    writing = false;
  }
};

/** How many times each field dictated into has changed: by the user, or by
 *  a later dictation (whose words moved this one's). */
const edits = new WeakMap<Element, number>();
function editCount(el: HTMLElement): number {
  if (!edits.has(el)) {
    edits.set(el, 0);
    el.addEventListener("input", () => edits.set(el, (edits.get(el) ?? 0) + 1));
  }
  return edits.get(el)!;
}

/** How much of `written` the last phrase starts at, ignoring the space
 *  before it; 0 for all of it. */
function phraseCut(written: string, all: boolean): number {
  if (all) return 0;
  let cut = lastPhraseStart(written);
  while (cut > 0 && /\s/.test(written[cut - 1])) cut -= 1;
  return cut;
}

/** ⌘Z (Ctrl+Z), and not ⌘⇧Z. */
const isUndo = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z";

function placeInField(t: Extract<DictationTarget, { kind: "field" }>, text: string): Placed | null {
  const el = t.el;
  // Still in the field: wherever its caret is now. Elsewhere: where it was.
  const live = el.ownerDocument.activeElement === el;
  const len = el.value.length;
  const start = Math.min(live ? (el.selectionStart ?? t.start) : t.start, len);
  const end = Math.min(live ? (el.selectionEnd ?? t.end) : t.end, len);
  const line = el instanceof HTMLInputElement;
  const fitted = fitToContext(text, el.value.slice(0, start), el.value.slice(end), { line });
  if (!fitted) return null;
  editCount(el);
  el.setRangeText(fitted, start, end, "end");
  announce(el, "insertText", fitted);
  let written = fitted;
  let version = editCount(el);
  const intact = () => el.isConnected && el.value.slice(start, start + written.length) === written;
  const untouched = () => intact() && editCount(el) === version;
  /** Swap the words for `next`, the caret kept where it was relative to them. */
  const swap = (next: string, inputType: string) => {
    const delta = next.length - written.length;
    const oldEnd = start + written.length;
    const keep = (at: number | null) => (at === null || at < oldEnd ? at : at + delta);
    const [selStart, selEnd] = [keep(el.selectionStart), keep(el.selectionEnd)];
    el.setRangeText(next, start, oldEnd, "end");
    if (selStart !== null && selEnd !== null) el.setSelectionRange(selStart, selEnd);
    written = next;
    announce(el, inputType, next);
    version = editCount(el);
  };
  return {
    el,
    text: () => written,
    untouched,
    takeBack(all) {
      if (!intact()) return false;
      const cut = phraseCut(written, all);
      el.setRangeText("", start + cut, start + written.length, "end");
      written = written.slice(0, cut);
      announce(el, "deleteContentBackward", null);
      version = editCount(el);
      return true;
    },
    replace(next) {
      if (!untouched()) return false;
      const before = written;
      swap(next, "insertReplacementText");
      // ⌘Z takes back the polish alone, while nothing else has changed:
      // the field's own undo never saw either write.
      const box: HTMLElement = el;
      const undo = (e: KeyboardEvent) => {
        if (!isUndo(e)) return;
        box.removeEventListener("keydown", undo, true);
        if (!untouched() || written !== next) return;
        e.preventDefault();
        swap(before, "historyUndo");
      };
      box.addEventListener("keydown", undo, true);
      return true;
    },
    around: {
      value: () => el.value,
      span: () => [start, start + written.length],
      onEdit(fn) {
        const heard = () => {
          if (!writing) fn();
        };
        el.addEventListener("input", heard);
        return () => el.removeEventListener("input", heard);
      },
    },
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Dictated text with breaks or list items, as editor HTML. */
function richHtml(text: string): string {
  return text
    .replace(/^\n+/, "")
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split("\n");
      if (lines.every((l) => l.startsWith("- "))) {
        return `<ul>${lines.map((l) => `<li><p>${escapeHtml(l.slice(2))}</p></li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
    })
    .join("");
}

function placeInRich(t: Extract<DictationTarget, { kind: "rich" }>, text: string): Placed | null {
  const { editor, el } = t;
  if (editor.isDestroyed) return null;
  const { from, to } = editor.state.selection;
  const doc = editor.state.doc;
  const before = doc.textBetween(Math.max(0, from - 200), from, "\n", " ");
  const after = doc.textBetween(to, Math.min(doc.content.size, to + 2), "\n", " ");
  const fitted = fitToContext(text, before, after);
  if (!fitted) return null;
  const inline = !fitted.includes("\n");
  // A text node as JSON, never a string: a string is parsed as HTML, which
  // would eat "<" and the space a word needs in front of it.
  writing = true;
  try {
    editor.commands.insertContent(inline ? { type: "text", text: fitted } : richHtml(fitted));
  } finally {
    writing = false;
  }
  let end = editor.state.selection.to;
  let mine = editor.state.doc;
  let written = fitted;
  const untouched = () => !editor.isDestroyed && editor.state.doc === mine;
  const all = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ");
  return {
    el,
    text: () => written,
    untouched,
    takeBack(all) {
      if (!untouched()) return false;
      // Positions are characters only while the dictation was one line.
      const cut = inline ? phraseCut(written, all) : 0;
      editor.commands.deleteRange({ from: from + cut, to: end });
      written = written.slice(0, cut);
      end = from + cut;
      mine = editor.state.doc;
      return true;
    },
    // One editor transaction: its own undo step, so ⌘Z takes back the
    // polish and leaves the words as first written.
    replace: inline
      ? (next) => {
          if (!untouched() || next.includes("\n")) return false;
          writing = true;
          try {
            editor.commands.insertContentAt({ from, to: end }, { type: "text", text: next });
          } finally {
            writing = false;
          }
          written = next;
          end = from + next.length;
          mine = editor.state.doc;
          return true;
        }
      : undefined,
    around: inline
      ? {
          value: all,
          span() {
            const at = editor.state.doc.textBetween(0, from, "\n", " ").length;
            return [at, at + written.length];
          },
          onEdit(fn) {
            const heard = () => {
              if (!writing) fn();
            };
            editor.on("update", heard);
            return () => editor.off("update", heard);
          },
        }
      : undefined,
  };
}

function placeInEditable(t: Extract<DictationTarget, { kind: "editable" }>, text: string): Placed | null {
  const { el } = t;
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  const live = el.contains(doc.activeElement) && !!sel?.rangeCount && el.contains(sel.anchorNode);
  const range = live ? sel!.getRangeAt(0).cloneRange() : (t.range ?? endOf(el));
  const head = doc.createRange();
  head.selectNodeContents(el);
  head.setEnd(range.startContainer, range.startOffset);
  const fitted = fitToContext(text, head.toString());
  if (!fitted) return null;
  // The editing command where it can run (a focused area): the browser's
  // own insertion, undoable with ⌘Z. Otherwise, at the saved caret.
  if (live && doc.execCommand?.("insertText", false, fitted)) {
    let touched = false;
    el.addEventListener("input", () => (touched = true), { once: true });
    return {
      el,
      text: () => fitted,
      untouched: () => !touched,
      takeBack: () => !touched && el.contains(doc.activeElement) && doc.execCommand("undo"),
    };
  }
  const node = doc.createTextNode(fitted);
  range.deleteContents();
  range.insertNode(node);
  announce(el, "insertText", fitted);
  return {
    el,
    text: () => node.data,
    untouched: () => node.isConnected,
    takeBack(all) {
      if (!node.isConnected || !node.data) return false;
      node.data = node.data.slice(0, phraseCut(node.data, all));
      announce(el, "deleteContentBackward", null);
      return true;
    },
  };
}

function endOf(el: HTMLElement): Range {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  return range;
}

/** Type into a web page's focused field, from inside the page. */
export function pageInsertScript(text: string): string {
  return `(function(t){var e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;if(!e)return;var v=e.value,s=e.selectionStart;if(typeof v==='string'&&typeof s==='number'&&s>0&&!/\\s/.test(v[s-1]))t=' '+t;if(document.execCommand('insertText',false,t))return;if(typeof e.setRangeText==='function'){e.setRangeText(t,s,e.selectionEnd,'end');e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:t}));}})(${JSON.stringify(text)})`;
}

/** Write cleaned dictation into its target. A turn is not written here. */
export function placeText(t: DictationTarget, text: string): Placed | null {
  switch (t.kind) {
    case "field":
      return placeInField(t, text);
    case "rich":
      return placeInRich(t, text);
    case "editable":
      return placeInEditable(t, text);
    case "terminal": {
      // Typed, as keys would be: xterm turns an `insertText` input into the
      // characters it sends. One line — a newline here would press return.
      const line = fitToContext(text, "", "", { line: true });
      if (line) announce(t.el, "insertText", line);
      return null;
    }
    case "page": {
      const line = fitToContext(text, "", "", {});
      if (line) void invoke("browser_eval", { label: t.label, script: pageInsertScript(line) }).catch(() => {});
      return null;
    }
    case "turn":
      return null;
  }
}

/** "Send it": submit the composer the way its own Enter does — after the
 *  inserted text has reached its state (a frame later, not in the same task
 *  as the input event, whose update React has yet to render). */
export function submitAfter(t: DictationTarget): Promise<void> {
  const el = targetElement(t);
  return new Promise((done) =>
    setTimeout(() => {
      el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      done();
    }, 0),
  );
}
