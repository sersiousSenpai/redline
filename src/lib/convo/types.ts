// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The conversation mirror's wire contract: what `src-tauri/src/convo` sends
//! the session stage about a live `claude` / `codex` CLI running in a PTY.
//!
//! The CLI keeps running in its terminal exactly as before; the host tails
//! its transcript (Claude) or reads its app-server thread (Codex) and turns
//! each line into one of these events. The stage renders them; the composer
//! types into the same PTY. Both sides are pinned to this file: the Rust
//! serde types serialize to exactly these shapes (camelCase, `kind` tag), and
//! the golden fixtures under `src-tauri/tests/fixtures/convo/` are parsed by
//! both test suites.
//!
//! Identity and order:
//! - `id` is unique and stable for the life of the session. A transcript
//!   line's `uuid` (suffixed `:n` when one line yields several events); a
//!   host event's `host:<n>`. Re-reading the same bytes yields the same ids,
//!   so a merge is a keyed upsert and every read is idempotent.
//! - `(epoch, offset)` orders events. `offset` is the byte offset of the
//!   source line in that epoch's transcript (Codex: the item ordinal); a host
//!   event carries the tail offset at the moment it happened. `epoch` starts
//!   at 0 and steps on `/clear`, or a resume that starts a new transcript.
//! - `ts` is epoch milliseconds: the transcript's own timestamp, else the
//!   host's clock.

export type ConvoHarness = "claude" | "codex";

/** What a CLI reports its permission mode as (Claude's `permission-mode`
 *  line, Shift+Tab, `/plan`). Unknown modes pass through as strings. */
export type ConvoMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | (string & {});

/** Why the composer can't type into the PTY right now, or null when it can. */
export type ConvoBlocker =
  /** No transcript bound yet (the CLI hasn't reported SessionStart). */
  | "unbound"
  /** The TUI hasn't turned bracketed paste on: it is still starting, or it
   *  is not a Claude/Codex TUI at all. */
  | "no_paste_mode"
  /** A native dialog (a permission prompt answered in the TUI, the rewind
   *  menu, /model's picker) owns the keyboard. */
  | "native_dialog"
  /** The user typed into the raw TUI and left it half-done; sending would
   *  append to their text. */
  | "dirty_input";

export interface AskOption {
  label: string;
  description?: string | null;
}

export interface AskQuestion {
  question: string;
  header?: string | null;
  multiSelect?: boolean;
  options: AskOption[];
}

/** One open ask, held by a hook until the stage (or the terminal) answers. */
export interface ConvoAsk {
  askId: string;
  /** `permission`: a PermissionRequest hook (Allow / Always / Deny).
   *  `question`: AskUserQuestion, answered through `updatedInput.answers`. */
  kind: "permission" | "question";
  toolName: string;
  /** One line, the same summarizer the run monitor uses: "npm test",
   *  "Edit src/App.tsx". */
  summary: string;
  /** The tool input as the hook received it (permission asks), trimmed of
   *  large string fields by the host. */
  input?: unknown;
  /** The payload's own `permission_suggestions`, passed back verbatim as
   *  `updatedPermissions` when the user picks Always. */
  suggestions?: unknown[] | null;
  /** The suggestions as a human rule, shown on the card next to Always:
   *  "Always allow Bash(npm test:*) in this project". */
  rule?: string | null;
  questions?: AskQuestion[] | null;
  openedAt: number;
}

export type AskAnswer =
  | { kind: "allow" }
  | { kind: "always" }
  | { kind: "deny"; message?: string | null }
  /** AskUserQuestion: question text → chosen label(s), comma-joined for a
   *  multi-select, or free text. */
  | { kind: "answers"; answers: Record<string, string> }
  /** Release the hook with `{}` so the TUI asks natively; the stage flips to
   *  the terminal. */
  | { kind: "terminal" };

export type ConvoAskOutcome = "allow" | "always" | "deny" | "answered" | "terminal" | "expired";

interface Base {
  id: string;
  epoch: number;
  offset: number;
  ts: number;
}

export type ConvoEvent = Base &
  (
    /** The terminal is bound to a transcript (host). Re-sent on every rebind;
     *  `source` is the SessionStart source, or how the host found it. */
    | {
        kind: "bound";
        harness: ConvoHarness;
        sessionId: string;
        transcriptPath: string | null;
        source: "startup" | "resume" | "clear" | "compact" | "fork" | "prompt" | "stop" | "restore";
      }
    /** A divider: what follows is a new transcript (or a cleared one). */
    | { kind: "epoch"; reason: "clear" | "resume" | "fork" }
    | { kind: "user_text"; text: string; promptId?: string | null }
    | { kind: "assistant_text"; text: string; model?: string | null }
    /** The model thought here. The text is never mirrored. */
    | { kind: "thinking" }
    | { kind: "tool_use"; toolUseId: string; name: string; summary: string }
    | { kind: "tool_result"; toolUseId: string; isError: boolean; preview: string }
    /** Esc (or Stop) cut the turn short. */
    | { kind: "interrupted" }
    | { kind: "mode_change"; mode: ConvoMode }
    | { kind: "model_seen"; model: string; effort?: string | null }
    | { kind: "compact"; trigger?: "manual" | "auto" | null }
    /** The turn finished (the Stop hook, or the transcript's turn
     *  duration line). */
    | { kind: "turn_end"; durationMs?: number | null }
    /** The CLI's own type-ahead queue (`queue-operation` lines). A prompt
     *  sent while a turn runs is `enqueue`d, then either `dequeue`d after the
     *  turn (its prompt line follows) or `remove`d with `reason`
     *  `absorbed_mid_turn` (folded into the running turn; no prompt line). */
    | { kind: "queued"; op: "enqueue" | "dequeue" | "remove" | "popAll"; text?: string | null; reason?: string | null }
    /** ExitPlanMode was called: a plan exists for review. `sessionId` is the
     *  same id the plan-received event carries. */
    | { kind: "plan_proposed"; toolUseId: string; sessionId: string; title?: string | null }
    | { kind: "plan_outcome"; toolUseId: string; outcome: "approved" | "denied" | "feedback"; feedback?: string | null }
    | { kind: "ask_opened"; ask: ConvoAsk }
    | { kind: "ask_closed"; askId: string; outcome: ConvoAskOutcome }
    /** A composer send (`convo_expect`) matched the transcript's prompt. */
    | { kind: "delivered"; nonce: string; promptId?: string | null }
    /** 45s passed with no matching prompt in the transcript. */
    | { kind: "undelivered"; nonce: string }
    /** The composer's readiness changed (host). */
    | { kind: "readiness"; ready: boolean; blocker: ConvoBlocker | null }
  );

export type ConvoEventKind = ConvoEvent["kind"];

/** `convo_subscribe`'s answer: the recent tail, then live batches on the
 *  channel. */
export interface ConvoSnapshot {
  subscriptionId: string;
  /** The last ≤200 events, oldest first. */
  events: ConvoEvent[];
  /** Whether `convo_page` has anything before `events[0]`. */
  hasOlder: boolean;
}

/** One coalesced delivery on the subscription channel (≤1 per 50ms).
 *  `reset` = drop what you hold and take `events` as the new tail (the
 *  terminal was rebound to an unrelated session). */
export interface ConvoBatch {
  events: ConvoEvent[];
  reset?: boolean;
}

export interface ConvoPage {
  events: ConvoEvent[];
  hasOlder: boolean;
}

/** What `pty_submit` did with the text. */
export type SubmitResult =
  | { status: "sent" }
  | { status: "blocked"; blocker: ConvoBlocker };

/** What a mid-session mode/model switch did. `terminal` = it can't be done
 *  from here right now (a turn is running, or no slash command exists);
 *  the chip says "Switch in terminal". */
export type SwitchResult = { status: "sent" } | { status: "terminal"; reason: string };

/** App-wide Tauri event names the engine emits beside the per-terminal
 *  channel, for surfaces that aren't subscribed to a conversation. */
export const CONVO_BOUND_EVENT = "convo-bound";
export const CONVO_TITLE_EVENT = "convo-title";

/** `convo-bound`: a terminal was bound to a session (on every bind, the same
 *  moment its `bound` event goes to subscribers). The stage keeps a
 *  sessionId → terminalId map from it. */
export interface ConvoBoundNotice {
  terminalId: string;
  sessionId: string;
  harness: ConvoHarness;
  transcriptPath: string | null;
}

/** `convo-title`: the CLI named the session (its transcript's `ai-title`,
 *  the same text its window title carries after the status glyph). Only
 *  terminals whose conversation is being tailed report it. */
export interface ConvoTitleNotice {
  terminalId: string;
  sessionId: string;
  title: string;
}
