// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Library } from "lucide-react";

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
  /** Open the draft's discussion (the voice panel — talk or type). Null
   *  hides the floating Discuss pill. */
  onDiscuss?: (() => void) | null;
  /** Show the shelf — the folder tree + document list this document sits in. */
  onOpenShelf?: () => void;
  /** Attached sources on the open document, for the footer's count. */
  sourceCount?: number;
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

/** What the footer's save indicator can say. `savedAt` is epoch ms. */
export interface DrafterSaveState {
  kind: "saving" | "saved" | "retrying";
  savedAt?: number;
}

// The Prompt Drafter: a Word-style document editor for authoring a prompt and
// launching it into a new Claude Code plan session. JSON is the in-editor source
// of truth (full fidelity, persisted); markdown is generated only at send time.
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
  onDiscuss = null,
  onOpenShelf,
  sourceCount = 0,
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
      if (editor.isDestroyed) return;
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
    () => localStorage.getItem(`rl-drafter-mode-${draftId}`) === "suggesting",
  );
  const suggestingRef = useRef(suggesting);
  suggestingRef.current = suggesting;
  const [modeNote, setModeNote] = useState<string | null>(null);
  const setSuggesting = useCallback(
    (on: boolean) => {
      setSuggestingState(on);
      try {
        localStorage.setItem(
          `rl-drafter-mode-${draftId}`,
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
  const [instructError, setInstructError] = useState<string | null>(null);

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
      setInstructError(null);
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
        setInstructError(String(e));
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
        setInstructError(e.payload.error);
      },
    );
    // A ✦ turn may still be streaming from before this mount — the ref gating
    // these handlers died with the previous mount, so its completion would be
    // silently dropped. Probe the backend (only once both listeners are LIVE,
    // so the terminal event can't slip between probe and subscription) and
    // re-arm the gate + the target block's pulse; the handlers above then
    // just work.
    void Promise.all([done, err])
      .then(() =>
        invoke<{ streaming: boolean; instruct: { blockId: string } | null }>(
          "draft_turn_status",
          { draftId },
        ),
      )
      .then((s) => {
        if (!alive || !s.streaming || !s.instruct) return;
        instructInFlight.current = true;
        const blockId = s.instruct.blockId;
        setGenerating((prev) =>
          prev.has(blockId) ? prev : new Set(prev).add(blockId),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
      void done.then((un) => un());
      void err.then((un) => un());
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
  const [userRun, setUserRun] = useState<{
    suggestionId: string;
    left: number;
    top: number;
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
      const coords = editor.view.coordsAtPos($head.pos);
      setUserRun({ suggestionId: sid, left: coords.left, top: coords.top });
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
  const [pendingSel, setPendingSel] = useState<{
    blockId: string | null;
    charStart: number;
    charEnd: number;
    quotedText: string;
    rect: { left: number; top: number };
  } | null>(null);

  const openCommentComposer = useCallback(() => {
    if (!selection) return;
    setPendingSel({
      blockId: selection.anchorId || null,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
      quotedText: selection.text,
      rect: { left: selection.rect.left, top: selection.rect.top },
    });
    setCommentDraft("");
    setAskDraft(null);
    clearSelection();
  }, [selection, clearSelection]);

  const openAskComposer = useCallback(() => {
    if (!selection) return;
    setPendingSel({
      blockId: selection.anchorId || null,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
      quotedText: selection.text,
      rect: { left: selection.rect.left, top: selection.rect.top },
    });
    setAskDraft("");
    setCommentDraft(null);
    clearSelection();
  }, [selection, clearSelection]);

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
        setComments(rows);
        if (rows.length > 0) setSidecarOpen(true);
      })
      .catch(() => {});
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
        .catch(() => {});
      setCommentDraft(null);
      setPendingSel(null);
    },
    [pendingSel, draftId],
  );

  const deleteComment = useCallback(
    (id: string) => {
      void invoke("draft_comment_delete", { draftId, commentId: id }).catch(
        () => {},
      );
      setComments((list) => list.filter((c) => c.id !== id));
      if (focusedCommentId === id) setFocusedCommentId(null);
    },
    [draftId, focusedCommentId],
  );

  const launch = useCallback(() => {
    if (!editor || editor.isEmpty) return;
    const markdown = planDocToMarkdown(editor.state.doc, { sidecars: false });
    onLaunch(markdown, selectedProject);
  }, [editor, selectedProject, onLaunch]);

  const canSend = !!editor && !editor.isEmpty;

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

  // useEditor re-renders on every transaction, so reading the text here yields
  // a live word count without an extra extension or subscription.
  const text = editor?.getText() ?? "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--color-paper)" }}
    >
      <DrafterToolbar
        editor={editor}
        sidecarOpen={sidecarOpen}
        onToggleSidecar={() => setSidecarOpen((v) => !v)}
        commentCount={comments.length}
        suggesting={suggesting}
        onSetSuggesting={setSuggesting}
        hasUserRuns={!!editor && hasPendingUserSuggestions(editor)}
        onResolveAllMine={resolveAllUserRuns}
        onGenerate={() => editor?.commands.instructAtCaret()}
        canGenerate={
          !!editor &&
          generating.size === 0 &&
          resolveInstructionBlock(editor.state) !== null
        }
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

      {instructError && (
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
          <span className="min-w-0 flex-1 truncate" title={instructError}>
            {instructError}
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
            onClick={() => setInstructError(null)}
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

      {suggestions.length > 0 && (
        <div
          data-no-drag="true"
          className="flex flex-col gap-1 px-4 py-1.5"
          style={{
            borderBottom: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
          }}
        >
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
                onClick={() => showSuggestion(s)}
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
                onClick={() => resolveSuggestion(s, "applied")}
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
                onClick={() => resolveSuggestion(s, "rejected")}
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
      )}

      {/* `relative` so the floating Discuss pill anchors to this body row (not
          the scroll container — an abspos child there would scroll away). */}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={workspaceRef}
          className="rl-thin-scroll-y rl-page-workspace rl-page-workspace--drafter relative min-h-0 flex-1 overflow-y-auto"
        >
          {userRun && !selection && (
            <div
              className="fixed z-30 flex items-center gap-0.5 rounded-full px-1 py-0.5"
              style={{
                left: `${Math.max(8, userRun.left)}px`,
                top: `${Math.max(8, userRun.top - 36)}px`,
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
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
            </div>
          )}
          {selection && pendingSel === null && (
            <div
              className="fixed z-30 flex items-center overflow-hidden rounded-full"
              style={{
                left: `${Math.max(8, selection.rect.left)}px`,
                top: `${Math.max(8, selection.rect.top - 34)}px`,
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              <button
                type="button"
                // preventDefault on mousedown so clicking the button never
                // collapses the selection it exists to act on (the plan
                // editor's SelectionMenu does the same).
                onMouseDown={(e) => e.preventDefault()}
                onClick={openCommentComposer}
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
                  onClick={openAskComposer}
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
            </div>
          )}
          {pendingSel && commentDraft !== null && (
            <div
              className="fixed z-30 flex flex-col gap-1 rounded p-2"
              style={{
                left: `${Math.max(8, pendingSel.rect.left)}px`,
                top: `${Math.max(8, pendingSel.rect.top - 96)}px`,
                width: "260px",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              <div
                className="truncate"
                style={{
                  fontSize: "10.5px",
                  color: "var(--color-ink-muted)",
                  borderLeft: "2px solid var(--color-rule)",
                  paddingLeft: "6px",
                }}
                title={pendingSel.quotedText}
              >
                {pendingSel.quotedText}
              </div>
              <textarea
                autoFocus
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    addComment(commentDraft);
                  }
                  if (e.key === "Escape") {
                    setCommentDraft(null);
                    setPendingSel(null);
                  }
                }}
                placeholder="Comment on this selection…"
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
                  onClick={() => {
                    setCommentDraft(null);
                    setPendingSel(null);
                  }}
                  style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => addComment(commentDraft)}
                  disabled={!commentDraft.trim()}
                  className="rounded px-2 py-0.5"
                  style={{
                    fontSize: "11px",
                    background: "var(--color-info)",
                    color: "var(--color-on-accent)",
                    opacity: commentDraft.trim() ? 1 : 0.5,
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
          {pendingSel && askDraft !== null && (
            <div
              className="fixed z-30 flex flex-col gap-1 rounded p-2"
              style={{
                left: `${Math.max(8, pendingSel.rect.left)}px`,
                top: `${Math.max(8, pendingSel.rect.top - 96)}px`,
                width: "280px",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              <div
                className="truncate"
                style={{
                  fontSize: "10.5px",
                  color: "var(--color-ink-muted)",
                  borderLeft: "2px solid var(--color-info)",
                  paddingLeft: "6px",
                }}
                title={pendingSel.quotedText}
              >
                {pendingSel.quotedText}
              </div>
              <textarea
                autoFocus
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitAsk(askDraft);
                  }
                  if (e.key === "Escape") {
                    setAskDraft(null);
                    setPendingSel(null);
                  }
                }}
                placeholder="Ask the agent — e.g. “make this punchier”…"
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
                  onClick={() => {
                    setAskDraft(null);
                    setPendingSel(null);
                  }}
                  style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => submitAsk(askDraft)}
                  disabled={!askDraft.trim()}
                  className="rounded px-2 py-0.5"
                  style={{
                    fontSize: "11px",
                    background: "var(--color-info)",
                    color: "var(--color-on-accent)",
                    opacity: askDraft.trim() ? 1 : 0.5,
                  }}
                >
                  ✦ Ask
                </button>
              </div>
            </div>
          )}
          {searchOpen && (
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
          )}
          <div
            ref={pageRef}
            className="rl-page"
            onClick={() => editor?.chain().focus().run()}
          >
            <EditorContent editor={editor} />
          </div>
        </div>
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

      {/* One slim footer row: project picker · word count · Send. Comments
          moved to the toolbar ribbon; discussion lives in the floating pill. */}
      <div
        data-no-drag="true"
        className="flex items-center gap-3 px-4 py-1.5"
        style={{
          borderTop: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
        }}
      >
        {onOpenShelf && (
          <button
            type="button"
            onClick={onOpenShelf}
            title="Your Bookshelf — every document you've stored, in folders"
            className="flex items-center gap-1 rounded-sm px-2 py-1"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <Library size={14} strokeWidth={2} />
            Bookshelf
            {sourceCount > 0 && (
              <span
                style={{ color: "var(--color-ink-muted)", fontSize: "11px" }}
                title={`${sourceCount} source${sourceCount === 1 ? "" : "s"} attached to this document`}
              >
                · {sourceCount} src
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
        />
        {saveState && (
          <span
            className="ml-auto"
            style={{
              fontSize: "11px",
              color:
                saveState.kind === "retrying"
                  ? "var(--color-warning)"
                  : "var(--color-ink-muted)",
              whiteSpace: "nowrap",
            }}
            title="Whether this document's latest keystrokes have reached the database"
          >
            {saveState.kind === "saving"
              ? "Saving…"
              : saveState.kind === "retrying"
                ? "Unsaved — retrying"
                : `Saved · ${describeAgo(saveState.savedAt)}`}
          </span>
        )}
        <span
          className={saveState ? undefined : "ml-auto"}
          style={{
            fontSize: "11px",
            color: "var(--color-ink-muted)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {words} {words === 1 ? "word" : "words"}
        </span>
        <button
          type="button"
          onClick={launch}
          disabled={!canSend}
          title={
            "Launch a new Claude Code plan session seeded with this prompt. " +
            "Sent as structured text — fonts, color & styling are drafting aids only."
          }
          className="rounded-sm px-3 py-1"
          style={{
            fontSize: "12.5px",
            border: "1px solid var(--color-rule)",
            background: canSend
              ? "var(--color-anchor-bg)"
              : "var(--color-bg-elevated)",
            color: canSend ? "var(--color-anchor-text)" : "var(--color-ink)",
            opacity: canSend ? 1 : 0.5,
            cursor: canSend ? "pointer" : "default",
            whiteSpace: "nowrap",
          }}
        >
          Send to Claude Code ▶
        </button>
      </div>
    </div>
  );
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
