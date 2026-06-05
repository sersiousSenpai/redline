// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ApproveToast } from "./components/ApproveToast";
import { CommentCard } from "./components/CommentCard";
import { CommentComposer } from "./components/CommentComposer";
import { MarkdownView } from "./components/MarkdownView";
import { lazy, Suspense } from "react";
import { stripSidecars } from "./editor/markdown/sidecar";
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
import { SidebarTabStrip } from "./components/SidebarTabStrip";
import { FileTree } from "./components/FileTree";
import { FileViewer } from "./components/FileViewer";
import { useFolderWorkspaces } from "./hooks/useFolderWorkspaces";
import { computeParagraphDiff } from "./diff";
import { blockIdByAnchorId } from "./editor/docModel";
import { useTextSelection } from "./hooks/useTextSelection";
import { applyTheme, readStoredTheme, storeTheme } from "./theme/applyTheme";
import type { ThemeName } from "./theme/themes";
import { usePersistedState } from "./theme/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { PaneDivider } from "./components/PaneDivider";
import { TerminalTabs } from "./components/TerminalTabs";
import type { TerminalTabsHandle } from "./components/TerminalTabs";
import { DecisionWindowBanner } from "./components/DecisionWindowBanner";
import { FlashOverlay } from "./components/FlashOverlay";
import { playInterceptBeep, DEFAULT_SOUND } from "./audio/beep";
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
  SkillStatus,
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
  /** Sub-block sidecar id when the original selection landed on clean
   *  unit boundaries; threaded through to the composer so the persisted
   *  selection carries the structural anchor. */
  subBlockId?: string;
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
  // True between a successful submit and the next plan-received POST for the
  // same session. Keeps the submit/approve buttons disabled across the brief
  // gap where the new plan's sender hasn't yet been registered — otherwise
  // the user can re-fire submit and silently drop feedback (bug #5).
  const [awaitingNextPlan, setAwaitingNextPlan] = useState(false);
  // null = "viewing the latest revision in the document pane" (normal editing
  // mode). A specific number puts the pane into read-only historical view of
  // that revision so the reviewer can scroll back and compare against the
  // current plan — toggled by clicking a revision in the SessionSidebar.
  const [viewedVersionNumber, setViewedVersionNumber] = useState<number | null>(
    null,
  );
  const [warning, setWarning] = useState<ResolutionWarning | null>(null);
  const [askModeViolation, setAskModeViolation] = useState<boolean>(false);
  // Set false when this window's daemon could not bind :7676 (another process
  // holds it): this window captures no plans, so we block it with a banner.
  const [daemonBound, setDaemonBound] = useState<boolean>(true);
  // True when the active session's held POST detached (timed out / terminal
  // closed) — Claude is no longer waiting, so the reviewer must re-run the plan.
  const [detached, setDetached] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [skillStatus, setSkillStatus] = useState<SkillStatus | null>(null);
  const [mode, setMode] = useState<InterceptionMode>("active");
  const [decisionWindow, setDecisionWindow] =
    useState<PlanDecisionWindowEvent | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  // Flash-on-intercept alert: an opt-in full-window pulse (+ optional beep)
  // fired whenever a plan is intercepted. `flashSeq` bumps to (re)trigger the
  // overlay; the three prefs persist via localStorage.
  const [flashEnabled, setFlashEnabled] = usePersistedState(
    "redline.flashOnIntercept.enabled",
    false,
  );
  const [flashColor, setFlashColor] = usePersistedState(
    "redline.flashOnIntercept.color",
    "#e8553d",
  );
  const [flashSound, setFlashSound] = usePersistedState(
    "redline.flashOnIntercept.sound",
    false,
  );
  const [flashSoundConfig, setFlashSoundConfig] = usePersistedState(
    "redline.flashOnIntercept.soundConfig",
    DEFAULT_SOUND,
  );
  const [flashSeq, setFlashSeq] = useState(0);
  // Read inside the plan-received listener (deps: [activeId]) without forcing a
  // re-subscribe of every event listener whenever these prefs toggle.
  const flashEnabledRef = useRef(flashEnabled);
  flashEnabledRef.current = flashEnabled;
  const flashSoundRef = useRef(flashSound);
  flashSoundRef.current = flashSound;
  const flashSoundConfigRef = useRef(flashSoundConfig);
  flashSoundConfigRef.current = flashSoundConfig;
  const [sidebarWidth, setSidebarWidth] = usePersistedState(
    "redline.sidebar.width",
    240,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState(
    "redline.sidebar.collapsed",
    false,
  );
  const [paneWidth, setPaneWidth] = usePersistedState(
    "redline.commentPane.width",
    320,
  );
  const [paneCollapsed, setPaneCollapsed] = usePersistedState(
    "redline.commentPane.collapsed",
    false,
  );
  const [paneFullscreen, setPaneFullscreen] = usePersistedState(
    "redline.commentPane.fullscreen",
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
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  // Project-folder explorer: open folders (sidebar tabs), the active tab, the
  // file shown in the center pane, and the linked-nav toggle.
  const {
    openFolders,
    sidebarTab,
    linkNav,
    activeFile,
    openFolder,
    closeFolder,
    selectSessions,
    selectFolder,
    setActiveFile,
    setLinkNav,
  } = useFolderWorkspaces();

  // Follow the active terminal's live working directory: when it `cd`s into a
  // new folder, auto-open that folder as a sidebar tab, and — when linked nav
  // is engaged — bring the tab forward. Only the active terminal is polled, so
  // this is one `lsof` call per tick. `linkNav` is read through a ref so the
  // poll loop isn't torn down and restarted each time the toggle flips.
  const linkNavRef = useRef(linkNav);
  linkNavRef.current = linkNav;
  // Per-folder memory of the last file viewed in each folder. Activating a
  // folder — by focusing a terminal sitting in it (linked nav), `cd`ing there,
  // or clicking its sidebar tab — reopens whatever file you last had open in
  // that folder, so every project keeps its place. Keyed by folder path; a ref
  // because it's written from handlers and read from the poll loop.
  const folderFileRef = useRef<Map<string, string | null>>(new Map());
  // Reverse of folder→file: which terminal currently lives in each folder, so
  // clicking a folder tab can focus its terminal. Each terminal maps to exactly
  // one folder (its live cwd); the poll keeps it pruned.
  const folderTermRef = useRef<Map<string, string>>(new Map());
  const terminalsRef = useRef<TerminalTabsHandle>(null);

  // Switch the sidebar to a folder and reopen the file last viewed there. The
  // single path for "this folder is now active", whatever triggered it. Does
  // NOT touch terminal focus — that's the caller's concern (the poll is itself
  // terminal-driven; a tab click adds the focus via selectFolderTab).
  const activateFolder = useCallback(
    (path: string) => {
      selectFolder(path);
      setActiveFile(folderFileRef.current.get(path) ?? null);
    },
    [selectFolder, setActiveFile],
  );

  // Folder-tab click: activate the folder and, with linked nav on, bring its
  // terminal forward — the mirror image of focusing a terminal to switch
  // folders. No-op on the terminal side if no terminal lives in that folder.
  const selectFolderTab = useCallback(
    (path: string) => {
      activateFolder(path);
      if (!linkNavRef.current) return;
      const termId = folderTermRef.current.get(path);
      if (termId) terminalsRef.current?.selectTab(termId);
    },
    [activateFolder],
  );

  useEffect(() => {
    const termId = activeTermId;
    if (!termId) return;
    let cancelled = false;
    let lastDir: string | null = null;
    const poll = async () => {
      let dir: string | null = null;
      try {
        dir = await invoke<string | null>("pty_cwd", { id: termId });
      } catch {
        return;
      }
      if (cancelled || !dir || dir === lastDir) return;
      lastDir = dir;
      // A terminal sitting in $HOME (where new shells spawn) or the filesystem
      // root isn't "a project" — don't surface those as folder tabs. The user
      // has to `cd` into an actual project for it to open.
      if (await isUninterestingDir(dir)) return;
      openFolder(dir);
      // Record folder→terminal, keeping this terminal in exactly one folder so
      // a later `cd` doesn't leave a stale folder pointing at it.
      for (const [f, t] of folderTermRef.current) {
        if (t === termId && f !== dir) folderTermRef.current.delete(f);
      }
      folderTermRef.current.set(dir, termId);
      if (linkNavRef.current) activateFolder(dir);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTermId, openFolder, activateFolder]);

  // Opening/closing a file records it as the active folder's remembered file,
  // so it reopens whenever that folder is next activated.
  const handleOpenFile = useCallback(
    (path: string) => {
      setActiveFile(path);
      if (sidebarTab.kind === "folder") {
        folderFileRef.current.set(sidebarTab.id, path);
      }
    },
    [setActiveFile, sidebarTab],
  );
  const handleCloseFile = useCallback(() => {
    setActiveFile(null);
    if (sidebarTab.kind === "folder") {
      folderFileRef.current.set(sidebarTab.id, null);
    }
  }, [setActiveFile, sidebarTab]);

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

  const { isDragging: sidebarDragging, startDrag: startSidebarDrag } =
    useResizablePane({
      width: sidebarWidth,
      onWidthChange: setSidebarWidth,
      side: "leading",
      min: 180,
    });

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
    // Always force=true: the UI confirm step is the user's intent gate, and
    // forcing drains any stale held POST so Claude Code's terminal unblocks
    // cleanly instead of stranding the backend in a phantom held state.
    try {
      await invoke<boolean>("delete_session", { sessionId: id, force: true });
    } catch (err) {
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
        const skill = await invoke<SkillStatus>("get_skill_status");
        setSkillStatus(skill);
      } catch (err) {
        console.error("get_skill_status failed", err);
      }
      try {
        const m = await invoke<InterceptionMode>("get_interception_mode");
        setMode(m);
      } catch (err) {
        console.error("get_interception_mode failed", err);
      }
      try {
        // Authoritative mount-time check — beats racing the daemon-bind-failed
        // event, which may fire before this listener is wired up.
        const bound = await invoke<boolean>("get_daemon_status");
        setDaemonBound(bound);
      } catch (err) {
        console.error("get_daemon_status failed", err);
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
      // Attention cue: a plan was just intercepted. Fire on *every* intercept,
      // regardless of which session it targets or whether we're focused.
      if (flashEnabledRef.current) {
        setFlashSeq((n) => n + 1);
        if (flashSoundRef.current) playInterceptBeep(flashSoundConfigRef.current);
      }
      if (payload.sessionId === activeId) {
        setAwaitingNextPlan(false);
        // A fresh plan means Claude is waiting again — clear any stale detach.
        setDetached(false);
      }
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
    // The held POST for a session detached before a decision (hook timeout,
    // terminal/session closed, app restart). Claude is no longer waiting.
    const detachedUnlisten = listen<{ sessionId: string }>(
      "session-detached",
      (e) => {
        void refreshSummaries();
        if (e.payload.sessionId === activeId) {
          setAwaitingNextPlan(false);
          setDetached(true);
        }
      },
    );
    // This window's daemon could not bind :7676 — it captures no plans.
    const bindFailedUnlisten = listen("daemon-bind-failed", () => {
      setDaemonBound(false);
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
      void detachedUnlisten.then((u) => u());
      void bindFailedUnlisten.then((u) => u());
      void commentsUnlisten.then((u) => u());
      void statusUnlisten.then((u) => u());
      void modeUnlisten.then((u) => u());
      void decisionUnlisten.then((u) => u());
    };
  }, [activeId]);

  // When user clicks a session in the sidebar, reload it. Clear any stale
  // session object up front so the next paint doesn't flash the previous
  // session's plan/comments while get_session is in flight — otherwise the
  // memoised threadRevisions/allComments still point at the old session.
  useEffect(() => {
    if (activeId) {
      setSession((prev) => (prev?.sessionId === activeId ? prev : null));
      void loadSession(activeId);
      setWarning(null);
      setAskModeViolation(false);
      setDetached(false);
    } else {
      setSession(null);
    }
    // Switching sessions invalidates the awaiting-next-plan lock — it was
    // scoped to the prior session's in-flight submit.
    setAwaitingNextPlan(false);
    // Historical-view state is per-session; fall back to "latest" on switch.
    setViewedVersionNumber(null);
  }, [activeId]);

  // Guard: only show session-scoped content (plan, comments, diff) once the
  // loaded session matches the clicked id. Bridges the async gap between
  // `activeId` flipping and `session` being repopulated by get_session.
  const sessionReady =
    session !== null && session.sessionId === activeId;

  const latest = session?.revisions[session.revisions.length - 1];
  // The revision currently displayed in the document pane. Null
  // `viewedVersionNumber` means "show the latest" — the normal editing path.
  // A specific number swaps in that historical revision (read-only). If the
  // number no longer matches any revision (defensive: shouldn't happen), we
  // fall through to `latest` rather than render an empty pane.
  const viewedRevision = useMemo(() => {
    if (viewedVersionNumber === null) return latest;
    return (
      session?.revisions.find((r) => r.versionNumber === viewedVersionNumber) ??
      latest
    );
  }, [session, viewedVersionNumber, latest]);
  const isViewingHistorical =
    viewedRevision !== undefined &&
    latest !== undefined &&
    viewedRevision.versionNumber !== latest.versionNumber;
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
  // `waiting` gates the submit/approve buttons. Two conditions hold it true:
  //   1) Comments are submitted but none are pending (Claude has the ball).
  //   2) `awaitingNextPlan` — a submit just fired and we have not yet seen the
  //      next plan-received POST. Without this, on the second feedback round
  //      the user could re-fire submit while the new plan's sender hasn't
  //      registered yet, and the second batch would silently drop.
  const waiting =
    awaitingNextPlan || (submittedCount > 0 && pendingComments.length === 0);
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
      subBlockId: selection.subBlockId,
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
      // Opt-in: auto-skip Claude Code's plan-rejection menu by writing the
      // configured keystroke into the active terminal. Off by default — flip
      // `redline.continueRevising.autoInject` in localStorage after running an
      // interactive verification to confirm the keystroke for your version.
      const autoContinue =
        typeof window !== "undefined" &&
        window.localStorage.getItem("redline.continueRevising.autoInject") ===
          "1";
      await invoke("submit_review", {
        sessionId: session.sessionId,
        terminalId: autoContinue ? activeTermId : null,
        autoContinue,
      });
      // Lock submit/approve until the next plan-received POST arrives — closes
      // the window where the user could re-fire submit before the new revision
      // is fully wired up.
      setAwaitingNextPlan(true);
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

  // Save one plan revision as a clean .md file (sidecars stripped) through a
  // native save dialog. A resolved `null` means the user cancelled the dialog.
  const exportRevision = async (sessionId: string, versionNumber: number) => {
    try {
      const saved = await invoke<string | null>("export_revision_markdown", {
        sessionId,
        versionNumber,
      });
      if (saved) {
        const name = saved.split(/[\\/]/).pop() ?? saved;
        setToast(`Saved ${name}`);
        setTimeout(() => setToast(null), 3500);
      }
    } catch (err) {
      console.error("export_revision_markdown failed", err);
      alert(`Export failed: ${err}`);
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

  // Installs both pieces of the Redline integration. The hook (a JSON merge
  // into the user's settings.json) and the skill (a whole-file write) have
  // independent failure modes — install each in its own try/catch so one
  // failing still installs the other.
  const installIntegration = async () => {
    try {
      const status = await invoke<HookStatus>("install_hook");
      setHookStatus(status);
    } catch (err) {
      console.error("install_hook failed", err);
      alert(`Hook install failed: ${err}`);
    }
    try {
      const skill = await invoke<SkillStatus>("install_skill");
      setSkillStatus(skill);
    } catch (err) {
      console.error("install_skill failed", err);
      alert(`Skill install failed: ${err}`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <FlashOverlay seq={flashSeq} color={flashColor} />
      {!daemonBound && (
        <div
          role="alert"
          className="px-4 py-2 text-sm text-center"
          style={{
            background: "var(--color-warning, #b45309)",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          Redline can’t capture plans — another process is using port 7676. This
          window won’t receive new plans. Quit any other Redline instance, then
          relaunch.
        </div>
      )}
      <Header
        session={session}
        theme={theme}
        onThemeChange={onThemeChange}
        mode={mode}
        onModeChange={changeMode}
        onExport={exportRevision}
        viewedVersionNumber={viewedVersionNumber}
        flashEnabled={flashEnabled}
        onFlashEnabledChange={setFlashEnabled}
        flashColor={flashColor}
        onFlashColorChange={setFlashColor}
        flashSound={flashSound}
        onFlashSoundChange={setFlashSound}
        flashSoundConfig={flashSoundConfig}
        onFlashSoundConfigChange={setFlashSoundConfig}
        onFlashSoundPreview={(cfg) => playInterceptBeep(cfg)}
        onFlashTest={() => {
          setFlashSeq((n) => n + 1);
          if (flashSound) playInterceptBeep(flashSoundConfig);
        }}
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
        {!sidebarCollapsed && (
        <aside
          className="flex flex-col shrink-0"
          style={{ width: `${sidebarWidth}px` }}
        >
          <SidebarTabStrip
            openFolders={openFolders}
            sidebarTab={sidebarTab}
            linkNav={linkNav}
            onSelectSessions={selectSessions}
            onSelectFolder={selectFolderTab}
            onCloseFolder={closeFolder}
            onToggleLink={() => setLinkNav((v) => !v)}
          />
          {sidebarTab.kind === "sessions" ? (
            <SessionSidebar
              sessions={summaries}
              activeId={activeId}
              pendingCounts={pendingPerSession}
              onSelect={(id) => setActiveId(id)}
              onDelete={deleteSession}
              onExport={exportRevision}
              onSelectRevision={(sessionId, versionNumber) => {
                // The sidebar fires this for the row click. The session it
                // points at might not be the active one yet — flip activeId
                // first so the pane mounts the right session before the
                // viewed-version applies.
                if (sessionId !== activeId) setActiveId(sessionId);
                setViewedVersionNumber(versionNumber);
              }}
              viewedVersionNumber={viewedVersionNumber}
            />
          ) : (
            <div className="flex-1 overflow-y-auto" style={{ background: "var(--color-paper)" }}>
              <FileTree
                root={sidebarTab.id}
                activeFile={activeFile}
                onOpenFile={handleOpenFile}
              />
            </div>
          )}
        </aside>
        )}
        <PaneDivider
          orientation="vertical"
          side="leading"
          label="sidebar"
          collapsed={sidebarCollapsed}
          dragging={sidebarDragging}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          onPointerDown={startSidebarDrag}
        />
        <div
          className="flex-1 overflow-hidden flex flex-col"
          style={{ background: "var(--color-paper)" }}
        >
          {sidebarTab.kind === "folder" && activeFile ? (
            <FileViewer path={activeFile} onClose={handleCloseFile} />
          ) : (
          <div className="flex-1 overflow-y-auto">
          <article
            ref={documentRef}
            className="doc-article mx-auto pl-16 pr-8 py-10"
            style={{ maxWidth: "820px" }}
          >
            {sidebarTab.kind === "folder" ? (
              <EmptyState
                title="Browsing files"
                body="Select a file from the tree to view it here."
              />
            ) : loading || (activeId && !sessionReady) ? (
              <EmptyState
                title="Loading…"
                body="Fetching the latest review session."
              />
            ) : sessionReady ? (
              isViewingHistorical && viewedRevision ? (
                <HistoricalRevisionView
                  versionNumber={viewedRevision.versionNumber}
                  latestVersionNumber={latest?.versionNumber ?? 0}
                  receivedAt={viewedRevision.receivedAt}
                  markdown={viewedRevision.rawPlanMarkdown}
                  onBackToLatest={() => setViewedVersionNumber(null)}
                />
              ) : (
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
              )
            ) : (
              <EmptyState
                title="No plans yet"
                body="Run Claude Code in plan mode in any project. When Claude calls ExitPlanMode, the plan will appear here."
              />
            )}
          </article>
          </div>
          )}
        </div>

        {!paneFullscreen && (
          <PaneDivider
            collapsed={paneCollapsed}
            dragging={isDragging}
            onToggle={() => setPaneCollapsed((c) => !c)}
            onPointerDown={startDrag}
          />
        )}

        {!paneCollapsed && (
        <aside
          ref={sidebarRef as React.RefObject<HTMLElement>}
          className={
            paneFullscreen
              ? "absolute inset-0 z-30 overflow-y-auto"
              : "overflow-y-auto border-l shrink-0"
          }
          style={
            paneFullscreen
              ? {
                  background: "var(--color-paper)",
                  borderColor: "var(--color-rule)",
                }
              : {
                  width: `${paneWidth}px`,
                  borderColor: "var(--color-rule)",
                  background: "var(--color-paper)",
                }
          }
        >
          {/* In fullscreen, mirror the terminal's overlay divider so the
              top-edge caret is the shrink-back affordance. */}
          {paneFullscreen && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 40,
              }}
            >
              <PaneDivider
                orientation="horizontal"
                label="comments"
                collapsed={false}
                dragging={false}
                onToggle={() => setPaneFullscreen(false)}
                onPointerDown={() => {}}
                fullscreen
                onExitFullscreen={() => setPaneFullscreen(false)}
              />
            </div>
          )}
          <div
            className="rl-chrome-label sticky top-0 z-10 px-4 py-2 border-b flex items-center justify-between"
            style={{
              borderColor: "var(--color-rule)",
              background: "var(--color-paper)",
            }}
          >
            <span>Discussion</span>
            <span className="flex items-center gap-2">
              {allComments.length > 0 && (
                <span
                  className="font-mono normal-case"
                  style={{
                    fontSize: "10px",
                    letterSpacing: "0.04em",
                    color: "var(--color-ink-muted)",
                    fontWeight: 500,
                  }}
                >
                  {pendingComments.length} pending · {allComments.length} total
                </span>
              )}
              <button
                type="button"
                onClick={() => setPaneFullscreen((f) => !f)}
                title={
                  paneFullscreen
                    ? "Restore comment pane"
                    : "Fullscreen comment pane"
                }
                aria-label={
                  paneFullscreen
                    ? "Restore comment pane"
                    : "Fullscreen comment pane"
                }
                className="flex items-center justify-center rounded"
                style={{
                  width: "20px",
                  height: "20px",
                  fontSize: "12px",
                  lineHeight: 1,
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-rule)",
                  color: "var(--color-ink-muted)",
                  cursor: "pointer",
                }}
              >
                {paneFullscreen ? "⤡" : "⤢"}
              </button>
            </span>
          </div>
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
            {detached && (
              <div
                role="alert"
                className="rounded p-3 text-sm flex items-start gap-2"
                style={{
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-warning, #b45309)",
                  color: "var(--color-ink)",
                }}
              >
                <span style={{ flex: 1 }}>
                  <strong>Claude is no longer waiting for this plan.</strong> The
                  review timed out (Redline holds a plan for up to 10 minutes) or
                  the Claude Code session ended. Re-run the plan in your terminal,
                  then submit your review again — your comments are preserved.
                </span>
                <button
                  type="button"
                  onClick={() => setDetached(false)}
                  aria-label="Dismiss"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--color-ink-muted)",
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            {composing && (
              <CommentComposer
                type={composing.type}
                anchorId={composing.anchorId}
                selectedText={composing.selectedText}
                charStart={composing.charStart}
                charEnd={composing.charEnd}
                subBlockId={composing.subBlockId}
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
            {/* Pin "Action items" (Claude's resolutions awaiting accept/
                reopen) at the top of the pane so the affordance is visible
                even when the "Claude is revising" banner sits above the
                regular cards. Clicking a pill focuses + scrolls to the card
                with the buttons. */}
            {(() => {
              const actionItems = allComments.filter(
                (c) => c.status === "resolved",
              );
              if (actionItems.length === 0) return null;
              return (
                <div
                  className="rounded-md border p-2"
                  style={{
                    borderColor: "var(--color-rule)",
                    background: "var(--color-bg-elevated)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "10px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--color-info)",
                      marginBottom: "6px",
                    }}
                  >
                    Action items · {actionItems.length}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {actionItems.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setFocusedCommentId(c.id)}
                        title={`Jump to ${c.id} — Accept or Reopen the resolution`}
                        className="font-mono rounded px-1.5 py-0.5"
                        style={{
                          background: "var(--color-anchor-bg)",
                          color: "var(--color-anchor-text)",
                          fontSize: "10px",
                          cursor: "pointer",
                        }}
                      >
                        {c.id}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
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
                submitInFlight={busy}
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
          {/* In fullscreen, an overlay divider at the top of the terminal
              gives the user the same top-edge caret they use to collapse
              the docked terminal — except here it exits fullscreen. */}
          {termFullscreen && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 40,
              }}
            >
              <PaneDivider
                orientation="horizontal"
                label="terminal"
                collapsed={false}
                dragging={false}
                onToggle={() => setTermFullscreen(false)}
                onPointerDown={() => {}}
                fullscreen
                onExitFullscreen={() => setTermFullscreen(false)}
              />
            </div>
          )}
          <TerminalTabs
            ref={terminalsRef}
            theme={theme}
            fullscreen={termFullscreen}
            onFullscreenChange={setTermFullscreen}
            onTabsChange={setTermTabCount}
            onActivityChange={setTermHasUnseen}
            collapsed={termFullscreen ? false : termCollapsed}
            onActiveTabChange={setActiveTermId}
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
      {selection && !composing && !isViewingHistorical && (
        <SelectionMenu rect={selection.rect} onPick={beginCompose} />
      )}
      {toast && <ApproveToast message={toast} />}
      {hookStatus &&
        skillStatus &&
        (!hookStatus.installed || !skillStatus.installed) && (
          <HookSetupModal
            hookStatus={hookStatus}
            skillStatus={skillStatus}
            onInstall={installIntegration}
            onSkip={() => {
              setHookStatus({ ...hookStatus, installed: true });
              setSkillStatus({
                ...skillStatus,
                installed: true,
                outdated: false,
              });
            }}
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

/** Read-only render of a prior revision plus a "back to latest" banner.
 *  Used when the reviewer clicks a historical revision in the sidebar to
 *  scroll back and compare against the current plan. Sidecar comments are
 *  stripped so the body reads as clean markdown. */
function HistoricalRevisionView({
  versionNumber,
  latestVersionNumber,
  receivedAt,
  markdown,
  onBackToLatest,
}: {
  versionNumber: number;
  latestVersionNumber: number;
  receivedAt: number;
  markdown: string;
  onBackToLatest: () => void;
}) {
  const clean = useMemo(() => stripSidecars(markdown).clean, [markdown]);
  const when = new Date(receivedAt).toLocaleString();
  return (
    <div>
      <div
        className="mb-4 flex items-center justify-between gap-3 rounded border px-3 py-2"
        style={{
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink-muted)",
          fontSize: "12px",
        }}
      >
        <span>
          Viewing{" "}
          <span
            className="font-mono"
            style={{ color: "var(--color-ink)", fontWeight: 600 }}
          >
            v{versionNumber}
          </span>{" "}
          · received {when} · read-only · latest is v{latestVersionNumber}
        </span>
        <button
          type="button"
          onClick={onBackToLatest}
          className="rounded px-2 py-0.5 font-medium"
          style={{
            background: "var(--color-paper)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          Back to latest
        </button>
      </div>
      <MarkdownView body={clean} />
    </div>
  );
}

/** Strip a single trailing slash so `/a/b/` and `/a/b` compare equal. */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

// Resolved once and cached — $HOME doesn't change over a session.
let homeDirCache: Promise<string | null> | null = null;
function getHomeDir(): Promise<string | null> {
  if (!homeDirCache) {
    homeDirCache = invoke<string | null>("home_dir")
      .then((d) => (d ? trimSlash(d) : null))
      .catch(() => null);
  }
  return homeDirCache;
}

/** A terminal's cwd that isn't worth surfacing as a project folder: the
 *  filesystem root, or $HOME (where new shells spawn by default). */
async function isUninterestingDir(dir: string): Promise<boolean> {
  const d = trimSlash(dir);
  if (d === "/") return true;
  const home = await getHomeDir();
  return home != null && d === home;
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
