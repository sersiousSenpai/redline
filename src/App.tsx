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
import { installExternalLinkHandler } from "./lib/externalLinks";
// Tiptap/ProseMirror is heavy; lazy-load so it's off the initial paint path.
const PlanEditor = lazy(() =>
  import("./components/PlanEditor").then((m) => ({ default: m.PlanEditor })),
);
import type { PlanEditorActions } from "./components/PlanEditor";
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
import { computeParagraphDiff, type ParagraphDiff } from "./diff";
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
  Revision,
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
  /** Preset value for the edit composer's "Revised" field. Empty string =
   *  a cross-out (delete the selected span); the composer opens ready to
   *  save the deletion. Undefined leaves the field defaulting to the
   *  selected text (a normal edit). */
  presetRevised?: string;
}

interface ResolutionWarning {
  parseError: string | null;
  unmatchedIds: string[];
  unresolvedSubmittedIds: string[];
}

// A backend error from approve_plan / submit_review meaning the held POST is
// gone (session ended or the hold timed out). Drives the detached banner so the
// buttons stop looking like silent no-ops.
function isDetachError(err: unknown): boolean {
  const msg = typeof err === "string" ? err : String(err);
  return (
    msg.includes("no longer waiting") ||
    msg.includes("no plan is currently waiting")
  );
}

// A round +/− control used by the floating document-zoom pill.
function ZoomButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: "22px",
        height: "22px",
        borderRadius: "50%",
        border: "1px solid var(--color-rule)",
        background: "var(--color-paper)",
        color: "var(--color-ink)",
        fontSize: "13px",
        lineHeight: 1,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {label}
    </button>
  );
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
  // Document zoom (content font-scale, not webview zoom). Persisted; clamped
  // 0.8–1.6. Driven by the in-pane control and Cmd +/-/0 shortcuts.
  const [docZoom, setDocZoom] = usePersistedState("redline.docZoom", 1);
  const clampZoom = (z: number) =>
    Math.min(1.6, Math.max(0.8, Math.round(z * 100) / 100));
  const zoomIn = () => setDocZoom((z) => clampZoom(z + 0.1));
  const zoomOut = () => setDocZoom((z) => clampZoom(z - 0.1));
  const zoomReset = () => setDocZoom(1);
  // The floating zoom control lives in the right gutter; it hides once the
  // (centered) text column grows wide enough to reach it, so it never sits on
  // top of the document text. Driven by the overlap effect below.
  const [zoomVisible, setZoomVisible] = useState(true);
  const zoomCtrlRef = useRef<HTMLDivElement | null>(null);
  // Cmd/Ctrl +/-/0 zoom the document. These combos aren't text input, so we
  // claim them globally (and preventDefault the browser's own page zoom).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setDocZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 100) / 100));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setDocZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 100) / 100));
      } else if (e.key === "0") {
        e.preventDefault();
        setDocZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDocZoom]);

  // Reveal the native window once the first themed frame has painted (the
  // window starts hidden), so launch never shows a flash of white. Two rAFs:
  // the first schedules after layout, the second after that frame commits.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void invoke("show_main_window").catch(() => {});
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
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
  // Per-terminal context: the folder this terminal lives in and the file last
  // viewed *from* it. Switching terminal tabs restores this instantly (no
  // 1.8s poll wait), so each terminal holds its own place even when several
  // share a project. Stale ids are harmless — activeTermId only ever points
  // at live tabs.
  const termCtxRef = useRef<
    Map<string, { folder: string | null; file: string | null }>
  >(new Map());
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
      // Track this terminal's own context. A `cd` to a different folder drops
      // its remembered file — the file belonged to the old project.
      const ctx = termCtxRef.current.get(termId);
      const file = ctx?.folder === dir ? (ctx?.file ?? null) : null;
      termCtxRef.current.set(termId, { folder: dir, file });
      // Terminal-aware activation: THIS terminal's remembered file wins over
      // the folder's shared memory. Going through activateFolder here would
      // clobber the per-terminal restore on every tab switch (the poll
      // restarts per terminal, so its first tick always lands here) — with
      // two terminals in one folder, both tabs would converge on whichever
      // file was opened last anywhere in that folder.
      if (linkNavRef.current) {
        selectFolder(dir);
        setActiveFile(file ?? folderFileRef.current.get(dir) ?? null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTermId, openFolder, selectFolder, setActiveFile]);

  // Opening/closing a file records it as the active folder's remembered file
  // (so the folder reopens on it) AND as the active terminal's remembered file
  // when that terminal lives in the folder (so switching terminals restores
  // each one's own place).
  const handleOpenFile = useCallback(
    (path: string) => {
      setActiveFile(path);
      if (sidebarTab.kind === "folder") {
        folderFileRef.current.set(sidebarTab.id, path);
        if (activeTermId) {
          const ctx = termCtxRef.current.get(activeTermId);
          if (ctx?.folder === sidebarTab.id) {
            termCtxRef.current.set(activeTermId, { ...ctx, file: path });
          }
        }
      }
    },
    [setActiveFile, sidebarTab, activeTermId],
  );
  const handleCloseFile = useCallback(() => {
    setActiveFile(null);
    if (sidebarTab.kind === "folder") {
      folderFileRef.current.set(sidebarTab.id, null);
      if (activeTermId) {
        const ctx = termCtxRef.current.get(activeTermId);
        if (ctx?.folder === sidebarTab.id) {
          termCtxRef.current.set(activeTermId, { ...ctx, file: null });
        }
      }
    }
  }, [setActiveFile, sidebarTab, activeTermId]);

  // Terminal tab switch → instantly restore that terminal's folder + file
  // (the poll above would catch up in ~1.8s; this makes it immediate).
  // Respects the linked-nav toggle exactly like the poll does, and falls back
  // to the folder's own memory when this terminal hasn't viewed a file yet.
  useEffect(() => {
    if (!activeTermId || !linkNavRef.current) return;
    const ctx = termCtxRef.current.get(activeTermId);
    if (!ctx?.folder) return;
    selectFolder(ctx.folder);
    setActiveFile(ctx.file ?? folderFileRef.current.get(ctx.folder) ?? null);
  }, [activeTermId, selectFolder, setActiveFile]);

  const documentRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  // When both side panes are dragged so wide that the document column is
  // squeezed to a sliver, the two dividers' chevrons collide. We replace them
  // with a single vertical "latch" (‹ above, › below) centered over the
  // vanished document; clicking either arrow snaps it back open.
  const docColumnRef = useRef<HTMLDivElement | null>(null);
  const [docObscured, setDocObscured] = useState(false);
  const [latchPos, setLatchPos] = useState({ left: 0, top: 0 });

  // Hide the floating zoom pill the moment the document text would reach it.
  // The article is centered with a max width, so on a wide pane there's an empty
  // right gutter to host the control; as the pane narrows the text column grows
  // toward the right edge — once its text (minus the article's right padding)
  // reaches the control's left edge, drop the control. Recomputed on any pane
  // resize via a ResizeObserver on the scroll container.
  useEffect(() => {
    const article = documentRef.current;
    const container = article?.parentElement ?? null;
    if (!article || !container) {
      setZoomVisible(false);
      return;
    }
    const recompute = () => {
      const a = article.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const controlW = zoomCtrlRef.current?.offsetWidth ?? 84;
      const controlLeft = c.right - 16 - controlW;
      // pr-8 (32px) of the article is empty padding, so the text ends short of
      // the article's right edge.
      const textRight = a.right - 32;
      setZoomVisible(textRight + 12 <= controlLeft);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [sidebarTab, activeFile, activeId]);

  // Track when the document column has been squeezed to a sliver so the latch
  // can replace the two colliding divider chevrons. Position is relative to the
  // positioned <main> ancestor (the document column's offsetParent).
  useEffect(() => {
    const el = docColumnRef.current;
    if (!el) return;
    const recompute = () => {
      const w = el.offsetWidth;
      setDocObscured(w < 56);
      // Center the latch over the vanished document, but keep it on-screen when
      // the document clamps against a window edge (one pane collapsed).
      const parent = el.offsetParent as HTMLElement | null;
      const maxLeft = (parent?.clientWidth ?? window.innerWidth) - 12;
      const rawLeft = el.offsetLeft + w / 2;
      setLatchPos({
        left: Math.min(maxLeft, Math.max(12, rawLeft)),
        top: el.offsetTop + el.offsetHeight / 2,
      });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sidebarWidth, paneWidth, sidebarCollapsed, paneCollapsed, paneFullscreen]);

  // The latch appears whenever the document has been clamped to a sliver —
  // whether between two open panes or against a collapsed pane's edge. Each
  // arrow reopens the document by shrinking whichever pane is actually open on
  // that side (falling back to the other side when one pane is collapsed).
  const latchActive = docObscured && !paneFullscreen;
  const reopenDocFromLeft = () => {
    if (!sidebarCollapsed) setSidebarWidth(180);
    else setPaneWidth(240);
  };
  const reopenDocFromRight = () => {
    if (!paneCollapsed) setPaneWidth(240);
    else setSidebarWidth(180);
  };

  // Bidirectional focus between in-doc highlights and sidebar cards. Single
  // source of truth: card click sets it; highlight click sets it; effects
  // mirror the change in each direction.
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  const onThemeChange = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
  };

  // Track the viewport width so each side pane's max can be "up to the other
  // pane" — letting EITHER pane be dragged until the document clamps fully shut,
  // symmetrically. (A fixed 320px reserve made this lopsided: one pane could
  // clamp the doc shut and the other couldn't.)
  const [winWidth, setWinWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Max width = whatever leaves the document at 0 against the *other* pane
  // (minus the two 6px dividers). Collapsed panes contribute 0.
  const sidebarMaxW = Math.max(
    180,
    winWidth - (paneCollapsed ? 0 : paneWidth) - 12,
  );
  const paneMaxW = Math.max(
    240,
    winWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 12,
  );

  const {
    isDragging: sidebarDragging,
    startDrag: startSidebarDrag,
    settling: sidebarSettling,
  } = useResizablePane({
    width: sidebarWidth,
    onWidthChange: setSidebarWidth,
    side: "leading",
    min: 180,
    max: sidebarMaxW,
    // Drag the document over the sidebar past its hard stop → snap it shut.
    onCollapse: () => setSidebarCollapsed(true),
    // Drag the divider of a collapsed sidebar to re-open it as a drawer.
    collapsed: sidebarCollapsed,
    onExpand: () => setSidebarCollapsed(false),
  });

  const {
    isDragging,
    startDrag,
    settling: paneSettling,
  } = useResizablePane({
    width: paneWidth,
    onWidthChange: setPaneWidth,
    max: paneMaxW,
    // Same for the comment pane on the right edge.
    onCollapse: () => setPaneCollapsed(true),
    collapsed: paneCollapsed,
    onExpand: () => setPaneCollapsed(false),
  });
  // Drawer-reveal geometry: the clip (outer) tracks the live width while the
  // content (inner aside) stays pinned at min so it's revealed, not reflowed.
  const revealSidebarW = Math.max(sidebarWidth, 180);
  const revealPaneW = Math.max(paneWidth, 240);

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
  // Imperative bridge to the lazily-mounted PlanEditor so the SelectionMenu's
  // Strike action can run an editor command without owning the editor.
  const planActionsRef = useRef<PlanEditorActions | null>(null);

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
    // Sweep the session's crash-recovery Y.Docs from IndexedDB. Dynamic
    // import: the yjs graph stays in the lazy PlanEditor chunk. Runs after
    // the active-session switch so PlanEditor has released its connection
    // and the deletes aren't left blocked.
    void import("./editor/yjs/planYDoc")
      .then((m) => m.clearStalePlanYDocs(id))
      .catch(() => {});
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

  // Route external links (markdown READMEs, comment panes, etc.) to the system
  // browser instead of letting them navigate — and replace — the webview.
  useEffect(() => installExternalLinkHandler(), []);

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
      void refreshSummaries().then(() => {
        // Bring the intercepted plan to the foreground no matter the current
        // view — browsing project files, sitting on another session, or no
        // session at all. The whole point of an intercept is to review the new
        // plan, so flip the sidebar back to Sessions and select it.
        selectSessions();
        setActiveId(payload.sessionId);
        // Land on the clean latest, even if the reviewer was parked on a
        // historical version when the revision arrived.
        setViewedVersionNumber(null);
        void loadSession(payload.sessionId);
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
  }, [activeId, selectSessions]);

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
  const sections = latest?.sections ?? [];
  // anchorId → stable blockId for the current revision. Selection-originated
  // comments only capture a positional anchorId; the in-doc highlight
  // decoration is keyed by blockId, so resolve it at submit time.
  const blockIdByAnchor = useMemo(
    () => blockIdByAnchorId(sections),
    [sections],
  );
  // Every comment in the current review thread — drives the footer counts,
  // waiting state, and action-items rail. The *pane and editor* scope tighter
  // (clean slate): see `paneComments` below.
  const threadComments = useMemo<Comment[]>(
    () => threadRevisions.flatMap((r) => r.comments),
    [threadRevisions],
  );
  // Clean slate: a new revision arrives with zero highlights and an empty
  // comment pane. The pane shows only the comments that live on the revision
  // being displayed; prior rounds (and their resolution cards) are reviewed
  // on the previous version via the revisions navigator.
  const latestComments = useMemo<Comment[]>(
    () => latest?.comments ?? [],
    [latest],
  );
  const paneComments =
    isViewingHistorical && viewedRevision
      ? viewedRevision.comments
      : latestComments;
  // Own-era diff for a viewed historical revision: what changed when *it*
  // arrived, i.e. against its predecessor in the session. Thread starts diff
  // against nothing (a fresh plan has no meaningful redline).
  const historicalDiff = useMemo(() => {
    if (!session || !viewedRevision || viewedRevision.threadStart) {
      return undefined;
    }
    const revs = session.revisions;
    const idx = revs.findIndex(
      (r) => r.versionNumber === viewedRevision.versionNumber,
    );
    const prev = idx > 0 ? revs[idx - 1] : undefined;
    return computeParagraphDiff(viewedRevision.sections, prev?.sections);
  }, [session, viewedRevision]);
  // commentId → the revision it lives on, so action-item pills can navigate
  // to the right version before focusing the card.
  const commentVersionById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of threadRevisions) {
      for (const c of r.comments) m.set(c.id, r.versionNumber);
    }
    return m;
  }, [threadRevisions]);

  const pendingComments = useMemo(
    () =>
      threadComments.filter(
        (c) => c.status === "draft" || c.status === "reopened",
      ),
    [threadComments],
  );
  const submittedComments = threadComments.filter(
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
  // in-flight batch is all non-actionable questions, Claude is answering,
  // not revising (a promoted question flips the batch to Revise).
  const waitingAsk =
    waiting &&
    submittedComments.every((c) => c.type === "question" && !c.actionable);
  // The active session's plan is currently held (Claude Code blocked in its
  // terminal awaiting review) — drives the in-dock "plan intercepted" strip.
  // `summaries` refreshes on plan-received / status / comment events, so the
  // strip tracks hold and release without its own wiring.
  const activeHeld =
    summaries.find((s) => s.sessionId === activeId)?.held ?? false;
  // A detached plan is no longer held by Claude — Approve / Continue Revising
  // would no-op against a dead channel, so disable them until the session is
  // restored (which clears `detached` on the next plan-received POST).
  const canSubmit = pendingComments.length > 0 && !detached;
  const canApprove = !!session && session.status !== "approved" && !detached;

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
    // The composer lives in the comment pane — make sure it's open, or the
    // action appears to do nothing when the pane is collapsed.
    setPaneCollapsed(false);
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

  // Cross out the selection: strike it in place exactly like the Delete key
  // (Word-style `rl_del` track change), driven through the editor's
  // `strikeSelection` command. The struck text round-trips through the
  // accept-all serializer as an [edit] with the span deleted — same outcome
  // as before, but the user sees an immediate strikethrough instead of a
  // composer with an empty field.
  const beginCrossOut = () => {
    if (!selection) return;
    // Reveal the pane so the resulting struck-edit card is visible.
    setPaneCollapsed(false);
    planActionsRef.current?.strikeSelection();
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
      if (isDetachError(err)) setDetached(true);
      else alert(`Submit failed: ${err}`);
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
      if (isDetachError(err)) setDetached(true);
      else alert(`Approve failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  // One-click recovery for a detached plan: open a terminal in the session's
  // project dir and resume the exact Claude Code conversation with an initial,
  // user-attested prompt that re-presents the plan. Because the resumed session
  // keeps the same session_id, its ExitPlanMode POST reattaches to this review —
  // comments, revisions and reopen history intact (no phantom new review).
  const restorePlanSession = () => {
    if (!session) return;
    const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const prompt =
      "The reviewer reopened this plan in Redline for continued review. " +
      "Please re-enter plan mode and call ExitPlanMode to re-present your " +
      "current plan for review (no changes needed unless you have them).";
    const cmd = `claude --resume ${shq(session.sessionId)} ${shq(prompt)}\r`;
    const cwd = session.projectPath || null;
    // Arm a one-shot restore so the resumed session's re-presented plan is
    // labeled "vN restored" rather than counted as a fresh version/thread.
    void invoke("arm_restore", { sessionId: session.sessionId });
    setTermFullscreen(false);
    setTermCollapsed(false);
    const id = terminalsRef.current?.openSessionTerminal(cwd) ?? null;
    if (id) {
      // Let the freshly-spawned shell finish its rc files before the command
      // lands; the PTY line-buffers anything typed earlier regardless.
      window.setTimeout(() => {
        void invoke("pty_write", { id, data: cmd });
      }, 900);
    }
    setDetached(false);
    setToast("Resuming the session in the terminal below ↓");
    setTimeout(() => setToast(null), 4000);
  };

  // Fallback for a Claude running in a terminal Redline doesn't own: copy the
  // resume command so the user can paste it into their own terminal.
  const copyRestoreCommand = () => {
    if (!session) return;
    const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const prompt =
      "The reviewer reopened this plan in Redline for continued review. " +
      "Please re-enter plan mode and call ExitPlanMode to re-present your " +
      "current plan for review (no changes needed unless you have them).";
    const cmd = `claude --resume ${shq(session.sessionId)} ${shq(prompt)}`;
    // Same one-shot restore arming as restorePlanSession — the resumed plan,
    // whichever terminal runs it, should land as "vN restored".
    void invoke("arm_restore", { sessionId: session.sessionId });
    void navigator.clipboard?.writeText(cmd);
    setToast("Resume command copied — paste it into your terminal");
    setTimeout(() => setToast(null), 4000);
  };

  // Local date/time stamp embedded in export file names.
  const exportStamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  };

  const toastSaved = (saved: string | null) => {
    if (!saved) return; // user cancelled the dialog
    const name = saved.split(/[\\/]/).pop() ?? saved;
    setToast(`Saved ${name}`);
    setTimeout(() => setToast(null), 3500);
  };

  // Save one plan revision as a clean .md file (sidecars stripped) through a
  // native save dialog. A resolved `null` means the user cancelled the dialog.
  const exportRevision = async (sessionId: string, versionNumber: number) => {
    try {
      const saved = await invoke<string | null>("export_revision_markdown", {
        sessionId,
        versionNumber,
        stamp: exportStamp(),
      });
      toastSaved(saved);
    } catch (err) {
      console.error("export_revision_markdown failed", err);
      alert(`Export failed: ${err}`);
    }
  };

  // Save one plan revision as a Word file. The bytes are built in the
  // frontend by the docx export adapter (dynamic import keeps the OOXML
  // writer off the initial paint path); the Rust command owns the save
  // dialog and the write, mirroring the markdown path.
  const exportRevisionDocx = async (sessionId: string, versionNumber: number) => {
    try {
      const s =
        session?.sessionId === sessionId
          ? session
          : await invoke<ReviewSession | null>("get_session", { id: sessionId });
      const revision = s?.revisions.find(
        (r) => r.versionNumber === versionNumber,
      );
      if (!revision) throw new Error(`revision v${versionNumber} not found`);
      const [{ docxAdapter }, { planMarkdownToDoc }, { anchorByBlockId }] =
        await Promise.all([
          import("./editor/adapters/docx/exporter"),
          import("./editor/markdown"),
          import("./editor/docModel"),
        ]);
      const bytes = (await docxAdapter.export({
        doc: planMarkdownToDoc(revision.rawPlanMarkdown),
        anchors: anchorByBlockId(revision.sections),
        comments: revision.comments,
      })) as Uint8Array;
      const saved = await invoke<string | null>("export_revision_docx", {
        sessionId,
        versionNumber,
        stamp: exportStamp(),
        bytes: Array.from(bytes),
      });
      toastSaved(saved);
    } catch (err) {
      console.error("export_revision_docx failed", err);
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

  const reopenResolution = async (commentId: string, note?: string) => {
    if (!session) return;
    try {
      await invoke("reopen_resolution", {
        sessionId: session.sessionId,
        commentId,
        note: note ?? null,
      });
    } catch (err) {
      console.error("reopen_resolution failed", err);
    }
  };

  // Promote a question into a plan-driving directive ("Make this a change").
  // Routes through the same reopen path with as_change set, so the comment
  // re-enters the next Revise as a [decision] Claude must apply.
  const promoteToChange = async (commentId: string, directive: string) => {
    if (!session) return;
    try {
      await invoke("reopen_resolution", {
        sessionId: session.sessionId,
        commentId,
        note: directive,
        asChange: true,
      });
    } catch (err) {
      console.error("promote-to-change failed", err);
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
        onExportDocx={exportRevisionDocx}
        viewedVersionNumber={viewedVersionNumber}
        downloadDisabled={sidebarTab.kind === "folder"}
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
        <div
          className="shrink-0"
          style={{
            width: `${sidebarWidth}px`,
            overflow: "hidden",
            display: "flex",
            justifyContent: "flex-start",
            transition: sidebarSettling ? "width 160ms ease" : undefined,
          }}
        >
        <aside
          className="flex flex-col shrink-0"
          style={{ width: `${revealSidebarW}px` }}
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
        </div>
        )}
        <PaneDivider
          orientation="vertical"
          side="leading"
          label="sidebar"
          collapsed={sidebarCollapsed}
          dragging={sidebarDragging}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          onPointerDown={startSidebarDrag}
          hideChevron={latchActive}
        />
        <div
          ref={docColumnRef}
          className="flex-1 overflow-hidden flex flex-col relative"
          style={{ background: "var(--color-paper)" }}
        >
          {sidebarTab.kind === "folder" && activeFile ? (
            <FileViewer path={activeFile} onClose={handleCloseFile} />
          ) : (
          <div className="rl-thin-scroll-y flex-1 overflow-y-auto">
          <article
            ref={documentRef}
            className="doc-article mx-auto pl-16 pr-8 py-10"
            style={
              {
                maxWidth: "820px",
                "--rl-doc-zoom": docZoom,
              } as React.CSSProperties
            }
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
                  sessionId={activeId ?? ""}
                  revision={viewedRevision}
                  diff={historicalDiff}
                  latestVersionNumber={latest?.versionNumber ?? 0}
                  focusedCommentId={focusedCommentId}
                  onHighlightClick={(id) => setFocusedCommentId(id)}
                  onBackToLatest={() => setViewedVersionNumber(null)}
                />
              ) : (
                <Suspense fallback={null}>
                  {/* Clean slate: the latest revision renders with no diff
                      highlights and only its own comments — prior rounds live
                      on the previous version (revisions navigator). */}
                  <PlanEditor
                    markdown={latest?.rawPlanMarkdown ?? ""}
                    sections={sections}
                    comments={latestComments}
                    revisionKey={`${activeId ?? ""}:${
                      threadRevisions[0]?.versionNumber ?? 0
                    }:${latest?.versionNumber ?? 0}`}
                    sessionId={activeId ?? undefined}
                    onAddComment={addEditorComment}
                    onUpdateComment={updateComment}
                    onDeleteComment={deleteComment}
                    focusedCommentId={focusedCommentId}
                    onHighlightClick={(id) => setFocusedCommentId(id)}
                    actionsRef={planActionsRef}
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
          {/* Floating document-zoom control — pinned to the pane (doesn't scroll
              with the plan). Hidden over the folder file viewer. */}
          {!(sidebarTab.kind === "folder" && activeFile) && zoomVisible && (
            <div
              ref={zoomCtrlRef}
              className="absolute flex items-center gap-1 rounded-full"
              style={{
                right: "16px",
                bottom: "16px",
                padding: "3px",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                opacity: 0.92,
              }}
            >
              <ZoomButton label="−" title="Zoom out (⌘−)" onClick={zoomOut} />
              <button
                type="button"
                onClick={zoomReset}
                title="Reset zoom (⌘0)"
                className="font-mono"
                style={{
                  fontSize: "10px",
                  minWidth: "34px",
                  color: "var(--color-ink-muted)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {Math.round(docZoom * 100)}%
              </button>
              <ZoomButton label="+" title="Zoom in (⌘+)" onClick={zoomIn} />
            </div>
          )}
        </div>

        {!paneFullscreen && (
          <PaneDivider
            collapsed={paneCollapsed}
            dragging={isDragging}
            onToggle={() => setPaneCollapsed((c) => !c)}
            onPointerDown={startDrag}
            hideChevron={latchActive}
          />
        )}

        {/* The latch: when the document is squeezed shut, the two dividers'
            chevrons would collide, so replace them with a single stacked pair
            centered over the vanished document. ‹ reopens from the left
            (sidebar), › from the right (comment pane). */}
        {latchActive && (
          <div
            className="absolute z-30 flex flex-col rounded-full overflow-hidden shadow-sm"
            style={{
              left: `${latchPos.left}px`,
              top: `${latchPos.top}px`,
              transform: "translate(-50%, -50%)",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
            }}
          >
            <button
              type="button"
              onClick={reopenDocFromLeft}
              title="Reopen document (shrink sessions)"
              aria-label="Reopen document from the left"
              className="flex items-center justify-center"
              style={{
                width: "18px",
                height: "26px",
                fontSize: "11px",
                lineHeight: 1,
                background: "transparent",
                color: "var(--color-ink-muted)",
                border: "none",
                borderBottom: "1px solid var(--color-rule)",
                cursor: "pointer",
              }}
            >
              ‹
            </button>
            <button
              type="button"
              onClick={reopenDocFromRight}
              title="Reopen document (shrink discussion)"
              aria-label="Reopen document from the right"
              className="flex items-center justify-center"
              style={{
                width: "18px",
                height: "26px",
                fontSize: "11px",
                lineHeight: 1,
                background: "transparent",
                color: "var(--color-ink-muted)",
                border: "none",
                cursor: "pointer",
              }}
            >
              ›
            </button>
          </div>
        )}

        {!paneCollapsed && (
        // Clip wrapper for the drawer reveal. In fullscreen it's display:contents
        // (no box) so the absolute overlay aside is unaffected; otherwise it's a
        // flex clip whose width tracks the live pane width while the aside inside
        // stays pinned at min and is revealed from the right.
        <div
          style={
            paneFullscreen
              ? { display: "contents" }
              : {
                  width: `${paneWidth}px`,
                  overflow: "hidden",
                  display: "flex",
                  justifyContent: "flex-end",
                  flexShrink: 0,
                  transition: paneSettling ? "width 160ms ease" : undefined,
                }
          }
        >
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
                  width: `${revealPaneW}px`,
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
              {/* Secondary count: keep it on one line, and drop it entirely when
                  the pane is too narrow to hold it (otherwise it wraps and looks
                  squished under "DISCUSSION"). */}
              {sidebarTab.kind === "sessions" &&
                paneComments.length > 0 &&
                (paneFullscreen || paneWidth >= 340) && (
                  <span
                    className="font-mono normal-case"
                    style={{
                      fontSize: "10px",
                      letterSpacing: "0.04em",
                      color: "var(--color-ink-muted)",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pendingComments.length} pending · {paneComments.length}{" "}
                    {isViewingHistorical ? "on this version" : "total"}
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
            {/* The discussion pane is scoped to the active sidebar context:
                in a folder tab it must not leak the previously-focused
                session's comments. */}
            {sidebarTab.kind !== "sessions" ? (
              <div
                className="italic"
                style={{
                  fontSize: "12px",
                  color: "var(--color-ink-muted)",
                  lineHeight: 1.5,
                }}
              >
                Comments belong to a plan session. Switch to{" "}
                <strong style={{ color: "var(--color-ink)" }}>Sessions</strong>{" "}
                to see a plan's discussion.
              </div>
            ) : (
              <>
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
                  Claude Code session ended (or the hold timed out). Your comments
                  are preserved — <strong>Restore plan session</strong> reopens the
                  same conversation in a terminal and re-presents the plan for
                  review.
                  <span
                    className="flex flex-wrap gap-2"
                    style={{ marginTop: "8px" }}
                  >
                    <button
                      type="button"
                      onClick={restorePlanSession}
                      className="rounded px-2 py-1"
                      style={{
                        background: "var(--color-anchor-bg)",
                        color: "var(--color-anchor-text)",
                        border: "1px solid var(--color-rule)",
                        cursor: "pointer",
                        fontSize: "12px",
                        fontWeight: 600,
                      }}
                    >
                      Restore plan session
                    </button>
                    <button
                      type="button"
                      onClick={copyRestoreCommand}
                      title="For a Claude running in a terminal Redline doesn't own — copy the resume command to paste yourself."
                      className="rounded px-2 py-1"
                      style={{
                        background: "transparent",
                        color: "var(--color-ink-muted)",
                        border: "1px solid var(--color-rule)",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      Copy resume command
                    </button>
                  </span>
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
                presetRevised={composing.presetRevised}
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
                  ? "Questions sent. Claude is answering in the background — "
                  : "Feedback sent. Claude is revising in the background — "}
                <button
                  type="button"
                  onClick={() => setTermCollapsed(false)}
                  style={{
                    color: "var(--color-ink)",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  open the terminal to watch
                </button>
              </div>
            )}
            {paneComments.length === 0 &&
              !composing &&
              (() => {
                // Clean slate: the new revision's pane starts empty. If the
                // prior round's discussions live on an earlier version, point
                // there instead of pretending nothing happened.
                const prior = !isViewingHistorical
                  ? [...threadRevisions]
                      .reverse()
                      .find(
                        (r) =>
                          r.versionNumber !== latest?.versionNumber &&
                          r.comments.length > 0,
                      )
                  : undefined;
                if (prior) {
                  return (
                    <div
                      className="rounded-md border p-3"
                      style={{
                        borderColor: "var(--color-rule)",
                        background: "var(--color-bg-elevated)",
                        fontSize: "12px",
                        color: "var(--color-ink-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      Comments and resolutions from v{prior.versionNumber} live
                      on that version —{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setViewedVersionNumber(prior.versionNumber)
                        }
                        style={{
                          color: "var(--color-ink)",
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        review them →
                      </button>
                    </div>
                  );
                }
                return (
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
                );
              })()}
            {/* Pin "Action items" (Claude's resolutions awaiting accept/
                reopen) at the top of the pane so the affordance is visible
                even when the "Claude is revising" banner sits above the
                regular cards. Clicking a pill focuses + scrolls to the card
                with the buttons. */}
            {(() => {
              const actionItems = threadComments.filter(
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
                        onClick={() => {
                          // Clean slate: the card may live on an earlier
                          // version — navigate there before focusing it.
                          const v = commentVersionById.get(c.id);
                          if (v !== undefined) {
                            setViewedVersionNumber(
                              v === latest?.versionNumber ? null : v,
                            );
                          }
                          setFocusedCommentId(c.id);
                        }}
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
            {paneComments.map((c) => (
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
                onReopen={(note) => reopenResolution(c.id, note)}
                onPromote={(directive) => promoteToChange(c.id, directive)}
                submitInFlight={busy}
              />
            ))}
              </>
            )}
          </div>
        </aside>
        </div>
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
              : "relative shrink-0 overflow-hidden"
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
          {/* Since text can't be injected into the held PTY, fake one line of
              terminal output: a strip pinned to the dock's bottom edge,
              terminal bg + mono font + matching padding so it sits on the
              glyph grid and reads as native output. Click-through so the
              shell underneath stays usable. */}
          {activeHeld && (!termCollapsed || termFullscreen) && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 20,
                pointerEvents: "none",
                background: "var(--color-paper)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: "18px",
                padding: "2px 8px",
                color: "#e8553d",
                whiteSpace: "pre",
                overflow: "hidden",
              }}
            >
              {"── plan intercepted by redline ──"}
            </div>
          )}
        </div>
      </main>
      <Footer
        comments={threadComments}
        canSubmit={canSubmit}
        canApprove={canApprove}
        waiting={waiting}
        waitingAsk={waitingAsk}
        onSubmit={submitReview}
        onApprove={approvePlan}
        termCollapsed={termCollapsed && !termFullscreen}
        termTabCount={termTabCount}
        termHasUnseen={termHasUnseen}
        onExpandTerminal={() => setTermCollapsed(false)}
      />
      {selection && !composing && !isViewingHistorical && (
        <SelectionMenu
          rect={selection.rect}
          onPick={beginCompose}
          onCrossOut={beginCrossOut}
        />
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
/** A previous revision, rendered with the same Tiptap editor as the latest so
 *  formatting matches — read-only (no comment handlers ⇒ `editable: false`)
 *  with that revision's own-era diff highlights and comment cards alive in
 *  the pane (Accept/Reopen work from here; the store mutators search every
 *  revision). Known limitation: the reviewer's live-era ins/del marks aren't
 *  replayed — they were serialized into [edit] comments at submit, and those
 *  cards represent them. */
function HistoricalRevisionView({
  sessionId,
  revision,
  diff,
  latestVersionNumber,
  focusedCommentId,
  onHighlightClick,
  onBackToLatest,
}: {
  sessionId: string;
  revision: Revision;
  diff?: ParagraphDiff;
  latestVersionNumber: number;
  focusedCommentId: string | null;
  onHighlightClick: (commentId: string) => void;
  onBackToLatest: () => void;
}) {
  const when = new Date(revision.receivedAt).toLocaleString();
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
            v{revision.versionNumber}
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
      <Suspense fallback={null}>
        {/* `sessionId` deliberately omitted: the historical doc is in-memory
            only — no IndexedDB persistence for a read-only view. The `hist`
            revisionKey namespace can never collide with the live editor's. */}
        <PlanEditor
          markdown={revision.rawPlanMarkdown}
          sections={revision.sections}
          diff={diff}
          comments={revision.comments}
          revisionKey={`${sessionId}:hist:${revision.versionNumber}`}
          focusedCommentId={focusedCommentId}
          onHighlightClick={onHighlightClick}
        />
      </Suspense>
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
