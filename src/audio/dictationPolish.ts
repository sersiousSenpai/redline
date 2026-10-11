// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The second cleanup tier for kept dictation: an AI polish that arrives after
// the words are already in. Insertion never waits for it (the rule tier,
// dictationCleanup.ts, has already run); a moment later it swaps the words
// for the polished ones — only if nobody has touched them since — and ⌘Z
// takes back the polish alone. It is spent only where it can earn its cost:
// more than `POLISH_MIN_WORDS` words, or a list. Never for a conversation
// turn (the agent reads messy speech fine), never for words "send it" has
// already sent, and not at all once the user turns it off.
//
// The engine sits behind `PolishEngine` (`polishEngine` below picks one). The
// local polish model comes first: a small model in the studio voice's sidecar
// (tts_studio.rs), installed from the studio voice's settings card, that never
// sends the words anywhere. Without it — or when it can't answer within its
// budget, about 0.7 s — the fixed cleanup child does it (voice.rs
// `voice_clean`: a fast model with no tools, kept warm). Both are told that
// the speaker is never talking to them and given the vocabulary's spellings,
// and the local one's every reply is checked in the sidecar as well. What
// comes back is checked here before it is used: an answer, a summary or a
// rewrite in place of a polish is thrown away.

import { Channel, invoke } from "@tauri-apps/api/core";

import { nextGeneration } from "./generation";

export interface PolishEngine {
  /** Polish dictated `text`, spelling the terms in `vocab` exactly as given. */
  polish(text: string, vocab: readonly string[]): Promise<string>;
  /** A dictation that will be polished started: get ready for `vocab`. */
  warm?(vocab: readonly string[]): void;
}

/** How many of the vocabulary's terms ride along: its ranked head. */
const SPELLINGS = 60;

/** The fixed cleanup child. Warming it starts the process (an empty text),
 *  so the first polish of a session doesn't wait out its cold start. */
export const cleanupChild: Required<PolishEngine> = {
  polish: (text, vocab) => invoke<string>("voice_clean", { text, vocab: vocab.slice(0, SPELLINGS) }),
  warm: () => void invoke("voice_clean", { text: "" }).catch(() => {}),
};

/** The terms the local model is given: the head, as the sidecar takes them
 *  (1–64 characters). The same list warms it and polishes, so the prompt it
 *  built while the user spoke is the one the polish uses. */
const localSpellings = (vocab: readonly string[]) =>
  vocab.filter((t) => t.trim() && t.length <= 64).slice(0, SPELLINGS);

/** Frame header flag (tts_studio.rs): the request's last frame. */
const FINAL = 1;
/** Rust gives up on a polish first (its budget); this is for a reply that
 *  never comes at all. */
export const LOCAL_LIMIT_MS = 8000;

/** The local polish model. Its reply is one frame on a Channel: the
 *  generation's low 32 bits, flags, then the outcome as JSON. Anything but a
 *  polish — not installed, slow, failed, cancelled — rejects. A reply the
 *  sidecar refused comes back as the words unchanged. Its warm-up answers
 *  whether it is installed and can load, so it will be the one to polish. */
export const localModel = {
  polish: (text, vocab) =>
    new Promise<string>((resolve, reject) => {
      // From the app-wide counter, so a speech driver's cancel never matches it.
      const generation = nextGeneration();
      const reply = new Channel<ArrayBuffer>();
      const timer = setTimeout(() => reject(new Error("slow")), LOCAL_LIMIT_MS);
      reply.onmessage = (data) => {
        if (data.byteLength < 12) return;
        const head = new DataView(data, 0, 12);
        if (head.getUint32(0, true) !== generation >>> 0 || !(head.getUint16(8, true) & FINAL)) return;
        clearTimeout(timer);
        let outcome: { type?: string; text?: unknown; code?: string } = {};
        try {
          outcome = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 12)));
        } catch {
          /* an outcome is always JSON; anything else is a failure */
        }
        if (outcome.type === "polished" && typeof outcome.text === "string") resolve(outcome.text);
        else reject(new Error(outcome.code ?? outcome.type ?? "error"));
      };
      const args = { text, vocab: localSpellings(vocab), generation };
      invoke("tts_studio", { op: "polish", args, onAudio: reply }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    }),
  warm: (vocab: readonly string[]) =>
    invoke<boolean>("tts_studio", { op: "warm", args: { polish: true, vocab: localSpellings(vocab) } }).catch(
      () => false,
    ),
} satisfies PolishEngine;

/** What dictation polishes with: the local model, which Rust refuses at once
 *  when it isn't installed, else — and whenever it fails — the cleanup child.
 *  Each warms for a dictation that will be polished: the local model when it
 *  is installed, else the cleanup child. */
export const polishEngine: PolishEngine = {
  polish: (text, vocab) => localModel.polish(text, vocab).catch(() => cleanupChild.polish(text, vocab)),
  warm: (vocab) =>
    void localModel.warm(vocab).then((local) => {
      if (!local) cleanupChild.warm(vocab);
    }),
};

/** Shorter dictations are left as the rules made them. */
export const POLISH_MIN_WORDS = 12;
/** A polish never lands sooner than this after the words it replaces: an
 *  editor keeps a separate undo step for it. */
export const POLISH_SETTLE_MS = 600;

const PREF = "redline.dictation.polish";

/** On unless the user turned it off (per machine, like the dictation key). */
export function polishEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) !== "off";
  } catch {
    return true;
  }
}

export function setPolishEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF, on ? "on" : "off");
  } catch {
    /* best-effort, like the voice prefs */
  }
}

/** A list said aloud: items the rules wrote, or counted clauses. */
const LIST_CUE = /^- |\n- |(?:^|[.,;:]\s+)(?:first(?:ly)?|second(?:ly)?|third(?:ly)?)\b|\bnumber (?:one|two|three)\b/i;

/** Whether dictated words are worth a polish. */
export function wantsPolish(text: string): boolean {
  return (text.match(/\S+/g)?.length ?? 0) > POLISH_MIN_WORDS || LIST_CUE.test(text);
}

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_.-]*/gu) ?? [];
const listItems = (s: string) => (s.match(/^- /gm) ?? []).length;

/** The polished words to put in place of `written`, or null to keep them:
 *  nothing changed, or what came back is not a polish of them. `written`'s
 *  own edges are kept — the space or break fitted before it, its first
 *  letter's case — and no full stop is added where the sentence runs on into
 *  `after`, the text that follows the words. */
export function polished(written: string, reply: string, vocab: readonly string[], after = ""): string | null {
  const lead = /^\s*/.exec(written)![0];
  const trail = /\s*$/.exec(written)![0];
  const core = written.trim();
  let p = reply
    .trim()
    .replace(/^<text>\s*|\s*<\/text>$/g, "")
    .trim();
  // Quotes around the whole reply are the model's, not the speaker's.
  if (/^["“][\s\S]*["”]$/.test(p) && !/^["“]/.test(core)) p = p.slice(1, -1).trim();
  if (!p) return null;
  const had = wordsOf(core);
  const got = wordsOf(p);
  if (!got.length) return null;
  // Words the speaker never said: an answer, or a rewrite.
  const pool = new Map<string, number>();
  for (const w of had) pool.set(w, (pool.get(w) ?? 0) + 1);
  let fresh = 0;
  for (const w of got) {
    const n = pool.get(w);
    if (n) pool.set(w, n - 1);
    else fresh += 1;
  }
  if (fresh > Math.max(2, got.length * 0.25)) return null;
  // Most of theirs gone (a summary), or more added than a polish adds.
  if (got.length < had.length * 0.6 || got.length > had.length + 3) return null;
  // Jargon kept as it was spelled, list items kept as items.
  if (vocab.some((term) => core.includes(term) && !p.includes(term))) return null;
  if (listItems(p) < listItems(core)) return null;
  // Its edges: it opens with the capital (or not) the text around it gave,
  // and runs on into the text after without a stop.
  if (p[0].toLowerCase() === core[0].toLowerCase()) p = core[0] + p.slice(1);
  if (!/[.!?…]$/.test(core) && /[^.]\.$/.test(p) && /^\s*[\p{Ll}\p{N}]/u.test(after)) p = p.slice(0, -1);
  return p === core ? null : lead + p + trail;
}
