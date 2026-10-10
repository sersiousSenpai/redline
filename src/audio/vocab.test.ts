// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoked: { cmd: string; args: unknown }[] = [];
let stored: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    invoked.push({ cmd, args });
    if (cmd === "get_ui_prefs") return Promise.resolve({ voiceVocab: stored });
    return Promise.resolve(null);
  }),
}));

import {
  addWord,
  buildVocab,
  learnPair,
  loadVocabStore,
  parseVocabStore,
  planVocab,
  removeWord,
  saveVocabStore,
  VOCAB_CAP,
  type VocabStore,
} from "./vocab";

const PLAN = `# Voice plan

## Door Interaction Rules

Keep Kokoro as the fallback, and run the Front Door through \`VoicePanel.tsx\`.
The Kokoro sidecar in \`tts.rs\` streams PCM; \`dictation_start\` takes an owner.
Describe the change. Rename VoicePanel to TalkPanel, and keep useStickToBottom.
Then the size budget: SIZE stays binding, and the Front Door stays light.

\`\`\`ts
const IgnoredInsideFences = notVocabulary_either;
\`\`\`
`;

describe("planVocab", () => {
  it("finds the code names: file names, CamelCase and snake_case, not fenced code", () => {
    const { identifiers } = planVocab(PLAN);
    for (const id of ["VoicePanel.tsx", "tts.rs", "VoicePanel", "TalkPanel", "useStickToBottom", "dictation_start"]) {
      expect(identifiers, id).toContain(id);
    }
    expect(identifiers.join(" ")).not.toMatch(/IgnoredInsideFences|notVocabulary_either/);
    expect(identifiers[0], "the most frequent first").toBe("VoicePanel");
  });

  it("finds the names a sentence capitalizes for their own sake, and acronyms", () => {
    const { terms } = planVocab(PLAN);
    expect(terms.slice(0, 2), "most frequent first").toEqual(["Kokoro", "Front Door"]);
    expect(terms).toContain("PCM");
    // A heading's title case, a sentence's opening verb, and a heading word
    // in capitals that the plan also writes in lowercase.
    for (const noise of ["Door Interaction Rules", "Interaction", "Describe", "Keep", "Then", "SIZE", "Voice"]) {
      expect(terms, noise).not.toContain(noise);
    }
  });
});

describe("buildVocab", () => {
  const store: VocabStore = {
    words: ["Qwen", "kokoro"],
    pairs: [
      { heard: "civ core", meant: "Kokoro", at: 2 },
      { heard: "tory", meant: "Tauri", at: 5 },
    ],
  };

  it("ranks the user's own words first, newest correction first, then the plan's names and code names", () => {
    const vocab = buildVocab({ plan: PLAN, store, identifiers: ["check-size.mjs", "VoicePanel"] });
    expect(vocab.slice(0, 4)).toEqual(["Tauri", "Kokoro", "Qwen", "Front Door"]);
    expect(vocab.indexOf("PCM")).toBeLessThan(vocab.indexOf("VoicePanel"));
    expect(vocab[vocab.length - 1]).toBe("check-size.mjs");
    expect(vocab.filter((t) => t.toLowerCase() === "kokoro"), "no repeats, whatever the case").toHaveLength(1);
  });

  it("caps the list and never lets a long plan crowd out the user's words", () => {
    const long = Array.from({ length: 400 }, (_, i) => `the Name${String.fromCharCode(65 + (i % 26))}x${i} here`).join(". ");
    const vocab = buildVocab({ plan: long, store });
    expect(vocab).toHaveLength(VOCAB_CAP);
    expect(vocab.slice(0, 3)).toEqual(["Tauri", "Kokoro", "Qwen"]);
    expect(buildVocab({ plan: PLAN }, 3)).toHaveLength(3);
    expect(buildVocab({})).toEqual([]);
  });
});

describe("the vocabulary store", () => {
  beforeEach(() => {
    invoked.length = 0;
    stored = null;
  });

  it("reads a missing or damaged blob as empty, and drops malformed entries", () => {
    expect(parseVocabStore(null)).toEqual({ words: [], pairs: [] });
    expect(parseVocabStore("{not json")).toEqual({ words: [], pairs: [] });
    expect(
      parseVocabStore(JSON.stringify({ words: ["Kokoro", 7], pairs: [{ heard: "a", meant: "b", at: 1 }, { heard: "x" }] })),
    ).toEqual({ words: ["Kokoro"], pairs: [{ heard: "a", meant: "b", at: 1 }] });
  });

  it("adds, re-adds and removes words; learns a pair once per heard text", () => {
    let s: VocabStore = { words: [], pairs: [] };
    s = addWord(addWord(addWord(s, "Kokoro"), "Tauri"), " kokoro ");
    expect(s.words).toEqual(["kokoro", "Tauri"]);
    s = learnPair(s, "civ core", "Kokoro", 1);
    s = learnPair(s, "Civ Core", "Kokoro.", 2);
    expect(s.pairs).toEqual([{ heard: "Civ Core", meant: "Kokoro.", at: 2 }]);
    expect(learnPair(s, "same", "same", 3)).toBe(s);
    s = removeWord(s, "KOKORO.");
    expect(s.pairs).toEqual([]);
    expect(removeWord(s, "kokoro").words).toEqual(["Tauri"]);
  });

  it("loads and saves through the voiceVocab ui pref", async () => {
    stored = JSON.stringify({ words: ["Kokoro"], pairs: [] });
    expect(await loadVocabStore()).toEqual({ words: ["Kokoro"], pairs: [] });
    await saveVocabStore({ words: ["Tauri"], pairs: [] });
    expect(invoked[invoked.length - 1]).toEqual({
      cmd: "set_ui_pref",
      args: { key: "voiceVocab", value: JSON.stringify({ words: ["Tauri"], pairs: [] }) },
    });
  });
});
