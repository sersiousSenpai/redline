// The flow stage, composed as App composes it: FlowStage as the surface
// pane's child, the plan document (the real PlanEditor) handed in as its
// body, the conversation rendered through a bounded portal host, the zoom
// pill and contents rail as the pane's siblings. Board data reproduces 4c,
// 4d and 5a. Components other lanes own render through this branch's
// placeholders; the integrator re-runs this with theirs merged.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import FlowStage from "../../src/shell/FlowStage";
import SessionConversation from "../../src/shell/SessionConversation";
import { PlanEditor } from "../../src/components/PlanEditor";
import { ZoomButton } from "../../src/components/ZoomButton";
import { DocWidthToggle } from "../../src/components/DocWidthToggle";
import { createBoundedPortalHost } from "../../src/components/PersistentPortalSlot";
import { FLOW_ARTICLE, openPlan } from "../../src/lib/flowPose";
import { planReadySummary } from "../../src/lib/planReady";
import { resetFlowStateForTests, setPanelTab, setPlanPose, setStage, useFlow } from "../../src/shell/flowState";
import type { PlanFooterApproval } from "../../src/shell/PlanPanelFooter";
import type { Comment, ReviewSession } from "../../src/types";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";
import "./fixture.css";

document.documentElement.dataset.rlShell = "flow";
document.documentElement.dataset.rlTransparency = "auto";

type BoardId = "4c" | "4d" | "5a";
const board = (new URLSearchParams(location.search).get("board") ?? "4c") as BoardId;

const DIN = [
  "<!-- rl:blk-title -->", "# Din roadmap: next steps", "",
  "<!-- rl:blk-lede -->", "Picks up from note 28 and the 2026-10-17 updates in the build log.", "",
  "<!-- rl:blk-h1 -->", "## 1. Finish Track B", "",
  "<!-- rl:blk-steps -->", "1. Compile the build in Xcode on the Mac.", "2. Apply 0018_vault_revisions.sql before the next build runs.", "3. Deploy the Worker; D3 crash reports need both.", "",
  "<!-- rl:blk-h2 -->", "## 2. Next by priority", "",
  "<!-- rl:blk-next -->", "C1, D1, D3, D4, C6 are built. Start with D6: the pattern and experiment loop.", "",
].join("\n");
const STEPS_TEXT = "Compile the build in Xcode on the Mac.Apply 0018_vault_revisions.sql before the next build runs.Deploy the Worker; D3 crash reports need both.";
const MARKED = "0018_vault_revisions.sql before the next build";

const DIAL = [
  "<!-- rl:blk-title -->", "# Dialcrown: fastest credible launch, Quo parity, and the voice-agent decision", "",
  "<!-- rl:blk-h1 -->", "## Context", "",
  "<!-- rl:blk-ctx -->", "A launch-first plan. It benchmarks Dialcrown against Quo and RingCentral, evaluates Guava as the voice-agent platform, and designs one configuration that drives the record, the agent and the call flow. The test throughout: the smallest release a customer can use and pay for.", "",
  "<!-- rl:blk-h2 -->", "## Decisions you made", "",
  "<!-- rl:blk-table -->",
  "| First pilot | **A law firm.** California PI intake. All-party consent and confidentiality matter more here than in home services. |",
  "|---|---|",
  "| Voice agent | **Fast-follow.** The pilot runs on human-answered calls. The after-hours agent is Release 2. |",
  "| Runtime | **Decide in §5.** Telnyx AI Assistants vs. Guava. |",
  "| Accounts | **Mostly ready.** Stripe and Resend verification are now on the critical path. |",
  "",
].join("\n");
const CTX_TEXT = "A launch-first plan. It benchmarks Dialcrown against Quo and RingCentral, evaluates Guava as the voice-agent platform, and designs one configuration that drives the record, the agent and the call flow. The test throughout: the smallest release a customer can use and pay for.";
const CTX_MARK = "The test throughout: the smallest release a customer can use and pay for.";

const at = (text: string, quote: string) => ({ charStart: text.indexOf(quote), charEnd: text.indexOf(quote) + quote.length, quotedText: quote });

const DIN_COMMENTS: Comment[] = [
  { id: "c-001", type: "feedback", anchorId: "A.1.p1", blockId: "blk-steps", body: "Run this against staging first, not prod.", createdAt: 1, status: "draft", selection: at(STEPS_TEXT, MARKED) },
  { id: "c-002", type: "feedback", anchorId: "A.2.p1", blockId: "blk-next", body: " ", createdAt: 2, status: "draft" },
];
const DIAL_COMMENTS: Comment[] = [
  { id: "c-001", type: "feedback", anchorId: "A.1.p1", blockId: "blk-ctx", body: "The pilot firm is my own firm.", createdAt: 1, status: "resolved", selection: at(CTX_TEXT, CTX_MARK), resolution: { body: "Done.", appearedInVersion: 2, acceptedAt: null } },
  ...Array.from({ length: 15 }, (_, i): Comment => ({ id: `c-${String(i + 2).padStart(3, "0")}`, type: "feedback", anchorId: "A.4", body: `Resolved item ${i + 2}`, createdAt: i + 2, status: "resolved", resolution: { body: "Done.", appearedInVersion: 2, acceptedAt: null } })),
];

const revision = (versionNumber: number, markdown: string, comments: Comment[]) => ({ versionNumber, receivedAt: 1_792_000_000_000 + versionNumber, rawPlanMarkdown: markdown, sections: [], comments, threadStart: versionNumber === 1, restored: false });
const DIAL_SESSION: ReviewSession = {
  sessionId: "S-dial", projectPath: "/p/dialcrown", projectName: "dialcrown", createdAt: 1, status: "approved", attachState: "idle", backend: "claude-code",
  revisions: [revision(1, DIAL, DIAL_COMMENTS), revision(2, DIAL, []), revision(3, DIAL, []), revision(4, DIAL, [])],
};

const SPEC = {
  "4c": { sessionId: "S-din", title: "Din roadmap: next steps", markdown: DIN, comments: DIN_COMMENTS, sidebar: 0, pose: "split" as const },
  "4d": { sessionId: "S-din", title: "Din roadmap: next steps", markdown: DIN, comments: DIN_COMMENTS, sidebar: 232, pose: "closed" as const },
  "5a": { sessionId: "S-dial", title: "Dialcrown: fastest credible launch", markdown: DIAL, comments: DIAL_COMMENTS, sidebar: 260, pose: "full" as const },
}[board];

resetFlowStateForTests({ sidebar: true });

function Fixture() {
  const [host] = useState(() => createBoundedPortalHost("session-conversation"));
  const [painted, setPainted] = useState<{ pose: string; layout: "stage" | "column" | "panel" }>({ pose: "closed", layout: "stage" });
  const [composing, setComposing] = useState(false);
  const [contents, setContents] = useState(false);
  const [wide, setWide] = useState(false);
  const [measure, setMeasure] = useState(820);
  const [zoom, setZoom] = useState(1);
  const view = useFlow((s) => s.stage);
  const articleRef = useRef<HTMLElement | null>(null);
  const focused = board === "5a" ? "c-001" : null;

  useEffect(() => {
    // After the stage's own revision rule has run: 4d is the plan closed
    // again, 5a the full pose on Feedback.
    if (SPEC.pose === "closed") setPlanPose(SPEC.sessionId, "closed");
    if (SPEC.pose === "full") { setPlanPose(SPEC.sessionId, "full"); setPanelTab("feedback"); }
    (window as any).__qa = {
      setTheme: applyTheme,
      setPose: (pose: "closed" | "split" | "full") => setPlanPose(SPEC.sessionId, pose),
      setTab: setPanelTab,
      setStage,
      setComposing,
      setContents,
      openPlan: () => openPlan(SPEC.sessionId, 0, false),
    };
    document.documentElement.dataset.qaReady = "true";
  }, []);

  const approval: PlanFooterApproval | null = board === "5a" ? { version: 4, runState: null, runLive: false, building: true } : null;
  const planBody = (
    <div className="rl-thin-scroll-y flex-1 overflow-y-auto">
      <article ref={articleRef} className="doc-article mx-auto pl-16 py-10" style={FLOW_ARTICLE}>
        <PlanEditor
          markdown={SPEC.markdown}
          sections={[]}
          comments={SPEC.comments}
          revisionKey={`qa:${board}`}
          focusedCommentId={focused}
          onAddComment={board === "5a" ? undefined : async () => {}}
          onUpdateComment={board === "5a" ? undefined : async () => {}}
          onDeleteComment={board === "5a" ? undefined : async () => {}}
          marginNotesBy={painted.pose === "split" ? "Imani" : undefined}
        />
      </article>
    </div>
  );
  const pending = SPEC.comments.filter((c) => c.status === "draft").length;
  const composer = composing ? <div className="qa-composer" style={{ fontSize: 13, color: "var(--color-ink)" }}>A comment composer</div> : null;
  const target = useMemo(() => ({ kind: "plan" as const, sessionId: SPEC.sessionId, terminalId: "T-1" }), []);
  return (
    <>
      <div className="qa-topbar"><b>Redline</b><span className="qa-faint">|</span><span>{SPEC.title}</span></div>
      <div className="qa-body">
        {SPEC.sidebar > 0 && painted.pose !== "split" && (
          <aside className="qa-sidebar" style={{ width: SPEC.sidebar }}><div>New session</div><div>{SPEC.title}</div></aside>
        )}
        <div className="qa-column">
          <div className="rl-surface-pane flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative" data-main-surface="document" style={{ "--rl-doc-zoom": zoom } as CSSProperties}>
            {contents && (
              <div className="rl-toc-rail" style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 230, zIndex: 20, background: "var(--color-bg-elevated)", borderRight: "1px solid var(--color-rule)" }} />
            )}
            <FlowStage
              target={target}
              harness="claude"
              conversationHost={host}
              onPose={(pose, layout) => setPainted((p) => (p.pose === pose && p.layout === layout ? p : { pose, layout }))}
              hasPlan
              planBody={planBody}
              latestVersion={board === "5a" ? 4 : 1}
              marks={pending}
              unresolved={board === "5a" ? 0 : pending}
              viewing={board === "5a" ? { viewing: 1, latest: 4, receivedAt: 1_792_000_000_001, onGoToLatest: () => {} } : null}
              contents={{ open: contents, onToggle: () => setContents((o) => !o) }}
              width={{ wide, measure }}
              footer={{
                author: "Claude",
                marks: pending,
                askOnly: false,
                canSubmit: pending > 0,
                canApprove: board !== "5a",
                waiting: false,
                waitingAsk: false,
                onSubmit: () => {},
                onApprove: () => {},
                onApproveLater: () => {},
                onBuildTeam: () => {},
                approval,
                buildTargets: [],
                onReopen: () => {},
                progress: board === "5a" ? { step: 3, of: 11 } : null,
                terminals: 1,
                onShowTerminal: () => setStage("terminal"),
                detached: null,
              }}
              feedback={board === "5a" ? { session: DIAL_SESSION, viewingVersion: 1, onJumpToAnchor: () => {}, focusedCommentId: focused, composer: { onSubmit: () => {} } } : null}
              composer={composer}
              terminalView={view === "terminal"}
            />
            <div className="rl-doc-zoom absolute flex items-center gap-1 rounded-full" style={{ right: 16, bottom: 16, padding: 3, background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)", boxShadow: "0 4px 14px rgba(0,0,0,0.18)", opacity: 0.92 }}>
              <ZoomButton label="−" title="Zoom out" onClick={() => setZoom((z) => z - 0.1)} />
              <button type="button" className="font-mono" style={{ fontSize: 10, minWidth: 34, color: "var(--color-ink-muted)", background: "transparent", border: "none" }}>{Math.round(zoom * 100)}%</button>
              <ZoomButton label="+" title="Zoom in" onClick={() => setZoom((z) => z + 0.1)} />
              <DocWidthToggle wide={wide} measure={measure} articleRef={articleRef} onToggle={() => setWide((w) => !w)} onCommit={(v) => { setWide(v.wide); setMeasure(v.measure); }} />
            </div>
          </div>
        </div>
      </div>
      {createPortal(
        <SessionConversation
          terminalId="T-1"
          sessionId={SPEC.sessionId}
          harness="claude"
          layout={painted.layout}
          planTitle={SPEC.title}
          planMarks={pending}
          planOpen={painted.pose !== "closed"}
          onOpenPlan={() => openPlan(SPEC.sessionId, 0, false)}
          onShowTerminal={() => setStage("terminal")}
        />,
        host,
      )}
      <span hidden data-summary={planReadySummary(SPEC.markdown) ?? ""} />
    </>
  );
}

applyTheme("aurora");
createRoot(document.getElementById("root")!).render(<Fixture />);
