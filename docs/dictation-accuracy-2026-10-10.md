# Dictation accuracy — measured 2026-10-10

**Target: at least 95% term accuracy on the default path. Status: open.** The best
default path measures 62.7%. Nothing shipped on this branch reaches the target, and
no change to the vocabulary or the rules will. What reaches the recognizers explains
most of the gap; the engines explain the rest.

## The test set

The shared dictation set has 150 clips: 50 repo-heavy phrases, each read by six
voices (four macOS `say` voices and two studio-voice presets), 16 kHz mono. The 50
phrases are about 74 terms: names such as Kokoro, DiscussPill and useStickToBottom,
and everyday words a developer uses (sidecar, worktree, git stash).

**Term accuracy** counts a term as heard when it appears verbatim in the output,
ignoring case, on word boundaries. "voice panel" for VoicePanel is a miss. The
`norm` column joins and splits words before comparing, and counts it.

## What each path scores

Each engine runs with the vocabulary the app would build for this repo. The plan is
the program's design brief and wave brief. Where a row says *project*, the project's
code names are added too (`dictation_identifiers` plus `projectVocab`), and Whisper's
prompt is capped at 75 terms. T0 is the rule cleanup. T0 + homophones adds its
near-homophone step.

| Engine and vocabulary | Raw | After T0 | T0 + homophones | Norm (T0 + homophones) | WER |
|---|---|---|---|---|---|
| Whisper base, plan prompt (before) | 61.8% | 61.8% | 62.7% | 71.9% | 13.7% |
| **Whisper base, project, 75 terms (default now)** | 61.4% | 61.4% | **62.7%** | 72.8% | 14.5% |
| Whisper turbo, plan prompt | 67.1% | 67.1% | 68.0% | 78.5% | 8.4% |
| Whisper turbo, project, 75 terms | 68.0% | 68.0% | 68.9% | 78.9% | 8.1% |
| Apple on-device, plan | 51.3% | 51.3% | 51.8% | 58.8% | 23.2% |
| Apple on-device, project | 50.0% | 50.0% | 50.4% | 58.8% | 23.4% |

The WER column is the raw output's word error. T0 leaves term accuracy unchanged on
its own. Its spelling step only recases terms the scorer already counts, and by
design it leaves an UpperCamel name said as words ("the voice panel") as words.

## Why the vocabulary can't close the gap

The realistic vocabulary covers only 13 of the 74 test terms in the 75 terms that
reach Whisper, and 17 in all 150. Most test terms are in no source the app reads:
they are not in the plan, the repo's file names or the memory titles. Given exactly
the 74 test terms as a prompt, the same engines reach about 81% (Whisper base and
turbo). That is still short of 95%.

A prompt of all 74 terms followed by 76 others measured worse than the 74 alone. Of
the plan's own ranked terms, the first 40 measured worse than the first 75. Hence
the 75-term cap.

## The near-homophone step

It writes a vocabulary name where the recognizer wrote something that sounds like
it and is spelled close to it. A match must meet one of two conditions:

- a single word capitalized mid-sentence, within half its letters of the name, or
  within one letter for a four-letter name;
- a run of words, one letter from the name when run together, never starting or
  ending on a small word like "the".

The step fixed these errors in the recognizers' output:

- "Coro" → Kokoro;
- "Tori" and "Tari" → Tauri;
- "corn ML" and "Coramel" → CoreML;
- "reply black" → reply block;
- "discuss bill" → discuss pill.

It changed nothing on the test set's own sentences. Across 3,333 lines of the repo's
docs, it changed only one other product's name to "Whisper", in two lines. That is
the false-positive risk it carries.

## Next (wave 3)

These numbers come from the HELPER lane's spike on the same set, with the oracle
terms.

**Recommended engine: Parakeet TDT v3 on Core ML with term boosting.** It reaches
87.2% strict term accuracy and 92.2% when words are joined.

**Option to measure: macOS's SpeechAnalyzer dictation transcriber.** It needs the
same vocabulary work, because neither engine gets there with the vocabulary the app
has today.

**Re-measure against the 95% bar with:**

- the engine;
- a vocabulary drawn from where the user's terms actually live: the memory index,
  the project's symbols beyond file names, and learned corrections.
