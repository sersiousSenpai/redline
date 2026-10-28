// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The chat panes (W2, W6). A session's own conversation is the Agent pane:
// the agent in its terminal, mirrored, with the Chat | CLI toggle — keyed by
// the terminal, so a launch becoming its plan keeps the conversation. A
// companion chat is the one ChatRoom body, mounted once in its portal host
// (`chatHost`); a companion pane shows only its slot, and the rail's Talk
// holds the room while no pane does. Both bodies are lazy chunks, as they
// were in App.

import { lazy, Suspense, type ComponentProps } from "react";

import { ErrorBoundary } from "../../components/ErrorBoundary";
import type { AgentPaneProps } from "../../components/agent/AgentPane";
import type { FlowLaunch } from "../../lib/sessionTerminals";
import type { PaneDataByKind } from "../model";
import { SingletonSlot } from "../singleton";
import type { PaneContext } from "../WorkbenchStage";
import { surfaceFallback } from "./fallback";

// The Agent pane: the session's conversation as a centre tab (W2), with its
// header and the Chat | CLI toggle. Rides the conversation's chunk.
const AgentPane = lazy(() => import("../../components/agent/AgentPane"));
// Off the boot path, and this one is not optional: a chat room in the boot
// chunk would fail `size-budget.json` outright. It loads when the door's
// chat destination is taken (or the dock warms it).
export const loadChatRoom = () => import("../../components/ChatRoom");
const ChatRoom = lazy(() => loadChatRoom().then((m) => ({ default: m.ChatRoom })));

/** What App knows about the open session, for the Agent pane of its own
 *  agent terminal; another session's terminal gets none of it. */
export interface AgentSessionFacts {
  activeId: string | null;
  backend: string | null;
  projectPath: string | null;
  /** The active session's summary: its own backend, title and status. */
  summary: { backend?: string | null; planTitle?: string | null; status: string } | null;
  pendingMarks: number;
  planMarkdown: string | null;
  planState: AgentPaneProps["planState"];
  fallbackModel: AgentPaneProps["fallbackModel"];
}

export interface AgentPaneViewProps {
  data: Extract<PaneDataByKind["chat"], { source: "agent" }>;
  ctx: PaneContext;
  facts: AgentSessionFacts;
  launches: readonly FlowLaunch[];
  /** The terminals the layer has reported live; null until it has. */
  liveTermIds: readonly string[] | null;
  termState: AgentPaneProps["termState"];
  /** The plan is a tab of this set and on screen. */
  planOpen: boolean;
  talking: boolean;
  onCliView: AgentPaneProps["onCliView"];
  handlers: { onFork: NonNullable<AgentPaneProps["onFork"]>; onOpenPlan: AgentPaneProps["onOpenPlan"]; onTalk: AgentPaneProps["onTalk"] };
}

export function AgentPaneView({ data, ctx, facts, launches, liveTermIds, termState, planOpen, talking, onCliView, handlers }: AgentPaneViewProps) {
  const agentTerminal = data.terminalId;
  const agentSession = data.sessionId;
  const launch = launches.find((l) => l.terminalId === agentTerminal) ?? null;
  const own = agentSession !== null && agentSession === facts.activeId;
  const ownSummary = own ? facts.summary : null;
  const harness: "claude" | "codex" = launch?.harness ?? ((own ? facts.backend : ownSummary?.backend) === "codex" ? "codex" : "claude");
  const projectPath = launch?.projectPath ?? (own ? facts.projectPath : null);
  return (
    <Suspense fallback={null}>
      <AgentPane
        key={agentTerminal}
        terminalId={agentTerminal}
        sessionId={agentSession}
        harness={harness}
        visible={ctx.visible}
        cliAvailable={!liveTermIds || liveTermIds.includes(agentTerminal)}
        onCliView={onCliView}
        onFork={harness === "claude" ? handlers.onFork : null}
        planTitle={ownSummary?.planTitle ?? null}
        planMarks={own ? facts.pendingMarks : 0}
        // The plan is a tab of this set: open while it is on screen, and
        // its card opens it.
        planOpen={planOpen}
        onOpenPlan={handlers.onOpenPlan}
        projectPath={projectPath}
        planMarkdown={own ? facts.planMarkdown : null}
        termState={termState}
        talking={talking}
        onTalk={handlers.onTalk}
        planState={own ? facts.planState : null}
        fallbackModel={own ? facts.fallbackModel : null}
        fallbackMode={ownSummary?.status === "in_review" ? "plan" : null}
      />
    </Suspense>
  );
}

/** A companion chat pane: the slot the one room's host lands in. */
export function CompanionPane({ host, ctx }: { host: HTMLElement; ctx: PaneContext }) {
  return <SingletonSlot host={host} name="conversation" active={ctx.visible} />;
}

export type CompanionRoomProps = ComponentProps<typeof ChatRoom>;

/** The one ChatRoom body, rendered into `chatHost`. Keyed by the thread by
 *  the caller: the room's mode and harness are stored per chat and
 *  `usePersistedState` reads its key once, so switching conversations is a
 *  REMOUNT by design. */
export function CompanionRoom(props: CompanionRoomProps) {
  return (
    <Suspense fallback={null}>
      <ErrorBoundary region="chat" fallback={surfaceFallback("chat")}>
        <ChatRoom {...props} />
      </ErrorBoundary>
    </Suspense>
  );
}
