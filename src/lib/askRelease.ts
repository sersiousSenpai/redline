// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A question may never wait where nobody can see it.
//!
//! While an AskUserQuestion hook is held, the CLI's own TUI shows no question
//! (measured by the engine lane, docs/protocol-verification.md): the question
//! exists only as the conversation's ask card, for as long as the hold lasts.
//! The engine arms that hold whenever a conversation is subscribed to the
//! terminal. So whenever the conversation is out of sight — the stage showing
//! the terminal (⌘J), the full pose's Feedback tab, another surface — or
//! goes away (another session on the stage), its open questions are released
//! to the terminal (`{kind: "terminal"}`), where the TUI asks natively and
//! the hooks' needs-you reaches the top bar and the sidebar. Permission asks
//! stay: the TUI shows its own dialog beside a held permission hook.
//!
//! The conversation stays subscribed while hidden, so its identity (events,
//! scroll, queued sends) survives; this is the "auto-answer while hidden"
//! half of the engine's two options.

import type { ConvoAsk } from "./convo/types";

/** The open question asks not yet released. */
export function questionsToRelease(
  open: readonly ConvoAsk[],
  released: ReadonlySet<string>,
): string[] {
  return open.filter((a) => a.kind === "question" && !released.has(a.askId)).map((a) => a.askId);
}
