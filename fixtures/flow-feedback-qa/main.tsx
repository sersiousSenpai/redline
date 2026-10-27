// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The flow Feedback lane's pieces at their boards' sizes: 5a's right panel
// (tabs, threads, composer) on board 5a's own session, and 4c's margin note
// in a plan panel. Production components, synthetic Tauri answers.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "../../src/styles.css";
import "./fixture.css";
import { feedbackSummary } from "../../src/lib/feedbackThreads";
import type { PanelTab } from "../../src/shell/flowState";
import FeedbackPanel, { FeedbackComposer, FeedbackTabs } from "../../src/components/plan/FeedbackPanel";
import { MarginNote, marginNoteElement } from "../../src/components/plan/MarginNote";
import { applyTheme } from "../../src/theme/applyTheme";
import type { ThemeName } from "../../src/theme/themes";
import { boardSession, marginNote, statesSession } from "./board";

// The flow shell, as main.tsx stamps it before React mounts.
localStorage.setItem("redline.shell", "flow");
document.documentElement.dataset.rlShell = "flow";

const view = new URLSearchParams(location.search).get("view") ?? "panel";
const qa = window as unknown as Record<string, unknown>;

function Panel() {
  const session = view === "states" ? statesSession : boardSession;
  const [tab, setTab] = useState<PanelTab>("feedback");
  const summary = feedbackSummary(session, 1);
  return (
    <>
      <div className="qa-topbar" />
      <aside className="qa-panel" data-qa="panel">
        <FeedbackTabs tab={tab} onTab={setTab} count={summary.count} allResolved={summary.allResolved} />
        <div className="qa-panel-body">
          <FeedbackPanel
            session={session}
            viewingVersion={1}
            onJumpToAnchor={(anchorId, commentId) => {
              qa.__qaJump = { anchorId, commentId };
            }}
            composer={
              <FeedbackComposer
                session={session}
                selection={view === "states" ? { anchorId: "A.4.p1", text: "Prove the E911 path", charStart: 0, charEnd: 19, subBlockId: "blk-steps.l5" } : null}
              />
            }
          />
        </div>
      </aside>
    </>
  );
}

function Margin() {
  const widget = useRef<HTMLDivElement>(null);
  // The ProseMirror-widget shape of the same note, for parity.
  useLayoutEffect(() => {
    widget.current?.replaceChildren(marginNoteElement({ ...marginNote, commentId: "qa-widget" }));
  }, []);
  return (
    <div className="qa-plan" data-qa="margin">
      <div className="qa-plan-body">
        <div className="qa-plan-title">Din roadmap: next steps</div>
        <div className="qa-plan-lede">Picks up from note 28 and the 2026-10-17 updates in the build log.</div>
        <div className="qa-plan-h2">1. Finish Track B</div>
        <div className="qa-plan-p">
          1. Compile the build in Xcode on the Mac.
          <br />
          2. Apply <mark>0018_vault_revisions.sql before the next build</mark> runs.
          <br />
          3. Deploy the Worker; D3 crash reports need both.
        </div>
        <MarginNote initials={marginNote.initials} commentId="qa-react">
          {marginNote.text}
        </MarginNote>
        <div className="qa-plan-h2">2. Next by priority</div>
        <div ref={widget} style={{ display: "flex", flexDirection: "column" }} />
      </div>
    </div>
  );
}

function Fixture() {
  useEffect(() => {
    qa.__qa = { setTheme: (name: ThemeName) => applyTheme(name) };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  return view === "margin" ? <Margin /> : <Panel />;
}

applyTheme("aurora");
createRoot(document.getElementById("root")!).render(<Fixture />);
