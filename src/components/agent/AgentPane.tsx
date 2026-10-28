// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Agent pane: a session's own conversation as a centre tab, with the
//! header the design draws over it — who is answering (the harness), the
//! model and effort, the mode, History and Fork — and the **Chat | CLI**
//! toggle. CLI reveals the SAME PTY: the terminal dock is pinned over this
//! pane's body showing that one terminal (`useStageDock`, the dock's
//! `solo`), never a second attachment, so the scrollback, the replay and
//! the one-attachment-per-PTY rule all hold. The conversation stays
//! subscribed underneath and, out of sight, releases its held questions to
//! the terminal it is now showing (`hidden`).
//!
//! One pane per terminal (the reducer dedupes `openSurface` on its data), so
//! opening it again focuses the one that is open.

import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { FilePenLine, GitFork, History } from "lucide-react";

import { modeLabel, modelChipLabel } from "./convo/status";
import type { ConvoActions, ConvoFacts } from "./SessionConversation";
import type { SessionConversationProps } from "./SessionConversation";

const SessionConversation = lazy(() => import("./SessionConversation"));

export type AgentView = "chat" | "cli";

/** Where the dock goes while a pane shows its PTY: that pane's box. */
export interface CliView {
  terminalId: string;
  el: HTMLElement;
}

export interface AgentPaneProps extends Omit<SessionConversationProps, "layout" | "hidden" | "header" | "onShowTerminal"> {
  /** The pane is on screen (the workbench's deferred visibility). */
  visible: boolean;
  /** The dock can show this PTY (it is one of the dock's terminals). */
  cliAvailable: boolean;
  /** The pane shows its PTY: App pins the dock over `el`. Null clears. */
  onCliView: (view: CliView | null) => void;
  /** Fork the CLI session into a new terminal (Claude's `--fork-session`);
   *  absent for a harness that cannot. */
  onFork?: ((cliSessionId: string) => void) | null;
}

export default function AgentPane(p: AgentPaneProps) {
  const { terminalId, visible, cliAvailable, onCliView, onFork, ...convo } = p;
  const [view, setView] = useState<AgentView>("chat");
  const [cliBox, setCliBox] = useState<HTMLDivElement | null>(null);
  const showingCli = view === "cli" && cliAvailable && !!terminalId;
  // The dock comes to this box while it is on screen; a hidden kept tab
  // hands it back, and so does toggling to Chat or losing the PTY.
  useLayoutEffect(() => {
    if (!showingCli || !visible || !cliBox || !terminalId) return;
    onCliView({ terminalId, el: cliBox });
    return () => onCliView(null);
  }, [showingCli, visible, cliBox, terminalId, onCliView]);
  const header = (facts: ConvoFacts, actions: ConvoActions): ReactNode => (
    <AgentHeader
      harness={p.harness}
      facts={facts}
      view={showingCli ? "cli" : "chat"}
      cliAvailable={cliAvailable && !!terminalId}
      onView={setView}
      onEarlier={facts.hasOlder ? actions.earlier : null}
      onFork={onFork && facts.boundSessionId ? () => onFork(facts.boundSessionId!) : null}
    />
  );
  return (
    <div className="rl-agent-pane" data-view={showingCli ? "cli" : "chat"}>
      <Suspense fallback={null}>
        <SessionConversation
          {...convo}
          terminalId={terminalId}
          layout="stage"
          hidden={!visible || showingCli}
          header={header}
          // "Open Terminal" anywhere in the thread is this pane's CLI view.
          onShowTerminal={() => setView("cli")}
        />
      </Suspense>
      {showingCli && <div ref={setCliBox} className="rl-agent-cli" aria-label="Terminal" />}
    </div>
  );
}

function AgentHeader({ harness, facts, view, cliAvailable, onView, onEarlier, onFork }: {
  harness: "claude" | "codex";
  facts: ConvoFacts;
  view: AgentView;
  cliAvailable: boolean;
  onView: (view: AgentView) => void;
  onEarlier: (() => void) | null;
  onFork: (() => void) | null;
}) {
  const agent = harness === "codex" ? "Codex" : "Claude Code";
  const model = facts.model ? modelChipLabel(facts.model, { harness, showHarness: false }) : null;
  const mode = facts.mode ? `${modeLabel(facts.mode)} mode` : null;
  return (
    <header className="rl-agent-head" data-agent-pane-header>
      <span className="rl-agent-head-agent">
        <span className="rl-agent-head-avatar" data-harness={harness} aria-hidden>{harness === "codex" ? "X" : "C"}</span>
        {agent}
      </span>
      {model && (
        <>
          <span className="rl-agent-head-dot" aria-hidden>·</span>
          <span className="rl-agent-head-meta">{model}</span>
        </>
      )}
      {mode && (
        <>
          <span className="rl-agent-head-dot" aria-hidden>·</span>
          <span className="rl-agent-head-mode" data-mode={facts.mode ?? undefined}>
            <FilePenLine size={12} aria-hidden />
            {mode}
          </span>
        </>
      )}
      <span className="rl-agent-head-spacer" />
      <span className="rl-agent-head-seg" role="radiogroup" aria-label="Show the conversation or its terminal">
        <button type="button" role="radio" aria-checked={view === "chat"} onClick={() => onView("chat")}>Chat</button>
        <button
          type="button"
          role="radio"
          aria-checked={view === "cli"}
          disabled={!cliAvailable}
          title={cliAvailable ? "The same session, in its terminal" : "This session isn't running in one of Redline's terminals"}
          onClick={() => onView("cli")}
        >
          CLI
        </button>
      </span>
      <button type="button" className="rl-agent-head-btn" aria-label="Earlier messages" title={onEarlier ? "Earlier messages" : "Nothing earlier"} disabled={!onEarlier} onClick={onEarlier ?? undefined}>
        <History size={14} aria-hidden />
      </button>
      {onFork && (
        <button type="button" className="rl-agent-head-btn" aria-label="Fork this session" title="Fork: continue this conversation in a new terminal, leaving this one as it is" onClick={onFork}>
          <GitFork size={14} aria-hidden />
        </button>
      )}
    </header>
  );
}
