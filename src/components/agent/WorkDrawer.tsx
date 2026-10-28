// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Agent pane's work drawer: what waits and what runs, in the rows
//! above the composer. Queued sends are numbered in the order they will go,
//! each with Steer (type it into the PTY now — the CLI takes type-ahead
//! mid-turn), Edit (back into the composer) and Remove; a running subagent
//! (a `Task` tool call that has not returned) shows beside the count with
//! the shared spinner. Nothing here decides anything: the conversation
//! owns the queue and the delivery, this draws them.

import { ListOrdered, Pencil, X } from "lucide-react";

import { Spinner } from "../Spinner";

export interface DrawerQueued {
  id: string;
  text: string;
}

export interface DrawerAgent {
  id: string;
  /** The Task's own summary: "explore-fixtures", "Review the diff". */
  label: string;
}

export interface WorkDrawerProps {
  queued: readonly DrawerQueued[];
  agents: readonly DrawerAgent[];
  /** Deliver it now, ahead of the rest. Null while the PTY can't take it. */
  onSteer: ((id: string) => void) | null;
  /** Out of the queue, its text back in the composer. */
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}

export function WorkDrawer({ queued, agents, onSteer, onEdit, onRemove }: WorkDrawerProps) {
  if (queued.length === 0 && agents.length === 0) return null;
  return (
    <div className="rl-work-drawer" role="group" aria-label="Queued and running work">
      <div className="rl-work-drawer-head">
        <ListOrdered size={12} aria-hidden />
        <span className="rl-work-drawer-count">
          {queued.length > 0 ? `Queued · ${queued.length}` : "Running"}
        </span>
        {agents.map((agent) => (
          <span key={agent.id} className="rl-work-drawer-agent" title={agent.label}>
            <Spinner size={10} className="rl-work-drawer-spin" />
            <span>subagent · </span>
            <code>{agent.label}</code>
          </span>
        ))}
      </div>
      {queued.map((row, i) => (
        <div key={row.id} className="rl-work-drawer-row">
          <span className="rl-work-drawer-n" aria-hidden>{i + 1}</span>
          <span className="rl-work-drawer-text" title={row.text}>{row.text}</span>
          {onSteer && (
            <button type="button" className="rl-work-drawer-steer" title="Type it into the session now, ahead of the rest" onClick={() => onSteer(row.id)}>
              Steer
            </button>
          )}
          <button type="button" className="rl-work-drawer-icon" aria-label={`Edit: ${row.text}`} title="Back into the composer" onClick={() => onEdit(row.id)}>
            <Pencil size={12} aria-hidden />
          </button>
          <button type="button" className="rl-work-drawer-icon" aria-label={`Remove: ${row.text}`} title="Take it out of the queue" onClick={() => onRemove(row.id)}>
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
