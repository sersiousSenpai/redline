// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Section } from "../types";
import {
  SpeechQueue,
  loadVoices,
  loadVoicePrefs,
  saveVoicePrefs,
  browserSpeechDriver,
  type SpeechState,
  type VoicePrefs,
} from "../audio/speech";
import { cloudTtsDriver } from "../audio/cloudTts";
import { UtteranceDetector, DEFAULT_VAD_SILENCE_MS } from "../audio/vad";
import { Playback, type NarrationMark } from "../audio/playback";
import { PREROLL_CLEAR_MS } from "../audio/dictationTypes";
import { quietFor } from "../audio/audible";
import { splitReply, spokenPause } from "../audio/voiceStream";
import {
  IDLE_TURN,
  accepts,
  thinkingCaption,
  turnReducer,
  type TurnAction,
  type TurnId,
  type TurnState,
} from "../audio/turnState";
import {
  isBenignDictationError,
  isNonSpeech,
  offerAnswer,
} from "../audio/utterance";
import { broker } from "../audio/dictationBroker";
import { mountStrip, registerTurnTaker } from "../audio/dictationHost";
import { loadHoldKey } from "../audio/voiceHotkey";
import { useDictationComposer } from "../lib/dictationComposer";
import {
  holdPoint,
  pointAt,
  scrollToSection,
  sectionInView,
  sectionTitles,
  showComment,
  titleFor,
} from "../audio/planPoint";
import { getVoiceAway, setVoiceAway } from "../audio/voiceAway";
import {
  markdownToSpeakable,
  flattenSections,
  type SpeechSegment,
} from "../lib/markdownToSpeakable";
import {
  groupOffers,
  offerChipLabel,
  type CommentOffer,
} from "../lib/commentOffers";
import type { Activity } from "../lib/turnMeter";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { VoiceSettings, type TtsEngine } from "./VoiceSettings";
import { PulseLogo, type PulseState } from "./PulseLogo";
import { MarkdownView } from "./MarkdownView";
import { levelHeight, STRIP_BARS, strip } from "./DictationStrip";
import { StreamingText } from "./StreamingText";

// Every turn-scoped `voice-*` event names its child and its turn (see
// turnState.ts): the panel acts only on the turn it is waiting for.
interface TurnEvent {
  sessionId: string;
  generation: number;
  turn: number;
}
interface VoiceDeltaEvent extends TurnEvent {
  text: string;
}
interface VoiceMeterEvent extends TurnEvent {
  activity: Activity | null;
}
interface VoiceDoneEvent extends TurnEvent {
  body: string;
  /** The persisted transcript row — what a just-staged offer binds to. */
  messageId: string | null;
}
/** A turn the user stopped: never an error. `text` is what had streamed,
 *  persisted as the reply. */
interface VoiceInterruptedEvent extends TurnEvent {
  text: string;
  messageId: string | null;
}
interface VoiceErrorEvent {
  sessionId: string;
  generation: number;
  /** The turn that failed; null when the child itself never came up. */
  turn: number | null;
  error: string;
}
interface VoiceChildEvent {
  sessionId: string;
  generation: number;
}
/** A feedback comment this voice session actually wrote. */
interface VoiceCapturedEvent {
  sessionId: string;
  commentId: string;
  anchorId: string;
  sectionTitle: string | null;
  body: string;
}

/** The panel's captures' owner (dictationBroker.ts): its push-to-talk takes
 *  the mic from anyone; hands-free listening yields to anyone. */
const VOICE_OWNER = "voice";

/** A capture confirmation's handles: Undo for a while, Show for good. */
interface CaptureNote {
  commentId: string;
  anchorId: string;
  sectionTitle: string | null;
  body: string;
  undone?: boolean;
}

interface TranscriptLine {
  role: "you" | "agent" | "note";
  /** For an agent line, the reply as it streamed (markers and all) — every
   *  render goes through `splitReply`, so a reloaded reply looks as it did. */
  text: string;
  /** The persisted `voice_messages` row id, when this line has one. Locally
   *  appended `you`/`note` lines don't — which is exactly why the rehydrate
   *  merge below still needs its text-based fallback key. */
  id?: string;
  /** A local line that may yet be withdrawn: a turn whose send failed. */
  key?: string;
  /** The user cut this reply off — a muted tag, never an error. */
  interrupted?: boolean;
  capture?: CaptureNote;
}

/** One persisted transcript line, as `voice_thread` returns it. */
interface VoiceMessage {
  id: string;
  sessionKey: string;
  role: string;
  text: string;
  createdAt: number;
}

/** Live status of the warm child, from `voice_session_status`. */
interface VoiceStatus {
  up: boolean;
  inFlight: boolean;
  generation: number;
  turn: number;
}

/** What `voice_interrupt` did. */
interface VoiceInterrupt {
  interrupting: boolean;
  generation: number;
  turn: number;
}

/** A turn waiting to go out: typed while a reply ran (shown in the tray), or
 *  spoken over one (sent the moment the interrupted turn ends). */
interface Outgoing {
  id: string;
  text: string;
  /** What the transcript shows, when that differs from what is sent. */
  label: string;
  spoken?: boolean;
  /** A starter's canned prompt: never put back in the composer. */
  canned?: boolean;
  /** Sends refused because a turn this panel lost track of was running. */
  retries?: number;
}

const TRANSCRIPT_ROLES = new Set(["you", "agent", "note"]);

/** Transcript lines a mounted panel holds: the newest, the same bound as every
 *  other chat surface's thread (`THREAD_KEEP` in lib/agentTurn; repeated here
 *  because importing it would split that module into a chunk of its own). The
 *  rest stay in SQLite, where the agent still reads them. */
const TRANSCRIPT_KEEP = 1000;

/** Typed turns that may wait behind a running reply (the chat surfaces'
 *  queue bound). */
const MAX_QUEUED = 5;

/** A key-held talk counts only after this long, so a stray Space tap never
 *  cuts a reply off. */
const KEY_HOLD_MS = 250;

/** How long a capture confirmation offers Undo. */
const UNDO_MS = 10_000;

/** A stop whose turn has not ended by now is checked on directly. The CLI
 *  answers in milliseconds and the backend replaces a wedged child within
 *  ~3 s, so this is only for a child that died without a word. */
const INTERRUPT_CHECK_MS = 6_000;

/** How long a selection in the plan stays "what they selected". */
const SELECTION_FRESH_MS = 120_000;

/** Narrow a persisted row back to a transcript line. An unrecognized role
 *  (a row from a newer build) renders as a plain note rather than vanishing. */
function toTranscriptLine(m: VoiceMessage): TranscriptLine {
  return {
    role: TRANSCRIPT_ROLES.has(m.role)
      ? (m.role as TranscriptLine["role"])
      : "note",
    text: m.text,
    id: m.id,
  };
}

const lineKey = (l: TranscriptLine) => `${l.role} ${l.text}`;

let outgoingSeq = 0;
const outgoingId = () => `out-${Date.now()}-${(outgoingSeq += 1)}`;

/** The end of `text`, at most `max` characters, marked when cut. */
function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max).trimStart()}` : t;
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Where read-aloud reaches each section: the "Section: <title>." lead-in
 *  `markdownToSpeakable` writes for every heading, found in order. */
function readMarks(speakable: string, segments: readonly SpeechSegment[]): NarrationMark[] {
  const marks: NarrationMark[] = [];
  let from = 0;
  for (const seg of segments) {
    const title = seg.title.replace(/[.:]+$/, "");
    if (!title) continue;
    const at = speakable.indexOf(`Section: ${title}.`, from);
    if (at === -1) continue;
    marks.push({ at, anchorId: seg.anchorId, kind: "read" });
    from = at + 1;
  }
  return marks;
}

/** Where a key-held talk may start: inside the panel, but never on a control —
 *  Space there is the control's own (a button's press, a field's space). */
function isTalkZone(target: EventTarget | null, panel: HTMLElement): boolean {
  if (!(target instanceof Element) || !panel.contains(target)) return false;
  const control = target.closest(
    "button, input, textarea, select, option, a[href], summary, [contenteditable]:not([contenteditable='false']), " +
      "[role='button'], [role='switch'], [role='checkbox'], [role='menuitem'], [role='slider'], [role='tab'], [role='option'], [role='textbox']",
  );
  return !control || !panel.contains(control);
}

const MUTED = "var(--color-ink-muted, #888)";

/** The input row's mic: a 30 px target, red while it listens. */
const MIC_BUTTON: React.CSSProperties = {
  width: "30px",
  height: "30px",
  flexShrink: 0,
  fontSize: "14px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-anchor-bg)",
  color: "var(--color-anchor-text)",
  cursor: "pointer",
  transition: "background 120ms ease",
};
const MIC_HOT: React.CSSProperties = { background: "var(--color-danger, #c0392b)", color: "#fff" };

/** The dictation key's glyph, for the input's hint; none when it is off. */
const TALK_KEY_GLYPH: Record<string, string> = { AltRight: "⌥", MetaRight: "⌘", ControlRight: "⌃" };

const BYLINE: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: MUTED,
  marginBottom: "2px",
};

const LINK_BTN: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  minHeight: "24px",
  color: "var(--color-anchor-text)",
  fontStyle: "normal",
  fontWeight: 600,
  cursor: "pointer",
};

/** A section the reply names: hover outlines it in the plan, a click scrolls
 *  there. Nothing else in the panel moves the plan. */
function SectionChip({ anchorId, title }: { anchorId: string; title: string }) {
  const release = useRef<(() => void) | null>(null);
  const hold = () => {
    release.current?.();
    release.current = holdPoint(anchorId);
  };
  const letGo = () => {
    release.current?.();
    release.current = null;
  };
  useEffect(() => letGo, []);
  return (
    <button
      type="button"
      onMouseEnter={hold}
      onMouseLeave={letGo}
      onFocus={hold}
      onBlur={letGo}
      onClick={() => scrollToSection(anchorId)}
      title={`Show “${title}” in the plan`}
      className="rounded-full px-2"
      style={{
        minHeight: "24px",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "11.5px",
        border: "1px solid var(--color-rule)",
        background: "transparent",
        color: "var(--color-anchor-text)",
        cursor: "pointer",
      }}
    >
      § {title}
    </button>
  );
}

/** One reply, live or settled, in one skeleton: a quiet byline, the spoken
 *  part, the sections it named, and the on-screen detail — muted markdown
 *  under it, never spoken, never boxed. */
const ReplyView = memo(function ReplyView({
  raw,
  live = false,
  interrupted = false,
  titles,
}: {
  raw: string;
  live?: boolean;
  interrupted?: boolean;
  /** Section titles by anchor; null where the document has no plan sections
   *  to point at (a draft). */
  titles: ReadonlyMap<string, string> | null;
}) {
  const reply = useMemo(() => splitReply(raw), [raw]);
  const chips = titles
    ? reply.sections.flatMap((id) => {
        const title = titleFor(titles, id);
        return title ? [[id, title] as const] : [];
      })
    : [];
  return (
    <div className="mb-3" data-voice-reply>
      <div style={BYLINE}>Claude</div>
      {live ? (
        <StreamingText text={reply.spoken} />
      ) : (
        <div>
          <MarkdownView body={reply.spoken} compact />
        </div>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1" style={{ marginTop: "4px" }}>
          {chips.map(([id, title]) => (
            <SectionChip key={id} anchorId={id} title={title} />
          ))}
        </div>
      )}
      {reply.screen && (
        <div style={{ marginTop: "6px", color: MUTED }} data-voice-screen>
          {live ? (
            <StreamingText text={reply.screen} />
          ) : (
            <div>
              <MarkdownView body={reply.screen} compact />
            </div>
          )}
        </div>
      )}
      {interrupted && (
        <span style={{ color: MUTED, fontSize: "0.9em", fontStyle: "italic" }}>
          (interrupted)
        </span>
      )}
    </div>
  );
});

/** The offer row under a reply: what would be added, and one tap to add it.
 *  Nothing here has touched the plan yet — the muted line is the exact body the
 *  feedback comment would carry, so the tap is never a surprise. An item the
 *  user asked for outright adds itself once the agent's read-back has played. */
function OfferRow({
  offers,
  busy,
  errors,
  explicit,
  onAdd,
  onDismiss,
}: {
  offers: CommentOffer[];
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  explicit: ReadonlySet<string>;
  onAdd: (o: CommentOffer) => void;
  onDismiss: (o: CommentOffer) => void;
}) {
  if (offers.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {offers.map((o) => {
        const disabled = !!busy[o.id] || !!o.stale;
        return (
          <div key={o.id} className="flex flex-col gap-1">
            <span style={{ color: MUTED, fontSize: "0.9em" }} title={o.body}>
              “{offerChipLabel(o)}”
              {explicit.has(o.id) && !o.stale && " — adding after the read-back"}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAdd(o)}
                title={
                  o.stale
                    ? "The plan changed under this item"
                    : `Add to the plan: ${o.body}`
                }
                className="rounded-full px-2.5 py-1"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-anchor-bg)",
                  color: "var(--color-anchor-text)",
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                ＋ Add as item
              </button>
              <button
                type="button"
                onClick={() => onDismiss(o)}
                title="Dismiss"
                aria-label="Dismiss offered item"
                className="rounded-full px-2 py-1"
                style={{
                  fontSize: "11px",
                  border: "1px solid var(--color-rule)",
                  background: "transparent",
                  color: MUTED,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            {(errors[o.id] || o.stale) && (
              <span
                style={{
                  color: "var(--color-danger, #c0392b)",
                  fontSize: "0.9em",
                }}
              >
                {errors[o.id] ??
                  "The plan changed under this item — ask again and I'll re-anchor it."}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Deferred `voice_session_stop` timers, keyed by voice key and held at MODULE
 *  scope on purpose.
 *
 *  A StrictMode mount→cleanup→mount reuses one component instance, so an
 *  instance ref sufficed to cancel the teardown. A *genuine* unmount→remount is
 *  not covered: when a revision lands, the pane clears its session and this
 *  panel is conditionally unmounted for the length of the load, then a brand-new
 *  instance mounts with a fresh ref — which cannot cancel its predecessor's
 *  timer. That timer went on to kill the warm child the new panel had just
 *  adopted, leaving it stuck on "Warming up…" for no visible reason. Keyed
 *  outside the component, any instance can cancel the pending stop for its own
 *  session. */
const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingStop(sessionId: string) {
  const t = pendingStops.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingStops.delete(sessionId);
  }
}

interface VoicePanelProps {
  /** The voice key: a plan session id, or `drafter:<draft_id>` for a Prompt
   *  Drafter session (the backend derives the kind from the key shape). */
  sessionId: string;
  /** The document under discussion (plan revision or draft), sidecars included. */
  markdown: string;
  /** Section tree — drives the structure-aware read and the walkthrough. */
  sections: Section[];
  /** Working dir for a drafter session (plan sessions resolve their own from
   *  the SessionStore). */
  cwd?: string | null;
  /** Drafter sessions only: a getter for the LIVE markdown mirror straight
   *  from the open editor. Sent with each turn so the backend can flush the
   *  DB mirror before the agent reads it — the `markdown` prop alone is
   *  debounce-lagged. Returning undefined (e.g. the drafter pane is closed)
   *  falls back to the `markdown` prop. */
  liveMarkdown?: (() => string | undefined) | null;
  /** Reports whether a discussion is actually going on here — a non-empty
   *  transcript, or a turn in flight. The host uses it to decide whether an
   *  incoming plan may steal focus: interrupting a live conversation to jump to
   *  another session is the one case where the intercept's auto-switch is
   *  wrong. Mirrors `TerminalTabs`' `onActivityChange`. */
  onActivityChange?: (active: boolean) => void;
  onClose: () => void;
  onOpenChat?: (companionId: string) => void;
}

const SUMMARY_PROMPT =
  "Give me a short spoken summary of this whole plan — the gist in a few " +
  "sentences, for the ear.";

function explainPrompt(title: string, body: string): string {
  return (
    `Explain this section of the plan to me conversationally, for the ear — ` +
    `the gist and why it matters, not a verbatim read.\n\nSection "${title}":\n\n${body}`
  );
}

function VoicePanelBase({
  sessionId,
  markdown,
  sections,
  cwd,
  liveMarkdown = null,
  onActivityChange,
  onClose,
  onOpenChat,
}: VoicePanelProps) {
  const isDrafter = sessionId.startsWith("drafter:");
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The hold-to-dictate key is a turn here, even from the typed input.
  useDictationComposer(panelRef, { turn: true });
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  /** Something is playing or queued to play (from `Playback`, not the queue's
   *  own flag — a clip that never ends trips the stall watchdog instead of
   *  holding this up forever). */
  const [audioBusy, setAudioBusy] = useState(false);
  const [sessionUp, setSessionUp] = useState(false);
  // Mirror of `sessionUp` for the readiness-timeout closure (avoids stale state).
  const sessionUpRef = useRef(false);
  sessionUpRef.current = sessionUp;
  // Latest plan markdown, read inside effects/callbacks without restarting the
  // session on every revision change.
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;
  const liveMarkdownRef = useRef(liveMarkdown);
  liveMarkdownRef.current = liveMarkdown;
  const titles = useMemo(() => sectionTitles(sections), [sections]);
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscriptState] = useState<TranscriptLine[]>([]);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  // Held to the newest TRANSCRIPT_KEEP lines (docs/perf-budget.md rule 7).
  const setTranscript = useCallback(
    (next: TranscriptLine[] | ((prev: TranscriptLine[]) => TranscriptLine[])) =>
      setTranscriptState((prev) => {
        const lines = typeof next === "function" ? next(prev) : next;
        const kept = lines.length > TRANSCRIPT_KEEP ? lines.slice(-TRANSCRIPT_KEEP) : lines;
        transcriptRef.current = kept;
        return kept;
      }),
    [],
  );
  const [originChat, setOriginChat] = useState<{ companionId: string; title: string; messages: { id: string; role: string; body: string }[] } | null>(null);
  useEffect(() => {
    let alive = true;
    setOriginChat(null);
    if (!sessionId.startsWith("drafter:")) void invoke<typeof originChat>("plan_origin_chat", { sessionId }).then(chat => { if (alive) setOriginChat(chat); }).catch(() => {});
    return () => { alive = false; };
  }, [sessionId]);

  // --- The turn ------------------------------------------------------------
  // One reducer (turnState.ts) owns which turn is live; `turnRef` is its sync
  // mirror for the event listeners, which must decide before React renders.
  const [turn, setTurn] = useState<TurnState>(IDLE_TURN);
  const turnRef = useRef<TurnState>(IDLE_TURN);
  // What runs when a turn ends — the queue's drain (assigned below).
  const afterTurnRef = useRef<() => void>(() => {});
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A stop was asked for this turn; asked again once `voice_send` names it,
  // in case the first ask reached the child before the turn did.
  const interruptWantedRef = useRef(false);
  const dispatch = useCallback((action: TurnAction) => {
    const prev = turnRef.current;
    const next = turnReducer(prev, action);
    if (next === prev) return;
    turnRef.current = next;
    setTurn(next);
    if (prev.phase !== "idle" && next.phase === "idle") {
      interruptWantedRef.current = false;
      if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
      interruptTimerRef.current = null;
      afterTurnRef.current();
    }
  }, []);
  // The newest child this panel has heard of: an error or exit from an older
  // one is a replaced child's last word, not news.
  const generationRef = useRef(0);
  const noteGeneration = useCallback((g: number | null | undefined) => {
    if (typeof g === "number" && g > generationRef.current) generationRef.current = g;
  }, []);

  // The live reply, raw, and how much of its spoken part went to speech.
  const [streaming, setStreaming] = useState("");
  const rawRef = useRef("");
  const spokenLenRef = useRef(0);
  const markedRef = useRef(0);

  // Typed turns waiting behind a reply, and a spoken one waiting for the
  // reply it interrupted to end.
  const [outbox, setOutboxState] = useState<Outgoing[]>([]);
  const outboxRef = useRef<Outgoing[]>([]);
  const setOutbox = useCallback((next: Outgoing[]) => {
    outboxRef.current = next;
    setOutboxState(next);
  }, []);

  // Hidden context for the next turn: where playback was cut, what was said to
  // an offer, a capture undone. Consumed by the next send.
  const cutNoteRef = useRef<string | null>(null);
  const contextNotesRef = useRef<string[]>([]);
  // The last text selected outside the panel (see the selection effect).
  const selectionRef = useRef<{ text: string; at: number } | null>(null);
  // The section read-aloud has reached, while it plays.
  const readingRef = useRef<{ anchorId: string; title: string } | null>(null);

  // Staged, not-yet-written plan items the agent offered this conversation, plus
  // per-offer in-flight/error state for the chip row.
  const [offers, setOffersState] = useState<CommentOffer[]>([]);
  const offersRef = useRef<CommentOffer[]>([]);
  const setOffers = useCallback(
    (next: CommentOffer[] | ((prev: CommentOffer[]) => CommentOffer[])) =>
      setOffersState((prev) => {
        const list = typeof next === "function" ? next(prev) : next;
        offersRef.current = list;
        return list;
      }),
    [],
  );
  const [offerBusy, setOfferBusy] = useState<Record<string, boolean>>({});
  const [offerErrors, setOfferErrors] = useState<Record<string, string>>({});
  // Offers the user asked for outright ("add that as feedback"): added once
  // the agent's read-back has played, unless they stop it first.
  const [explicit, setExplicitState] = useState<ReadonlySet<string>>(new Set());
  const explicitRef = useRef<ReadonlySet<string>>(new Set());
  const setExplicit = useCallback((next: ReadonlySet<string>) => {
    explicitRef.current = next;
    setExplicitState(next);
  }, []);
  const autoAddArmedRef = useRef(false);
  // Capture confirmations still offering Undo.
  const [undoable, setUndoable] = useState<ReadonlySet<string>>(new Set());

  // The composer's text.
  const [typed, setTyped] = useState("");
  // The last thing spoken aloud — what "▶ Replay" plays again.
  const [lastSpoken, setLastSpoken] = useState("");
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  // Active TTS engine (system speechSynthesis vs cloud premium) + settings view.
  const [engine, setEngine] = useState<TtsEngine>("system");
  const [showSettings, setShowSettings] = useState(false);

  // Push-to-talk (Phase 2). `listening` drives the indicator + button; `partial`
  // is the live transcript shown while the talk button is held. `talkingRef`
  // dedupes the hold (mouse and key autorepeat both fire repeatedly).
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const talkingRef = useRef(false);
  // The capture in progress: when the hold began, and whether the live
  // recognizer has heard any words (the non-speech filter reads both).
  const captureRef = useRef({ startedAt: 0, heard: false });
  // Pending end-of-capture timer. On release we keep the recognizer running a
  // short beat so it finishes transcribing the tail of speech (the last word
  // lags the audio); re-pressing within that window cancels it and keeps going.
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The input row the strip sits over, and the waveform's latest levels.
  const inputRowRef = useRef<HTMLFormElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  // A key-held talk (Space in the panel, or on the talk button): the timer is
  // the hold not yet long enough to count; `keyHeldRef` is one that counted.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyHeldRef = useRef(false);

  // Hands-free (Step 3): converse without holding a button. The mic listens, a
  // silence pause ends the utterance (VAD), the transcript auto-sends, the reply
  // is spoken, then it listens again. It's HALF-DUPLEX on purpose: the mic is
  // only armed while the agent is idle and is torn down the moment an utterance
  // ends, so it can't transcribe the agent's own TTS (acoustic echo). Push-to-
  // talk is suspended while hands-free is on (one mic owner, no races) and is the
  // fallback when it's off. `hfArmedRef` = the mic is currently live for
  // hands-free; `handsFreeRef` mirrors the toggle for sync reads in callbacks.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const hfArmedRef = useRef(false);
  // An utterance has ended and is being transcribed: the mic must not re-arm
  // under it.
  const [utterancePending, setUtterancePending] = useState(false);
  // Re-arming after a benign recognizer error waits a beat longer, so a silent
  // room doesn't spin the recognizer.
  const rearmDelayRef = useRef(300);
  // End-of-utterance detector, fed by the `dictation-partial` stream. Built once;
  // its callback dispatches through a ref so it always runs the latest handler.
  const onUtteranceRef = useRef<(text: string) => void>(() => {});
  const vadRef = useRef<UtteranceDetector | null>(null);
  if (!vadRef.current) {
    vadRef.current = new UtteranceDetector({
      silenceMs: DEFAULT_VAD_SILENCE_MS,
      onUtteranceEnd: (text) => onUtteranceRef.current(text),
    });
  }

  // Walkthrough cursor. It's an opt-in starter ("Walk me through it") that
  // explains one section at a time and waits — the user taps "Next section" to
  // advance (no auto-running). `walkActive` shows the inline walk controls.
  const segments = useMemo(() => flattenSections(sections), [sections]);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const [walkIndex, setWalkIndex] = useState(0);
  const [walkActive, setWalkActive] = useState(false);

  // When the user stops or talks over a reply, the rest of it — still
  // streaming in — must not be spoken. Cleared when a new turn begins.
  const discardSpeechRef = useRef(false);

  // What is actually being heard (playback.ts). Its callbacks dispatch through
  // a ref, like the VAD's, so they always run the latest handlers.
  const playbackEventsRef = useRef<{
    point: (marks: NarrationMark[]) => void;
    idle: () => void;
    stall: () => void;
  }>({ point: () => {}, idle: () => {}, stall: () => {} });
  const playbackRef = useRef<Playback | null>(null);
  // When the agent's voice last went quiet (Infinity while it sounds): the
  // warm mic's pre-roll, the moment before a capture starts, holds its end
  // for a little while after.
  const quietAtRef = useRef(0);
  if (!playbackRef.current) {
    playbackRef.current = new Playback({
      onClipStart: () => {
        quietAtRef.current = Infinity;
        setAudioBusy(true);
      },
      onPoint: (marks) => playbackEventsRef.current.point(marks),
      onIdle: () => playbackEventsRef.current.idle(),
      onStall: () => playbackEventsRef.current.stall(),
    });
  }
  const playback = playbackRef.current;

  // One SpeechQueue for the panel's lifetime; state drives the indicator.
  const queueRef = useRef<SpeechQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SpeechQueue({
      prefs,
      driver: playback.wrap(browserSpeechDriver()),
      onState: (s) => setSpeechState(s),
    });
  }

  /** Hand text to speech, mirrored into the narration so its clips can be
   *  matched to the sections they mention. */
  const say = useCallback(
    (text: string, marks: NarrationMark[] = []) => {
      playback.narrate(text, marks);
      if (text) queueRef.current?.enqueue(text);
    },
    [playback],
  );

  /** Speak whatever of the live reply's spoken part is new — never the
   *  ⟦screen⟧ detail, never a marker. The held-back tail is spoken at the
   *  end (`final`), and as soon as the spoken part pauses (`spokenPause`). */
  const speakLive = useCallback(
    (final: boolean) => {
      if (discardSpeechRef.current) return;
      const raw = rawRef.current;
      const reply = splitReply(raw);
      const base = spokenLenRef.current;
      const fresh = reply.spoken.slice(base);
      const marks = reply.marks.slice(markedRef.current);
      if (fresh || marks.length) {
        say(
          fresh,
          marks.map((m) => ({
            at: Math.max(0, m.at - base),
            anchorId: m.anchorId,
            kind: "point" as const,
          })),
        );
        spokenLenRef.current = reply.spoken.length;
        markedRef.current = reply.marks.length;
      }
      if (final || spokenPause(raw)) queueRef.current?.flush();
    },
    [say],
  );

  // Populate the system-voice list (async on first call in some engines).
  useEffect(() => {
    let alive = true;
    void loadVoices().then((vs) => {
      if (alive) setVoices(vs);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the queue's prefs in sync and persist them.
  useEffect(() => {
    queueRef.current?.setPrefs(prefs);
    saveVoicePrefs(prefs);
  }, [prefs]);

  // Apply a TTS engine by swapping the queue's driver. `system` uses the WebView
  // `speechSynthesis`; every other engine (cloud OpenAI or local Kokoro) is
  // synthesized in Rust via `tts_synth` and played through the same Web-Audio
  // driver — the engine choice is resolved server-side per call.
  // Surface a synthesis failure (e.g. a bad key, a 429, an out-of-credits error
  // from a cloud engine, a wedged Kokoro) into the transcript so a change of
  // voice has a visible reason: the driver hands every sentence the engine
  // failed on to the system voice, so the reply keeps talking. Deduped on the
  // message itself: a streamed reply fails the SAME way on every sentence over
  // many seconds, so we show one note per DISTINCT error and suppress repeats
  // of it (no time window — a long turn must still collapse to one). Every
  // occurrence is still logged by the driver (console) and Rust (`error`
  // level, with the provider's full response).
  const lastSynthErrRef = useRef<string>("");
  const reportSynthError = useCallback((msg: string) => {
    if (lastSynthErrRef.current === msg) return;
    lastSynthErrRef.current = msg;
    const short = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    // Deliberately NOT persisted (unlike the other transcript lines): this is a
    // diagnostic about the audio session that's live right now, not part of the
    // conversation. Replaying "🔇 … the system voice is reading" on every
    // reopen — long after a key was fixed — would just be a stale alarm.
    setTranscript((t) => [
      ...t,
      { role: "note", text: `🔇 The voice engine failed, so the system voice is reading — ${short}` },
    ]);
  }, [setTranscript]);

  const applyEngine = useCallback(
    (e: TtsEngine) => {
      setEngine(e);
      queueRef.current?.setDriver(
        playback.wrap(
          e === "system" ? browserSpeechDriver() : cloudTtsDriver(reportSynthError),
        ),
      );
      // Pre-load Kokoro's model so the first sentence doesn't pay cold-start.
      if (e === "kokoro") void invoke("tts_kokoro_warm").catch(() => {});
    },
    [playback, reportSynthError],
  );

  // Silence everything queued or playing, and stop feeding the queue the rest
  // of a reply still streaming in. A read-back the user cut short adds nothing.
  const stopSpeech = useCallback(() => {
    discardSpeechRef.current = true;
    readingRef.current = null;
    autoAddArmedRef.current = false;
    if (explicitRef.current.size) setExplicit(new Set());
    queueRef.current?.cancel();
  }, [setExplicit]);

  // Stop all speech, then close the panel (don't let a still-streaming reply keep
  // talking after it's gone).
  const handleClose = useCallback(() => {
    discardSpeechRef.current = true;
    queueRef.current?.cancel();
    onClose();
  }, [onClose]);

  // Open/close settings; opening stops any current speech so it doesn't keep
  // talking from behind the settings view (where there's no Stop button).
  const toggleSettings = useCallback(() => {
    setShowSettings((s) => {
      if (!s) {
        discardSpeechRef.current = true;
        queueRef.current?.cancel();
      }
      return !s;
    });
  }, []);

  // Load the configured engine on open.
  useEffect(() => {
    void invoke<{ engine: string }>("tts_get_settings")
      .then((s) => applyEngine((s.engine as TtsEngine) || "system"))
      .catch(() => {});
  }, [applyEngine]);

  // Warm Kokoro's model the instant the panel opens (a no-op for other engines),
  // so its ~seconds of first-load happen while you're reading, not after you
  // press a button. The sidecar then stays warm for the rest of the app session.
  useEffect(() => {
    void invoke("tts_kokoro_warm").catch(() => {});
  }, []);

  // Pre-warm the warm Claude session on open so the first agent turn is fast.
  // Verbatim never needs it, but opening the panel signals intent to discuss.
  useEffect(() => {
    let alive = true;
    // Cancel any deferred teardown left by a just-unmounted pass — a StrictMode
    // mount→cleanup→mount in dev, or the real unmount→remount of a load gap.
    // Without this the cleanup would kill the session we're about to reuse.
    cancelPendingStop(sessionId);
    // Opening the panel is looking at whatever the pill was holding up for
    // this conversation (another plan's waiting reply stays on its pill).
    if (getVoiceAway()?.key === sessionId) setVoiceAway(null);
    // Spawn the warm child and mark it ready once spawned. (A fresh `claude
    // --input-format stream-json` doesn't emit `init` until its first turn, so
    // we can't wait on `voice-ready` to show Ready — but `voice-exit` /
    // `voice-error` flip it back if the child actually dies, and the deferred
    // teardown below stops a StrictMode remount from killing a healthy child.)
    void invoke<number>("voice_session_start", {
      sessionId,
      planMarkdown: markdownRef.current,
      cwd: cwd ?? null,
    })
      .then((generation) => {
        noteGeneration(generation);
        if (alive) setSessionUp(true);
      })
      .catch((e) => alive && setError(String(e)));
    // Rehydrate what was on screen. The agent's own memory has always survived
    // a session switch or a restart (its forked session id is in the DB); the
    // transcript lived only in this component's state, so the panel came back
    // blank next to an agent that remembered everything. These rows are the
    // matching half — written from Rust, so they include replies that landed
    // while the panel was unmounted.
    void invoke<VoiceMessage[]>("voice_thread", { sessionId })
      .then((rows) => {
        if (!alive) return;
        const history = rows.map(toTranscriptLine);
        setTranscript((local) => {
          // The common case: nothing has happened since mount.
          if (local.length === 0) return history;
          // A turn completed while this fetch was in flight — its line is both
          // in `history` (Rust persists before it emits) and already on screen.
          // Keep the live lines, put the rest of the history in front. Prefer
          // id equality where both sides have one (a repeated question is not a
          // duplicate); the text key still covers locally-appended `you`/`note`
          // lines, which never carry an id.
          const seenIds = new Set(
            local.map((l) => l.id).filter((id): id is string => !!id),
          );
          const seen = new Set(local.map(lineKey));
          const already = (h: TranscriptLine) =>
            (h.id !== undefined && seenIds.has(h.id)) || seen.has(lineKey(h));
          return [...history.filter((h) => !already(h)), ...local];
        });
      })
      .catch(() => {
        /* best-effort: an unreadable transcript starts the panel empty */
      });
    // A turn may still be streaming from before the unmount (a plan arrived
    // mid-reply). Adopt it, so its reply lands in this mount instead of looking
    // idle and then appearing from nowhere on the next reopen; otherwise every
    // turn so far is history, and nothing it says now is news.
    void invoke<VoiceStatus>("voice_session_status", { sessionId })
      .then((s) => {
        if (!alive || !s) return;
        if (s.up) setSessionUp(true);
        if (typeof s.generation !== "number") return;
        noteGeneration(s.generation);
        const id = { generation: s.generation, turn: s.turn };
        dispatch(s.inFlight ? { type: "adopt", id, at: Date.now() } : { type: "baseline", id });
      })
      .catch(() => {});
    // If the warm child never reports `init` (no `voice-ready`), don't sit on
    // "Warming up…" forever — probe the child and surface what it printed so a
    // stuck/failed spawn is actionable instead of a silent dead-end.
    const readyTimer = setTimeout(() => {
      if (!alive || sessionUpRef.current) return;
      void invoke<{ alive: boolean; stderrTail: string }>("voice_session_probe", {
        sessionId,
      })
        .then((p) => {
          if (!alive || sessionUpRef.current) return;
          if (p.alive) {
            // Genuinely still coming up (hooks/resume replay) but not yet
            // ready — surface what it has printed so far, if anything.
            const detail = p.stderrTail
              ? `\n\nClaude reported:\n${p.stderrTail}`
              : "";
            setError(
              (prev) =>
                prev ??
                "The voice session is taking longer than expected to start." +
                  detail,
            );
          } else {
            // The child has already exited. `read_voice` owns this case: it
            // emits `voice-error` with the captured stderr tail (the *real*
            // reason). The proc is already out of the registry by now, so the
            // probe can't see that tail — only fall back to a generic line if
            // no error surfaced, and never clobber the accurate one.
            setError(
              (prev) =>
                prev ??
                "The voice session failed to start — the `claude` process " +
                  "exited. Check that Claude Code runs in this project, or " +
                  "launch Redline from a terminal so it inherits your PATH.",
            );
          }
        })
        .catch(() => {
          if (alive && !sessionUpRef.current) {
            setError((prev) => prev ?? "The voice session hasn't started yet.");
          }
        });
    }, 15000);
    return () => {
      alive = false;
      clearTimeout(readyTimer);
      // A turn left running goes on without the panel; the pill says so.
      if (turnRef.current.phase !== "idle") {
        setVoiceAway({ key: sessionId, state: "thinking" });
      }
      queueRef.current?.cancel();
      // Defer teardown (memory persists in the DB → resumes on reopen). A real
      // close lets this fire; a quick StrictMode/remount cancels it on re-entry,
      // so a healthy warm child isn't killed by its own stdin closing.
      // Unforced: the backend leaves a streaming turn alone, so a plan arriving
      // mid-reply no longer throws away the answer the user is waiting for.
      pendingStops.set(
        sessionId,
        setTimeout(() => {
          pendingStops.delete(sessionId);
          void invoke("voice_session_stop", { sessionId }).catch(() => {});
          broker.cancel(VOICE_OWNER);
        }, 300),
      );
    };
  }, [sessionId]);

  // Send one turn to the warm session, self-healing if it died: a
  // "voice session not started" means the child is gone, so restart it once and
  // retry. Any other error (or a second failure) propagates to the caller.
  // `label` is what this turn LOOKS like in the transcript when that differs
  // from what's sent (the canned starters send a long prompt but read as
  // "▶ Summarize the plan"). The backend persists the line, so it needs the
  // display text. `context` rides the turn hidden (see `takeContext`).
  const sendToSession = useCallback(
    async (text: string, label: string, context: string): Promise<TurnId | null> => {
      // Drafter sessions carry the LIVE editor markdown so the backend can
      // flush the DB mirror before the agent's mid-turn re-read; plan
      // sessions send null (their doc lives elsewhere).
      const draftMarkdown = sessionId.startsWith("drafter:")
        ? (liveMarkdownRef.current?.() ?? markdownRef.current ?? null)
        : null;
      const args = {
        sessionId,
        text,
        label: label === text ? null : label,
        draftMarkdown,
        context: context || null,
      };
      try {
        return await invoke<TurnId | null>("voice_send", args);
      } catch (e) {
        if (!String(e).includes("not started")) throw e;
        noteGeneration(
          await invoke<number>("voice_session_start", {
            sessionId,
            planMarkdown: markdownRef.current,
            cwd: cwd ?? null,
          }),
        );
        return await invoke<TurnId | null>("voice_send", args);
      }
    },
    [sessionId],
  );

  // Persist a transcript line the panel produced with no backend turn behind it
  // (the "▶ Read the plan" marker, a capture confirmation, a spoken yes to an
  // offer), so a rehydrated transcript matches what was on screen. Best-effort.
  const persistNote = useCallback(
    (role: TranscriptLine["role"], text: string) => {
      void invoke("voice_note", { sessionId, role, text }).catch(() => {});
    },
    [sessionId],
  );

  /** What the user is pointing at, as hidden context for the next turn: the
   *  section in view, what they selected, where read-aloud is — plus the notes
   *  left since the last turn (where a reply was cut off, an answer to an
   *  offer). `restore` puts the notes back when the send fails. */
  const takeContext = useCallback(() => {
    const lines: string[] = [];
    if (!isDrafter) {
      const view = sectionInView(titlesRef.current);
      if (view) lines.push(`Looking at §${view.anchorId} "${view.title}"`);
    }
    const sel = selectionRef.current;
    if (sel && Date.now() - sel.at < SELECTION_FRESH_MS) {
      lines.push(`Selected: "${clip(sel.text, 300)}"`);
    }
    const reading = readingRef.current;
    if (reading) lines.push(`Reading aloud: §${reading.anchorId} "${reading.title}"`);
    const notes = [
      ...(cutNoteRef.current ? [cutNoteRef.current] : []),
      ...contextNotesRef.current,
    ];
    cutNoteRef.current = null;
    contextNotesRef.current = [];
    return {
      text: [...lines, ...notes].join("\n"),
      restore: () => {
        contextNotesRef.current = [...notes, ...contextNotesRef.current];
      },
    };
  }, [isDrafter]);

  const restoreDraft = useCallback((text: string) => {
    setTyped((prev) => (prev.trim() ? `${text} ${prev}` : text));
  }, []);

  // Ask the CLI to stop the turn in place: the same child, with everything said
  // so far in memory, takes the next one. Its end arrives as `voice-interrupted`.
  const sendInterrupt = useCallback(() => {
    void invoke<VoiceInterrupt | null>("voice_interrupt", { sessionId })
      .then((r) => {
        if (!r?.interrupting) return;
        noteGeneration(r.generation);
        dispatch({ type: "sent", id: { generation: r.generation, turn: r.turn } });
      })
      .catch(() => {});
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    interruptTimerRef.current = setTimeout(() => {
      interruptTimerRef.current = null;
      if (turnRef.current.phase === "idle") return;
      void invoke<VoiceStatus>("voice_session_status", { sessionId })
        .then((s) => {
          if (s && !s.inFlight) dispatch({ type: "lost" });
        })
        .catch(() => {});
    }, INTERRUPT_CHECK_MS);
  }, [sessionId, dispatch, noteGeneration]);

  // Send one turn now. The user's line shows at once; a send that fails takes
  // it back off and puts the words in the composer — nothing said is lost.
  const sendNow = useCallback(
    (item: Outgoing) => {
      setError(null);
      const context = takeContext();
      dispatch({ type: "send", at: Date.now() });
      rawRef.current = "";
      spokenLenRef.current = 0;
      markedRef.current = 0;
      setStreaming("");
      discardSpeechRef.current = false; // speak the reply to this new turn
      queueRef.current?.primeTurn(); // start speaking at the first clause
      setTranscript((t) => [...t, { role: "you", text: item.label, key: item.id }]);
      sendToSession(item.text, item.label, context.text)
        .then((id) => {
          if (!id) return;
          noteGeneration(id.generation);
          dispatch({ type: "sent", id });
          if (interruptWantedRef.current) sendInterrupt();
        })
        .catch((e) => {
          const msg = String(e);
          setTranscript((t) => t.filter((l) => l.key !== item.id));
          context.restore();
          // The child is still finishing a turn this panel lost track of: wait
          // for that one to end, then go.
          if (msg.includes("still streaming") && (item.retries ?? 0) < 3) {
            setOutbox([{ ...item, retries: (item.retries ?? 0) + 1 }, ...outboxRef.current]);
            void invoke<VoiceStatus>("voice_session_status", { sessionId })
              .then((s) => {
                if (s?.inFlight) {
                  noteGeneration(s.generation);
                  dispatch({
                    type: "adopt",
                    id: { generation: s.generation, turn: s.turn },
                    at: Date.now(),
                  });
                } else {
                  dispatch({ type: "send-failed" });
                }
              })
              .catch(() => dispatch({ type: "send-failed" }));
            return;
          }
          dispatch({ type: "send-failed" });
          if (!item.canned) restoreDraft(item.text);
          setError(msg);
        });
    },
    [sessionId, takeContext, dispatch, sendToSession, sendInterrupt, noteGeneration, setTranscript, setOutbox, restoreDraft],
  );

  // The next waiting turn goes out once nothing is running.
  const drain = useCallback(() => {
    if (turnRef.current.phase !== "idle") return;
    const [next, ...rest] = outboxRef.current;
    if (!next) return;
    setOutbox(rest);
    sendNow(next);
  }, [sendNow, setOutbox]);
  afterTurnRef.current = drain;

  /** Where the listener was when a reply was cut off — the agent remembers
   *  its whole reply, but they heard only this much. */
  const cutNote = useCallback((): string | null => {
    const playing = playback.current();
    const reading = readingRef.current;
    if (playing && reading) {
      return `They stopped the read-aloud in §${reading.anchorId} "${reading.title}"`;
    }
    if (playing) return `You were interrupted after saying: "${tail(playing.text, 160)}"`;
    const phase = turnRef.current.phase;
    if (phase === "streaming") return "You were interrupted before they heard any of your reply";
    if (phase !== "idle") return "You were interrupted before you said anything";
    return null;
  }, [playback]);

  // Stop: silence what is playing and, when a turn is running, stop it in
  // place. Talking over a reply does exactly the same before it listens.
  const stopReply = useCallback(() => {
    const note = cutNote();
    if (note) cutNoteRef.current = note;
    stopSpeech();
    if (turnRef.current.phase === "idle") return;
    interruptWantedRef.current = true;
    if (turnRef.current.interrupting) return;
    dispatch({ type: "interrupt" });
    sendInterrupt();
  }, [cutNote, stopSpeech, dispatch, sendInterrupt]);

  // --- Offered items ---------------------------------------------------------

  // Tap (or a spoken yes, or the read-back of an explicit capture finishing):
  // create the real feedback comment. Its confirmation comes from the write
  // itself — `voice-captured` — so on success the chip simply goes away.
  const addOffer = useCallback((offer: CommentOffer) => {
    setOfferBusy((b) => ({ ...b, [offer.id]: true }));
    setOfferErrors(({ [offer.id]: _drop, ...rest }) => rest);
    void invoke("comment_offer_add", { offerId: offer.id })
      .then(() => {
        setOffers((list) => list.filter((o) => o.id !== offer.id));
      })
      .catch((e) => {
        const raw = String(e);
        setOfferErrors((errs) => ({
          ...errs,
          [offer.id]: /no block .* in the latest revision/.test(raw)
            ? "The plan changed under this item — ask again and I'll re-anchor it."
            : raw,
        }));
      })
      .finally(() => {
        setOfferBusy(({ [offer.id]: _drop, ...rest }) => rest);
      });
  }, [setOffers]);

  const dismissOffer = useCallback((offer: CommentOffer) => {
    setOffers((list) => list.filter((o) => o.id !== offer.id));
    if (explicitRef.current.has(offer.id)) {
      const next = new Set(explicitRef.current);
      next.delete(offer.id);
      setExplicit(next);
    }
    void invoke("comment_offer_dismiss", { offerId: offer.id }).catch(() => {});
  }, [setOffers, setExplicit]);

  // The read-back of an explicit capture has played: add it.
  const runAutoAdd = useCallback(() => {
    autoAddArmedRef.current = false;
    const due = explicitRef.current;
    if (due.size === 0) return;
    setExplicit(new Set());
    for (const o of offersRef.current) {
      if (due.has(o.id) && !o.stale) addOffer(o);
    }
  }, [addOffer, setExplicit]);

  /** A spoken yes or no to what the agent offered in its last reply, handled
   *  here instead of becoming a turn. The agent hears about it next turn. */
  const answerOffers = useCallback(
    (text: string): boolean => {
      const lastAgent = [...transcriptRef.current]
        .reverse()
        .find((l) => l.role === "agent")?.id;
      const pending = offersRef.current.filter(
        (o) =>
          !o.stale &&
          !explicitRef.current.has(o.id) &&
          (o.messageId === null || o.messageId === lastAgent),
      );
      if (pending.length === 0) return false;
      const answer = offerAnswer(text);
      if (!answer) return false;
      setTranscript((t) => [...t, { role: "you", text }]);
      persistNote("you", text);
      const labels = pending.map((o) => `"${offerChipLabel(o)}"`).join(", ");
      if (answer === "yes") {
        pending.forEach(addOffer);
        contextNotesRef.current.push(`They said yes to adding ${labels}`);
      } else {
        pending.forEach(dismissOffer);
        contextNotesRef.current.push(`They said no to adding ${labels}`);
      }
      return true;
    },
    [addOffer, dismissOffer, persistNote, setTranscript],
  );

  // Something the user said: an answer to an offer, or a turn — which goes out
  // first, ahead of anything typed, the moment nothing is running.
  const submitSpoken = useCallback(
    (text: string) => {
      if (answerOffers(text)) return;
      setOutbox([{ id: outgoingId(), text, label: text, spoken: true }, ...outboxRef.current]);
      drain();
    },
    [answerOffers, drain, setOutbox],
  );

  // --- Playback events -------------------------------------------------------
  playbackEventsRef.current = {
    // A section the narration reached: light it (never scroll to it), and
    // remember where read-aloud is.
    point: (marks) => {
      for (const m of marks) {
        if (m.kind === "read") {
          readingRef.current = {
            anchorId: m.anchorId,
            title: titlesRef.current.get(m.anchorId) ?? "",
          };
        }
        if (!isDrafter) pointAt(m.anchorId);
      }
    },
    idle: () => {
      setAudioBusy(false);
      if (quietAtRef.current === Infinity) quietAtRef.current = Date.now();
      readingRef.current = null;
      if (autoAddArmedRef.current) runAutoAdd();
    },
    stall: () => {
      setTranscript((t) => [
        ...t,
        { role: "note", text: "🔇 Playback stalled — skipped the rest of that reply." },
      ]);
      queueRef.current?.cancel();
    },
  };

  // --- Stream events -----------------------------------------------------------
  // Handlers read everything through refs or stable callbacks, so the
  // listeners are wired once per session.
  const streamRef = useRef({ speakLive, runAutoAdd });
  streamRef.current = { speakLive, runAutoAdd };
  useEffect(() => {
    // `listen()` is async; under StrictMode the cleanup runs before these
    // resolve, so guard with `disposed` and immediately unlisten anything that
    // resolves after teardown — otherwise the dev mount→cleanup→mount leaves
    // TWO live listener sets and every event fires twice (duplicate transcript
    // + doubled, jerky speech).
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const add = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    const mine = (e: { sessionId: string }) => e.sessionId === sessionId;
    const idOf = (e: TurnEvent): TurnId => ({ generation: e.generation, turn: e.turn });
    const wire = async () => {
      add(
        await listen<VoiceChildEvent>("voice-ready", (e) => {
          if (!mine(e.payload)) return;
          noteGeneration(e.payload.generation);
          setSessionUp(true);
        }),
      );
      add(
        await listen<VoiceDeltaEvent>("voice-delta", (e) => {
          if (!mine(e.payload)) return;
          const id = idOf(e.payload);
          if (!accepts(turnRef.current, id)) return;
          dispatch({ type: "text", id });
          rawRef.current += e.payload.text;
          setStreaming(rawRef.current);
          streamRef.current.speakLive(false);
        }),
      );
      add(
        await listen<VoiceMeterEvent>("voice-meter", (e) => {
          if (!mine(e.payload)) return;
          dispatch({ type: "activity", id: idOf(e.payload), activity: e.payload.activity ?? null });
        }),
      );
      add(
        await listen<VoiceDoneEvent>("voice-done", (e) => {
          if (!mine(e.payload)) return;
          const id = idOf(e.payload);
          if (!accepts(turnRef.current, id)) return;
          const body = e.payload.body || rawRef.current;
          const messageId = e.payload.messageId ?? undefined;
          rawRef.current = body;
          streamRef.current.speakLive(true);
          rawRef.current = "";
          setStreaming("");
          setTranscript((t) => [...t, { role: "agent", text: body, id: messageId }]);
          // Rust bound this turn's offers to the row it just wrote; do the same
          // locally so chips staged mid-turn snap under this reply immediately
          // instead of waiting for a remount to re-read them.
          if (messageId) {
            setOffers((list) =>
              list.map((o) => (o.messageId ? o : { ...o, messageId })),
            );
          }
          if (!discardSpeechRef.current) {
            setLastSpoken(splitReply(body).spoken);
            // An explicit capture is added once its read-back has played.
            if (explicitRef.current.size) {
              autoAddArmedRef.current = true;
              if (!playbackRef.current?.busy()) streamRef.current.runAutoAdd();
            }
          } else if (explicitRef.current.size) {
            // Its speech was silenced (settings opened over it): nobody heard
            // the read-back, so the item waits for a tap — and must not ride
            // along with the next reply's.
            setExplicit(new Set());
          }
          dispatch({ type: "end", id });
        }),
      );
      add(
        await listen<VoiceInterruptedEvent>("voice-interrupted", (e) => {
          if (!mine(e.payload)) return;
          const id = idOf(e.payload);
          if (!accepts(turnRef.current, id)) return;
          const text = e.payload.text.trim();
          const messageId = e.payload.messageId ?? undefined;
          rawRef.current = "";
          setStreaming("");
          setTranscript((t) => [
            ...t,
            text
              ? { role: "agent", text, id: messageId, interrupted: true }
              : { role: "note", text: "(interrupted)", interrupted: true },
          ]);
          if (messageId) {
            setOffers((list) =>
              list.map((o) => (o.messageId ? o : { ...o, messageId })),
            );
          }
          // Nobody heard a read-back that was cut off: an explicit capture
          // waits for a tap like any other.
          if (explicitRef.current.size) setExplicit(new Set());
          dispatch({ type: "end", id });
        }),
      );
      add(
        await listen<VoiceErrorEvent>("voice-error", (e) => {
          if (!mine(e.payload)) return;
          const { generation, turn: t } = e.payload;
          if (t === null || t === undefined) {
            // The child itself failed. An older child's last word is not news.
            if (generation < generationRef.current) return;
            dispatch({ type: "lost", generation });
          } else {
            const id = { generation, turn: t };
            if (!accepts(turnRef.current, id)) return;
            rawRef.current = "";
            setStreaming("");
            dispatch({ type: "end", id });
          }
          setWalkActive(false);
          if (explicitRef.current.size) setExplicit(new Set());
          setError(e.payload.error);
        }),
      );
      add(
        await listen<VoiceChildEvent>("voice-exit", (e) => {
          if (!mine(e.payload)) return;
          if (e.payload.generation < generationRef.current) return;
          setSessionUp(false);
          setWalkActive(false);
          if (turnRef.current.phase !== "idle") {
            rawRef.current = "";
            setStreaming("");
          }
          dispatch({ type: "lost", generation: e.payload.generation });
        }),
      );
      add(
        // The confirmation of a capture is the capture: only a feedback comment
        // this voice session actually wrote announces itself here — never any
        // `comments-changed`, which the user's own edits fire too.
        await listen<VoiceCapturedEvent>("voice-captured", (e) => {
          if (!mine(e.payload)) return;
          const { commentId, anchorId, sectionTitle, body } = e.payload;
          const text =
            `📝 Captured as feedback${sectionTitle ? ` on “${sectionTitle}”` : ""}: ` +
            clip(body, 140);
          setTranscript((t) => [
            ...t,
            { role: "note", text, capture: { commentId, anchorId, sectionTitle, body } },
          ]);
          void invoke("voice_note", { sessionId, role: "note", text }).catch(() => {});
          setUndoable((s) => new Set(s).add(commentId));
          setTimeout(() => {
            setUndoable((s) => {
              const next = new Set(s);
              next.delete(commentId);
              return next;
            });
          }, UNDO_MS);
        }),
      );
    };
    void wire();
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [sessionId]);

  // Offered plan items — the `＋ Add as item` chips. Drain what's already
  // staged (a chip that landed while this panel was closed), then take live
  // ones off the event. The DB drain is authoritative: it also decides which
  // offers are `stale`, so a remount self-heals any local drift. Only the live
  // event says an offer was asked for outright — a panel that mounts later
  // never heard that read-back, so it shows an ordinary chip.
  useEffect(() => {
    let alive = true;
    setOffers([]);
    setOfferErrors({});
    void invoke<CommentOffer[]>("comment_offers_pending", { sessionId })
      .then((rows) => {
        if (!alive) return;
        setOffers((list) => {
          const seen = new Set(list.map((o) => o.id));
          return [...list, ...rows.filter((r) => !seen.has(r.id))];
        });
      })
      .catch(() => {
        /* best-effort: no chips is a fine degraded state */
      });
    const p = listen<CommentOffer & { explicit?: boolean }>("comment-offer", (e) => {
      if (!alive || e.payload.sessionId !== sessionId) return;
      setOffers((list) =>
        list.some((o) => o.id === e.payload.id) ? list : [...list, e.payload],
      );
      if (e.payload.explicit && turnRef.current.phase !== "idle") {
        setExplicit(new Set(explicitRef.current).add(e.payload.id));
      }
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
  }, [sessionId]);

  const groupedOffers = useMemo(
    () => groupOffers(transcript, offers),
    [transcript, offers],
  );

  const undoCapture = useCallback(
    (c: CaptureNote) => {
      void invoke<boolean>("delete_comment", { sessionId, commentId: c.commentId })
        .then((removed) => {
          setTranscript((t) =>
            t.map((l) =>
              l.capture?.commentId === c.commentId
                ? { ...l, capture: { ...l.capture, undone: true } }
                : l,
            ),
          );
          const note = removed
            ? `↩ Removed that feedback${c.sectionTitle ? ` from “${c.sectionTitle}”` : ""}.`
            : "That feedback was already gone.";
          setTranscript((t) => [...t, { role: "note", text: note }]);
          persistNote("note", note);
          if (removed) {
            contextNotesRef.current.push(
              `They removed the item you captured: "${clip(c.body, 120)}"`,
            );
          }
        })
        .catch((e) => setError(String(e)));
    },
    [sessionId, persistNote, setTranscript],
  );

  // Replay the last spoken reply (the idle "▶ Replay" action).
  const replayLast = useCallback(() => {
    const text = lastSpoken.trim();
    if (!text) return;
    setError(null);
    stopSpeech();
    discardSpeechRef.current = false;
    say(text);
    queueRef.current?.flush();
  }, [lastSpoken, stopSpeech, say]);

  const advanceWalk = useCallback(
    (index: number) => {
      const seg = segments[index];
      if (!seg) {
        setWalkActive(false);
        return;
      }
      setWalkActive(true);
      setWalkIndex(index);
      stopSpeech();
      sendNow({
        id: outgoingId(),
        text: explainPrompt(seg.title, seg.bodyMarkdown),
        label: `▶ ${seg.title || `Section ${index + 1}`}`,
        canned: true,
      });
    },
    [segments, stopSpeech, sendNow],
  );

  // A one-shot turn from a button (a starter, a walkthrough interjection).
  const sendTurn = useCallback(
    (text: string, label: string) => {
      stopSpeech();
      sendNow({ id: outgoingId(), text, label, canned: true });
    },
    [stopSpeech, sendNow],
  );

  // Typed turn (the chat half of the panel): same warm session, same
  // transcript, same spoken reply — just entered without the mic. While a
  // reply runs it waits in the tray (never refused, never dropped) and goes
  // out when the reply ends; otherwise it goes now, cutting off any speech.
  const sendTyped = useCallback(() => {
    const t = typed.trim();
    if (!t) return;
    if (turnRef.current.phase !== "idle" || outboxRef.current.length > 0) {
      if (outboxRef.current.filter((o) => !o.spoken).length >= MAX_QUEUED) {
        setError(`${MAX_QUEUED} messages are already waiting — this one is still in the box.`);
        return;
      }
      setTyped("");
      setOutbox([...outboxRef.current, { id: outgoingId(), text: t, label: t }]);
      return;
    }
    setTyped("");
    if (playback.busy()) {
      const note = cutNote();
      if (note) cutNoteRef.current = note;
      stopSpeech();
    }
    sendNow({ id: outgoingId(), text: t, label: t });
  }, [typed, playback, cutNote, stopSpeech, sendNow, setOutbox]);

  // × on a waiting message puts it back in the composer.
  const unqueue = useCallback(
    (id: string) => {
      const item = outboxRef.current.find((o) => o.id === id);
      if (!item) return;
      setOutbox(outboxRef.current.filter((o) => o.id !== id));
      restoreDraft(item.text);
    },
    [setOutbox, restoreDraft],
  );

  // --- Hands-free turn-taking (Step 3) -------------------------------------

  // Arm the mic for the next hands-free utterance. No-op unless hands-free is on
  // and not already armed. Reuses the push-to-talk capture (`dictation_start`)
  // and feeds its partial stream into the VAD detector.
  const armHandsFree = useCallback(() => {
    if (!handsFreeRef.current || hfArmedRef.current) return;
    hfArmedRef.current = true;
    rearmDelayRef.current = 300;
    captureRef.current = { startedAt: Date.now(), heard: false };
    vadRef.current?.reset();
    setError(null);
    setListening(true);
    setPartial("");
    // Re-armed right after the agent spoke: the warm mic's last moments are
    // its voice, never the user's first word.
    const preroll = Date.now() - quietAtRef.current > PREROLL_CLEAR_MS && quietFor() > PREROLL_CLEAR_MS;
    void broker.start(VOICE_OWNER, { kind: "open", preroll }).then(
      (grant) => {
        if (grant.granted) return;
        // A dictation holds the mic: listen again once it is done.
        hfArmedRef.current = false;
        rearmDelayRef.current = 1000;
        setListening(false);
      },
      (e) => {
        hfArmedRef.current = false;
        handsFreeRef.current = false;
        setHandsFree(false);
        setListening(false);
        setError(String(e));
      },
    );
  }, []);

  // Tear the mic down and stop detecting (toggle off, error, or unmount).
  const disarmHandsFree = useCallback(() => {
    hfArmedRef.current = false;
    vadRef.current?.reset();
    setListening(false);
    setPartial("");
    broker.cancel(VOICE_OWNER);
  }, []);

  // VAD says the user paused → this is the end of an utterance. Close the mic
  // (half-duplex: it stays off through the agent's reply so it can't transcribe
  // the TTS) and send it — unless it was no speech at all, in which case the
  // re-arm effect simply listens again.
  const handleUtteranceEnd = useCallback(
    (vadText: string) => {
      if (!handsFreeRef.current) return;
      hfArmedRef.current = false;
      setListening(false);
      setUtterancePending(true);
      void broker.stop(VOICE_OWNER)
        .then((finalText) => {
          setPartial("");
          const text = ((finalText || vadText) || "").trim();
          const capture = { text, heldMs: null, heard: captureRef.current.heard };
          if (!isNonSpeech(capture)) submitSpoken(text);
        })
        .catch((e) => {
          handsFreeRef.current = false;
          setHandsFree(false);
          setError(String(e));
        })
        .finally(() => setUtterancePending(false));
    },
    [submitSpoken],
  );
  onUtteranceRef.current = handleUtteranceEnd;

  // Toggle hands-free. Turning it off tears the mic down; turning it on lets the
  // re-arm effect open the mic once the agent is idle.
  const toggleHandsFree = useCallback(() => {
    setHandsFree((on) => {
      const next = !on;
      handsFreeRef.current = next;
      if (!next) disarmHandsFree();
      return next;
    });
  }, [disarmHandsFree]);

  // The hands-free status button doubles as manual barge-in: since the mic is
  // half-duplex, a tap stops the agent, and the re-arm effect drops back to
  // listening once the turn has ended.
  const onHandsFreeButton = useCallback(() => {
    if (turnRef.current.phase !== "idle" || playback.busy()) stopReply();
  }, [playback, stopReply]);

  // Re-arm the mic once the turn is over and nothing is left to hear. Driven by
  // the turn and by what is actually playing — never by the speech queue's own
  // flag, which a clip that never ends could hold at "speaking" for good (the
  // stall watchdog ends such a clip instead). The short delay leaves a natural
  // beat before listening resumes.
  const turnBusy = turn.phase !== "idle";
  useEffect(() => {
    if (
      !handsFree ||
      hfArmedRef.current ||
      turnBusy ||
      outbox.length > 0 ||
      utterancePending ||
      audioBusy
    ) {
      return;
    }
    const t = setTimeout(() => armHandsFree(), rearmDelayRef.current);
    return () => clearTimeout(t);
  }, [handsFree, listening, turnBusy, outbox.length, utterancePending, audioBusy, armHandsFree]);

  // Live partial transcript + dictation errors from the native mic: this
  // panel's captures only (the broker routes by owner), so a dictation into
  // a composer never paints here or feeds the end-of-utterance detector.
  useEffect(() => {
    const detach = broker.attach(VOICE_OWNER, {
      // The strip's waveform: drawn straight onto it, never through a render.
      level: (l) => {
        if (strip.get()?.owner !== VOICE_OWNER) return;
        levelsRef.current = [...levelsRef.current.slice(1 - STRIP_BARS), levelHeight(l.rms)];
        strip.update({ levels: levelsRef.current });
      },
      partial: (text) => {
        setPartial(text);
        if (text.trim()) captureRef.current.heard = true;
        // In hands-free, the partial stream drives end-of-utterance detection.
        if (handsFreeRef.current && hfArmedRef.current) {
          vadRef.current?.feed(text);
        }
      },
      error: (e) => {
        // "No speech detected" and its kin: the recognizer had nothing (more)
        // to hear. A push-to-talk hold carries on to its release; hands-free
        // listens again after a beat. Neither is worth a red line, and
        // neither turns hands-free off.
        if (isBenignDictationError(e)) {
          if (handsFreeRef.current && hfArmedRef.current) {
            hfArmedRef.current = false;
            rearmDelayRef.current = 1000;
            vadRef.current?.reset();
            setListening(false);
            setPartial("");
            // The task is over but its capture is still open, and
            // `dictation_start` does nothing while one is: close it, so
            // the re-arm really listens.
            broker.cancel(VOICE_OWNER);
          }
          return;
        }
        talkingRef.current = false;
        // Likewise the capture a failed task leaves open, or the next press
        // would start nothing.
        broker.cancel(VOICE_OWNER);
        // A real mic error can't be auto-recovered cleanly, and re-arming
        // would just loop, so drop out of hands-free and surface it.
        hfArmedRef.current = false;
        handsFreeRef.current = false;
        setHandsFree(false);
        vadRef.current?.reset();
        setListening(false);
        setPartial("");
        setError(e.error);
      },
      // A dictation took the mic (the hold key, a composer's mic): this
      // capture is over. Hands-free listens again once the mic is free.
      preempted: () => {
        talkingRef.current = false;
        if (hfArmedRef.current) {
          hfArmedRef.current = false;
          rearmDelayRef.current = 1000;
        }
        vadRef.current?.reset();
        setListening(false);
        setPartial("");
      },
    });
    return () => {
      detach();
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      hfArmedRef.current = false;
      vadRef.current?.reset();
    };
  }, []);

  // Remember what the user selects outside the panel — the "that" in "add that
  // here". Clicking into the panel to answer leaves it alone; a fresh click
  // elsewhere forgets it.
  useEffect(() => {
    const onSelection = () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      if (!el || panelRef.current?.contains(el)) return;
      const text = sel.toString().trim();
      selectionRef.current = text ? { text, at: Date.now() } : null;
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  // How long to keep the recognizer running after release so it can transcribe
  // the tail of speech (Apple's partial results lag the audio by a beat).
  const CAPTURE_TAIL_MS = 350;

  // Push-to-talk: press → stop whatever is running and listen; release →
  // (after a short tail) → transcribe → send, unless it was no speech at all.
  // `since` is when the hold began (a key hold counts from its keydown).
  const startTalk = useCallback(
    (since = Date.now()) => {
      // Hands-free owns the mic while it's on — manual push-to-talk is suspended.
      if (handsFreeRef.current) return;
      if (talkingRef.current) return;
      // Re-pressing during the post-release tail: cancel the pending stop and keep
      // the same capture going (the recognizer never actually stopped).
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
        talkingRef.current = true;
        setListening(true);
        return;
      }
      talkingRef.current = true;
      captureRef.current = { startedAt: since, heard: false };
      setError(null);
      // Talking over the agent's voice (or a chat read aloud elsewhere): what
      // the warm mic heard just before the press is that voice, not the
      // user's first syllable.
      const preroll = Date.now() - quietAtRef.current > PREROLL_CLEAR_MS && quietFor() > PREROLL_CLEAR_MS;
      // Talking over the agent: silence it and stop its turn in place, so it
      // stops generating what nobody will hear — its memory stays whole.
      if (turnRef.current.phase !== "idle" || playback.busy()) stopReply();
      setListening(true);
      setPartial("");
      void broker.start(VOICE_OWNER, { kind: "hold", preroll }).catch((e) => {
        talkingRef.current = false;
        setListening(false);
        setError(String(e));
      });
    },
    [playback, stopReply],
  );

  const stopTalk = useCallback(() => {
    if (handsFreeRef.current) return;
    if (!talkingRef.current) return;
    talkingRef.current = false;
    const heldMs = Date.now() - captureRef.current.startedAt;
    // Don't stop the recognizer the instant the button is released — give it a
    // beat to catch the last word, then read the finalized transcript.
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(() => {
      stopTimerRef.current = null;
      setListening(false);
      void broker.stop(VOICE_OWNER)
        .then((finalText) => {
          setPartial("");
          const text = (finalText || "").trim();
          // In any mode — in the Walkthrough this is exactly the §1e
          // interjection signal — but never a tap, a cough or a silence.
          const capture = { text, heldMs, heard: captureRef.current.heard };
          if (!isNonSpeech(capture)) submitSpoken(text);
        })
        .catch((e) => setError(String(e)));
    }, CAPTURE_TAIL_MS);
  }, [submitSpoken]);

  // Esc on the hold-to-dictate key's turn: nothing is sent.
  const cancelTalk = useCallback(() => {
    if (handsFreeRef.current) return;
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    talkingRef.current = false;
    setListening(false);
    setPartial("");
    broker.cancel(VOICE_OWNER);
  }, []);

  // The hold-to-dictate key, with nothing that takes text focused (or focus
  // in this panel), is a turn here: the panel's own push-to-talk.
  useEffect(
    () => registerTurnTaker({ key: sessionId, start: startTalk, stop: stopTalk, cancel: cancelTalk }),
    [sessionId, startTalk, stopTalk, cancelTalk],
  );

  // While this panel's own capture listens, the dictation strip over its
  // input row shows it — the waveform and the words so far — and nothing in
  // the panel moves. It never clears another capture's strip.
  useEffect(() => {
    if (!listening) {
      levelsRef.current = [];
      if (strip.get()?.owner === VOICE_OWNER) strip.set(null);
      return;
    }
    mountStrip();
    const next = {
      owner: VOICE_OWNER,
      phase: "listening" as const,
      text: partial,
      anchor: inputRowRef.current,
      hint: handsFreeRef.current ? "pause to send" : "release to send",
    };
    if (strip.get()?.owner === VOICE_OWNER) strip.update(next);
    else strip.set({ ...next, levels: levelsRef.current });
  }, [listening, partial]);
  useEffect(
    () => () => {
      if (strip.get()?.owner === VOICE_OWNER) strip.set(null);
    },
    [],
  );

  // A key-held talk: Space with focus in the panel (off its controls), or on
  // the talk button itself. It counts once held KEY_HOLD_MS; released sooner,
  // it was a tap and nothing happened.
  const beginKeyHold = useCallback(() => {
    if (handsFreeRef.current || holdTimerRef.current || keyHeldRef.current) return;
    const since = Date.now();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      keyHeldRef.current = true;
      startTalk(since);
    }, KEY_HOLD_MS);
  }, [startTalk]);

  const endKeyHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      return;
    }
    if (!keyHeldRef.current) return;
    keyHeldRef.current = false;
    stopTalk();
  }, [stopTalk]);

  // The release can land anywhere (focus may have moved mid-hold), so it is
  // heard on the window — and never has its default prevented there.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") endKeyHold();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", endKeyHold);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endKeyHold);
    };
  }, [endKeyHold]);

  // Space in the panel's own space (the transcript, its blank areas) is the
  // talk key; everywhere else — the app, the plan, the panel's own buttons
  // and fields — Space is left alone.
  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.code !== "Space" || handsFreeRef.current) return;
      if (!isTalkZone(e.target, e.currentTarget)) return;
      // Ours here: holding it must not page-scroll the transcript.
      e.preventDefault();
      if (!e.repeat) beginKeyHold();
    },
    [beginKeyHold],
  );

  // Starters — quick ways to begin; after any of them you just hold-to-talk to
  // keep the conversation going.
  const readAloud = useCallback(() => {
    setError(null);
    setWalkActive(false);
    stopSpeech();
    const speakable = markdownToSpeakable(markdownRef.current);
    if (!speakable) {
      setError("Nothing to read — the plan is empty.");
      return;
    }
    // Local TTS only — no backend turn, so the marker is persisted directly.
    setTranscript((t) => [...t, { role: "you", text: "▶ Read the plan" }]);
    persistNote("you", "▶ Read the plan");
    setLastSpoken(speakable);
    discardSpeechRef.current = false;
    // Each section's lead-in carries its anchor, so the plan lights up as the
    // reading reaches it and a question asked mid-read knows where it was.
    say(speakable, isDrafter ? [] : readMarks(speakable, segmentsRef.current));
    queueRef.current?.flush();
  }, [isDrafter, stopSpeech, say, persistNote, setTranscript]);

  const summarize = useCallback(() => {
    setWalkActive(false);
    sendTurn(SUMMARY_PROMPT, "▶ Summarize the plan");
  }, [sendTurn]);

  const startWalkthrough = useCallback(() => {
    advanceWalk(0);
  }, [advanceWalk]);

  // Report "a discussion is live here" to the host (see `onActivityChange`).
  // Reported on unmount as false, so a closed panel never keeps suppressing the
  // auto-switch.
  const discussionLive = transcript.length > 0 || turnBusy;
  useEffect(() => {
    onActivityChange?.(discussionLive);
  }, [discussionLive, onActivityChange]);
  useEffect(
    () => () => onActivityChange?.(false),
    [onActivityChange],
  );

  // The thinking line's clock: ticks only while waiting for the first word.
  const waiting = turn.phase === "sending" || turn.phase === "thinking";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const caption = turn.interrupting
    ? { text: "Stopping…", offerStop: false }
    : thinkingCaption(turn.activity, now - (turn.since ?? now));

  const queued = outbox.filter((o) => !o.spoken);
  // The tray floats over the transcript's foot; the transcript makes room under
  // its last line instead of shrinking, so nothing above it moves.
  const trayRef = useRef<HTMLDivElement | null>(null);
  const [trayHeight, setTrayHeight] = useState(0);
  useLayoutEffect(() => {
    setTrayHeight(trayRef.current?.offsetHeight ?? 0);
  }, [queued.length]);
  const stick = useStickToBottom<HTMLDivElement>([transcript, streaming, turn.phase, trayHeight]);

  const busy = turnBusy || outbox.length > 0;
  // Drives the spinning-logo pulse in the header: a steady working spin while
  // thinking or speaking, a slow receptive spin while the mic is open, still
  // otherwise.
  const voicePulse: PulseState = waiting
    ? "thinking"
    : turn.phase === "streaming" || speechState === "speaking"
      ? "streaming"
      : listening
        ? "listening"
        : "idle";
  const indicator: { label: string; color: string } = listening
    ? { label: "Listening…", color: "var(--color-danger, #c0392b)" }
    : waiting
    ? { label: caption.text, color: "var(--color-warn, #b8860b)" }
    : turn.phase === "streaming" && speechState !== "speaking"
    ? { label: "Answering…", color: "var(--color-anchor-text)" }
    : speechState === "speaking"
      ? { label: "Speaking…", color: "var(--color-anchor-text)" }
      : speechState === "paused"
        ? { label: "Paused", color: MUTED }
        : { label: sessionUp ? "Ready" : "Warming up…", color: MUTED };

  // The composer's one button: send; queue, once a reply is running and there
  // is text; stop, while one runs (or plays) and the box is empty.
  const hasText = typed.trim().length > 0;
  const primary: "send" | "queue" | "stop" = hasText
    ? busy
      ? "queue"
      : "send"
    : turnBusy || audioBusy
      ? "stop"
      : "send";
  const titlesForReplies = isDrafter ? null : titles;
  const heldKey = TALK_KEY_GLYPH[loadHoldKey()];
  const talkPlaceholder = handsFree
    ? "Just talk, or type…"
    : heldKey
      ? `Ask, or hold ${heldKey} to talk…`
      : "Ask, or hold 🎙️ to talk…";

  return (
    // A docked column, not a drawer: the panel fills the width its host dock
    // was given (App owns that, so a drag never has to round-trip through this
    // component's render — which fires on every streamed voice delta). Hence no
    // width, no z-index and no drop shadow here; the border-left is the same
    // seam the discussion sidecar uses. Focusable (not tabbable) so a click in
    // the transcript puts focus here — which is what scopes Space-to-talk.
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="flex-1 min-w-0 flex flex-col"
      style={{
        background: "var(--color-bg-elevated)",
        borderLeft: "1px solid var(--color-rule)",
        outline: "none",
      }}
      data-tour="voice"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <div className="flex items-center gap-2">
          <PulseLogo state={voicePulse} size={20} />
          <span style={{ fontWeight: 600, color: "var(--color-ink)" }}>
            Talk to the plan
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleSettings}
            title="Voice settings"
            aria-label="Voice settings"
            aria-pressed={showSettings}
            className="rounded-sm px-2 py-0.5"
            style={{
              color:
                engine !== "system"
                  ? "var(--color-anchor-text)"
                  : "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Close voice"
            aria-label="Close voice"
            className="rounded-sm px-2 py-0.5"
            style={{ color: "var(--color-ink)", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
      </div>

      {showSettings ? (
        <div className="flex-1 overflow-y-auto rl-thin-scroll-y">
          <VoiceSettings
            onClose={() => setShowSettings(false)}
            onSaved={applyEngine}
          />
          <div
            className="px-4 pb-4 pt-3 flex flex-col gap-3"
            style={{ borderTop: "1px solid var(--color-rule)" }}
          >
            {/* Speed — applies to every engine (system + cloud). */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>
                  Speech speed
                </span>
                <span style={{ fontSize: "11px", color: MUTED }}>
                  {prefs.rate.toFixed(1)}×
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={prefs.rate}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, rate: Number(e.target.value) }))
                }
                style={{ width: "100%" }}
                aria-label="Speech speed"
              />
              <span style={{ fontSize: "11px", color: MUTED }}>
                1.0× is normal; most voices feel natural around 1.2–1.4×.
              </span>
            </div>

            {/* Voice name — only the system engine exposes named voices here;
                the cloud voice is chosen above in the engine settings. */}
            {engine === "system" && (
              <div className="flex flex-col gap-1.5">
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>
                  System voice
                </span>
                <select
                  value={prefs.voiceURI ?? ""}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, voiceURI: e.target.value || null }))
                  }
                  className="rounded-sm"
                  style={{
                    width: "100%",
                    minWidth: 0,
                    fontSize: "12px",
                    background: "var(--color-paper)",
                    color: "var(--color-ink)",
                    border: "1px solid var(--color-rule)",
                    padding: "4px 6px",
                  }}
                >
                  <option value="">System default</option>
                  {(() => {
                    const enhanced = voices.filter(isEnhancedVoice);
                    const standard = voices.filter((v) => !isEnhancedVoice(v));
                    return (
                      <>
                        {enhanced.length > 0 && (
                          <optgroup label="Enhanced (neural) — much better">
                            {enhanced.map((v) => (
                              <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="System voices">
                          {standard.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                              {v.name}
                            </option>
                          ))}
                        </optgroup>
                      </>
                    );
                  })()}
                </select>
                {!voices.some(isEnhancedVoice) && (
                  <p style={{ fontSize: "11px", color: MUTED }}>
                    Tip: the default system voice sounds robotic. For a far more
                    natural voice (free, offline), download an{" "}
                    <strong>Enhanced</strong> voice in System&nbsp;Settings →
                    Accessibility → Spoken&nbsp;Content → System&nbsp;Voice →
                    Manage Voices, then pick it here.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Conversation — the whole panel is one running transcript. */}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={stick.ref}
            onScroll={stick.onScroll}
            className="flex-1 overflow-y-auto px-4 pt-3 rl-thin-scroll-y"
            style={{ fontSize: "13px", lineHeight: 1.5, paddingBottom: `${12 + trayHeight}px` }}
          >
            {originChat && <details key={originChat.companionId} open={transcript.length === 0} className="mb-3 rounded border p-2" style={{ borderColor: "var(--color-rule)" }}>
              <summary style={{ cursor: "pointer" }}>From chat: {originChat.title}</summary>
              {onOpenChat && <button type="button" onClick={() => onOpenChat(originChat.companionId)} style={{ color: "var(--color-info)", marginBlock: 8 }}>Open chat →</button>}
              {originChat.messages.map(message => <div key={message.id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginBlock: 10 }}><strong>{message.role === "user" ? "You" : "Assistant"}</strong><p>{message.body}</p></div>)}
            </details>}
            {transcript.length === 0 && !turnBusy && (
              <p style={{ color: MUTED }}>
                Hold the button below (or click here and hold{" "}
                <strong>Space</strong>) and ask anything about the plan — this
                discussion has the current plan, its source chat when
                available, and access to your repo. Replies are spoken aloud,
                with any detail shown here. Turn on <strong>Hands-free</strong>{" "}
                to just talk — it sends when you pause and listens again after
                each reply. Or tap a starter to begin.
              </p>
            )}
            {transcript.map((line, i) =>
              line.role === "note" ? (
                <div
                  key={line.id ?? line.key ?? `i-${i}`}
                  className="mb-2"
                  style={{
                    color: MUTED,
                    fontStyle: "italic",
                    fontSize: "0.9em",
                  }}
                >
                  {line.text}
                  {line.capture && !line.capture.undone && (
                    <>
                      {undoable.has(line.capture.commentId) && (
                        <button
                          type="button"
                          onClick={() => line.capture && undoCapture(line.capture)}
                          title="Remove this feedback from the plan"
                          style={LINK_BTN}
                        >
                          Undo
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          line.capture &&
                          showComment(line.capture.commentId, line.capture.anchorId)
                        }
                        title="Show it in the plan"
                        style={LINK_BTN}
                      >
                        Show
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div key={line.id ?? line.key ?? `i-${i}`}>
                  {line.role === "you" ? (
                    <div
                      className="mb-3 rounded-lg px-3 py-2"
                      style={{
                        background: "var(--color-paper)",
                        border: "1px solid var(--color-rule)",
                        color: "var(--color-ink)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {line.text}
                    </div>
                  ) : (
                    <ReplyView
                      raw={line.text}
                      interrupted={line.interrupted}
                      titles={titlesForReplies}
                    />
                  )}
                  {/* What this reply offered to add, if anything. */}
                  <OfferRow
                    offers={
                      (line.id && groupedOffers.byMessage.get(line.id)) || []
                    }
                    busy={offerBusy}
                    errors={offerErrors}
                    explicit={explicit}
                    onAdd={addOffer}
                    onDismiss={dismissOffer}
                  />
                </div>
              ),
            )}
            {/* The reply on its way: what the agent is doing until it speaks,
                then the reply itself in the same skeleton it settles into. */}
            {turnBusy &&
              (streaming ? (
                <ReplyView raw={streaming} live titles={titlesForReplies} />
              ) : (
                <div className="mb-3" data-voice-thinking>
                  <div style={BYLINE}>Claude</div>
                  <span style={{ color: MUTED }} aria-live="polite">
                    {caption.text}
                  </span>
                  {caption.offerStop && (
                    <button
                      type="button"
                      onClick={stopReply}
                      title="Stop this reply"
                      style={LINK_BTN}
                    >
                      Stop
                    </button>
                  )}
                </div>
              ))}
            {/* Offers not yet bound to a reply — under the one still streaming,
                or at the tail once it has landed. Either way they stay tappable
                rather than waiting on the join. */}
            <OfferRow
              offers={groupedOffers.loose}
              busy={offerBusy}
              errors={offerErrors}
              explicit={explicit}
              onAdd={addOffer}
              onDismiss={dismissOffer}
            />
            {error && (
              <p style={{ color: "var(--color-danger, #c0392b)", marginTop: "8px" }}>
                {error}
              </p>
            )}
          </div>
          {/* Typed turns waiting for the reply to finish. × puts one back in
              the box. */}
          {queued.length > 0 && (
            <div
              ref={trayRef}
              aria-label="Queued messages"
              className="absolute flex flex-col gap-1 rounded-md px-2.5 py-1.5"
              style={{
                left: "12px",
                right: "12px",
                bottom: "6px",
                background: "var(--color-paper)",
                border: "1px solid var(--color-rule)",
                fontSize: "12px",
              }}
            >
              {queued.map((q) => (
                <div key={q.id} className="flex items-center gap-1.5" data-queued>
                  <span style={{ color: MUTED, flexShrink: 0 }}>Queued</span>
                  <span
                    className="flex-1 min-w-0"
                    title={q.text}
                    style={{
                      color: "var(--color-ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {q.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => unqueue(q.id)}
                    aria-label={`Put back in the box: ${q.text}`}
                    title="Put it back in the box"
                    style={{
                      minWidth: "24px",
                      minHeight: "24px",
                      border: "none",
                      background: "transparent",
                      color: MUTED,
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          </div>

          {/* Control dock — talk, starters, status — all at the bottom. */}
          <div
            className="px-4 py-3 flex flex-col gap-2"
            style={{ borderTop: "1px solid var(--color-rule)" }}
          >
            {/* Hands-free toggle — converse without holding a button — and
                what the conversation is doing. */}
            <div className="flex items-center justify-between gap-2">
              <span style={{ fontSize: "12px", color: MUTED }}>
                {!handsFree
                  ? "Hold to talk, or go hands-free"
                  : listening
                    ? "Hands-free — just talk; it sends on a pause"
                    : waiting
                      ? `${caption.text} (tap 🎙️ to interrupt)`
                      : turn.phase === "streaming"
                        ? "Answering… (tap 🎙️ to interrupt)"
                        : speechState === "speaking" || speechState === "paused"
                          ? "Speaking… (tap 🎙️ to interrupt)"
                          : "Hands-free — getting ready to listen"}
              </span>
              <button
                type="button"
                onClick={toggleHandsFree}
                role="switch"
                aria-checked={handsFree}
                title="Toggle hands-free conversation"
                className="rounded-full px-2.5 py-1 select-none"
                style={{
                  flexShrink: 0,
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: handsFree
                    ? "var(--color-anchor-bg)"
                    : "transparent",
                  color: handsFree
                    ? "var(--color-anchor-text)"
                    : "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                {handsFree ? "🎧 Hands-free: on" : "🎧 Hands-free: off"}
              </button>
            </div>

            {/* One input row: type, or hold the mic (or Space, or the
                dictation key) and talk — released, it sends. Enter sends a
                typed turn (or queues it while a reply runs); the reply is
                spoken as usual. Never disabled. While the mic listens, the
                dictation strip floats over this row with the words so far. */}
            <form
              ref={inputRowRef}
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                sendTyped();
              }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={busy ? "Type to queue a follow-up…" : talkPlaceholder}
                aria-label="Type a message to the voice agent"
                spellCheck={false}
                className="flex-1 rounded-md px-2.5 py-1.5"
                style={{
                  fontSize: "12.5px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  outline: "none",
                  minWidth: 0,
                }}
              />
              {handsFree ? (
                <button
                  type="button"
                  onClick={onHandsFreeButton}
                  title="Hands-free — tap to interrupt and listen"
                  aria-label="Hands-free status"
                  aria-pressed={listening}
                  className="rounded-md select-none"
                  style={{ ...MIC_BUTTON, ...(listening ? MIC_HOT : null) }}
                >
                  🎙️
                </button>
              ) : (
                <button
                  type="button"
                  onMouseDown={() => startTalk()}
                  onMouseUp={stopTalk}
                  onMouseLeave={stopTalk}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    startTalk();
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault();
                    stopTalk();
                  }}
                  // Space held on the button itself is a hold too — the key
                  // aimed at the thing. Its own press is left alone.
                  onKeyDown={(e) => {
                    if (e.code === "Space" && !e.repeat) beginKeyHold();
                  }}
                  title="Hold to talk (or hold Space with the panel focused)"
                  aria-label="Hold to talk"
                  aria-pressed={listening}
                  className="rounded-md select-none"
                  style={{ ...MIC_BUTTON, ...(listening ? MIC_HOT : null) }}
                >
                  🎙️
                </button>
              )}
              <button
                // Keyed by role: a stop that turns into a send must not be
                // the same element mid-click.
                key={primary === "stop" ? "stop" : "send"}
                type={primary === "stop" ? "button" : "submit"}
                onClick={primary === "stop" ? stopReply : undefined}
                disabled={primary === "send" && !hasText}
                title={
                  primary === "stop"
                    ? "Stop the reply"
                    : primary === "queue"
                      ? "Queue — it goes when this reply finishes (Enter)"
                      : "Send (Enter)"
                }
                aria-label={primary === "stop" ? "Stop" : undefined}
                className="rounded-md px-2.5 py-1.5"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  background: hasText ? "var(--color-anchor-bg)" : "transparent",
                  color: hasText
                    ? "var(--color-anchor-text)"
                    : primary === "stop"
                      ? "var(--color-ink)"
                      : MUTED,
                  cursor: hasText || primary === "stop" ? "pointer" : "default",
                }}
              >
                {primary === "stop" ? "■ Stop" : primary === "queue" ? "Queue" : "Send"}
              </button>
            </form>

            {/* Walkthrough controls — only while a guided walk is running. It
                waits here for "Next section" instead of auto-running. */}
            {walkActive && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => advanceWalk(walkIndex + 1)}
                  className="rounded-full px-2.5 py-1"
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    border: "1px solid var(--color-rule)",
                    background: "var(--color-anchor-bg)",
                    color: "var(--color-anchor-text)",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  Next section ▸
                </button>
                {(
                  [
                    ["Simpler", "That's a bit much — explain it more simply, like I'm new to this."],
                    ["Again", "Wait, can you explain that part again?"],
                  ] as [string, string][]
                ).map(([label, prompt]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() => sendTurn(prompt, label)}
                    className="rounded-full px-2.5 py-1"
                    style={{
                      fontSize: "12px",
                      border: "1px solid var(--color-rule)",
                      background: "transparent",
                      color: "var(--color-ink)",
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {label}
                  </button>
                ))}
                <span style={{ fontSize: "11px", color: MUTED }}>
                  {segments.length
                    ? `§${Math.min(walkIndex + 1, segments.length)} / ${segments.length}`
                    : "no sections"}
                </span>
                <button
                  type="button"
                  onClick={() => setWalkActive(false)}
                  title="End walkthrough"
                  className="rounded-full px-2 py-1 ml-auto"
                  style={{
                    fontSize: "11px",
                    border: "1px solid var(--color-rule)",
                    background: "transparent",
                    color: MUTED,
                    cursor: "pointer",
                  }}
                >
                  End
                </button>
              </div>
            )}

            {/* Starters — quick ways in; the conversation continues by talking. */}
            {!walkActive && (
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["▸ Read it to me", readAloud],
                    ["▸ Summarize", summarize],
                    ["▸ Walk me through it", startWalkthrough],
                  ] as [string, () => void][]
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={fn}
                    className="rounded-full px-2.5 py-1"
                    style={{
                      fontSize: "12px",
                      border: "1px solid var(--color-rule)",
                      background: "transparent",
                      color: "var(--color-ink)",
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* Status + transport. Stop lives in the composer's button; this
                row replays the last reply when idle and pauses one playing. */}
            <div className="flex items-center gap-2">
              {speechState === "speaking" ? (
                <button
                  type="button"
                  onClick={() => queueRef.current?.pause()}
                  title="Pause"
                  aria-label="Pause speech"
                  className="rounded-sm px-2 py-1"
                  style={transportBtn}
                >
                  ⏸
                </button>
              ) : speechState === "paused" ? (
                <button
                  type="button"
                  onClick={() => queueRef.current?.resume()}
                  title="Resume"
                  aria-label="Resume speech"
                  className="rounded-sm px-2 py-1"
                  style={transportBtn}
                >
                  ▶
                </button>
              ) : (
                <button
                  type="button"
                  onClick={replayLast}
                  disabled={busy || !lastSpoken}
                  title="Replay the last reply"
                  className="rounded-sm px-2 py-1"
                  style={{
                    ...transportBtn,
                    cursor: busy || !lastSpoken ? "default" : "pointer",
                    opacity: busy || !lastSpoken ? 0.5 : 1,
                  }}
                >
                  ▶ Replay
                </button>
              )}
              <span
                className="ml-auto"
                style={{ fontSize: "12px", color: indicator.color }}
              >
                ● {indicator.label}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** macOS "Enhanced"/"Premium" voices are downloadable neural voices — far more
 *  natural than the default, and exposed through the same `speechSynthesis` API
 *  once installed. Detect them by their parenthetical name suffix. */
function isEnhancedVoice(v: SpeechSynthesisVoice): boolean {
  return /\((enhanced|premium)\)/i.test(v.name);
}

const transportBtn: React.CSSProperties = {
  fontSize: "13px",
  border: "1px solid var(--color-rule)",
  background: "transparent",
  color: "var(--color-ink)",
  cursor: "pointer",
};

/** Memoized: one of the center-pane surfaces that used to reconcile on
 *  every frame of a divider drag. */
export const VoicePanel = memo(VoicePanelBase);
