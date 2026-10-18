// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The flow conversation in a stand-in shell sized like the boards, so the
// stage's geometry is the board's: a 46px top bar with its hairline, and
// (4b, 4d) the board's sidebar — 232px plus its 10px padding and hairline,
// as the design's content-box styles add up to (253px). `?board=` picks the
// state, `?theme=` the theme.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import SessionConversation, { type SessionConversationProps } from "../../src/shell/SessionConversation";
import { applyTheme } from "../../src/theme/applyTheme";
import type { ThemeName } from "../../src/theme/themes";
import type { ConvoEvent } from "../../src/lib/convo/types";
import planLive from "../../src/lib/convo/__fixtures__/plan-live.events.json";
import planTurn from "../../src/lib/convo/__fixtures__/plan-turn.events.json";
import asks from "../../src/lib/convo/__fixtures__/asks.events.json";
import "../../src/styles.css";
import "./fixture.css";

const query = new URLSearchParams(location.search);
const board = query.get("board") ?? "4b";
type Page = Window & { __qaSnapshot?: ConvoEvent[]; __qaChannel?: { onmessage: (m: unknown) => void }; __qa?: unknown; __qaOpened?: number; __qaTerminal?: number };
const page = window as Page;

/** The fixture's events with their clock moved so its first prompt was sent
 *  `ago` ms before now: the working row's timer reads what the board does. */
function shifted(events: ConvoEvent[], ago: number): ConvoEvent[] {
  const first = events.find((e) => e.kind === "user_text")?.ts ?? events[0].ts;
  const delta = Date.now() - ago - first;
  return events.map((e) => ({ ...e, ts: e.ts + delta }));
}

const PLAN_MARKDOWN = [
  "# Din roadmap: next steps",
  "",
  "Picks up from note 28 and the 2026-10-17 updates in the build log.",
  "",
  "## 1. Finish Track B",
  "1. Compile the build in Xcode on the Mac.",
  "2. Apply 0018_vault_revisions.sql before the next build runs.",
  "3. Deploy the Worker; D3 crash reports need both.",
  "",
  "## 2. Next by priority",
  "1. Start with D6: the pattern and experiment loop.",
  "2. D7.",
  "3. D8.",
  "",
  "## 3. Later",
  "1. a",
  "2. b",
  "3. c",
  "4. d",
  "5. e",
].join("\n");

const extraAsk: ConvoEvent = {
  id: "host:9",
  epoch: 0,
  offset: 4100,
  ts: 1760774421200,
  kind: "ask_opened",
  ask: {
    askId: "ask-3",
    kind: "permission",
    toolName: "Bash",
    summary: "npm test -- --run src/lib/convo",
    input: { command: "npm test -- --run src/lib/convo" },
    suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }],
    rule: "Always allow Bash(npm test:*) in this project",
    questions: null,
    openedAt: 1760774421200,
  },
};

const SNAPSHOTS: Record<string, ConvoEvent[]> = {
  "4b": shifted(planLive as ConvoEvent[], 72_400),
  "4c": shifted(planTurn as ConvoEvent[], 300_000),
  "4d": shifted(planTurn as ConvoEvent[], 300_000),
  panel: shifted(planTurn as ConvoEvent[], 300_000),
  asks: shifted([...(asks as ConvoEvent[]), extraAsk], 20_000),
  queue: shifted(planLive as ConvoEvent[], 9_000).map((e) => (e.kind === "readiness" ? { ...e, ready: false, blocker: "native_dialog" as const } : e)),
};
page.__qaSnapshot = SNAPSHOTS[board] ?? SNAPSHOTS["4b"];

function Fixture() {
  const [planOpen, setPlanOpen] = useState(board === "4c" || board === "panel");
  const [layout, setLayout] = useState<SessionConversationProps["layout"]>(board === "4c" ? "column" : board === "panel" ? "panel" : "stage");
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    page.__qa = {
      setTheme: (name: ThemeName) => applyTheme(name),
      push: (events: ConvoEvent[], reset = false) => page.__qaChannel?.onmessage({ events, reset }),
      setPlanOpen,
      setLayout,
    };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  const props: SessionConversationProps = {
    terminalId: "term-qa",
    sessionId: "sess-din-1",
    harness: "claude",
    layout,
    planTitle: board === "4b" || board === "asks" || board === "queue" ? null : "Din roadmap: next steps",
    planMarks: 2,
    planOpen,
    onOpenPlan: () => {
      page.__qaOpened = (page.__qaOpened ?? 0) + 1;
    },
    onShowTerminal: () => {
      page.__qaTerminal = (page.__qaTerminal ?? 0) + 1;
    },
    projectPath: "/Users/me/projects/din",
    planMarkdown: board === "4b" ? null : PLAN_MARKDOWN,
    talking,
    onTalk: () => setTalking((t) => !t),
  };
  const conversation = <SessionConversation {...props} />;
  if (board === "panel")
    return (
      <div className="qa-frame" data-board="panel" style={{ width: 1600, height: 960 }}>
        <div className="qa-top" />
        <div className="qa-body">
          <div className="qa-sidebar" style={{ width: 260 - 20 }} />
          <div className="qa-paper" />
          <div className="qa-panel">
            <div className="qa-panel-head">Chat · Feedback</div>
            <div className="qa-slot">{conversation}</div>
          </div>
        </div>
      </div>
    );
  return (
    <div className="qa-frame" data-board={board}>
      <div className="qa-top" />
      <div className="qa-body">
        {layout === "column" ? (
          <>
            <div className="qa-column">{conversation}</div>
            <div className="qa-paper" />
          </>
        ) : (
          <>
            <div className="qa-sidebar" />
            <main className="qa-stage">{conversation}</main>
          </>
        )}
      </div>
    </div>
  );
}

applyTheme((query.get("theme") ?? "aurora") as ThemeName);
createRoot(document.getElementById("root")!).render(<Fixture />);
