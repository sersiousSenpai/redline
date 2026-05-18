import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { ApproveToast } from "./components/ApproveToast";
import { CommentCard } from "./components/CommentCard";
import { CommentComposer } from "./components/CommentComposer";
import { Document } from "./components/Document";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { HookSetupModal } from "./components/HookSetupModal";
import { ResolutionWarningBanner } from "./components/ResolutionWarningBanner";
import { SelectionMenu } from "./components/SelectionMenu";
import { SessionSidebar } from "./components/SessionSidebar";
import { computeParagraphDiff } from "./diff";
import { useTextSelection } from "./hooks/useTextSelection";
import { applyTheme, readStoredTheme, storeTheme } from "./theme/applyTheme";
import type { ThemeName } from "./theme/themes";
import { usePersistedState } from "./theme/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { PaneDivider } from "./components/PaneDivider";
import type {
  Comment,
  CommentType,
  HookStatus,
  NewCommentRequest,
  PlanReceivedEvent,
  ReviewSession,
  SessionSummary,
} from "./types";

interface ComposingState {
  type: CommentType;
  anchorId: string;
  selectedText: string;
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
  const [toast, setToast] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  const [paneWidth, setPaneWidth] = usePersistedState(
    "redline.commentPane.width",
    320,
  );
  const [paneCollapsed, setPaneCollapsed] = usePersistedState(
    "redline.commentPane.collapsed",
    false,
  );
  const documentRef = useRef<HTMLElement | null>(null);

  const onThemeChange = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
  };

  const { isDragging, startDrag } = useResizablePane({
    width: paneWidth,
    onWidthChange: setPaneWidth,
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
    return () => {
      void planUnlisten.then((u) => u());
      void commentsUnlisten.then((u) => u());
      void statusUnlisten.then((u) => u());
    };
  }, [activeId]);

  // When user clicks a session in the sidebar, reload it
  useEffect(() => {
    if (activeId) {
      void loadSession(activeId);
      setWarning(null);
    }
  }, [activeId]);

  const latest = session?.revisions[session.revisions.length - 1];
  const previous =
    session && session.revisions.length >= 2
      ? session.revisions[session.revisions.length - 2]
      : undefined;
  const sections = latest?.sections ?? [];
  const diff = useMemo(
    () => computeParagraphDiff(sections, previous?.sections),
    [sections, previous],
  );
  const allComments = useMemo<Comment[]>(
    () => (session ? session.revisions.flatMap((r) => r.comments) : []),
    [session],
  );

  const pendingComments = useMemo(
    () =>
      allComments.filter(
        (c) => c.status === "draft" || c.status === "reopened",
      ),
    [allComments],
  );
  const submittedCount = allComments.filter(
    (c) => c.status === "submitted",
  ).length;
  const waiting = submittedCount > 0 && pendingComments.length === 0;
  const canSubmit = pendingComments.length > 0;
  const canApprove = !!session && session.status !== "approved";

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
    });
    clearSelection();
  };

  const submitComment = async (req: NewCommentRequest) => {
    if (!session) return;
    try {
      await invoke<Comment>("add_comment", {
        sessionId: session.sessionId,
        request: req,
      });
      setComposing(null);
    } catch (err) {
      console.error("failed to add comment", err);
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
      <Header session={session} theme={theme} onThemeChange={onThemeChange} />
      <main className="flex-1 overflow-hidden flex">
        <SessionSidebar
          sessions={summaries}
          activeId={activeId}
          pendingCounts={pendingPerSession}
          onSelect={(id) => setActiveId(id)}
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
              <Document
                sections={sections}
                diff={diff}
                comments={allComments}
              />
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
          className="overflow-y-auto border-l shrink-0"
          style={{
            width: `${paneWidth}px`,
            borderColor: "var(--color-rule)",
            background: "var(--color-paper)",
          }}
        >
          <div className="p-4 flex flex-col gap-3">
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
                onCancel={() => setComposing(null)}
                onSubmit={submitComment}
              />
            )}
            {waiting && (
              <div
                className="rounded-md border p-3 italic"
                style={{
                  borderColor: "var(--color-rule)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink-muted)",
                  fontSize: "12px",
                }}
              >
                Waiting for Claude's revised plan…
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
                key={c.id}
                comment={c}
                onDelete={() => deleteComment(c.id)}
                onAccept={() => acceptResolution(c.id)}
                onReopen={() => reopenResolution(c.id)}
              />
            ))}
          </div>
        </aside>
        )}
      </main>
      <Footer
        comments={allComments}
        canSubmit={canSubmit}
        canApprove={canApprove}
        waiting={waiting}
        onSubmit={submitReview}
        onApprove={approvePlan}
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
