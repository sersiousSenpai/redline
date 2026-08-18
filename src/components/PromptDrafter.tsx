// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, CornerDownLeft, Library, Plus, X } from "lucide-react";

import { drafterExtensions } from "../editor/extensions/drafterExtensions";
import { resolveInstructionBlock } from "../editor/extensions/InstructionTrigger";
import { planDocToMarkdown } from "../editor/markdown/serializer";
import {
  acceptAllUserSuggestions,
  acceptDraftSuggestion,
  acceptUserSuggestion,
  applyDraftSuggestion,
  hasPendingUserSuggestions,
  rejectAllUserSuggestions,
  rejectDraftSuggestion,
  rejectUserSuggestion,
  suggestionLeaves,
  type DraftSuggestionRow,
} from "../editor/drafterSuggestions";
import {
  isPendingSuggestionMark,
  USER_AUTHOR,
} from "../editor/extensions/TrackChanges";
import { DrafterToolbar } from "./DrafterToolbar";
import { DrafterFindBar } from "./DrafterFindBar";
import { DrafterSidecar } from "./DrafterSidecar";
import { DiscussPill } from "./DiscussPill";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { BlockedLaunch, ReadinessStrip } from "./ReadinessStrip";
import { WorkingIndicator } from "./WorkingIndicator";
import { CopyChip } from "./CopyChip";
import { AnchoredOverlay } from "./AnchoredOverlay";
import { Panel, useClickPopover } from "./popover";
import type { AnchorRect } from "../lib/anchorPlacement";
import { drafterModeKey } from "../lib/drafterCache";
import type { BookshelfDraft, DraftSource } from "../lib/bookshelf";
import type { DrafterStarter } from "../lib/drafterOpening";
import {
  attemptLaunch,
  composePrompt,
  launchReceipt,
  type PendingLaunch,
} from "../lib/launch";
import type { ReadinessItem } from "../lib/readiness";
import { useTextSelection } from "../hooks/useTextSelection";
import type { CommentHighlightRange } from "../editor/extensions/CommentHighlights";
import type { DraftComment } from "../types";

interface PromptDrafterProps {
  /** The draft's durable identity — keys its agents, comments, and memory. */
  draftId: string;
  /** The document to open (Tiptap JSON), or null for a blank one. The host
   *  guarantees this is the LATEST content ever on screen for `draftId` this
   *  session (its in-session cache, falling back to a DB read — the Bookshelf
   *  owns storage), and that it never belongs to a different draft: the host
   *  gates the mount on its id tag. Captured once, at editor creation — later
   *  prop changes are the host mirroring this editor's own flushes back. */
  doc: JSONContent | null;
  /** Called (debounced) with the document AND its markdown mirror, together.
   *  One callback, because they are one write: `doc_json` is the fidelity
   *  source and `doc_markdown` is the projection agents read, and a mirror that
   *  can land without its document is how the two drift. */
  onPersist: (json: JSONContent, markdown: string) => void;
  /** Candidate project directories for the launch picker. */
  projectOptions: ProjectOption[];
  /** Selected project dir, or null for $HOME. */
  selectedProject: string | null;
  onSelectedProjectChange: (path: string | null) => void;
  /** Launch a fresh Claude plan session with this prompt (markdown) + cwd. */
  onLaunch: (markdown: string, projectPath: string | null) => void;
  /** Live readiness. Deliberately NOT rendered as a standing strip here — see
   *  the launch bar below. Two moments only: a refused launch, and the silent
   *  wait after one. A permanent fault row under someone's prose is chrome they
   *  learn to stop seeing, which is the exact failure readiness exists to fix. */
  readiness?: ReadinessItem[];
  /** Runs a readiness item's fix; resolves true when the fault is cleared. */
  onFix?: (item: ReadinessItem) => Promise<boolean>;
  /** THIS document's in-flight launch, or null. The host passes it only when
   *  `pending.draftId` matches `draftId` — a card on the wrong document would
   *  claim a launch that isn't this one's. */
  pending?: PendingLaunch | null;
  /** This document's attached sources. They are DURABLE (rows in
   *  `draft_sources`, files copied into the document's source directory at
   *  capture time), not a per-launch list — and at launch their paths ride out
   *  as the plan session's `Context:` list. */
  sources?: DraftSource[];
  /** Copy files in and attach them. Null hides the `+` and the drop target. */
  onAttachFiles?: ((paths: string[]) => void) | null;
  onRemoveSource?: (id: string) => void;
  /** Retire the launch card without launching again. */
  onDismissPending?: () => void;
  /** Templates on the shelf, offered on a blank page. Clicking one mints a new
   *  document from it — the host owns the mint. */
  templates?: BookshelfDraft[];
  onUseTemplate?: (draftId: string) => void;
  /** Open the draft's discussion (the voice panel — talk or type). Null
   *  hides the floating Discuss pill. */
  onDiscuss?: (() => void) | null;
  /** Show the shelf — the folder tree + document list this document sits in. */
  onOpenShelf?: () => void;
  /** Back to the Front Door's one-line composer. Rendered in the launch bar
   *  with the rest of this surface's navigation — a floating chip at the top
   *  would land on the ribbon, which is where the first attempt put it. */
  onExit?: (() => void) | null;
  /** The documents dropdown (host-wired), mounted beside the Bookshelf button. */
  documentsMenu?: React.ReactNode;
  /** Persistence status, rendered quietly next to the word count. The host
   *  owns the write (and its retries); this just says how it's going. */
  saveState?: DrafterSaveState | null;
  /** The landing handoff (A4): returns the keystrokes the host buffered
   *  between the first key typed on the landing and this editor taking
   *  focus, and resets the handoff. Called atomically with the mount focus;
   *  empty on ordinary opens. */
  consumeSeed?: (() => string) | null;
  /** Hands the host a getter for the LIVE markdown mirror (sidecars on), so
   *  the drafter-keyed voice panel can flush exactly what's on screen before
   *  each turn instead of the debounce-lagged persisted mirror. Called with
   *  null on unmount. */
  registerLiveMarkdown?: ((get: (() => string) | null) => void) | null;
}

/** Everything the surface reflects about the live document. Flat and primitive
 *  on purpose: `useEditorState` compares snapshots with `deepEqual`, so a shape
 *  like this is what turns a keystroke into zero renders. */
interface DrafterView {
  words: number;
  isEmpty: boolean;
  isFocused: boolean;
  hasUserRuns: boolean;
  canInstruct: boolean;
}

/** What the footer's save indicator can say. `savedAt` is epoch ms. */
export interface DrafterSaveState {
  kind: "saving" | "saved" | "retrying";
  savedAt?: number;
}

// The Prompt Drafter: a Word-style document editor for authoring a prompt and
// launching it into a new Claude Code plan session. JSON is the in-editor source
// of truth (full fidelity, persisted); markdown is generated only at send time.
// Stable identities for the optional list props — a fresh `[]` default would
// change on every render and defeat the memo() this component is wrapped in.
const EMPTY_READINESS: ReadinessItem[] = [];
const EMPTY_SOURCES: DraftSource[] = [];
const EMPTY_TEMPLATES: BookshelfDraft[] = [];
// The idle flush: a pause in typing this long lands the write.
const PERSIST_DEBOUNCE_MS = 400;
// The max-wait cap: a pure debounce never fires under sustained typing, so an
// un-flushed edit this old forces the write regardless.
const PERSIST_MAX_WAIT_MS = 2000;

function PromptDrafterBase({
  draftId,
  doc,
  onPersist,
  projectOptions,
  selectedProject,
  onSelectedProjectChange,
  onLaunch,
  readiness = EMPTY_READINESS,
  onFix,
  pending = null,
  sources = EMPTY_SOURCES,
  onAttachFiles = null,
  onRemoveSource,
  onDismissPending,
  templates = EMPTY_TEMPLATES,
  onUseTemplate,
  onDiscuss = null,
  onOpenShelf,
  onExit = null,
  documentsMenu = null,
  saveState = null,
  consumeSeed = null,
  registerLiveMarkdown = null,
}: PromptDrafterProps) {
  const persistTimer = useRef<number | null>(null);
  // When the oldest un-flushed edit happened — drives the max-wait cap.
  const firstPendingAt = useRef<number | null>(null);
  // Latest onPersist without re-creating the editor on identity churn.
  const onPersistRef = useRef(onPersist);
  onPersistRef.current = onPersist;
  // Persist the document + its markdown mirror (sidecars ON so block ids
  // survive for the agents' block-addressed suggestions) as one write.
  const persistNow = useCallback((ed: NonNullable<typeof editor>) => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    firstPendingAt.current = null;
    onPersistRef.current(
      ed.getJSON(),
      planDocToMarkdown(ed.state.doc, { sidecars: true }),
    );
  }, []);

  // "Resolve it first": a user edit inside a block owned by a pending agent
  // suggestion is filtered by TrackChangesInput's lock — surface why,
  // transiently. Ref-routed so the extension (created once) stays current.
  const [lockedNote, setLockedNote] = useState<string | null>(null);
  const lockedNoteTimer = useRef<number | null>(null);
  const showLockedNote = useCallback(() => {
    setLockedNote(
      "That text is part of a pending suggestion — accept or reject it first.",
    );
    if (lockedNoteTimer.current !== null)
      window.clearTimeout(lockedNoteTimer.current);
    lockedNoteTimer.current = window.setTimeout(
      () => setLockedNote(null),
      3500,
    );
  }, []);
  const showLockedNoteRef = useRef(showLockedNote);
  showLockedNoteRef.current = showLockedNote;
  // ✦ instruction dispatch, ref-routed: the extension set is created once,
  // the handler must stay current.
  const runInstructRef = useRef<(blockId: string, text: string) => void>(
    () => {},
  );

  const editor = useEditor({
    // The jank, in one flag. `useEditor` re-renders its host on EVERY
    // ProseMirror transaction by default — so a keystroke re-rendered ~2,800
    // lines of JSX and walked the document three times to recompute a word
    // count. Everything this surface reflects now comes through
    // `useEditorState` selectors instead (here and in DrafterToolbar, which
    // must have its own or the ribbon freezes).
    shouldRerenderOnTransaction: false,
    extensions: drafterExtensions({
      onLockedEdit: () => showLockedNoteRef.current(),
      onInstruct: (blockId, text) => runInstructRef.current(blockId, text),
    }),
    content: doc ?? undefined,
    editorProps: {
      attributes: {
        class: "rl-prose font-serif",
        "data-drafter": "true",
      },
    },
    onUpdate: ({ editor }) => {
      // Debounce the write — avoid a serialize+stringify per keystroke — but
      // cap how long an edit can wait: under sustained typing the 400ms idle
      // window never opens, and a pure debounce would hold the write forever.
      const now = Date.now();
      if (firstPendingAt.current === null) firstPendingAt.current = now;
      const overdue = now - firstPendingAt.current >= PERSIST_MAX_WAIT_MS;
      if (persistTimer.current !== null)
        window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(
        () => persistNow(editor),
        overdue ? 0 : PERSIST_DEBOUNCE_MS,
      );
    },
  });

  // Land a blinking caret at the end of the document once the pane is mounted.
  // Done in an effect (not useEditor's `autofocus`, which targets the wrong
  // instance under React.StrictMode's mount→unmount→remount) and deferred a
  // frame so the ProseMirror view is in the DOM before we focus it.
  const consumeSeedRef = useRef(consumeSeed);
  consumeSeedRef.current = consumeSeed;
  useEffect(() => {
    if (!editor) return;
    const raf = requestAnimationFrame(() => {
      // Not just `isDestroyed`: a view that exists but is NOT CONNECTED can't
      // take the insert or the focus, and `consumeSeed` is destructive — one
      // dropped frame and the landing's keystrokes are gone with no second
      // chance. The connected check has to come BEFORE the consume.
      if (editor.isDestroyed || !editor.view.dom.isConnected) return;
      // The landing handoff: keystrokes typed between the landing's first
      // key and this focus were buffered by the host — insert them ahead of
      // the caret, in the same synchronous block as the focus, so no keydown
      // can land between the two. A text node, not a string: insertContent
      // parses strings as markup, and the user may well have typed a "<".
      const seed = consumeSeedRef.current?.() ?? "";
      if (seed) editor.commands.insertContent({ type: "text", text: seed });
      editor.commands.focus("end");
    });
    return () => cancelAnimationFrame(raf);
  }, [editor]);

  // Flush any pending debounced write on unmount (toggling the pane closed
  // shouldn't drop the last few keystrokes).
  useEffect(() => {
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        if (editor && !editor.isDestroyed) persistNow(editor);
      }
    };
  }, [editor, persistNow]);

  // Quit flush. The unmount effect covers toggling the pane; it does NOT
  // cover app quit, where the webview is torn down wholesale. `beforeunload`
  // still runs synchronously then — persistNow calls the host's onPersist,
  // which writes the localStorage crash shadow before its async invoke, and
  // the shadow is the part guaranteed to land during teardown.
  useEffect(() => {
    const flush = () => {
      if (persistTimer.current !== null && editor && !editor.isDestroyed) {
        persistNow(editor);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [editor, persistNow]);

  // Word's Editing/Suggesting switch. Editing (default): keystrokes are plain
  // edits. Suggesting: TrackChangesInput paints them as pending tracked runs.
  // Persisted per draft; auto-flips ON (with a note) the first time an agent
  // suggestion lands as `proposed`, so the user doesn't destructively type
  // over a document that has entered review flow.
  const [suggesting, setSuggestingState] = useState<boolean>(
    () => localStorage.getItem(drafterModeKey(draftId)) === "suggesting",
  );
  const suggestingRef = useRef(suggesting);
  suggestingRef.current = suggesting;
  const [modeNote, setModeNote] = useState<string | null>(null);
  const setSuggesting = useCallback(
    (on: boolean) => {
      setSuggestingState(on);
      try {
        localStorage.setItem(
          drafterModeKey(draftId),
          on ? "suggesting" : "editing",
        );
      } catch {
        /* quota / private mode — mode just won't persist */
      }
    },
    [draftId],
  );
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setSuggesting(suggesting);
  }, [editor, suggesting]);

  // --- ✦ co-authoring: instruction → generate ------------------------------
  // Blocks the doc agent is currently generating into. They pulse
  // (`.rl-generating`) and are folded into the locked set so the user can't
  // edit the instruction out from under the agent mid-turn (the
  // debounce-window race the plan calls out).
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setGeneratingBlocks([...generating]);
  }, [editor, generating]);
  // One ✦ turn at a time (the backend busy-guards too); done/error events are
  // only ours to handle while this is set.
  const instructInFlight = useRef(false);
  const lastInstruct = useRef<{
    blockId: string;
    text: string;
    sel: { quote: string; charStart: number; charEnd: number } | null;
  } | null>(null);
  // The agent's one-short-line chat reply after a ✦ turn, shown transiently.
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const agentNoteTimer = useRef<number | null>(null);
  // One transient banner for anything the USER did that failed — a ✦ turn, a
  // comment add, a comment delete. It was `instructError` when ✦ was the only
  // thing that could fail out loud; the comment paths swallowed theirs into
  // `.catch(() => {})`, so a rejected comment vanished with the optimistic row
  // still on screen and nothing said why.
  const [surfaceError, setSurfaceError] = useState<string | null>(null);

  const runInstruct = useCallback(
    (
      blockId: string,
      text: string,
      sel: { quote: string; charStart: number; charEnd: number } | null = null,
    ) => {
      if (!editor || editor.isDestroyed) return;
      // Flush the persisted doc + mirror FIRST so the backend flush and the
      // agent's read both see the instruction exactly as written.
      persistNow(editor);
      const md = planDocToMarkdown(editor.state.doc, { sidecars: true });
      setSurfaceError(null);
      setAgentNote(null);
      instructInFlight.current = true;
      lastInstruct.current = { blockId, text, sel };
      setGenerating((prev) => new Set(prev).add(blockId));
      void invoke("draft_instruct", {
        draftId,
        blockId,
        instruction: text,
        draftMarkdown: md,
        projectPath: selectedProject,
        cwd: selectedProject,
        selQuote: sel?.quote ?? null,
        selCharStart: sel?.charStart ?? null,
        selCharEnd: sel?.charEnd ?? null,
      }).catch((e) => {
        instructInFlight.current = false;
        setGenerating((prev) => {
          const next = new Set(prev);
          next.delete(blockId);
          return next;
        });
        setSurfaceError(String(e));
      });
    },
    [editor, draftId, selectedProject, persistNow],
  );
  runInstructRef.current = runInstruct;

  const retryInstruct = useCallback(() => {
    const last = lastInstruct.current;
    if (last) runInstruct(last.blockId, last.text, last.sel);
  }, [runInstruct]);

  // The ✦ turn's endgame: the agent's one-liner arrives on `draft-chat-done`
  // (the suggestion itself streams in via `drafter-suggestion`, which clears
  // the pulse — see landSuggestion); an error stops the pulse and offers
  // Retry.
  useEffect(() => {
    let alive = true;
    const done = listen<{ draftId: string; body: string }>(
      "draft-chat-done",
      (e) => {
        if (!alive || e.payload.draftId !== draftId) return;
        if (!instructInFlight.current) return;
        instructInFlight.current = false;
        // Whatever is still pulsing stops — the agent may have declined to
        // post a suggestion; its one-liner says why.
        setGenerating((prev) => (prev.size ? new Set<string>() : prev));
        const line = e.payload.body.trim();
        if (line) {
          setAgentNote(line);
          if (agentNoteTimer.current !== null)
            window.clearTimeout(agentNoteTimer.current);
          agentNoteTimer.current = window.setTimeout(
            () => setAgentNote(null),
            12_000,
          );
        }
      },
    );
    const err = listen<{ draftId: string; error: string }>(
      "draft-chat-error",
      (e) => {
        if (!alive || e.payload.draftId !== draftId) return;
        if (!instructInFlight.current) return;
        instructInFlight.current = false;
        setGenerating((prev) => (prev.size ? new Set<string>() : prev));
        setSurfaceError(e.payload.error);
      },
    );
    // A ✦ turn may still be streaming from before this mount — the ref gating
    // these handlers died with the previous mount, so its completion would be
    // silently dropped. Probe the backend (only once both listeners are LIVE,
    // so the terminal event can't slip between probe and subscription) and
    // re-arm the gate + the target block's pulse; the handlers above then
    // just work.
    // The cancel's terminal event. Without this the ✕ kills the process and
    // leaves the block pulsing forever — a stop button that doesn't visibly
    // stop anything is worse than no stop button.
    const cancelled = listen<{ draftId: string }>("draft-chat-cancelled", (e) => {
      if (!alive || e.payload.draftId !== draftId) return;
      instructInFlight.current = false;
      setGenerating((prev) => (prev.size ? new Set<string>() : prev));
      setAgentNote("Stopped. The document is unchanged — Retry re-runs it.");
    });
    void Promise.all([done, err, cancelled])
      .then(() =>
        invoke<{
          streaming: boolean;
          instruct: { blockId: string; instruction: string } | null;
        }>("draft_turn_status", { draftId }),
      )
      .then((s) => {
        if (!alive || !s.streaming || !s.instruct) return;
        instructInFlight.current = true;
        const { blockId, instruction } = s.instruct;
        setGenerating((prev) =>
          prev.has(blockId) ? prev : new Set(prev).add(blockId),
        );
        // Restore `lastInstruct` too, not just the pulse. Without this Retry is
        // DEAD for any turn recovered across a remount — and a turn you had to
        // remount through is exactly the one most likely to need retrying.
        if (instruction)
          lastInstruct.current = { blockId, text: instruction, sel: null };
      })
      // Not a swallowed catch: the probe failing means the pulse and Retry are
      // both silently unavailable, which is worth knowing.
      .catch((e) => console.warn("draft_turn_status failed", e));
    return () => {
      alive = false;
      void done.then((un) => un());
      void err.then((un) => un());
      void cancelled.then((un) => un());
    };
  }, [draftId]);

  // Agent write-suggestions: drain the pending queue on mount (proposals made
  // while the pane was closed), then apply live `drafter-suggestion` events.
  // Each lands as tracked changes (or applies directly into an empty doc) and
  // gets a card with Accept/Reject; the verdict is persisted so the agent's
  // next doc read reflects it.
  const [suggestions, setSuggestions] = useState<DraftSuggestionRow[]>([]);
  const seenSuggestions = useRef<Set<string>>(new Set());

  const landSuggestion = useCallback(
    (s: DraftSuggestionRow) => {
      if (!editor || editor.isDestroyed) return;
      if (seenSuggestions.current.has(s.id)) return;
      seenSuggestions.current.add(s.id);
      // A landing suggestion ends the ✦ generating pulse on its target block.
      if (s.blockId) {
        const bare = s.blockId.replace(/^blk-/, "");
        setGenerating((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(
            [...prev].filter((id) => id.replace(/^blk-/, "") !== bare),
          );
          return next.size === prev.size ? prev : next;
        });
      }
      // Re-drain guard: the marks of an unresolved suggestion are persisted
      // in doc_json, so reopening the draft finds them already in the
      // document. Re-applying would duplicate the proposal — surface the
      // card only.
      if (suggestionLeaves(editor, s.id).length > 0) {
        setSuggestions((list) =>
          list.some((x) => x.id === s.id) ? list : [...list, s],
        );
        return;
      }
      const outcome = applyDraftSuggestion(editor, s);
      if (outcome === "proposed" && !suggestingRef.current) {
        setSuggesting(true);
        setModeNote(
          "A suggestion landed, so Suggesting mode is on — your own edits are now tracked too. Switch back to Editing in the toolbar.",
        );
      }
      if (outcome === "applied") {
        void invoke("draft_suggestion_resolve", {
          id: s.id,
          status: "applied",
        }).catch(() => {});
        // Persist the applied content promptly (skip the debounce race on an
        // immediate launch after a whole-cloth draft).
        persistNow(editor);
        return;
      }
      if (outcome === "stale") {
        void invoke("draft_suggestion_resolve", {
          id: s.id,
          status: "rejected",
        }).catch(() => {});
        return;
      }
      setSuggestions((list) =>
        list.some((x) => x.id === s.id) ? list : [...list, s],
      );
    },
    [editor, persistNow, setSuggesting],
  );

  useEffect(() => {
    if (!editor) return;
    let alive = true;
    void invoke<DraftSuggestionRow[]>("draft_suggestions_pending", {
      draftId,
    })
      .then((rows) => {
        if (!alive) return;
        for (const s of rows) landSuggestion(s);
      })
      .catch(() => {});
    const p = listen<DraftSuggestionRow>("drafter-suggestion", (e) => {
      if (!alive || e.payload.draftId !== draftId) return;
      landSuggestion(e.payload);
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
  }, [editor, draftId, landSuggestion]);

  const resolveSuggestion = useCallback(
    (s: DraftSuggestionRow, verdict: "applied" | "rejected") => {
      if (editor && !editor.isDestroyed) {
        if (verdict === "applied") acceptDraftSuggestion(editor, s);
        else rejectDraftSuggestion(editor, s);
      }
      setSuggestions((list) => list.filter((x) => x.id !== s.id));
      void invoke("draft_suggestion_resolve", {
        id: s.id,
        status: verdict,
      }).catch(() => {});
    },
    [editor],
  );

  // Lock enforcement input: blocks whose text carries a pending FOREIGN
  // (agent) suggestion mark — plus blocks the agent is generating into —
  // are handed to TrackChangesInput, which filters user edits inside them
  // ("resolve it first"). Recomputed on every doc change — prompt-sized docs
  // make the scan trivial.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const recompute = () => {
      if (editor.isDestroyed) return;
      const locked = new Set<string>(generating);
      editor.state.doc.forEach((node) => {
        const id = node.attrs?.blockId as string | null;
        if (!id || locked.has(id)) return;
        let foreign = false;
        node.descendants((n) => {
          if (foreign) return false;
          if (
            n.isText &&
            n.marks.some(
              (m) =>
                isPendingSuggestionMark(m) &&
                (m.attrs.authorId ?? USER_AUTHOR) !== USER_AUTHOR,
            )
          )
            foreign = true;
          return !foreign;
        });
        if (foreign) locked.add(id);
      });
      editor.commands.setLockedBlocks([...locked]);
    };
    recompute();
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (transaction.docChanged) recompute();
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, generating]);

  // The user's own pending run under the caret (Suggesting-mode typing) gets
  // an in-place "✓ Keep / ✗ Revert" chip — the self-service twin of the
  // agent-suggestion cards, with no DB row behind it.
  //
  // It holds a DOCUMENT POSITION, never screen coordinates. Captured
  // coordinates were the stale-chip bug: the chip kept pointing at where the
  // run used to be after any edit reflowed the line, and never moved on scroll
  // at all. `AnchoredOverlay` re-derives the rect from this position on every
  // measure, so the chip follows the text it belongs to.
  const [userRun, setUserRun] = useState<{
    suggestionId: string;
    pos: number;
  } | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const update = () => {
      if (editor.isDestroyed) return;
      const { selection } = editor.state;
      if (!selection.empty) {
        setUserRun(null);
        return;
      }
      const $head = selection.$head;
      const ownPendingSid = (n: PMNode | null | undefined): string | null => {
        if (!n || !n.isText) return null;
        const m = n.marks.find(
          (m) =>
            isPendingSuggestionMark(m) &&
            (m.attrs.authorId ?? USER_AUTHOR) === USER_AUTHOR &&
            m.attrs.suggestionId,
        );
        return m ? (m.attrs.suggestionId as string) : null;
      };
      const sid =
        ownPendingSid($head.nodeBefore) ?? ownPendingSid($head.nodeAfter);
      if (!sid) {
        setUserRun(null);
        return;
      }
      setUserRun({ suggestionId: sid, pos: $head.pos });
    };
    editor.on("selectionUpdate", update);
    editor.on("blur", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("blur", update);
    };
  }, [editor]);

  const resolveUserRun = useCallback(
    (keep: boolean) => {
      if (!editor || editor.isDestroyed || !userRun) return;
      if (keep) acceptUserSuggestion(editor, userRun.suggestionId);
      else rejectUserSuggestion(editor, userRun.suggestionId);
      setUserRun(null);
      persistNow(editor);
    },
    [editor, userRun, persistNow],
  );

  // Review menu: settle or revert EVERY pending user run at once.
  const resolveAllUserRuns = useCallback(
    (keep: boolean) => {
      if (!editor || editor.isDestroyed) return;
      const changed = keep
        ? acceptAllUserSuggestions(editor)
        : rejectAllUserSuggestions(editor);
      if (changed) {
        setUserRun(null);
        persistNow(editor);
      }
    },
    [editor, persistNow],
  );

  // Card "Show": scroll the suggestion's first mark leaf into view (or its
  // target block, for card-only proposals that carry no marks).
  const showSuggestion = useCallback(
    (s: DraftSuggestionRow) => {
      if (!editor || editor.isDestroyed) return;
      let pos: number | null = suggestionLeaves(editor, s.id)[0]?.from ?? null;
      if (pos === null && s.blockId) {
        const bare = s.blockId.replace(/^blk-/, "");
        editor.state.doc.forEach((node, p) => {
          if (
            pos === null &&
            (node.attrs?.blockId as string | null)?.replace(/^blk-/, "") ===
              bare
          )
            pos = p + 1;
        });
      }
      if (pos === null) return;
      const at = editor.view.domAtPos(pos);
      const el = at.node instanceof HTMLElement ? at.node : at.node.parentElement;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [editor],
  );

  // Hand the host a live-markdown getter (voice mirror flush): unlike the
  // debounced onPersist mirror, this serializes the CURRENT doc on demand.
  useEffect(() => {
    if (!editor || !registerLiveMarkdown) return;
    registerLiveMarkdown(() =>
      editor.isDestroyed
        ? ""
        : planDocToMarkdown(editor.state.doc, { sidecars: true }),
    );
    return () => registerLiveMarkdown(null);
  }, [editor, registerLiveMarkdown]);

  // --- The comment sidecar (selection-anchored draft comments) -------------
  const [comments, setComments] = useState<DraftComment[]>([]);
  const [sidecarOpen, setSidecarOpen] = useState(false);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // The page sheet — what the floating Discuss pill measures itself against.
  const pageRef = useRef<HTMLDivElement>(null);
  const [selection, clearSelection] = useTextSelection(workspaceRef, true);
  const [commentDraft, setCommentDraft] = useState<string | null>(null);
  // The ✦ Ask-agent composer over the same selection snapshot — a typed
  // instruction that becomes a tracked rewrite of the selection (P3).
  const [askDraft, setAskDraft] = useState<string | null>(null);
  // The selection SNAPSHOT the composer works from. The live `selection`
  // collapses the instant focus moves (clicking the button, the textarea's
  // autofocus — each fires `selectionchange`), which unmounted the popover a
  // frame after it appeared. Snapshot on click; the popover renders from the
  // snapshot and survives losing the live selection.
  //
  // `pos` is the ProseMirror position the composer hangs off — a DOCUMENT
  // position, not a captured rect, so the composer follows the text on scroll
  // instead of sitting where the selection used to be on screen.
  const [pendingSel, setPendingSel] = useState<{
    blockId: string | null;
    charStart: number;
    charEnd: number;
    quotedText: string;
    pos: number;
  } | null>(null);

  // ONE opener for both composers — they differ by which draft they arm, and
  // nothing else. (The panels themselves are one `SelectionComposer` too.)
  const openComposer = useCallback(
    (kind: "comment" | "ask") => {
      if (!selection || !editor) return;
      setPendingSel({
        blockId: selection.anchorId || null,
        charStart: selection.charStart,
        charEnd: selection.charEnd,
        quotedText: selection.text,
        pos: editor.state.selection.from,
      });
      setCommentDraft(kind === "comment" ? "" : null);
      setAskDraft(kind === "ask" ? "" : null);
      clearSelection();
    },
    [selection, clearSelection, editor],
  );
  const closeComposer = useCallback(() => {
    setCommentDraft(null);
    setAskDraft(null);
    setPendingSel(null);
  }, []);

  const submitAsk = useCallback(
    (instruction: string) => {
      if (!pendingSel?.blockId || !instruction.trim()) return;
      runInstruct(pendingSel.blockId, instruction.trim(), {
        quote: pendingSel.quotedText,
        charStart: pendingSel.charStart,
        charEnd: pendingSel.charEnd,
      });
      setAskDraft(null);
      setPendingSel(null);
    },
    [pendingSel, runInstruct],
  );

  useEffect(() => {
    let alive = true;
    void invoke<DraftComment[]>("draft_comment_list", { draftId })
      .then((rows) => {
        if (!alive) return;
        // Defensive: a null/garbage response must not take the whole surface
        // down with `rows.length`. The command returns a list or errors, but
        // this render tree is the user's document and it does not get to crash
        // over a sidecar read.
        const list = Array.isArray(rows) ? rows : [];
        setComments(list);
        if (list.length > 0) setSidecarOpen(true);
      })
      // Background reconciliation stays quiet — the user didn't ask for this
      // and can't act on it — but it stops being invisible to us.
      .catch((err) => console.warn("draft_comment_list failed", err));
    return () => {
      alive = false;
    };
  }, [draftId]);

  // Project the comments to inline highlights (CommentHighlights keys on the
  // same blockId/charStart/charEnd anchors the plan editor uses).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const ranges: CommentHighlightRange[] = comments.flatMap((c) =>
      c.blockId && c.selCharStart != null && c.selCharEnd != null
        ? [
            {
              commentId: c.id,
              blockId: c.blockId,
              charStart: c.selCharStart,
              charEnd: c.selCharEnd,
              quotedText: c.selQuotedText ?? "",
              muted: false,
            },
          ]
        : [],
    );
    editor.commands.setCommentHighlights(ranges);
    editor.commands.focusCommentHighlight(focusedCommentId);
  }, [editor, comments, focusedCommentId]);

  const addComment = useCallback(
    (body: string) => {
      if (!pendingSel || !body.trim()) return;
      // The optimistic row lands only ON SUCCESS. Adding it first and letting
      // a rejection quietly remove it is how a comment could be typed, appear,
      // and evaporate with nothing said.
      void invoke<DraftComment>("draft_comment_add", {
        draftId,
        body,
        blockId: pendingSel.blockId,
        selCharStart: pendingSel.charStart,
        selCharEnd: pendingSel.charEnd,
        selQuotedText: pendingSel.quotedText,
      })
        .then((c) => {
          setComments((list) => [...list, c]);
          setSidecarOpen(true);
          setFocusedCommentId(c.id);
        })
        .catch((e) => setSurfaceError(`Couldn't save that comment: ${e}`));
      setCommentDraft(null);
      setPendingSel(null);
    },
    [pendingSel, draftId],
  );

  const deleteComment = useCallback(
    (id: string) => {
      const previous = comments;
      setComments((list) => list.filter((c) => c.id !== id));
      if (focusedCommentId === id) setFocusedCommentId(null);
      void invoke("draft_comment_delete", { draftId, commentId: id }).catch(
        (e) => {
          // Put it back. A comment that reappears with an explanation is
          // recoverable; one that silently stays deleted on screen while it
          // lives on in the DB is a lie the next open exposes.
          setComments(previous);
          setSurfaceError(`Couldn't delete that comment: ${e}`);
        },
      );
    },
    [draftId, focusedCommentId, comments],
  );

  // The blocker a refused ⌘⇧⏎ is showing, rendered INSIDE the bar. This is the
  // whole reason the Drafter gained a preflight: it ran the identical
  // `claude --permission-mode plan` with none, and handed the user a terminal
  // spinning over nothing.
  const [blocked, setBlocked] = useState<ReadinessItem | null>(null);

  // Everything this surface reflects about the document, in ONE selector.
  //
  // The selector body still runs per transaction — that is unavoidable and
  // fine, it is prompt-sized data and compliant with perf-budget rule 1. What
  // is eliminated is the RENDER: `useEditorState` compares with `deepEqual`, so
  // typing three characters inside one word produces zero re-renders of this
  // ~2,800-line tree. (`isFocused` rides along because the bar's lift is a
  // focus state and focus changes are transactions too.)
  const view = useEditorState({
    editor,
    selector: ({ editor: e }): DrafterView | null => {
      if (!e) return null;
      const text = e.getText().trim();
      return {
        words: text ? text.split(/\s+/).length : 0,
        isEmpty: e.isEmpty,
        isFocused: e.isFocused,
        hasUserRuns: hasPendingUserSuggestions(e),
        canInstruct: resolveInstructionBlock(e.state) !== null,
      };
    },
  });
  const words = view?.words ?? 0;

  // A source's addressable location: the copied file for an imported file, the
  // URL for a captured page. Only these can ride out as `Context:` lines.
  const sourcePaths = useMemo(
    () =>
      sources
        .map((s) => s.filePath ?? s.url ?? "")
        .filter((p): p is string => p.length > 0),
    [sources],
  );

  // Drag-and-drop onto the page. Tauri's own file-drop event carries real
  // paths; the DOM's DataTransfer does not in a webview, so this is the
  // pointer-driven half and the host owns the native listener.
  const [dropping, setDropping] = useState(false);

  // Re-measure the anchored overlays when the document changes shape under
  // them. A SUBSCRIPTION, not a state nonce: a nonce would re-render this
  // ~2,800-line tree on every keystroke, which is exactly the jank the
  // `useEditorState` selector above just eliminated. (The render-count test
  // catches it if anyone reaches for the nonce again.)
  const overlaySubscribe = useCallback(
    (remeasure: () => void) => {
      if (!editor || editor.isDestroyed) return () => {};
      editor.on("update", remeasure);
      return () => {
        editor.off("update", remeasure);
      };
    },
    [editor],
  );

  // The document AS SENT. The card describes a transaction, and the document
  // stays editable underneath it — so reading the live doc for the receipt
  // would make "412 words · 9 blocks" drift as you keep typing, describing
  // something nobody sent.
  const sentDocRef = useRef<{ json: JSONContent; text: string } | null>(null);

  const launch = useCallback(() => {
    if (!editor || editor.isEmpty || pending) return;
    const gate = attemptLaunch(readiness);
    if (gate.kind === "blocked") {
      setBlocked(gate.item);
      return;
    }
    setBlocked(null);
    const markdown = planDocToMarkdown(editor.state.doc, { sidecars: false });
    sentDocRef.current = { json: editor.getJSON(), text: editor.getText() };
    // Attachments ride as a `Context:` path list — never inlined bytes; the
    // plan session already has Read/Grep/Glob pre-approved.
    onLaunch(composePrompt(markdown, sourcePaths), selectedProject);
  }, [editor, selectedProject, onLaunch, readiness, sourcePaths, pending]);

  const canSend = !!editor && !(view?.isEmpty ?? true) && !pending;

  // Attach files as context. Paths only, never inlined bytes — see
  // `composePrompt`. The plan session already has Read/Grep/Glob pre-approved,
  // so a path is all it needs, and inlining bytes would only burn its context.
  const attach = useCallback(async () => {
    if (!onAttachFiles) return;
    try {
      const picked = await openDialog({ multiple: true });
      const paths = Array.isArray(picked)
        ? picked
        : typeof picked === "string"
          ? [picked]
          : [];
      if (paths.length > 0) onAttachFiles(paths);
    } catch {
      /* cancelled or dialog unavailable */
    } finally {
      editor?.chain().focus().run();
    }
  }, [onAttachFiles, editor]);

  // ⌘⇧⏎ sends. NOT ⏎ — this is a document, and no design elegance is worth
  // Return sometimes spawning a subprocess. NOT ⌘⏎ either: ✦ Generate already
  // owns that at priority 1000 in InstructionTrigger.
  const launchRef = useRef(launch);
  launchRef.current = launch;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey) return;
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      launchRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // In-document find & replace (Cmd/Ctrl+F). PromptDrafter owns the query +
  // counters; the SearchHighlight extension owns the match positions and
  // decorations. Replace is layered on top via plain editor transactions —
  // SearchHighlight stays find-only.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchActive, setSearchActive] = useState(-1);

  const syncSearchState = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    setSearchCount(s.matches.length);
    setSearchActive(s.activeIndex);
  }, [editor]);

  const scrollToActiveMatch = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const at = editor.view.domAtPos(m.from);
    const el =
      at.node instanceof HTMLElement ? at.node : at.node.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor]);

  const runSearch = useCallback(
    (q: string) => {
      setSearchQuery(q);
      editor?.commands.setSearchQuery(q);
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  const stepSearch = useCallback(
    (dir: "next" | "prev") => {
      if (!editor) return;
      if (dir === "next") editor.commands.nextMatch();
      else editor.commands.prevMatch();
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  // Replace one range with the replacement as literal text (a text node, so
  // markup characters aren't reparsed); an empty replacement deletes.
  const replaceRange = (
    chain: ReturnType<NonNullable<typeof editor>["chain"]>,
    from: number,
    to: number,
  ) =>
    replacement
      ? chain.insertContentAt({ from, to }, { type: "text", text: replacement })
      : chain.deleteRange({ from, to });

  const replaceActive = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    replaceRange(editor.chain().focus(), m.from, m.to).run();
    // Recompute matches against the edited doc.
    editor.commands.setSearchQuery(searchQuery);
    syncSearchState();
    scrollToActiveMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, searchQuery, replacement, syncSearchState, scrollToActiveMatch]);

  const replaceAll = useCallback(() => {
    if (!editor) return;
    const matches = [...editor.storage.searchHighlight.matches];
    if (!matches.length) return;
    // Right-to-left so earlier (smaller) positions stay valid as we edit.
    let chain = editor.chain().focus();
    for (let i = matches.length - 1; i >= 0; i--) {
      chain = replaceRange(chain, matches[i].from, matches[i].to);
    }
    chain.run();
    editor.commands.setSearchQuery(searchQuery);
    syncSearchState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, searchQuery, replacement, syncSearchState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    editor?.commands.clearSearch();
    syncSearchState();
    editor?.commands.focus();
  }, [editor, syncSearchState]);

  // Intercept Cmd/Ctrl+F while the drafter is mounted: open the find bar
  // instead of the WebView's native find, and refresh the count for any prior
  // query against the latest doc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
        if (editor && searchQuery) {
          editor.commands.setSearchQuery(searchQuery);
          syncSearchState();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, searchQuery, syncSearchState]);


  return (
    // No opaque fill: the desk behind (the front door's ruled paper, lit from
    // behind) has to read THROUGH the surface, or the glass sheet sits in a
    // solid frame and the room stops being one material.
    <div className="rl-drafter-glass flex h-full min-h-0 flex-col">
      <DrafterToolbar
        editor={editor}
        sidecarOpen={sidecarOpen}
        onToggleSidecar={() => setSidecarOpen((v) => !v)}
        commentCount={comments.length}
        suggesting={suggesting}
        onSetSuggesting={setSuggesting}
        hasUserRuns={!!view?.hasUserRuns}
        onResolveAllMine={resolveAllUserRuns}
        onGenerate={() => editor?.commands.instructAtCaret()}
        canGenerate={!!editor && generating.size === 0 && !!view?.canInstruct}
      />

      {agentNote && (
        <div
          data-no-drag="true"
          className="flex items-center gap-2 px-4 py-1"
          style={{
            borderBottom: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            fontSize: "11.5px",
            color: "var(--color-ink)",
          }}
        >
          <span style={{ fontSize: "12px", color: "var(--color-info)" }}>
            ✦
          </span>
          <span className="min-w-0 flex-1 truncate" title={agentNote}>
            {agentNote}
          </span>
          <button
            type="button"
            onClick={() => setAgentNote(null)}
            aria-label="Dismiss"
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {surfaceError && (
        <div
          data-no-drag="true"
          className="flex items-center gap-2 px-4 py-1"
          style={{
            borderBottom: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            fontSize: "11.5px",
            color: "var(--color-ink)",
          }}
        >
          <span style={{ fontSize: "12px", color: "var(--color-warning)" }}>
            ⚠
          </span>
          <span className="min-w-0 flex-1 truncate" title={surfaceError}>
            {surfaceError}
          </span>
          {lastInstruct.current && (
            <button
              type="button"
              onClick={retryInstruct}
              className="rounded-sm px-2 py-0.5"
              style={{
                fontSize: "11px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => setSurfaceError(null)}
            aria-label="Dismiss"
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* A ✦ turn is running, and this is the ONLY way to stop it. Without it
          the target block pulses, the draft's turn slot stays reserved against
          every other ✦, and the only exits are success, error, or quitting the
          app. `draft_chat_cancel` has existed all along with no caller — a
          missing feature masquerading as dead code. */}
      {generating.size > 0 && (
        <div
          data-no-drag="true"
          className="flex items-center gap-2 px-4 py-1"
          style={{
            borderBottom: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            fontSize: "11.5px",
            color: "var(--color-ink)",
          }}
        >
          <span style={{ fontSize: "12px", color: "var(--color-info)" }}>✦</span>
          <span className="min-w-0 flex-1 truncate">
            Writing into the document…
          </span>
          <button
            type="button"
            onClick={() => {
              void invoke("draft_chat_cancel", { draftId }).catch((e) =>
                setSurfaceError(`Couldn't stop that turn: ${e}`),
              );
            }}
            title="Stop this turn"
            aria-label="Stop this turn"
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {(modeNote || lockedNote) && (
        <div
          data-no-drag="true"
          className="flex items-center gap-2 px-4 py-1"
          style={{
            borderBottom: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            fontSize: "11.5px",
            color: "var(--color-ink)",
          }}
        >
          <span style={{ fontSize: "12px" }}>
            {modeNote ? "✎" : "🔒"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {modeNote ?? lockedNote}
          </span>
          {modeNote && (
            <button
              type="button"
              onClick={() => setModeNote(null)}
              aria-label="Dismiss"
              style={{
                fontSize: "12px",
                color: "var(--color-ink-muted)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* The suggestions strip does NOT push the document down.
          Four stacked banners used to sit above the page, each appearing and
          disappearing as agents worked — so the document you were reading moved
          under your eyes. This is one row, absolutely positioned in the body row
          below, and `Review ▾` opens a panel holding exactly the per-row JSX
          that used to be inline. The `lockedNote`-has-no-dismiss bug dies
          structurally: everything transient lives in one dismissible place. */}
      {/* `relative` so the floating Discuss pill anchors to this body row (not
          the scroll container — an abspos child there would scroll away). */}
      <div className="relative flex min-h-0 flex-1">
        {suggestions.length > 0 && (
          <SuggestionsStrip
            suggestions={suggestions}
            onShow={showSuggestion}
            onResolve={resolveSuggestion}
          />
        )}
        <div
          ref={workspaceRef}
          className="rl-thin-scroll-y rl-page-workspace rl-page-workspace--drafter relative min-h-0 flex-1 overflow-y-auto"
        >
          {/* Every overlay that points at the document goes through ONE
              mechanism now. Each was a `position: fixed` child of THIS scroll
              container, which is exactly the bug popover.tsx documents: a fixed
              child inside a scrolled subtree is positioned against it, so none
              of them followed scroll — they sat where the anchor used to be.
              And each clamped with `Math.max(8, top - 36)`, which near the top
              of the pane pins the panel over the ribbon while still claiming to
              point at a paragraph. AnchoredOverlay portals out and flips. */}
          {userRun && !selection && editor && (
            <AnchoredOverlay
              anchor={() => coordsRect(editor, userRun.pos)}
              boundsRef={workspaceRef}
              subscribe={overlaySubscribe}
              onVanish={() => setUserRun(null)}
              className="rl-dl-overlay flex items-center gap-0.5 rounded-full px-1 py-0.5"
            >
              <button
                type="button"
                // preventDefault so clicking never moves focus/caret off the
                // run the chip is resolving.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => resolveUserRun(true)}
                className="rounded-full px-2 py-0.5"
                title="Keep this change — settle it as ordinary text"
                style={{
                  fontSize: "11px",
                  color: "var(--color-anchor-text)",
                  cursor: "pointer",
                }}
              >
                ✓ Keep
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => resolveUserRun(false)}
                className="rounded-full px-2 py-0.5"
                title="Revert this change — the text reads as before it"
                style={{
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                  cursor: "pointer",
                }}
              >
                ✗ Revert
              </button>
            </AnchoredOverlay>
          )}
          {selection && pendingSel === null && (
            <AnchoredOverlay
              // Re-derived from the LIVE range, not a captured rect.
              anchor={() => liveSelectionRect()}
              boundsRef={workspaceRef}
              subscribe={overlaySubscribe}
              onVanish={clearSelection}
              className="rl-dl-overlay flex items-center overflow-hidden rounded-full"
              style={{ overflow: "hidden" }}
            >
              <button
                type="button"
                // preventDefault on mousedown so clicking the button never
                // collapses the selection it exists to act on (the plan
                // editor's SelectionMenu does the same).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openComposer("comment")}
                className="px-2.5 py-1"
                style={{
                  fontSize: "11.5px",
                  color: "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                🗨️ Comment
              </button>
              {selection.anchorId && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => openComposer("ask")}
                  className="px-2.5 py-1"
                  title="Type an instruction — the agent rewrites this selection as a tracked change"
                  style={{
                    fontSize: "11.5px",
                    color: "var(--color-info)",
                    borderLeft: "1px solid var(--color-rule)",
                    cursor: "pointer",
                  }}
                >
                  ✦ Ask agent
                </button>
              )}
            </AnchoredOverlay>
          )}
          {/* The comment composer and the ✦ Ask composer were ~110 lines of
              near-identical JSX differing only in placeholder, accent, submit
              label and handler. They are one component with four props. */}
          {pendingSel && editor && commentDraft !== null && (
            <SelectionComposer
              anchor={() => coordsRect(editor, pendingSel.pos)}
              boundsRef={workspaceRef}
              subscribe={overlaySubscribe}
              quote={pendingSel.quotedText}
              accent="var(--color-rule)"
              width={260}
              placeholder="Comment on this selection…"
              submitLabel="Add"
              value={commentDraft}
              onChange={setCommentDraft}
              onSubmit={() => addComment(commentDraft)}
              onCancel={closeComposer}
            />
          )}
          {pendingSel && editor && askDraft !== null && (
            <SelectionComposer
              anchor={() => coordsRect(editor, pendingSel.pos)}
              boundsRef={workspaceRef}
              subscribe={overlaySubscribe}
              quote={pendingSel.quotedText}
              accent="var(--color-info)"
              width={280}
              placeholder="Ask the agent — e.g. “make this punchier”…"
              submitLabel="✦ Ask"
              value={askDraft}
              onChange={setAskDraft}
              onSubmit={() => submitAsk(askDraft)}
              onCancel={closeComposer}
            />
          )}
          <div
            ref={pageRef}
            className={`rl-page${dropping ? " is-dropping" : ""}`}
            onClick={() => editor?.chain().focus().run()}
            onDragOver={
              onAttachFiles
                ? (e) => {
                    e.preventDefault();
                    setDropping(true);
                  }
                : undefined
            }
            onDragLeave={onAttachFiles ? () => setDropping(false) : undefined}
            onDrop={
              onAttachFiles
                ? (e) => {
                    e.preventDefault();
                    setDropping(false);
                    const paths = [...e.dataTransfer.files]
                      .map((f) => (f as File & { path?: string }).path ?? "")
                      .filter(Boolean);
                    if (paths.length > 0) onAttachFiles(paths);
                  }
                : undefined
            }
          >
            {/* The opening, INSIDE the page. `.rl-page` is already
                `position: relative` with `cursor: text`, and its click handler
                lands the caret from anywhere — so a click straight through the
                ghost text still starts typing, which is the whole point. */}
            {view?.isEmpty && (
              <DrafterOpening
                templates={templates}
                onUseTemplate={onUseTemplate}
                onStarter={(build) => {
                  editor?.chain().focus().setContent(build()).run();
                }}
              />
            )}
            <EditorContent editor={editor} />
          </div>
        </div>
        {/* OUT of the scroll container. Inside it, `.rl-search-box`'s
            `position: sticky` pushed the whole page down by the bar's height the
            moment ⌘F opened — the document visibly jumped. Absolutely
            positioned in the `relative` body row instead, it floats over the
            page and moves nothing. The plan editor's search box is untouched. */}
        {searchOpen && (
          <div className="rl-dl-findbar">
            <DrafterFindBar
              query={searchQuery}
              onQueryChange={runSearch}
              replacement={replacement}
              onReplacementChange={setReplacement}
              matchCount={searchCount}
              activeIndex={searchActive}
              onNext={() => stepSearch("next")}
              onPrev={() => stepSearch("prev")}
              onReplaceOne={replaceActive}
              onReplaceAll={replaceAll}
              onClose={closeSearch}
            />
          </div>
        )}
        {sidecarOpen && (
          <DrafterSidecar
            draftId={draftId}
            comments={comments}
            focusedId={focusedCommentId}
            onSelect={setFocusedCommentId}
            onDelete={deleteComment}
            onClose={() => setSidecarOpen(false)}
          />
        )}
        {onDiscuss && (
          <DiscussPill
            onClick={onDiscuss}
            title="Discuss this draft — talk or type"
            textRef={pageRef}
            /* 0: clear the page SHEET's edge, not the text inside it — in a
               Word-style surface the sheet is the document, and a pill on the
               white paper reads as on the document however clear of the words
               it is. */
            textInset={0}
          />
        )}
      </div>

      {/* The launch bar: the Front Door's island, docked. Same glass, same
          lift, same CTA, same refusal — because it is the same act at the
          other scale, and a document surface that launched a plan through a
          different-looking control with no preflight was the whole problem.

          On send it MORPHS IN PLACE into the launch card. The document above
          stays visible and editable; the scroll container simply reflows
          shorter. Nothing is covered and focus is not stolen. */}
      <div className="rl-dl-bar-wrap" data-no-drag="true">
        <div
          className={[
            "rl-dl-bar",
            view?.isFocused || pending ? "is-lifted" : "",
            pending ? "is-planning" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {pending ? (
            <DrafterLaunchCard
              pending={pending}
              sent={sentDocRef.current}
              readiness={readiness}
              onFix={onFix}
              onRelaunch={launch}
              onDismiss={onDismissPending}
            />
          ) : (
            <div className="rl-fd-morph">
              {sources.length > 0 && (
                <div className="rl-fd-attach">
                  {sources.map((s) => {
                    const where = s.filePath ?? s.url ?? "";
                    return (
                      <span
                        key={s.id}
                        className="rl-fd-chip"
                        title={`${where}\nRides out as a Context: line — the plan session reads it itself.`}
                      >
                        {s.title?.trim() || basename(where)}
                        <button
                          type="button"
                          onClick={() => onRemoveSource?.(s.id)}
                          title="Remove"
                          className="rl-fd-x"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="rl-fd-tools">
                {onExit && (
                  <button
                    type="button"
                    onClick={onExit}
                    title="Back to the one-line composer"
                    className="rl-fd-tool"
                  >
                    <ChevronLeft size={14} />
                  </button>
                )}
                {onOpenShelf && (
                  <button
                    type="button"
                    onClick={onOpenShelf}
                    title="Your Bookshelf — every document you've stored, in folders"
                    className="rl-fd-tool is-wide"
                  >
                    <Library size={13} strokeWidth={2} />
                    Bookshelf
                    {/* True at last: the count comes from the same list the
                        chips render, so the two can't disagree. It was
                        provably always 0 before — nothing could attach a
                        source, so this chip could never appear. */}
                    {sources.length > 0 && (
                      <span
                        style={{ opacity: 0.7 }}
                        title={`${sources.length} source${sources.length === 1 ? "" : "s"} attached to this document`}
                      >
                        · {sources.length} src
                      </span>
                    )}
                  </button>
                )}
                {documentsMenu}
                <ProjectPicker
                  options={projectOptions}
                  value={selectedProject}
                  onChange={onSelectedProjectChange}
                  onAfterPick={() => editor?.chain().focus().run()}
                  chromeless
                />
                {onAttachFiles && (
                  <button
                    type="button"
                    onClick={attach}
                    title="Attach files as context for the plan session"
                    className="rl-fd-tool"
                  >
                    <Plus size={14} />
                  </button>
                )}
                {/* ONE geometry, always. The old conditional `ml-auto` moved
                    between two different children depending on whether the
                    save indicator was up, so the row re-laid-out on a save. */}
                <div style={{ flex: 1 }} />
                <SavedAgo state={saveState} />
                <span className="rl-fd-detail" style={{ whiteSpace: "nowrap" }}>
                  {words} {words === 1 ? "word" : "words"}
                </span>
                <button
                  type="button"
                  onClick={launch}
                  disabled={!canSend}
                  title="Plan this (⌘⇧⏎)"
                  className={`rl-fd-go${canSend ? " is-armed" : ""}`}
                >
                  <CornerDownLeft size={15} />
                </button>
              </div>
            </div>
          )}

          {onFix && (
            <BlockedLaunch
              blocked={blocked}
              readiness={readiness}
              onFix={onFix}
              onShow={setBlocked}
              onProceed={launch}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** After ⌘⇧⏎ the bar doesn't disappear — it becomes this, and the document
 *  stays exactly where it was. That changes what the card is FOR: the Front
 *  Door's card is a receipt of *content* (it holds the sentence, because the
 *  composer gave it up), and this one is a receipt of *transaction* — what was
 *  sent, in what shape, and where to watch it. */
function DrafterLaunchCard({
  pending,
  sent,
  readiness,
  onFix,
  onRelaunch,
  onDismiss,
}: {
  pending: PendingLaunch;
  /** The document as it was AT LAUNCH — not as it is now. */
  sent: { json: JSONContent; text: string } | null;
  readiness: ReadinessItem[];
  onFix?: (item: ReadinessItem) => Promise<boolean>;
  onRelaunch: () => void;
  onDismiss?: () => void;
}) {
  const [showSent, setShowSent] = useState(false);
  const receipt = useMemo(
    () => launchReceipt(sent?.json ?? null, sent?.text ?? ""),
    [sent],
  );
  // The one failure with no other signal at all — nothing fires, nothing
  // errors, the bar just waits. It matters MORE here than at the front door:
  // after sending a long brief you are exactly the person who waits five
  // minutes before suspecting anything.
  const nudge = readiness.find((i) => i.id === "hook-unapproved");
  return (
    <div className="rl-fd-morph">
      <div className="rl-fd-planning-prompt">{firstLine(pending.prompt)}</div>
      <div className="rl-fd-detail">
        {receipt.words} {receipt.words === 1 ? "word" : "words"} ·{" "}
        {receipt.blocks} {receipt.blocks === 1 ? "block" : "blocks"} · sent as
        structured text
      </div>
      {/* ONLY when true. The tooltip this replaces said it unconditionally,
          which claims a loss even for the document that lost nothing —
          absence is what makes it credible when it appears. */}
      {receipt.aidsDropped && (
        <div className="rl-fd-detail">
          Font, colour and alignment stayed here — Claude got the words and the
          structure.
        </div>
      )}
      {pending.lineageError && (
        <div className="rl-fd-detail" style={{ color: "var(--color-warning)" }}>
          The plan is launching, but Redline couldn&rsquo;t file this prompt in
          your memory ({pending.lineageError}).
        </div>
      )}
      <div className="rl-fd-tools">
        <WorkingIndicator label="Planning" startedAt={pending.startedAt} />
        <span className="rl-fd-detail">watch it in the terminal below ↓</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="rl-fd-quiet"
          onClick={() => setShowSent((v) => !v)}
        >
          {showSent ? "hide what was sent" : "view what was sent"}
        </button>
        <button type="button" className="rl-fd-quiet" onClick={onRelaunch}>
          send again →
        </button>
        {/* "keep drafting", not "start something else": the document was never
            taken away, so there is nothing to start. */}
        {onDismiss && (
          <button type="button" className="rl-fd-quiet" onClick={onDismiss}>
            keep drafting
          </button>
        )}
      </div>
      {showSent && (
        <div className="rl-fd-block">
          <div className="rl-fd-row" style={{ marginTop: 0 }}>
            <span className="rl-fd-label">Sent to Claude Code</span>
            <div style={{ flex: 1 }} />
            <CopyChip text={pending.prompt} title="Copy the exact prompt" />
          </div>
          <pre
            className="rl-thin-scroll-y font-mono"
            style={{
              maxHeight: "240px",
              overflow: "auto",
              fontSize: "11px",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              color: "var(--color-ink-muted)",
              marginTop: "6px",
            }}
          >
            {pending.prompt}
          </pre>
        </div>
      )}
      {nudge && onFix && (
        <div className="rl-fd-block">
          <ReadinessStrip items={[nudge]} onFix={onFix} />
        </div>
      )}
    </div>
  );
}

/** The agent-suggestion strip.
 *
 *  One row, floated over the top of the page instead of stacked above it — the
 *  document never moves. `Review ▾` opens a panel holding the per-row JSX
 *  verbatim, so nothing about reviewing a suggestion changed; only where the
 *  list lives did. */
function SuggestionsStrip({
  suggestions,
  onShow,
  onResolve,
}: {
  suggestions: DraftSuggestionRow[];
  onShow: (s: DraftSuggestionRow) => void;
  onResolve: (s: DraftSuggestionRow, verdict: "applied" | "rejected") => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const pop = useClickPopover(btnRef, "right", "below", 420);

  // A new suggestion un-dismisses the strip: dismissing is "I've seen these",
  // not "stop telling me".
  const count = suggestions.length;
  useEffect(() => setDismissed(false), [count]);
  if (dismissed) return null;

  return (
    <div className="rl-dl-suggest-strip rl-fd-block" data-no-drag="true">
      <span style={{ fontSize: "12px" }}>✍️</span>
      <span className="rl-fd-label">
        {count} suggestion{count === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        ref={btnRef}
        onClick={pop.toggle}
        className="rl-fd-quiet"
        aria-expanded={pop.open}
      >
        Review <span className="rl-fd-caret">▾</span>
      </button>
      <button
        type="button"
        onClick={() => {
          for (const s of suggestions) onResolve(s, "applied");
        }}
        className="rl-fd-fix"
      >
        Accept all
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rl-fd-x"
        title="Hide this until the next suggestion"
      >
        <X size={11} />
      </button>
      {pop.open && (
        <Panel label="Agent suggestions" {...pop.panelProps}>
          <div className="rl-thin-scroll-y flex flex-col gap-1 p-2" style={{ maxHeight: "320px", overflowY: "auto" }}>
          {suggestions.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span style={{ fontSize: "12px" }}>✍️</span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontSize: "11.5px", color: "var(--color-ink)" }}
                title={s.body ?? undefined}
              >
                {s.body?.trim() ||
                  {
                    append: "Proposed new content",
                    replace_block: "Proposed a rewrite of a block",
                    insert_after: "Proposed an insertion",
                    delete_block: "Proposed removing a block",
                  }[s.op] ||
                  "Agent suggestion"}
                <span
                  style={{
                    color: "var(--color-ink-muted)",
                    marginLeft: "6px",
                    fontSize: "10px",
                  }}
                >
                  — tracked in the document
                </span>
              </span>
              <button
                type="button"
                onClick={() => onShow(s)}
                title="Scroll to this suggestion in the document"
                className="rounded-sm px-2 py-0.5"
                style={{
                  fontSize: "11px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                Show
              </button>
              <button
                type="button"
                onClick={() => onResolve(s, "applied")}
                className="rounded-sm px-2 py-0.5"
                style={{
                  fontSize: "11px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-anchor-bg)",
                  color: "var(--color-anchor-text)",
                  cursor: "pointer",
                }}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onResolve(s, "rejected")}
                className="rounded-sm px-2 py-0.5"
                style={{
                  fontSize: "11px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink-muted)",
                  cursor: "pointer",
                }}
              >
                Reject
              </button>
            </div>
          ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/** A ProseMirror position as a viewport rect. Re-derived on every measure, so
 *  an edit that reflows the line moves the overlay with it. */
function coordsRect(editor: Editor, pos: number): AnchorRect | null {
  try {
    const c = editor.view.coordsAtPos(Math.min(pos, editor.state.doc.content.size));
    return { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
  } catch {
    // The position no longer resolves (the text it pointed at is gone). The
    // overlay's `onVanish` retires it rather than pinning it somewhere wrong.
    return null;
  }
}

/** The LIVE DOM selection's rect. The selection menu re-derives from this
 *  rather than from a rect captured when the selection was made — a captured
 *  one is wrong the moment anything scrolls. */
function liveSelectionRect(): AnchorRect | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** The comment composer and the ✦ Ask composer, which were ~110 lines of
 *  near-identical JSX. They differ by placeholder, accent, submit label and
 *  handler — so those are the props, and everything else is shared. */
function SelectionComposer({
  anchor,
  boundsRef,
  subscribe,
  quote,
  accent,
  width,
  placeholder,
  submitLabel,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  anchor: () => AnchorRect | null;
  boundsRef: React.RefObject<HTMLElement | null>;
  subscribe: (remeasure: () => void) => () => void;
  quote: string;
  accent: string;
  width: number;
  placeholder: string;
  submitLabel: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <AnchoredOverlay
      anchor={anchor}
      boundsRef={boundsRef}
      subscribe={subscribe}
      onVanish={onCancel}
      className="rl-dl-overlay flex flex-col gap-1 rounded p-2"
      style={{ width: `${width}px` }}
    >
      <div
        className="truncate"
        style={{
          fontSize: "10.5px",
          color: "var(--color-ink-muted)",
          borderLeft: `2px solid ${accent}`,
          paddingLeft: "6px",
        }}
        title={quote}
      >
        {quote}
      </div>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        rows={2}
        className="rounded px-1.5 py-1"
        style={{
          fontSize: "12px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          resize: "none",
        }}
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim()}
          className="rounded px-2 py-0.5"
          style={{
            fontSize: "11px",
            background: "var(--color-info)",
            color: "var(--color-on-accent)",
            opacity: value.trim() ? 1 : 0.5,
          }}
        >
          {submitLabel}
        </button>
      </div>
    </AnchoredOverlay>
  );
}

/** The blank page.
 *
 *  The eyebrow says PLAN MODE, exactly as the Front Door's does. The repetition
 *  is the point: it is the strongest available statement that these are two
 *  doors into one room, and it is literally true — both start the same
 *  `claude --permission-mode plan` session.
 *
 *  The serif line is 30px, not the hero's 40: the page is 816px wide at 84px of
 *  padding, and the hero's measure would run into the margin.
 *
 *  Every chip FILLS. None of them sends. */
function DrafterOpening({
  templates,
  onUseTemplate,
  onStarter,
}: {
  templates: BookshelfDraft[];
  onUseTemplate?: (draftId: string) => void;
  onStarter: (build: () => JSONContent) => void;
}) {
  const [starters, setStarters] = useState<DrafterStarter[] | null>(null);
  // Lazy: the starters' document bodies are dead weight on every open of a
  // document that already has words in it.
  useEffect(() => {
    let alive = true;
    void import("../lib/drafterOpening").then((m) => {
      if (alive) setStarters(m.DRAFTER_STARTERS);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="rl-dl-open" aria-hidden={false}>
      <div className="rl-fd-eyebrow">Plan mode</div>
      <div className="rl-dl-open-title font-serif">Write the brief.</div>
      <p className="rl-fd-sub" style={{ marginBottom: 18 }}>
        Send it and Claude Code plans against exactly this.
      </p>
      <div className="rl-fd-suggestions">
        {templates.slice(0, 3).map((t) => (
          <button
            key={t.draftId}
            type="button"
            className="rl-fd-suggestion"
            title="Start from this template"
            onClick={() => onUseTemplate?.(t.draftId)}
          >
            {t.title?.trim() || "Untitled template"}
          </button>
        ))}
        {(starters ?? []).map((s) => (
          <button
            key={s.label}
            type="button"
            className="rl-fd-suggestion"
            title={s.hint}
            onClick={() => onStarter(s.doc)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The document's title line, for the card's heading. */
function firstLine(prompt: string): string {
  for (const raw of prompt.split("\n")) {
    const line = raw.replace(/^\s*#{1,6}\s+/, "").trim();
    if (line) return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  }
  return "Untitled document";
}

/** The save clock, on its OWN interval.
 *
 *  `describeAgo` computes at render time, and this surface only re-rendered on
 *  editor transactions — so "Saved · 2s ago" sat there saying 2s for as long as
 *  you weren't typing, which is precisely when you'd look at it. Same shape as
 *  WorkingIndicator's ticker. */
function SavedAgo({ state }: { state: DrafterSaveState | null }) {
  const at = state?.kind === "saved" ? state.savedAt : undefined;
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [at]);
  if (!state) return null;
  return (
    <span
      className="rl-fd-detail"
      style={{
        whiteSpace: "nowrap",
        color:
          state.kind === "retrying"
            ? "var(--color-warning)"
            : "var(--color-ink-muted)",
      }}
      title="Whether this document's latest keystrokes have reached the database"
    >
      {state.kind === "saving"
        ? "Saving…"
        : state.kind === "retrying"
          ? "Unsaved — retrying"
          : `Saved · ${describeAgo(state.savedAt)}`}
    </span>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** "2s ago" / "3m ago" — coarse on purpose; it re-renders on editor
 *  transactions, not on a clock, so second-precision would sit stale. */
function describeAgo(at?: number): string {
  if (!at) return "now";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** Memoized: one of the center-pane surfaces that used to reconcile on
 *  every frame of a divider drag. TipTap builds its view in a content-keyed
 *  effect, so this is reconciliation cost only. */
export const PromptDrafter = memo(PromptDrafterBase);
