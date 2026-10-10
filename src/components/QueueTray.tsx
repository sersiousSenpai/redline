// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What waits behind the running reply (design decision 6): a pill anchored
//! above the composer — "2 queued", the next one's text, ⌄ — that expands
//! upward into one row per queued message. × takes a message out of the queue
//! and puts its text back in the composer; Steer (the chat room only — browse
//! has no steer route, BC-29) delivers it now.
//!
//! It OVERLAYS the thread from a zero-height anchor rather than taking height
//! from it: the thread's viewport keeps its size whether anything is queued,
//! and each queueing surface reserves the pill's height at the bottom of its
//! thread, so the newest line is never under it.

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./ChatWorkbench.css";

export interface QueueItem { id: string; text: string; mode?: "chat" | "plan" | "build"; assignee?: "chat" | "agent" }

interface QueueActions {
  /** × — out of the queue, its text back in the composer. */
  onRemove: (id: string) => void;
  /** Deliver it now, where the surface can. */
  onSteer?: (id: string) => void;
  /** Send it next, ahead of the rest. */
  onPromote?: (id: string) => void;
}

export function QueueTray({ rows, ...actions }: { rows: QueueItem[] } & QueueActions) {
  const [open, setOpen] = useState(false);
  const empty = rows.length === 0;
  useEffect(() => { if (empty) setOpen(false); }, [empty]);
  if (empty) return null;
  return <div className="rl-queue-anchor">
    <div className="rl-queue-tray" role="group" aria-label="Queued messages">
      {open && <QueueRows rows={rows} {...actions}/>}
      <QueuePill rows={rows} open={open} onToggle={() => setOpen(!open)}/>
    </div>
  </div>;
}

/** The tray's expanded list, one row per queued message. The page chat's
 *  status rail opens it in its own tray slot. */
export function QueueRows({ rows, onRemove, onSteer, onPromote }: { rows: QueueItem[] } & QueueActions) {
  return <ul className="rl-queue-list">{rows.map((row, i) => {
    // Plans and new agents wait for a quiet chat, and a row the backend
    // hasn't confirmed has no id to deliver yet.
    const steerable = row.mode !== "plan" && row.assignee !== "agent" && !row.id.includes("-tmp-");
    return <li className="rl-queue-row" key={row.id}>
      {row.mode && row.mode !== "chat" && <span className="rl-queue-mode" title={row.mode}>{row.mode === "plan" ? "◇" : "⚒"}</span>}
      <span className="rl-queue-text" tabIndex={0}>{row.text}</span>
      {onSteer && <button type="button" disabled={!steerable} title={steerable ? "Deliver this instruction now; where it can't be injected, the reply is interrupted and this sends next" : "Plans and new agents wait for a quiet chat"} onClick={() => onSteer(row.id)}>↪ Steer</button>}
      {onPromote && i > 0 && <button type="button" title="Send this one next" onClick={() => onPromote(row.id)}>↑ Next</button>}
      <button type="button" className="rl-queue-x" aria-label={`Unqueue ${row.text}`} title="Take it out of the queue and put the text back in the composer" onClick={() => onRemove(row.id)}>×</button>
    </li>;
  })}</ul>;
}

/** "2 queued · <the next one's text> ⌄"; `compact` leaves the text to the
 *  tray, for a pill that shares its row. */
export function QueuePill({ rows, open, onToggle, compact = false }: { rows: QueueItem[]; open: boolean; onToggle: () => void; compact?: boolean }) {
  return <button type="button" className="rl-queue-pill" aria-expanded={open} title={compact ? rows[0].text : undefined} onClick={onToggle}>
    <span className="rl-queue-count">{rows.length} queued</span>
    {!compact && <span className="rl-queue-preview">{rows[0].text}</span>}
    <ChevronDown size={13} aria-hidden className="rl-queue-chevron"/>
  </button>;
}
