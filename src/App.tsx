// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ApproveToast } from "./components/ApproveToast";
import { CommentCard } from "./components/CommentCard";
import { CommentComposer } from "./components/CommentComposer";
import { lazy, Suspense } from "react";
// Tiptap/ProseMirror is heavy; lazy-load so it's off the initial paint path.
const PlanEditor = lazy(() =>
  import("./components/PlanEditor").then((m) => ({ default: m.PlanEditor })),
);
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { HookSetupModal } from "./components/HookSetupModal";
import { AskModeViolationBanner } from "./components/AskModeViolationBanner";
import { ResolutionWarningBanner } from "./components/ResolutionWarningBanner";
import { SelectionMenu } from "./components/SelectionMenu";
import { SessionSidebar } from "./components/SessionSidebar";
import { computeParagraphDiff } from "./diff";
import { blockIdByAnchorId } from "./editor/docModel";
import { useTextSelection } from "./hooks/useTextSelection";
import { applyTheme, readStoredTheme, storeTheme } from "./theme/applyTheme";
import type { ThemeName } from "./theme/themes";
import { usePersistedState } from "./theme/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { PaneDivider } from "./components/PaneDivider";
import { TerminalTabs } from "./components/TerminalTabs";
import { DecisionWindowBanner } from "./components/DecisionWindowBanner";
import type {
  Comment,
  CommentType,
  HookStatus,
  InterceptionMode,
  ModeEvent,
  NewCommentRequest,
  PlanDecisionWindowEvent,
  PlanReceivedEvent,
  ReviewSession,
  SessionSummary,
} from "./types";

interface ComposingState {
  type: CommentType;
  anchorId: string;
  selectedText: string;
  /** Block-relative character range of the original selection. Forwarded
   *  with the NewCommentRequest so the editor can paint a persistent
   *  highlight over exactly the selected span (and click-bridge it with
   *  the card). */
  charStart: number;
  charEnd: number;
}

interface ResolutionWarning {
  parseError: string | null;
  unmatchedIds: string[];
  unresolvedSubmittedIds: string[];
}

function App() {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState<ComposingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<ResolutionWarning | null>(null);
  const [askModeViolation, setAskModeViolation] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [mode, setMode] = useState<InterceptionMode>("active");
  const [decisionWindow, setDecisionWindow] =
    useState<PlanDecisionWindowEvent | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  const [paneWidth, setPaneWidth] = usePersistedState(
    "redline.commentPane.width",
    320,
  );
  const [paneCollapsed, setPaneCollapsed] = usePersistedState(
    "redline.commentPane.collapsed",
    false,
  );
  const [termHeight, setTermHeight] = usePersistedState(
    "redline.terminalPane.height",
    260,
  );
  const [termCollapsed, setTermCollapsed] = usePersistedState(
    "redline.terminalPane.collapsed",
    false,
  );
  const [termFullscreen, setTermFullscreen] = usePersistedState(
    "redline.terminalPane.fullscreen",
    false,
  );
  const [termTabCount, setTermTabCount] = useState(1);
  const [termHasUnseen, setTermHasUnseen] = useState(false);
  const documentRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  // Bidirectional focus between in-doc highlights and sidebar cards. Single
  // source of truth: card click sets it; highlight click sets it; effects
  // mirror the change in each direction.
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  const onThemeChange = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
  };

  const { isDragging, startDrag } = useResizablePane({
    width: paneWidth,
    onWidthChange: setPaneWidth,
  });

  const { isDragging: termDragging, startDrag: startTermDrag } =
    useResizablePane({
      width: termHeight,
      onWidthChange: setTermHeight,
      axis: "y",
      min: 120,
    });

  const [selection, clearSelection] = useTextSelection(
    documentRef,
    composing === null,
  );

  async function refreshSummaries(): Promise<SessionSummary[]> {
    try {
      const list = await invoke<SessionSummary[]>("list_sessions");
      setSummaries(list);
      return list;
    } catch (err) {
      console.error("list_sessions failed", err);
      return [];
    }
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      await invoke<boolean>("delete_session", { sessionId: id });
    } catch (err) {
      // Backend rejects sessions whose terminal is still active; the ✕ is
      // already hidden for those, so this is just a safety net.
      console.error("delete_session failed", err);
      return;
    }
    const list = await refreshSummaries();
    if (id === activeId) {
      const next = list[0]?.sessionId ?? null;
      setActiveId(next);
      if (next === null) setSession(null);
    }
  }

  async function loadSession(id: string | null): Promise<void> {
    if (!id) {
      setSession(null);
      return;
    }
    try {
      const full = await invoke<ReviewSession | null>("get_session", { id });
      setSession(full);
    } catch (err) {
      console.error("get_session failed", err);
    }
  }

  // Initial load: hook status + sessions
  useEffect(() => {
    (async () => {
      try {
        const status = await invoke<HookStatus>("get_hook_status");
        setHookStatus(status);
      } catch (err) {
        console.error("get_hook_status failed", err);
      }
      try {
        const m = await invoke<InterceptionMode>("get_interception_mode");
        setMode(m);
      } catch (err) {
        console.error("get_interception_mode failed", err);
      }
      const list = await refreshSummaries();
      const first = list[0]?.sessionId ?? null;
      setActiveId(first);
      await loadSession(first);
      setLoading(false);
    })();
  }, []);

  // Event subscriptions
  useEffect(() => {
    const planUnlisten = listen<PlanReceivedEvent>("plan-received", (e) => {
      const payload = e.payload;
      void refreshSummaries().then((list) => {
        if (activeId === null && list.length > 0) {
          setActiveId(list[0].sessionId);
          void loadSession(list[0].sessionId);
        } else if (payload.sessionId === activeId) {
          void loadSession(payload.sessionId);
        }
      });
      if (
        payload.sessionId === activeId &&
        (payload.resolutionParseError ||
          payload.unmatchedResolutionIds.length > 0 ||
          payload.unresolvedSubmittedIds.length > 0)
      ) {
        setWarning({
          parseError: payload.resolutionParseError,
          unmatchedIds: payload.unmatchedResolutionIds,
          unresolvedSubmittedIds: payload.unresolvedSubmittedIds,
        });
      }
      if (payload.sessionId === activeId && payload.askModeViolated) {
        setAskModeViolation(true);
      }
    });
    const commentsUnlisten = listen<{ sessionId: string }>(
      "comments-changed",
      (e) => {
        void refreshSummaries();
        if (e.payload.sessionId === activeId) {
          void loadSession(e.payload.sessionId);
        }
      },
    );
    const statusUnlisten = listen<{ sessionId: string }>(
      "session-status-changed",
      (e) => {
        void refreshSummaries();
        if (e.payload.sessionId === activeId) {
          void loadSession(e.payload.sessionId);
        }
      },
    );
    const modeUnlisten = listen<ModeEvent>("mode-changed", (e) => {
      setMode(e.payload.mode);
    });
    const decisionUnlisten = listen<PlanDecisionWindowEvent>(
      "plan-decision-window",
      (e) => {
        setDecisionWindow(e.payload);
        // Attention-grab: a short window is useless behind other windows.
        void (async () => {
          try {
            const w = getCurrentWindow();
            if (!(await w.isFocused())) {
              await w.unminimize();
              await w.setFocus();
            }
          } catch {
            /* window API unavailable — banner still shows */
          }
        })();
      },
    );
    return () => {
      void planUnlisten.then((u) => u());
      void commentsUnlisten.then((u) => u());
      void statusUnlisten.then((u) => u());
      void modeUnlisten.then((u) => u());
      void decisionUnlisten.then((u) => u());
    };
  }, [activeId]);

  // When user clicks a session in the sidebar, reload it
  useEffect(() => {
    if (activeId) {
      void loadSession(activeId);
      setWarning(null);
      setAskModeViolation(false);
    }
  }, [activeId]);

  const latest = session?.revisions[session.revisions.length - 1];
  // Scope diff + comments to the current review *thread*: everything from the
  // last `threadStart` revision onward. A fresh plan (threadStart) therefore
  // renders clean (diffs against nothing) with an empty comment pane instead
  // of redlining against an unrelated prior plan in the same terminal session.
  const threadRevisions = useMemo(() => {
    if (!session || session.revisions.length === 0) return [];
    const revs = session.revisions;
    let start = 0;
    for (let i = revs.length - 1; i >= 0; i--) {
      if (revs[i].threadStart) {
        start = i;
        break;
      }
    }
    return revs.slice(start);
  }, [session]);
  const previous =
    threadRevisions.length >= 2
      ? threadRevisions[threadRevisions.length - 2]
      : undefined;
  const sections = latest?.sections ?? [];
  const diff = useMemo(
    () => computeParagraphDiff(sections, previous?.sections),
    [sections, previous],
  );
  // anchorId → stable blockId for the current revision. Selection-originated
  // comments only capture a positional anchorId; the in-doc highlight
  // decoration is keyed by blockId, so resolve it at submit time.
  const blockIdByAnchor = useMemo(
    () => blockIdByAnchorId(sections),
    [sections],
  );
  const allComments = useMemo<Comment[]>(
    () => threadRevisions.flatMap((r) => r.comments),
    [threadRevisions],
  );

  const pendingComments = useMemo(
    () =>
      allComments.filter(
        (c) => c.status === "draft" || c.status === "reopened",
      ),
    [allComments],
  );
  const submittedComments = allComments.filter(
    (c) => c.status === "submitted",
  );
  const submittedCount = submittedComments.length;
  const waiting = submittedCount > 0 && pendingComments.length === 0;
  // Mirror Footer's mode inference for the pane-side waiting card: if the
  // in-flight batch is all questions, Claude is answering, not revising.
  const waitingAsk =
    waiting && submittedComments.every((c) => c.type === "question");
  const canSubmit = pendingComments.length > 0;
  const canApprove = !!session && session.status !== "approved";

  // While Claude revises, the live terminal *is* the waiting state — make sure
  // the dock is visible so "watch it below" actually points at something.
  useEffect(() => {
    if (waiting) setTermCollapsed(false);
  }, [waiting, setTermCollapsed]);

  // Bidirectional focus: when the editor (or anything else) sets a focused
  // comment id, scroll the matching sidebar card into view. The editor side
  // is handled by PlanEditor's own effect on `focusedCommentId`.
  useEffect(() => {
    if (!focusedCommentId) return;
    const aside = sidebarRef.current;
    if (!aside) return;
    const card = aside.querySelector(
      `[data-comment-id="${cssEscape(focusedCommentId)}"]`,
    );
    if (card instanceof HTMLElement) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusedCommentId]);

  // Clear focus when the user clicks the document chrome outside any
  // highlight or card (Word's behaviour). Anchored to the main panel so
  // clicks inside the highlight/card still propagate to their handlers.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!focusedCommentId) return;
      const target = e.target as Node | null;
      if (!target) return;
      // Inside the editor — let CommentHighlights' click handler decide.
      if (documentRef.current?.contains(target)) return;
      // Inside the sidebar — let card onSelect decide.
      if (sidebarRef.current?.contains(target)) return;
      setFocusedCommentId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [focusedCommentId]);

  const pendingPerSession = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of summaries) {
      map[s.sessionId] = s.pendingCount;
    }
    return map;
  }, [summaries]);

  const beginCompose = (type: CommentType) => {
    if (!selection) return;
    setComposing({
      type,
      anchorId: selection.anchorId,
      selectedText: selection.text,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
    });
    clearSelection();
  };

  const submitComment = async (req: NewCommentRequest) => {
    if (!session) return;
    try {
      await invoke<Comment>("add_comment", {
        sessionId: session.sessionId,
        // Resolve the stable blockId from the comment's anchor so the in-doc
        // highlight decoration (keyed by blockId) paints — without it the
        // highlight never renders and the highlight↔card focus bridge is dead.
        request: {
          ...req,
          blockId: req.blockId ?? blockIdByAnchor.get(req.anchorId),
        },
      });
      setComposing(null);
    } catch (err) {
      console.error("failed to add comment", err);
    }
  };

  const addEditorComment = async (req: NewCommentRequest) => {
    if (!session) return;
    return invoke<Comment>("add_comment", {
      sessionId: session.sessionId,
      request: req,
    });
  };

  const updateComment = async (
    commentId: string,
    update: import("./types").UpdateCommentRequest,
  ) => {
    if (!session) return;
    try {
      await invoke<Comment>("update_comment", {
        sessionId: session.sessionId,
        commentId,
        update,
      });
    } catch (err) {
      console.error("failed to update comment", err);
    }
  };

  const deleteComment = async (commentId: string) => {
    if (!session) return;
    try {
      await invoke<boolean>("delete_comment", {
        sessionId: session.sessionId,
        commentId,
      });
    } catch (err) {
      console.error("failed to delete comment", err);
    }
  };

  const submitReview = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      await invoke("submit_review", { sessionId: session.sessionId });
    } catch (err) {
      console.error("submit_review failed", err);
      alert(`Submit failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const approvePlan = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      await invoke("approve_plan", { sessionId: session.sessionId });
      setToast("Approved · Claude is executing");
      setTimeout(() => setToast(null), 3500);
    } catch (err) {
      console.error("approve_plan failed", err);
      alert(`Approve failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const changeMode = async (next: InterceptionMode) => {
    setMode(next); // optimistic; the mode-changed event confirms
    try {
      await invoke("set_interception_mode", { mode: next });
    } catch (err) {
      console.error("set_interception_mode failed", err);
    }
  };

  const dismissDecisionWindow = useCallback(() => setDecisionWindow(null), []);

  const openDecisionForReview = async () => {
    const dw = decisionWindow;
    if (!dw) return;
    try {
      await invoke<boolean>("claim_review", { sessionId: dw.sessionId });
    } catch (err) {
      console.error("claim_review failed", err);
    }
    setActiveId(dw.sessionId);
    void loadSession(dw.sessionId);
    setDecisionWindow(null);
  };

  const approveFromDecision = async () => {
    const dw = decisionWindow;
    if (!dw) return;
    try {
      await invoke("approve_plan", { sessionId: dw.sessionId });
      setToast("Approved · Claude is executing");
      setTimeout(() => setToast(null), 3500);
    } catch (err) {
      console.error("approve_plan failed", err);
    }
    setDecisionWindow(null);
  };

  const acceptResolution = async (commentId: string) => {
    if (!session) return;
    try {
      await invoke("accept_resolution", {
        sessionId: session.sessionId,
        commentId,
      });
    } catch (err) {
      console.error("accept_resolution failed", err);
    }
  };

  const reopenResolution = async (commentId: string) => {
    if (!session) return;
    try {
      await invoke("reopen_resolution", {
        sessionId: session.sessionId,
        commentId,
      });
    } catch (err) {
      console.error("reopen_resolution failed", err);
    }
  };

  const installHook = async () => {
    try {
      const status = await invoke<HookStatus>("install_hook");
      setHookStatus(status);
    } catch (err) {
      console.error("install_hook failed", err);
      alert(`Install failed: ${err}`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <Header
        session={session}
        theme={theme}
        onThemeChange={onThemeChange}
        mode={mode}
        onModeChange={changeMode}
      />
      {decisionWindow && (
        <DecisionWindowBanner
          event={decisionWindow}
          onOpen={openDecisionForReview}
          onApprove={approveFromDecision}
          onExpire={dismissDecisionWindow}
        />
      )}
      <main className="relative flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden flex">
        <SessionSidebar
          sessions={summaries}
          activeId={activeId}
          pendingCounts={pendingPerSession}
          onSelect={(id) => setActiveId(id)}
          onDelete={deleteSession}
        />
        <div
          className="flex-1 overflow-y-auto"
          style={{ background: "var(--color-paper)" }}
        >
          <article
            ref={documentRef}
            className="doc-article mx-auto px-8 py-10"
            style={{ maxWidth: "780px" }}
          >
            {loading ? (
              <EmptyState
                title="Loading…"
                body="Fetching the latest review session."
              />
            ) : session ? (
              <Suspense fallback={null}>
                <PlanEditor
                  markdown={latest?.rawPlanMarkdown ?? ""}
                  sections={sections}
                  diff={diff}
                  comments={allComments}
                  revisionKey={`${activeId ?? ""}:${
                    threadRevisions[0]?.versionNumber ?? 0
                  }:${latest?.versionNumber ?? 0}`}
                  onAddComment={addEditorComment}
                  onUpdateComment={updateComment}
                  onDeleteComment={deleteComment}
                  focusedCommentId={focusedCommentId}
                  onHighlightClick={(id) => setFocusedCommentId(id)}
                />
              </Suspense>
            ) : (
              <EmptyState
                title="No plans yet"
                body="Run Claude Code in plan mode in any project. When Claude calls ExitPlanMode, the plan will appear here."
              />
            )}
          </article>
        </div>

        <PaneDivider
          collapsed={paneCollapsed}
          dragging={isDragging}
          onToggle={() => setPaneCollapsed((c) => !c)}
          onPointerDown={startDrag}
        />

        {!paneCollapsed && (
        <aside
          ref={sidebarRef as React.RefObject<HTMLElement>}
          className="overflow-y-auto border-l shrink-0"
          style={{
            width: `${paneWidth}px`,
            borderColor: "var(--color-rule)",
            background: "var(--color-paper)",
          }}
        >
          <div className="p-4 flex flex-col gap-3">
            {askModeViolation && (
              <AskModeViolationBanner
                onDismiss={() => setAskModeViolation(false)}
              />
            )}
            {warning && (
              <ResolutionWarningBanner
                warning={warning}
                onDismiss={() => setWarning(null)}
              />
            )}
            {composing && (
              <CommentComposer
                type={composing.type}
                anchorId={composing.anchorId}
                selectedText={composing.selectedText}
                charStart={composing.charStart}
                charEnd={composing.charEnd}
                onCancel={() => setComposing(null)}
                onSubmit={submitComment}
              />
            )}
            {waiting && (
              <div
                className="rounded-md border p-3"
                style={{
                  borderColor: "var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink-muted)",
                  fontSize: "12px",
                  lineHeight: 1.5,
                }}
              >
                {waitingAsk
                  ? "Questions sent. Claude is answering — "
                  : "Feedback sent. Claude is revising — "}
                <span style={{ color: "var(--color-ink)" }}>
                  watch it work in the terminal below ↓
                </span>
              </div>
            )}
            {allComments.length === 0 && !composing && (
              <div
                className="italic"
                style={{
                  fontSize: "12px",
                  color: "var(--color-ink-muted)",
                  lineHeight: 1.5,
                }}
              >
                Select text in the plan to add a comment.
              </div>
            )}
            {allComments.map((c) => (
              <CommentCard
                key={`${session?.sessionId ?? ""}-${c.id}`}
                sessionId={session?.sessionId ?? ""}
                comment={c}
                focused={focusedCommentId === c.id}
                onSelect={() =>
                  setFocusedCommentId((prev) => (prev === c.id ? null : c.id))
                }
                onDelete={() => deleteComment(c.id)}
                onAccept={() => acceptResolution(c.id)}
                onReopen={() => reopenResolution(c.id)}
              />
            ))}
          </div>
        </aside>
        )}
        </div>

        {!termFullscreen && (
          <PaneDivider
            orientation="horizontal"
            label="terminal"
            collapsed={termCollapsed}
            dragging={termDragging}
            onToggle={() => setTermCollapsed((c) => !c)}
            onPointerDown={startTermDrag}
          />
        )}
        <div
          className={
            termFullscreen
              ? "absolute inset-0 z-30"
              : "shrink-0 overflow-hidden"
          }
          style={
            termFullscreen
              ? { background: "var(--color-paper)" }
              : { height: termCollapsed ? 0 : `${termHeight}px` }
          }
        >
          <TerminalTabs
            theme={theme}
            fullscreen={termFullscreen}
            onFullscreenChange={setTermFullscreen}
            onTabsChange={setTermTabCount}
            onActivityChange={setTermHasUnseen}
            collapsed={termFullscreen ? false : termCollapsed}
          />
        </div>
      </main>
      <Footer
        comments={allComments}
        canSubmit={canSubmit}
        canApprove={canApprove}
        waiting={waiting}
        onSubmit={submitReview}
        onApprove={approvePlan}
        termCollapsed={termCollapsed && !termFullscreen}
        termTabCount={termTabCount}
        termHasUnseen={termHasUnseen}
        onExpandTerminal={() => setTermCollapsed(false)}
      />
      {selection && !composing && (
        <SelectionMenu rect={selection.rect} onPick={beginCompose} />
      )}
      {toast && <ApproveToast message={toast} />}
      {hookStatus && !hookStatus.installed && (
        <HookSetupModal
          status={hookStatus}
          onInstall={installHook}
          onSkip={() => setHookStatus({ ...hookStatus, installed: true })}
        />
      )}
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="font-sans" style={{ color: "var(--color-ink-muted)" }}>
      <div
        className="font-serif font-semibold mb-2"
        style={{ color: "var(--color-ink)", fontSize: "22px" }}
      >
        {title}
      </div>
      <p style={{ fontSize: "14px", lineHeight: 1.6, maxWidth: "60ch" }}>
        {body}
      </p>
    </div>
  );
}

export default App;
