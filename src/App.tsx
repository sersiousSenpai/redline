// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ApproveToast } from "./components/ApproveToast";
import { CommentCard } from "./components/CommentCard";
import { CommentComposer } from "./components/CommentComposer";
import { DiscussionZoomContext } from "./components/DiscussionViewContext";
import { lazy, Suspense } from "react";
import { installExternalLinkHandler } from "./lib/externalLinks";
import { isClaudeWorking } from "./lib/claudeWorking";
// Tiptap/ProseMirror is heavy; lazy-load so it's off the initial paint path.
const PlanEditor = lazy(() =>
  import("./components/PlanEditor").then((m) => ({ default: m.PlanEditor })),
);
import type { PlanEditorActions } from "./components/PlanEditor";
import type { PlanEditorCollab } from "./components/PlanEditor";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { InviteDialog } from "./components/InviteDialog";
import { JoinDialog } from "./components/JoinDialog";
import { ShareSnapshotDialog } from "./components/ShareSnapshotDialog";
import { importSharedPlanFromUrl } from "./collab/importSharedLink";
import { deriveActiveSurface } from "./lib/activeSurface";
import { CompanionDrawer } from "./components/CompanionDrawer";
import { useCompanion } from "./hooks/useCompanion";
import { PresenceBar } from "./components/PresenceBar";
import {
  collabRevisionKey,
  collabRoomBase,
  encodeJoinCode,
  presenceColor,
  randomToken,
  type CollabConfig,
} from "./collab/collabConfig";
import type { CollabProviderHandle } from "./collab/provider";
import { useCommentMirror } from "./collab/useCommentMirror";
import { createYjsCommentBackend } from "./collab/yjsCommentBackend";
import { observeMeta, publishMeta, readMeta } from "./collab/meta";
import {
  connectRoomAccess,
  hashToken,
  openEnvelope,
  sealEnvelope,
  type RoomAccess,
} from "./collab/access";
import { activeLiveRequests } from "./collab/reviewRequest";
import { useReviewRequests } from "./collab/useReviewRequests";
import {
  isJoinedSessionId,
  joinedSessionKey,
  useJoinedSession,
} from "./collab/useJoinedSession";
import { HookSetupModal } from "./components/HookSetupModal";
import { HowItWorksCard } from "./components/HowItWorksCard";
import { ReadmeModal } from "./components/ReadmeModal";
import { FeedbackModal } from "./components/FeedbackModal";
import { OnboardingTour } from "./components/OnboardingTour";
import { AskModeViolationBanner } from "./components/AskModeViolationBanner";
import { ResolutionWarningBanner } from "./components/ResolutionWarningBanner";
import { SelectionMenu } from "./components/SelectionMenu";
import { SessionSidebar } from "./components/SessionSidebar";
import { SidebarTabStrip } from "./components/SidebarTabStrip";
import { PlanToc } from "./components/PlanToc";
import { FileTree } from "./components/FileTree";
import { FileViewer } from "./components/FileViewer";
import { BrowserPane } from "./components/BrowserPane";
import { MenuOverlayProvider } from "./components/menuOverlay";
import { SplitPane } from "./components/SplitPane";
import { PromptDrafter } from "./components/PromptDrafter";
import ReviewPanel from "./components/ReviewPanel";
import { MemoryInspector } from "./components/MemoryInspector";
import ReviewDiscussionPane from "./components/ReviewDiscussionPane";
import { useReview } from "./hooks/useReview";
import {
  effectiveDiscussionContext,
  type DiscussionContext,
} from "./lib/discussionContext";
import { VoicePanel } from "./components/VoicePanel";
import type { ProjectOption } from "./components/ProjectPicker";
import { useFolderWorkspaces } from "./hooks/useFolderWorkspaces";
import { computeParagraphDiff, type ParagraphDiff } from "./diff";
import { blockIdByAnchorId } from "./editor/docModel";
import { useTextSelection } from "./hooks/useTextSelection";
import {
  applyFont,
  applyLint,
  applyTheme,
  hasStoredFont,
  hasStoredLint,
  readStoredFont,
  readStoredLint,
  readStoredTheme,
  storeFont,
  storeLint,
  storeTheme,
} from "./theme/applyTheme";
import type { ThemeName } from "./theme/themes";
import { SUGGESTED_FONT_FOR_THEME } from "./theme/fonts";
import type { LintName } from "./theme/lint";
import { SUGGESTED_LINT_FOR_THEME } from "./theme/lint";
import type { FontName } from "./theme/fonts";
import { usePersistedState } from "./theme/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { useAutoExitFullscreen } from "./hooks/useAutoExitFullscreen";
import { PaneDivider } from "./components/PaneDivider";
import { TerminalTabs } from "./components/TerminalTabs";
import type { TerminalTabsHandle } from "./components/TerminalTabs";
import { DecisionWindowBanner } from "./components/DecisionWindowBanner";
import { FlashOverlay } from "./components/FlashOverlay";
import { playInterceptBeep, DEFAULT_SOUND } from "./audio/beep";
import { buildResumeCommand } from "./lib/resumeCommand";
import { computePaneLayout } from "./lib/paneLayout";
import { buildPlanLaunchCommand } from "./lib/planLaunchCommand";
import { guessProjectForPlan } from "./lib/guessProject";
import { SendToRedlineDialog } from "./components/SendToRedlineDialog";
import type { JSONContent } from "@tiptap/react";
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
  Section,
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
  // Count of open header dropdowns (theme, mode, alerts, download). Folded into
  // `browserVisible` below so the native browser webview hides while a menu is
  // up — otherwise the OS-composited webview paints over the DOM menu. Header
  // dropdowns register via the MenuOverlayProvider / useMenuOverlay context.
  const [openMenuCount, setOpenMenuCount] = useState(0);
  const adjustMenuOverlay = useCallback(
    (delta: number) => setOpenMenuCount((c) => Math.max(0, c + delta)),
    [],
  );
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState<ComposingState | null>(null);
  const [busy, setBusy] = useState(false);
  // Session ids with a submit in flight: added on a successful submit, removed
  // by that session's next plan-received (or detach) event. Keeps the
  // submit/approve buttons disabled across the brief gap where the new plan's
  // sender hasn't yet been registered — otherwise the user can re-fire submit
  // and silently drop feedback (bug #5). Per-session so the lock survives
  // sidebar switches and clears even when the plan lands while another
  // session is in the foreground.
  const [awaitingSessions, setAwaitingSessions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  // The detached banner's manual dismiss. The detached state itself is
  // derived from the active session's persisted `attachState` (see below) so
  // it survives app restarts and background-session detaches; this flag only
  // hides the banner until the next session switch / plan arrival.
  const [detachDismissed, setDetachDismissed] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [skillStatus, setSkillStatus] = useState<SkillStatus | null>(null);
  // First-run setup modal: "setup" until an in-app install fully succeeds,
  // then "done" shows the one-time what-now explainer until dismissed.
  const [setupPhase, setSetupPhase] = useState<"setup" | "done">("setup");
  const [installError, setInstallError] = useState<string | null>(null);
  const [mode, setMode] = useState<InterceptionMode>("active");
  const [decisionWindow, setDecisionWindow] =
    useState<PlanDecisionWindowEvent | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  const [font, setFont] = useState<FontName>(() => readStoredFont());
  const [lint, setLint] = useState<LintName>(() => readStoredLint());
  // Flash-on-intercept alert: an opt-in full-window pulse (+ optional beep)
  // fired whenever a plan is intercepted. `flashSeq` bumps to (re)trigger the
  // overlay; the three prefs persist via localStorage.
  // Table-of-contents rail (Phase 2): a collapsible outline of the current
  // plan's headings, docked to the left of the document column. Persisted so a
  // reader's preference sticks across sessions.
  const [tocOpen, setTocOpen] = usePersistedState("redline.tocOpen", true);
  // The "How Redline works" explainer (Phase 3) — opened from the empty state
  // and the post-install screen; purely informational.
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
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
  // Which artifact the Discussion sidecar pertains to (plan comments vs the
  // code review's annotations/questions). Only consulted in a true split —
  // see `effectiveDiscussionContext`.
  const [discussionPinned, setDiscussionPinned] =
    usePersistedState<DiscussionContext>("redline.discussion.context", "plan");
  // The center pane hosts two independently-toggleable views: the document
  // (editor/plan) and the embedded browser. Each has a toolbar toggle. When
  // both are on, they share the pane as a foldable split (see SplitPane);
  // `splitVertical` flips between side-by-side (default) and stacked, and
  // `splitRatio` is the document's share. `splitDragging` hides the native
  // webview during a split-divider drag so it doesn't swallow the pointer.
  // `docOpen` only matters while the browser is open: it adds the document to a
  // split alongside the browser. With the browser closed, the document is the
  // default full view regardless. So the document toolbar toggle is shown only
  // when the browser is open.
  const [docOpen, setDocOpen] = usePersistedState("redline.doc.open", false);
  const [browserOpen, setBrowserOpen] = usePersistedState(
    "redline.browser.open",
    false,
  );
  const [splitVertical, setSplitVertical] = usePersistedState(
    "redline.split.vertical",
    false,
  );
  const [splitRatio, setSplitRatio] = usePersistedState(
    "redline.split.ratio",
    0.5,
  );
  const [splitDragging, setSplitDragging] = useState(false);
  // The Prompt Drafter — a Word-style authoring surface that takes over the
  // center pane (mutually exclusive with the browser). Its draft (Tiptap JSON)
  // and the project it launches into persist across reloads.
  const [drafterOpen, setDrafterOpen] = usePersistedState(
    "redline.drafter.open",
    false,
  );
  // The voice agent — a drawer docked to the plan pane that reads the plan
  // aloud or discusses it (spoken) via the warm Claude session. Kept on the
  // plan surface (not the Header) so it reads as a plan feature.
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [drafterDoc, setDrafterDoc] = usePersistedState<JSONContent | null>(
    "redline.drafter.doc",
    null,
  );
  const [drafterProject, setDrafterProject] = usePersistedState<string | null>(
    "redline.drafter.project",
    null,
  );
  // The draft's durable identity — keys its discussion agent, comments, voice
  // memory, and its lineage in the memory lake. "New draft" mints a fresh id;
  // old rows stay queryable as history.
  const [drafterDraftId, setDrafterDraftId] = usePersistedState<string | null>(
    "redline.drafter.draftId",
    null,
  );
  useEffect(() => {
    if (!drafterDraftId) setDrafterDraftId(crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafterDraftId]);
  // The drafter's 💬 discussion pane (internal split inside the drafter).
  const [drafterChatOpen, setDrafterChatOpen] = usePersistedState(
    "redline.drafter.chatOpen",
    false,
  );
  // The drafter's 🎙️ voice drawer + what it's primed with: the latest mirrored
  // markdown and its parsed Section tree (for the Guided Walkthrough).
  const [drafterVoiceOpen, setDrafterVoiceOpen] = useState(false);
  const [drafterMarkdown, setDrafterMarkdown] = useState("");
  const [drafterSections, setDrafterSections] = useState<Section[]>([]);
  // Flush the draft's markdown mirror (sidecars on) to the backend `drafts`
  // table so the agents' /v1/drafter/:id/doc reads are never stale.
  const drafterMarkdownChange = useCallback(
    (markdown: string) => {
      setDrafterMarkdown(markdown);
      if (!drafterDraftId) return;
      void invoke("drafter_set_doc", {
        draftId: drafterDraftId,
        markdown,
        projectPath: drafterProject,
      }).catch(() => {});
    },
    [drafterDraftId, drafterProject],
  );
  // Sections for the drafter voice walkthrough — parsed backend-side from the
  // mirrored markdown, only while the voice drawer is open.
  useEffect(() => {
    if (!drafterVoiceOpen) return;
    let alive = true;
    void invoke<Section[]>("parse_markdown_sections", {
      markdown: drafterMarkdown,
    })
      .then((s) => alive && setDrafterSections(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [drafterVoiceOpen, drafterMarkdown]);
  // A plan sent from the browser page-discussion agent, held for a repo-confirm
  // step (SendToRedlineDialog) before it launches into a terminal — so it never
  // silently lands in $HOME.
  const [sendConfirm, setSendConfirm] = useState<{
    markdown: string;
    initialProject: string | null;
  } | null>(null);
  // The Code Review surface — a third secondary pane (mutually exclusive with
  // the browser/drafter): the annotatable git diff of what the agent just
  // wrote. `useReview` owns the repo/source choice, the parsed diff, and the
  // line-anchored annotations.
  const [reviewOpen, setReviewOpen] = usePersistedState(
    "redline.review.open",
    false,
  );
  // Memory is plumbing: no per-surface toolbar panes anymore. One ephemeral,
  // read-mostly inspector (Lake / Catalog / Settings) behind the quiet pill.
  const [memoryInspectorOpen, setMemoryInspectorOpen] = useState(false);
  // The Companion — the global cross-surface discussion. A right-docked
  // overlay drawer OUTSIDE the secondary-pane exclusivity (it must coexist
  // with browser/drafter/review). ⌘J toggles it from anywhere.
  const [companionOpen, setCompanionOpen] = useState(false);
  const companionCtl = useCompanion(companionOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setCompanionOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const codeReview = useReview();
  // A `/redline-code-review` curl is holding for feedback → surface the review
  // pane immediately (the hook itself adopts the repo/source/round).
  useEffect(() => {
    let alive = true;
    const p = listen("review-requested", () => {
      if (!alive) return;
      setSplitRatio(0.5);
      setBrowserOpen(false);
      setDrafterOpen(false);
      setReviewOpen(true);
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Document zoom (content font-scale, not webview zoom). Persisted; clamped
  // 0.8–1.6. Driven by the in-pane control and Cmd +/-/0 shortcuts.
  const [docZoom, setDocZoom] = usePersistedState("redline.docZoom", 1);

  // First-run onboarding tour. The flag persists so the tour auto-runs once;
  // `tourOpen` force-shows it (menu replay) regardless of the flag.
  const [onboardingDone, setOnboardingDone] = usePersistedState(
    "redline.onboardingDone",
    false,
  );
  const [tourOpen, setTourOpen] = useState(false);
  const clampZoom = (z: number) =>
    Math.min(1.6, Math.max(0.8, Math.round(z * 100) / 100));
  const zoomIn = () => setDocZoom((z) => clampZoom(z + 0.1));
  const zoomOut = () => setDocZoom((z) => clampZoom(z - 0.1));
  const zoomReset = () => setDocZoom(1);
  // Sidecar-discussion text-size. Persisted; same 0.8–1.6 clamp as docZoom.
  // Drives the `--rl-discussion-zoom` multiplier on each discussion via the
  // A−/A+ control in the discussion header; one shared preference for all.
  const [discussionZoom, setDiscussionZoom] = usePersistedState(
    "redline.discussionZoom",
    1,
  );
  // Stable adjuster handed to every discussion's A−/A+ via context. The current
  // zoom is never passed down as a prop — the size rides the
  // `--rl-discussion-zoom` CSS var set once on the discussion pane — so changing
  // it re-renders nothing in the comment list.
  const adjustDiscussionZoom = useCallback(
    (delta: number) =>
      setDiscussionZoom((z) =>
        Math.min(1.6, Math.max(0.8, Math.round((z + delta) * 100) / 100)),
      ),
    [setDiscussionZoom],
  );
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

  // Cmd+W (native File ▸ Close Tab) closes a browser tab when the browser pane
  // is open — BrowserPane handles that itself. When it's NOT open there's no tab
  // to close, so fall back to the conventional macOS behaviour and close the
  // window. (Both listeners fire; this one no-ops while the browser is open so
  // the keystroke doesn't both close a tab AND the window.)
  useEffect(() => {
    if (browserOpen) return;
    const p = listen("menu-close-tab", () => {
      void getCurrentWindow().close();
    });
    return () => {
      void p.then((un) => un());
    };
  }, [browserOpen]);

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

  // Onboarding tour reveal/restore: the spotlight needs its target on-screen, so
  // when a step points at a collapsed pane we expand it, remembering the prior
  // state to put back when the step moves on (or the tour closes). One pane at a
  // time — each call undoes the previous reveal first.
  const tourRevealRestore = useRef<(() => void) | null>(null);
  const handleTourAnchor = useCallback(
    (anchor: string | undefined) => {
      tourRevealRestore.current?.();
      tourRevealRestore.current = null;
      if (anchor === "terminal") {
        // Open the terminal partway for the tour — never its full saved height
        // (which can be near full-screen) and never fullscreen, both of which
        // swamp the window and look funky mid-tutorial. Restore the real size
        // when the step moves on.
        const prevCollapsed = termCollapsed;
        const prevFullscreen = termFullscreen;
        const prevHeight = termHeight;
        const partial = Math.max(
          180,
          Math.min(prevHeight, Math.round(window.innerHeight * 0.32)),
        );
        if (termCollapsed || termFullscreen || termHeight !== partial) {
          if (termFullscreen) setTermFullscreen(false);
          if (termCollapsed) setTermCollapsed(false);
          if (termHeight !== partial) setTermHeight(partial);
          tourRevealRestore.current = () => {
            setTermCollapsed(prevCollapsed);
            setTermFullscreen(prevFullscreen);
            setTermHeight(prevHeight);
          };
        }
      } else if (anchor === "sessions" && sidebarCollapsed) {
        setSidebarCollapsed(false);
        tourRevealRestore.current = () => setSidebarCollapsed(true);
      } else if (anchor === "discussion" && paneCollapsed) {
        setPaneCollapsed(false);
        tourRevealRestore.current = () => setPaneCollapsed(true);
      }
    },
    [
      termCollapsed,
      termFullscreen,
      termHeight,
      sidebarCollapsed,
      paneCollapsed,
      setTermCollapsed,
      setTermFullscreen,
      setTermHeight,
      setSidebarCollapsed,
      setPaneCollapsed,
    ],
  );
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

  // Shift + arrows toggle the surrounding panes (← sidebar, → comment pane,
  // ↓ terminal dock) and cycle the sidebar tab (↑). A capture-phase window
  // listener so the keystroke is caught — and swallowed — even when the xterm
  // terminal has focus (its handler sits on a bubble-phase helper textarea, so
  // capture runs first and stopPropagation keeps the shell from seeing the
  // escape sequence). Real editors (Tiptap, composer inputs) keep native
  // Shift+Arrow text selection; the xterm helper textarea is exempted so the
  // hotkeys still fire there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight" &&
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown"
      )
        return;

      const el = e.target as HTMLElement | null;
      const editing =
        el &&
        !el.classList?.contains("xterm-helper-textarea") &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (editing) return;

      e.preventDefault();
      e.stopPropagation();

      switch (e.key) {
        case "ArrowLeft":
          setSidebarCollapsed((c) => !c);
          break;
        case "ArrowRight":
          setPaneCollapsed((c) => !c);
          break;
        case "ArrowDown":
          setTermCollapsed((c) => !c);
          break;
        case "ArrowUp": {
          // Ordered tabs: index 0 = sessions, 1..n = open folders. Wrap forward.
          const len = openFolders.length + 1;
          const cur =
            sidebarTab.kind === "sessions"
              ? 0
              : openFolders.findIndex((f) => f.id === sidebarTab.id) + 1;
          const next = (cur + 1) % len;
          if (next === 0) selectSessions();
          else selectFolderTab(openFolders[next - 1].path);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    setSidebarCollapsed,
    setPaneCollapsed,
    setTermCollapsed,
    openFolders,
    sidebarTab,
    selectSessions,
    selectFolderTab,
  ]);

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
      // If a secondary pane (browser or drafter) is filling the center pane on
      // its own, opening a document would otherwise load hidden behind it.
      // Bring up the split so both show.
      if ((browserOpen || drafterOpen || reviewOpen) && !docOpen) {
        setSplitRatio(0.5);
        setDocOpen(true);
      }
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
    [setActiveFile, sidebarTab, activeTermId, browserOpen, drafterOpen, reviewOpen, docOpen, setDocOpen, setSplitRatio],
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
  const [latchPos, setLatchPos] = useState({ left: 0, top: 0 });

  // Track the viewport width so each side pane's max can be "up to the other
  // pane" — letting EITHER pane be dragged until the document clamps fully
  // shut, symmetrically. (A fixed 320px reserve made this lopsided: one pane
  // could clamp the doc shut and the other couldn't.)
  const [winWidth, setWinWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The row's space model: the doc column floors at DOC_MIN and any pane
  // width past that becomes curtain overlay instead of flow. Stateless — it
  // appears and retracts continuously as widths / window / collapse change.
  const layout = computePaneLayout({
    winWidth,
    sidebarWidth,
    sidebarCollapsed,
    paneWidth,
    paneCollapsed,
    paneFullscreen,
  });

  // When collapsing the sidebar (or growing the window) frees enough room
  // for the fullscreen discussion to fit beside a full-width doc, drop it
  // back to side-by-side so the doc reflows into the freed space.
  useAutoExitFullscreen({
    paneFullscreen,
    setPaneFullscreen,
    layoutInput: {
      winWidth,
      sidebarWidth,
      sidebarCollapsed,
      paneWidth,
      paneCollapsed,
      paneFullscreen,
    },
  });

  // Hide the floating zoom pill the moment the document text would reach it.
  // The article is centered with a max width, so on a wide pane there's an empty
  // right gutter to host the control; as the pane narrows the text column grows
  // toward the right edge — once its text (minus the article's right padding)
  // reaches the control's left edge, drop the control. Recomputed on any pane
  // resize via a ResizeObserver on the scroll container. Re-runs on the
  // browser/drafter/docOpen toggles too: those unmount and remount the document,
  // giving a fresh ref/observer — otherwise the pill would stay stale-hidden
  // after the secondary pane is toggled back off.
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
  }, [sidebarTab, activeFile, activeId, browserOpen, drafterOpen, reviewOpen, docOpen]);

  // Position the latch over the visible remnant of the document. The doc
  // column's flow box floors at DOC_MIN now, so "squeezed shut" means the
  // curtains cover it — center the latch on the strip they leave uncovered.
  // Position is relative to the positioned <main> ancestor (the document
  // column's offsetParent).
  const { sidebarOverlayPx, paneOverlayPx, docVisibleW } = layout;
  useEffect(() => {
    const el = docColumnRef.current;
    if (!el) return;
    const recompute = () => {
      // Keep the latch on-screen when the visible strip clamps against a
      // window edge (one pane collapsed).
      const parent = el.offsetParent as HTMLElement | null;
      const maxLeft = (parent?.clientWidth ?? window.innerWidth) - 12;
      const rawLeft = el.offsetLeft + sidebarOverlayPx + docVisibleW / 2;
      setLatchPos({
        left: Math.min(maxLeft, Math.max(12, rawLeft)),
        top: el.offsetTop + el.offsetHeight / 2,
      });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    sidebarWidth,
    paneWidth,
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
    sidebarOverlayPx,
    paneOverlayPx,
    docVisibleW,
  ]);

  // The latch appears whenever the document's uncovered strip has shrunk to a
  // sliver — the curtains (or a collapsed pane's edge) have swallowed it. Each
  // arrow reopens the document by shrinking whichever pane is actually open on
  // that side (falling back to the other side when one pane is collapsed).
  const docObscured = docVisibleW < 56;
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
  // A comment the agent just created by voice — auto-expand its discussion
  // sidecar once (then cleared, so a later manual collapse isn't fought).
  const [autoOpenCommentId, setAutoOpenCommentId] = useState<string | null>(null);
  // Comment ids already on the displayed revision, scoped to the session so a
  // session switch doesn't read its comments as "new". Drives auto-open below.
  const seenCommentsRef = useRef<{ sid: string | null; ids: Set<string> }>({
    sid: null,
    ids: new Set(),
  });
  // Stable so it doesn't defeat the memo on CommentCard / CommentThread.
  const clearAutoOpen = useCallback(() => setAutoOpenCommentId(null), []);

  const onThemeChange = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
    // Recommend (never force) the theme's companion font: apply it only if the
    // user is still on the untouched default, so a real font pick is preserved.
    const suggested = SUGGESTED_FONT_FOR_THEME[name];
    if (suggested && suggested !== font && !hasStoredFont()) {
      setFont(suggested);
      applyFont(suggested);
      // Not stored — leaves the pick "untouched" so switching away restores the
      // default face, and an explicit FontPicker choice still takes over.
    }
    // Same recommend-never-force rule for the theme's companion lint: apply it
    // only while the user is still on the untouched default (Off), so a real
    // lint pick is preserved and switching away restores plain prose.
    const suggestedLint = SUGGESTED_LINT_FOR_THEME[name];
    if (suggestedLint && suggestedLint !== lint && !hasStoredLint()) {
      setLint(suggestedLint);
      applyLint(suggestedLint);
    }
  };

  const onFontChange = (name: FontName) => {
    setFont(name);
    applyFont(name);
    storeFont(name);
  };

  const onLintChange = (name: LintName) => {
    setLint(name);
    applyLint(name);
    storeLint(name);
  };

  // Max width = whatever leaves the document at 0 against the *other* pane
  // (minus the two 6px dividers). Collapsed panes contribute 0. Widths past
  // the doc's DOC_MIN floor render as curtain overlay (see `layout` above).
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

  // The Discussion sidecar's context. Plan comments need the doc pane on a
  // sessions tab; the review context needs the Code Review pane open. In a
  // true split the header toggle (discussionPinned) decides.
  const planDiscussionAvailable = docOpen && sidebarTab.kind === "sessions";
  const discussionContext = effectiveDiscussionContext(
    reviewOpen,
    planDiscussionAvailable,
    discussionPinned,
  );

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
    if (!id || isJoinedSessionId(id)) {
      // A joined room has no backend session — its pane renders entirely
      // from Yjs (the joined-session shadow), so there is nothing to fetch.
      setSession(null);
      return;
    }
    try {
      const full = await invoke<ReviewSession | null>("get_session", { id });
      // Revision-rollover handoff (live collab): if this session is being
      // shared and the fetched state moved to a NEW latest revision, bump
      // `meta.currentVersion` into the room we're STILL attached to before
      // setSession re-keys the editor — after the re-key the old room's
      // provider is gone and collaborators would never learn where we went.
      const share = collabShareRef.current;
      const handle = collabPresenceRef.current;
      if (share && handle && full && full.sessionId === share.sessionId) {
        const v =
          full.revisions[full.revisions.length - 1]?.versionNumber ?? 0;
        publishMeta(handle.ydoc, { currentVersion: v });
      }
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

  // Native app menu → README / feedback overlays. Mount-once: the menu items'
  // identities never change, so this must not re-subscribe with session state.
  const [showReadme, setShowReadme] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  useEffect(() => {
    const readmeUnlisten = listen("menu-open-readme", () =>
      setShowReadme(true),
    );
    const feedbackUnlisten = listen("menu-open-feedback", () =>
      setShowFeedback(true),
    );
    const tutorialUnlisten = listen("menu-open-tutorial", () =>
      setTourOpen(true),
    );
    return () => {
      void readmeUnlisten.then((u) => u());
      void feedbackUnlisten.then((u) => u());
      void tutorialUnlisten.then((u) => u());
    };
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
      // The round-trip for this session is over — release its submit lock no
      // matter which session is in the foreground.
      setAwaitingSessions((prev) => {
        if (!prev.has(payload.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(payload.sessionId);
        return next;
      });
      if (payload.sessionId === activeId) {
        // A fresh plan means Claude is waiting again — re-arm the banner for
        // any future detach (the derived state clears via attachState=held).
        setDetachDismissed(false);
      }
      void refreshSummaries().then((list) => {
        // Restore landed: drafts from before the detach were carried onto the
        // re-presented revision. Nudge — the user's next move is theirs.
        if (payload.restored) {
          const pending =
            list.find((s) => s.sessionId === payload.sessionId)
              ?.pendingCount ?? 0;
          if (pending > 0) {
            setToast(
              `${pending} pending comment${pending === 1 ? "" : "s"} carried over — Send to Claude Code when ready`,
            );
            setTimeout(() => setToast(null), 4000);
          }
        }
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
    // The backend persisted attachState=detached before emitting, so the
    // summary refresh is what flips the derived `detached` — this listener
    // just makes that immediate.
    const detachedUnlisten = listen<{ sessionId: string }>(
      "session-detached",
      (e) => {
        void refreshSummaries();
        setAwaitingSessions((prev) => {
          if (!prev.has(e.payload.sessionId)) return prev;
          const next = new Set(prev);
          next.delete(e.payload.sessionId);
          return next;
        });
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

  // `redline://…#RLS1…` deep links — the browser viewer's "Open in Redline"
  // link lands a shared plan here as a full native review. The handler ref is
  // refreshed each render so the mount-once listener always sees the latest
  // selection closures without re-subscribing onOpenUrl.
  const openSharedRef = useRef<(urls: string[]) => void>(() => {});
  openSharedRef.current = (urls: string[]) => {
    void (async () => {
      for (const url of urls) {
        try {
          const id = await importSharedPlanFromUrl(url);
          if (!id) continue;
          await refreshSummaries();
          selectSessions();
          setActiveId(id);
          setViewedVersionNumber(null);
          void loadSession(id);
        } catch (err) {
          console.error("failed to import shared plan", err);
        }
      }
    })();
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const dl = await import("@tauri-apps/plugin-deep-link");
        unlisten = await dl.onOpenUrl((urls) => openSharedRef.current(urls));
        // Cold start: the URL that launched the app, if any.
        const current = await dl.getCurrent().catch(() => null);
        if (!cancelled && current && current.length) {
          openSharedRef.current(current);
        }
      } catch {
        // deep-link plugin unavailable (e.g. under test) — no-op.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
      setDetachDismissed(false);
    } else {
      setSession(null);
    }
    // The awaiting-next-plan lock is per-session (`awaitingSessions`), so a
    // sidebar switch neither clears nor leaks it — switching back to a session
    // mid-revision correctly resumes its "Claude is working" state.
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
  // Headings shown in the doc pane right now — the historical revision when
  // one is being viewed, otherwise the latest. Drives the TOC rail.
  const displaySections =
    isViewingHistorical && viewedRevision ? viewedRevision.sections : sections;
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

  // ── Live collaboration (Phases 1a–1d) ─────────────────────────────────
  // Owner side: one active share scoped to the session it was minted for,
  // plus the per-session Review Request registry (live invites + async
  // snapshot requests). Collaborator side: one joined room — the shadow
  // session. Both attach through PlanEditor's `collab` prop; the provider
  // handles surface back here for presence UI, mirrors, and access control.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [collabShare, setCollabShare] = useState<CollabConfig | null>(null);
  // The room's admin token — the credential the signaling server ties
  // manage (allowlist/revoke) rights to. Never leaves this machine.
  const [shareAdmin, setShareAdmin] = useState<string | null>(null);
  const [joinedRoom, setJoinedRoom] = useState<{
    config: CollabConfig;
    name: string;
    /** SHA-256 of our invite token, advertised in awareness. */
    inviteHash?: string;
    /** The owner revoked our invite — transport access is gone. */
    revoked?: boolean;
  } | null>(null);
  const [sharePresence, setSharePresence] =
    useState<CollabProviderHandle | null>(null);
  const [joinedPresence, setJoinedPresence] =
    useState<CollabProviderHandle | null>(null);
  const [collabPeers, setCollabPeers] = useState(0);
  // Read inside loadSession (defined earlier, runs later) so the rollover
  // bump can reach the still-attached room without re-binding listeners.
  const collabShareRef = useRef<CollabConfig | null>(null);
  collabShareRef.current = collabShare;
  const collabPresenceRef = useRef<CollabProviderHandle | null>(null);
  collabPresenceRef.current = sharePresence;
  const [relayDefaults, setRelayDefaults] = useState<{
    displayName: string;
    signaling: string[];
  }>({ displayName: "", signaling: ["ws://127.0.0.1:4444"] });

  useEffect(() => {
    void invoke<{ displayName: string; signaling: string[] }>(
      "get_relay_config",
    )
      .then(setRelayDefaults)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!sharePresence) {
      setCollabPeers(0);
      return;
    }
    setCollabPeers(sharePresence.peerCount);
    return sharePresence.onPeersChanged(setCollabPeers);
  }, [sharePresence]);

  // Which invite hashes are in the owner's room right now — drives the
  // "connected" chips and maps roster entries back to Review Requests.
  const [presentHashes, setPresentHashes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (!sharePresence) {
      setPresentHashes(new Set());
      return;
    }
    const awareness = sharePresence.awareness;
    const read = () => {
      const next = new Set<string>();
      for (const [, state] of awareness.getStates()) {
        const hash = (state as { user?: { inviteHash?: string } }).user
          ?.inviteHash;
        if (hash) next.add(hash);
      }
      setPresentHashes(next);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [sharePresence]);

  // Review Requests are per-session. While sharing, the registry stays bound
  // to the SHARED session even if the sidebar views another — the signaling
  // allowlist must keep tracking the room being shared.
  const requestsSessionId =
    collabShare?.sessionId ??
    (activeId && !isJoinedSessionId(activeId) ? activeId : null);
  const reviewRequests = useReviewRequests(requestsSessionId);
  const activePlanTitle =
    summaries.find((s) => s.sessionId === (session?.sessionId ?? ""))
      ?.planTitle ?? null;

  // Memory-by-session (spine): mirror "where is the user" into the backend
  // ActiveSurface cell. Debounced so pane flips during a drag/animation
  // collapse to one write; the backend journals only identity changes. The
  // browser tab's own detail is mirrored separately by BrowserPane
  // (`browser_set_active`/`browser_set_tabs`) — the backend enriches from
  // those cells when the surface is `browser`.
  const activeSummary = summaries.find((s) => s.sessionId === activeId);
  const activeSurface = deriveActiveSurface({
    browserOpen,
    drafterOpen,
    reviewOpen,
    activeId,
    planTitle: activeSummary?.planTitle ?? null,
    planProject: activeSummary?.projectPath ?? null,
    activeTab: null,
    reviewId: codeReview.activeReviewId,
    reviewRepo: codeReview.repo,
    drafterDraftId,
    drafterProject,
    activeFile,
    hasTerminal: termTabCount > 0,
  });
  const activeSurfaceKey = `${activeSurface.kind} ${activeSurface.id ?? ""} ${
    activeSurface.label ?? ""
  } ${activeSurface.detail ?? ""}`;
  useEffect(() => {
    const t = window.setTimeout(() => {
      void invoke("surface_set_active", { info: activeSurface }).catch(
        () => {},
      );
    }, 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSurfaceKey]);

  const startShare = useCallback(
    (displayName: string, signaling: string[]) => {
      if (!activeId || !latest || isJoinedSessionId(activeId)) return;
      // Persist the relay settings so the next invite is prefilled.
      void invoke("set_relay_config", { displayName, signaling }).catch(
        () => undefined,
      );
      setRelayDefaults({ displayName, signaling });
      const sessionId = activeId;
      const threadStart = threadRevisions[0]?.versionNumber ?? 0;
      const version = latest.versionNumber;
      void (async () => {
        // Reuse the persisted room identity (secret/epoch/admin) so a
        // restart doesn't strand join codes minted before it.
        let persisted: { secret?: string; epoch?: number; admin?: string } = {};
        try {
          const json = await invoke<string | null>("get_collab_share", {
            sessionId,
          });
          if (json) persisted = JSON.parse(json) as typeof persisted;
        } catch {
          // Fresh share.
        }
        const secret = persisted.secret ?? randomToken();
        const epoch = persisted.epoch ?? 0;
        const admin = persisted.admin ?? randomToken(16);
        if (!persisted.secret || !persisted.admin) {
          void invoke("set_collab_share", {
            sessionId,
            json: JSON.stringify({ secret, epoch, admin }),
          }).catch(() => undefined);
        }
        setShareAdmin(admin);
        setCollabShare({
          sessionId,
          threadStart,
          version,
          signaling,
          secret,
          invite: "",
          ownerName: displayName,
          ...(epoch ? { epoch } : {}),
        });
      })();
    },
    [activeId, latest, threadRevisions],
  );

  const stopShare = useCallback(() => {
    setCollabShare(null);
    setShareAdmin(null);
    setInviteOpen(false);
  }, []);

  // Owner access channels: one per signaling server, authed with the admin
  // token. They carry the allowlist/revocation state (rl-manage) and let the
  // server push room facts (epoch, envelopes, current version) to joiners.
  const accessClientsRef = useRef<RoomAccess[]>([]);
  useEffect(() => {
    if (!collabShare || !shareAdmin) return;
    const base = collabRoomBase(collabShare);
    const clients = collabShare.signaling.map((url) =>
      connectRoomAccess({ url, base, token: shareAdmin }),
    );
    accessClientsRef.current = clients;
    return () => {
      for (const client of clients) client.close();
      accessClientsRef.current = [];
    };
    // Session identity + admin change ⇒ new channels; secret/epoch churn is
    // pushed through manage() below, not by reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabShare?.sessionId, collabShare?.threadStart, shareAdmin]);

  // Push the current access state whenever it changes: the live allowlist,
  // revocations, key epoch (+ per-invite secret envelopes after a rotation),
  // and the current revision so late joiners find the live room.
  useEffect(() => {
    const share = collabShare;
    if (!share || !shareAdmin || !reviewRequests.ready) return;
    let cancelled = false;
    void (async () => {
      const base = collabRoomBase(share);
      const epoch = share.epoch ?? 0;
      const allowed: string[] = [];
      const envelopes: Record<string, string> = {};
      for (const r of activeLiveRequests(reviewRequests.requests)) {
        const hash = r.inviteHash ?? (await hashToken(r.invite!));
        allowed.push(hash);
        if (epoch > 0) {
          envelopes[hash] = await sealEnvelope(r.invite!, base, {
            secret: share.secret,
            epoch,
          });
        }
      }
      const revoked = reviewRequests.requests
        .filter(
          (r) => r.mode === "live" && r.status === "revoked" && r.inviteHash,
        )
        .map((r) => r.inviteHash!);
      if (cancelled) return;
      for (const client of accessClientsRef.current) {
        client.manage({
          allowed,
          revoked,
          envelopes,
          epoch,
          extra: { version: latest?.versionNumber ?? share.version },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collabShare, shareAdmin, reviewRequests.ready, reviewRequests.requests, latest]);

  // Mint a join code for a live invite against the room's CURRENT state.
  const mintJoinCode = useCallback(
    (invite: string): string | null => {
      const share = collabShare;
      if (!share || !invite) return null;
      return encodeJoinCode({
        ...share,
        version: latest?.versionNumber ?? share.version,
        invite,
      });
    },
    [collabShare, latest],
  );

  const createLiveInvite = useCallback(
    async (reviewerName: string): Promise<string | null> => {
      const share = collabShare;
      if (!share || !reviewRequests.ready) return null;
      const invite = randomToken(16);
      const inviteHash = await hashToken(invite);
      reviewRequests.add({
        id: `rr-${randomToken(8)}`,
        reviewerName,
        mode: "live",
        status: "pending",
        createdAt: Date.now(),
        baseVersion: latest?.versionNumber ?? share.version,
        invite,
        inviteHash,
      });
      return mintJoinCode(invite);
    },
    [collabShare, reviewRequests, latest, mintJoinCode],
  );

  // Transport-side revoke: mark the request revoked and ROTATE the room key.
  // The manage push evicts the peer at the signaling server (no new WebRTC
  // conns for them, ever), remaining peers re-key from their sealed
  // envelopes, and the revoked peer's old secret opens a room nobody is in.
  const revokeRequest = useCallback(
    (requestId: string) => {
      const req = reviewRequests.requests.find((r) => r.id === requestId);
      if (!req) return;
      reviewRequests.update(requestId, { status: "revoked" });
      const share = collabShare;
      if (share) {
        const epoch = (share.epoch ?? 0) + 1;
        const secret = randomToken();
        setCollabShare({ ...share, secret, epoch });
        void invoke("set_collab_share", {
          sessionId: share.sessionId,
          json: JSON.stringify({ secret, epoch, admin: shareAdmin }),
        }).catch(() => undefined);
      }
    },
    [reviewRequests, collabShare, shareAdmin],
  );

  const revokeByHash = useCallback(
    (inviteHash: string) => {
      const req = reviewRequests.requests.find(
        (r) => r.inviteHash === inviteHash,
      );
      if (req) revokeRequest(req.id);
    },
    [reviewRequests, revokeRequest],
  );

  // The room follows the CURRENT revision (a revise round rolls the room);
  // the join code's minted version is only where a joiner starts.
  const ownerCollab = useMemo<PlanEditorCollab | undefined>(() => {
    if (!collabShare || !activeId || collabShare.sessionId !== activeId) {
      return undefined;
    }
    if (!latest) return undefined;
    const name = collabShare.ownerName || "Owner";
    return {
      config: collabShare,
      role: "owner",
      user: { name, color: presenceColor(name) },
      room: {
        sessionId: activeId,
        threadStart: threadRevisions[0]?.versionNumber ?? 0,
        version: latest.versionNumber,
        ...(collabShare.epoch ? { epoch: collabShare.epoch } : {}),
      },
      ...(shareAdmin ? { authToken: shareAdmin } : {}),
      onProvider: setSharePresence,
    };
  }, [collabShare, shareAdmin, activeId, latest, threadRevisions]);

  const collaboratorCollab = useMemo<PlanEditorCollab | undefined>(() => {
    if (!joinedRoom || joinedRoom.revoked) return undefined;
    const name = joinedRoom.name || "Guest";
    return {
      config: joinedRoom.config,
      role: "collaborator",
      user: { name, color: presenceColor(name) },
      ...(joinedRoom.inviteHash ? { inviteHash: joinedRoom.inviteHash } : {}),
      onProvider: setJoinedPresence,
    };
  }, [joinedRoom]);

  // Joined-session shadow (1c): the sidebar row + pane header facts are
  // synthesized entirely from the room's Yjs state — no backend session.
  const joinedInfo = useJoinedSession(joinedRoom, joinedPresence);
  const joinedActive = !!joinedInfo && activeId === joinedInfo.key;

  // Width of the table-of-contents rail. Kept in one place so the rail and the
  // left space it reserves in the document scroller stay in lockstep.
  const TOC_RAIL_W = 230;
  // The TOC rail applies only over a plainly-displayed plan document (a real
  // session, latest or historical, with headings) — never the folder viewer, a
  // joined shadow session, or while a secondary pane (browser/drafter/review)
  // shares the column. When eligible + open it becomes an in-flow panel: the
  // document scroller reserves `TOC_RAIL_W` on its left so the rail docks
  // beside the plan instead of floating over it.
  const tocEligible =
    sidebarTab.kind === "sessions" &&
    !joinedActive &&
    sessionReady &&
    !browserOpen &&
    !drafterOpen &&
    !reviewOpen &&
    displaySections.length > 0;
  const tocDocked = tocEligible && tocOpen;

  const joinRoom = useCallback((config: CollabConfig, name: string) => {
    setJoinedRoom({ config, name });
    setJoinOpen(false);
    setActiveId(joinedSessionKey(config));
    void hashToken(config.invite).then((hash) =>
      setJoinedRoom((r) =>
        r && r.config.sessionId === config.sessionId
          ? { ...r, inviteHash: hash }
          : r,
      ),
    );
  }, []);

  const leaveJoined = useCallback(() => {
    setJoinedRoom(null);
    setActiveId((prev) => {
      if (!isJoinedSessionId(prev)) return prev;
      return summaries[0]?.sessionId ?? null;
    });
  }, [summaries]);

  // Collaborator access channel: epoch/envelope discovery (key rotation),
  // current-version discovery (late join after a rollover), and the
  // revocation notice. Keyed to the joined room's identity — survives
  // re-keys, dies with leave.
  useEffect(() => {
    if (!joinedRoom) return;
    const config = joinedRoom.config; // identity fields are stable per join
    const base = collabRoomBase(config);
    const url = config.signaling[0];
    if (!url) return;
    const client = connectRoomAccess({
      url,
      base,
      token: config.invite,
      onUpdate: (info) => {
        if (info.managed && !info.allowed) {
          setJoinedRoom((r) => (r ? { ...r, revoked: true } : r));
          return;
        }
        const version = info.extra["version"];
        if (typeof version === "number") {
          setJoinedRoom((r) =>
            r && version > r.config.version
              ? { ...r, config: { ...r.config, version } }
              : r,
          );
        }
        if (info.envelope) {
          void openEnvelope(config.invite, base, info.envelope).then(
            (sealed) => {
              if (!sealed) return;
              setJoinedRoom((r) =>
                r && sealed.epoch > (r.config.epoch ?? 0)
                  ? {
                      ...r,
                      config: {
                        ...r.config,
                        secret: sealed.secret,
                        epoch: sealed.epoch,
                      },
                    }
                  : r,
              );
            },
          );
        }
      },
      onDenied: () => setJoinedRoom((r) => (r ? { ...r, revoked: true } : r)),
    });
    return () => client.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedRoom?.config.sessionId, joinedRoom?.config.threadStart]);

  // Collaborator comment backend (Phase 1b): SyncBackend-shaped writes into
  // the room's comments map; the owner's mirror lands them in SQLite. The
  // local read side feeds the joined editor's highlight/gutter decorations.
  const yjsBackend = useMemo(
    () =>
      joinedRoom && !joinedRoom.revoked && joinedPresence
        ? createYjsCommentBackend(
            joinedPresence.ydoc,
            joinedPresence.awareness.clientID,
            joinedRoom.name || "Guest",
          )
        : null,
    [joinedRoom, joinedPresence],
  );
  const [collabComments, setCollabComments] = useState<Comment[]>([]);
  useEffect(() => {
    if (!yjsBackend) {
      setCollabComments([]);
      return;
    }
    setCollabComments(yjsBackend.list());
    return yjsBackend.observe(() => setCollabComments(yjsBackend.list()));
  }, [yjsBackend]);

  // Owner: publish session meta into the current room (idempotent per key).
  // Rollover bumps happen separately in loadSession — they must reach the
  // OLD room before the editor re-keys; this effect covers steady state.
  useEffect(() => {
    if (!ownerCollab || !sharePresence || !session || !latest) return;
    publishMeta(sharePresence.ydoc, {
      currentVersion: latest.versionNumber,
      threadStart: threadRevisions[0]?.versionNumber ?? 0,
      ownerName: ownerCollab.user.name,
      projectName: session.projectName,
      ...(activePlanTitle ? { planTitle: activePlanTitle } : {}),
      status: session.status,
    });
  }, [
    ownerCollab,
    sharePresence,
    session,
    latest,
    threadRevisions,
    activePlanTitle,
  ]);

  // Collaborator: follow the rollover forwarding address. When the room's
  // meta says the plan moved to a newer revision, re-point the joined config
  // — the revisionKey changes, PlanEditor re-keys onto a fresh Y.Doc, and
  // the provider reattaches to the new room and hydrates from the mesh.
  useEffect(() => {
    if (!joinedRoom || !joinedPresence) return;
    const ydoc = joinedPresence.ydoc;
    const check = () => {
      const v = readMeta(ydoc).currentVersion;
      if (typeof v === "number" && v > joinedRoom.config.version) {
        setJoinedRoom((r) =>
          r ? { ...r, config: { ...r.config, version: v } } : r,
        );
      }
    };
    check();
    return observeMeta(ydoc, check);
  }, [joinedRoom, joinedPresence]);
  // When a voice-authored comment newly appears on the displayed revision (the
  // agent captured a spoken change over the curl bridge, so we never saw the
  // returned Comment), focus it and auto-open its discussion sidecar.
  useEffect(() => {
    const sid = session?.sessionId ?? null;
    const prev = seenCommentsRef.current;
    const ids = new Set<string>();
    let fresh: Comment | null = null;
    for (const c of paneComments) {
      ids.add(c.id);
      if (prev.sid === sid && !prev.ids.has(c.id) && c.author === "voice") {
        fresh = c;
      }
    }
    seenCommentsRef.current = { sid, ids };
    if (fresh) {
      // Reveal the outer comment pane too — otherwise the card/thread expand
      // inside a collapsed sidecar and nothing becomes visible (the common case
      // while the user is just talking to the voice agent). Mirrors the
      // `setPaneCollapsed(false)` that the manual `beginCompose` gesture does.
      setPaneCollapsed(false);
      setAutoOpenCommentId(fresh.id);
      setFocusedCommentId(fresh.id);
    }
  }, [paneComments, session?.sessionId]);
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
  // The active session's plan is currently held (Claude Code blocked in its
  // terminal awaiting review) — anchors the "Claude is working" window below:
  // held means the plan is back, so Claude is by definition not revising
  // anymore. `summaries`
  // refreshes on plan-received / status / comment events, so this tracks hold
  // and release without its own wiring.
  const activeHeld =
    summaries.find((s) => s.sessionId === activeId)?.held ?? false;
  // The focused terminal tab hosts a held plan (any session's): the backend
  // pins each held POST to the dock terminal whose claude sent it, so the
  // "plan intercepted" strip renders only inside that terminal — never in a
  // sibling tab, and never for plans intercepted from external terminals.
  const heldInFocusedTerm =
    activeTermId !== null &&
    summaries.some((s) => s.held && s.heldTerminalId === activeTermId);
  // Detached is *derived* from the active session's persisted attach state —
  // the backend records detachment (drop-guard, failed submit, startup sweep
  // for POSTs orphaned by a restart), so this survives restarts and detaches
  // that fire while another session is in the foreground. `detachDismissed`
  // only mutes the banner; the disabled submit/approve gating stays.
  const activeDetached =
    summaries.find((s) => s.sessionId === activeId)?.attachState ===
    "detached";
  const detached = activeDetached && !detachDismissed;
  // `waiting` shows the "Claude is working" indicators and gates the
  // submit/approve buttons — true from "Send to Claude Code" until that
  // session's next plan arrives. See isClaudeWorking for the exact rules
  // (notably: comments stuck at "submitted" after the plan is back must NOT
  // keep the indicator lit — the unresolved-ids warning owns that).
  const waiting = isClaudeWorking({
    awaitingNextPlan: activeId !== null && awaitingSessions.has(activeId),
    held: activeHeld,
    detached,
    sessionStatus: session?.status,
    submittedCount,
    pendingCount: pendingComments.length,
  });
  // Mirror Footer's mode inference for the pane-side waiting card: if the
  // in-flight batch is all non-actionable questions, Claude is answering,
  // not revising (a promoted question flips the batch to Revise).
  const waitingAsk =
    waiting &&
    submittedComments.every((c) => c.type === "question" && !c.actionable);
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

  // Owner-side comment mirror (Phase 1b): SQLite ⇄ the shared comments map.
  // Runs only while sharing; remote (collaborator) writes land through the
  // normal comment commands, so `comments-changed` → reload → re-mirror is
  // the same loop local edits already take.
  useCommentMirror({
    ydoc: ownerCollab && sharePresence ? sharePresence.ydoc : null,
    enabled: !!ownerCollab && !!sharePresence,
    comments: latestComments,
    backend: {
      addComment: addEditorComment,
      updateComment,
      deleteComment,
    },
  });

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
      setAwaitingSessions((prev) => new Set(prev).add(session.sessionId));
    } catch (err) {
      console.error("submit_review failed", err);
      // The backend persisted attachState=detached on this failure — pull the
      // fresh summaries so the derived banner/gating pick it up.
      if (isDetachError(err)) {
        setDetachDismissed(false);
        void refreshSummaries();
      } else alert(`Submit failed: ${err}`);
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
      if (isDetachError(err)) {
        setDetachDismissed(false);
        void refreshSummaries();
      } else alert(`Approve failed: ${err}`);
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
    const cwd = session.projectPath || null;
    const cmd = `${buildResumeCommand(session.sessionId, new Date(), cwd)}\r`;
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
    // Hide the banner while the resume runs; the re-presented plan flips
    // attachState back to held, which clears the derived state for real.
    setDetachDismissed(true);
    setToast("Resuming the session in the terminal below ↓");
    setTimeout(() => setToast(null), 4000);
  };

  // Candidate project directories for the drafter's launch picker: every review
  // session's project plus each open folder workspace, deduped by path.
  const projectOptions = useMemo<ProjectOption[]>(() => {
    const seen = new Map<string, ProjectOption>();
    const add = (path: string, name: string, source: ProjectOption["source"]) => {
      if (!path) return;
      const key = path.replace(/\/+$/, "") || "/";
      if (!seen.has(key)) seen.set(key, { path, name, source });
    };
    for (const s of summaries) add(s.projectPath, s.projectName, "session");
    for (const f of openFolders) add(f.path, f.name, "folder");
    return [...seen.values()];
  }, [summaries, openFolders]);

  // Send the drafted prompt to a *fresh* Claude Code plan session: spawn a
  // terminal in the chosen project and launch `claude --permission-mode plan`
  // seeded with the prompt — the same spawn → 900ms → write pattern as
  // restorePlanSession (let the shell's rc files settle before the command lands).
  const launchPromptDraft = (markdown: string, projectPath: string | null) => {
    const trimmed = markdown.trim();
    if (!trimmed) return;
    // Polis ledger: record the drafted prompt at launch (the plan session
    // doesn't exist yet, so this is the only place its body is first-class).
    // The draft_id makes the eventual plan session a CHILD of this draft —
    // the ingest hook links them when the spawned session first fires.
    void invoke("record_drafted_prompt", {
      markdown: trimmed,
      projectPath,
      draftId: drafterDraftId,
    });
    const cmd = `${buildPlanLaunchCommand(trimmed, projectPath)}\r`;
    setTermFullscreen(false);
    setTermCollapsed(false);
    const id = terminalsRef.current?.openSessionTerminal(projectPath) ?? null;
    if (id) {
      window.setTimeout(() => {
        void invoke("pty_write", { id, data: cmd });
      }, 900);
    }
    setToast("Launching plan in the terminal below ↓");
    setTimeout(() => setToast(null), 4000);
  };

  // "Send to Claude Code" from a browser page-discussion reply. The plan was
  // drafted while browsing, so nothing yet pins it to a repo — launching it
  // straight into a terminal used to default the cwd to $HOME, stranding a plan
  // about (say) `qwallah-crm` in the wrong directory. Instead, guess the target
  // repo from the plan text and hold it for a one-tap repo-confirm step
  // (SendToRedlineDialog) before spawning. Close the native webview first — it
  // paints OVER the React DOM, so the dialog would be hidden behind it otherwise.
  const sendBrowserDraftToRedline = (markdown: string) => {
    if (!markdown.trim()) return;
    const folder = sidebarTab.kind === "folder" ? sidebarTab.id : null;
    const initialProject =
      guessProjectForPlan(markdown, projectOptions) ?? folder ?? drafterProject;
    setBrowserOpen(false);
    setSendConfirm({ markdown, initialProject });
  };

  // Repo confirmed in SendToRedlineDialog: bring the document pane forward and
  // launch the held plan in a terminal scoped to the chosen repo.
  const confirmSendToRedline = (project: string | null) => {
    const markdown = sendConfirm?.markdown;
    setSendConfirm(null);
    if (!markdown) return;
    setDrafterOpen(false);
    setDocOpen(true);
    launchPromptDraft(markdown, project);
  };

  // Seed the Prompt Drafter with agent-authored markdown (markdown → Tiptap doc)
  // and pre-select the repo guessed from the plan text, so the drafter's picker
  // already shows the right project when the user ships it with "Send to Claude
  // Code". Shared by the mission "→ Drafter" and browser "Open in Drafter" paths.
  const openDrafterWithMarkdown = async (markdown: string) => {
    if (!markdown.trim()) return;
    try {
      const { planMarkdownToDoc } = await import("./editor/markdown/parser");
      setDrafterDoc(planMarkdownToDoc(markdown).toJSON() as JSONContent);
    } catch {
      // Fall back to a single text block if the parser import/parse fails.
      setDrafterDoc({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: markdown }] }],
      } as unknown as JSONContent);
    }
    const guess = guessProjectForPlan(markdown, projectOptions);
    if (guess !== null) setDrafterProject(guess);
    setBrowserOpen(false);
    setDrafterOpen(true);
  };

  // "Synthesize → Drafter" from a mission: the orchestrator's brief becomes a
  // drafter doc the user shapes and then ships to Claude Code.
  const seedDrafterFromMission = async (markdown: string) => {
    await openDrafterWithMarkdown(markdown);
    if (!markdown.trim()) return;
    setToast("Mission brief opened in the drafter ✍️");
    setTimeout(() => setToast(null), 4000);
  };

  // "Open in Drafter" from a browser page-discussion reply — same seeding, with
  // the target repo pre-guessed, so the user reviews + picks the repo there.
  const sendBrowserToDrafter = async (markdown: string) => {
    await openDrafterWithMarkdown(markdown);
    if (!markdown.trim()) return;
    setToast("Reply opened in the drafter ✍️");
    setTimeout(() => setToast(null), 4000);
  };

  // Fallback for a Claude running in a terminal Redline doesn't own: copy the
  // resume command so the user can paste it into their own terminal.
  const copyRestoreCommand = () => {
    if (!session) return;
    // Same one-shot restore arming as restorePlanSession — the resumed plan,
    // whichever terminal runs it, should land as "vN restored".
    void invoke("arm_restore", { sessionId: session.sessionId });
    void navigator.clipboard?.writeText(
      buildResumeCommand(session.sessionId, new Date(), session.projectPath || null),
    );
    setToast("Resume command copied — paste it into a shell prompt");
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

  // Save one plan revision as a note in the user's Obsidian vault. The vault
  // folder is asked for once (native picker) and remembered by the backend.
  const saveRevisionToObsidian = async (
    sessionId: string,
    versionNumber: number,
  ) => {
    try {
      const saved = await invoke<string | null>("save_revision_to_obsidian", {
        sessionId,
        versionNumber,
      });
      toastSaved(saved);
    } catch (err) {
      console.error("save_revision_to_obsidian failed", err);
      alert(`Save to Obsidian failed: ${err}`);
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

  // M4: accept a still-draft agent suggestion in place. Editor first — settle
  // the marks before the backend write, so the comments-changed reload finds
  // the block already settled and the reconcile has nothing to re-derive.
  const acceptAgentSuggestion = async (c: Comment) => {
    if (!session || !c.blockId) return;
    planActionsRef.current?.acceptBlockSuggestions(c.blockId);
    try {
      await invoke("accept_agent_suggestion", {
        sessionId: session.sessionId,
        commentId: c.id,
      });
    } catch (err) {
      console.error("accept_agent_suggestion failed", err);
    }
  };

  // M4 lock feedback: a keystroke landed in a block owned by a pending agent
  // suggestion and was filtered.
  const lockedEditToast = () => {
    setToast("Resolve the agent suggestion on this block first");
    setTimeout(() => setToast(null), 3000);
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

  // Stable, id-based callbacks for the comment cards. Each card's `React.memo`
  // only pays off if its props keep referential identity across unrelated App
  // re-renders (a focus flip, a layout tweak); inline `() => deleteComment(c.id)`
  // closures would defeat that by minting a new function every render. We route
  // through a ref that always holds the latest handlers, so the wrappers stay
  // identity-stable for the component's lifetime with no stale-closure risk.
  const commentHandlersRef = useRef({
    select: (id: string) =>
      setFocusedCommentId((prev) => (prev === id ? null : id)),
    remove: deleteComment,
    accept: acceptResolution,
    acceptSuggestion: acceptAgentSuggestion,
    reopen: reopenResolution,
    promote: promoteToChange,
  });
  commentHandlersRef.current = {
    select: (id: string) =>
      setFocusedCommentId((prev) => (prev === id ? null : id)),
    remove: deleteComment,
    accept: acceptResolution,
    acceptSuggestion: acceptAgentSuggestion,
    reopen: reopenResolution,
    promote: promoteToChange,
  };
  // Stable so PlanEditor / HistoricalRevisionView don't re-bind their highlight
  // click handler on every App render (notably ~60×/s during a divider drag).
  const handleHighlightClick = useCallback(
    (id: string) => setFocusedCommentId(id),
    [],
  );
  const commentCallbacks = useMemo(
    () => ({
      onSelect: (id: string) => commentHandlersRef.current.select(id),
      onDelete: (id: string) => commentHandlersRef.current.remove(id),
      onAccept: (id: string) => commentHandlersRef.current.accept(id),
      onAcceptSuggestion: (c: Comment) =>
        commentHandlersRef.current.acceptSuggestion(c),
      onReopen: (id: string, note?: string) =>
        commentHandlersRef.current.reopen(id, note),
      onPromote: (id: string, directive: string) =>
        commentHandlersRef.current.promote(id, directive),
    }),
    [],
  );

  // Installs both pieces of the Redline integration. The hook (a JSON merge
  // into the user's settings.json) and the skill (a whole-file write) have
  // independent failure modes — install each in its own try/catch so one
  // failing still installs the other. Failures render inline in the setup
  // modal (which is unskippable, so it must own its error display); full
  // success advances it to the post-install explainer.
  const installIntegration = async () => {
    const errors: string[] = [];
    let hookOk = false;
    let skillOk = false;
    try {
      const status = await invoke<HookStatus>("install_hook");
      setHookStatus(status);
      hookOk = status.installed;
    } catch (err) {
      console.error("install_hook failed", err);
      errors.push(`Hook install failed: ${err}`);
    }
    try {
      const skill = await invoke<SkillStatus>("install_skill");
      setSkillStatus(skill);
      skillOk = skill.installed;
    } catch (err) {
      console.error("install_skill failed", err);
      errors.push(`Skill install failed: ${err}`);
    }
    setInstallError(errors.length > 0 ? errors.join(" ") : null);
    if (errors.length === 0 && hookOk && skillOk) setSetupPhase("done");
  };

  // A native child webview paints on top of all React DOM, so when a
  // full-pane overlay is up the browser must be hidden underneath it. Mirrors
  // the setup-modal / tour gating used in the JSX below.
  const setupModalActive =
    !!hookStatus &&
    !!skillStatus &&
    (!hookStatus.installed ||
      !skillStatus.installed ||
      setupPhase === "done");
  const tourActive = tourOpen || (!onboardingDone && !setupModalActive);
  const browserOverlayActive =
    showReadme ||
    showFeedback ||
    setupModalActive ||
    tourActive ||
    inviteOpen ||
    joinOpen ||
    shareOpen;
  // The native webview must be hidden whenever a pane divider is mid-drag —
  // otherwise it swallows the pointer and the resize freezes. This makes the
  // sidebar, comment pane, terminal, and the document/browser split all
  // draggable over the browser, exactly as they are over the document.
  // A curtained side pane paints over the doc column in React DOM — which the
  // native webview would ignore (it always paints above). Hide the browser
  // while any curtain is up, exactly like under modals and drags.
  const browserVisible =
    !browserOverlayActive &&
    !sidebarDragging &&
    !isDragging &&
    !termDragging &&
    !splitDragging &&
    !layout.curtainActive &&
    openMenuCount === 0;

  return (
    <MenuOverlayProvider value={adjustMenuOverlay}>
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
        font={font}
        onFontChange={onFontChange}
        lint={lint}
        onLintChange={onLintChange}
        mode={mode}
        onModeChange={changeMode}
        onExport={exportRevision}
        onExportDocx={exportRevisionDocx}
        onSaveObsidian={saveRevisionToObsidian}
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
        docOpen={docOpen}
        onToggleDoc={() => {
          // Entering/leaving a split — start it even so both panes are visible.
          setSplitRatio(0.5);
          setDocOpen((v) => !v);
        }}
        browserOpen={browserOpen}
        onToggleBrowser={() => {
          // Browser, drafter and review share the single "secondary pane" slot,
          // so opening one closes the others; the split resets to even so a
          // folded pane reappears.
          setSplitRatio(0.5);
          setBrowserOpen((v) => {
            if (!v) {
              setDrafterOpen(false);
              setReviewOpen(false);
            }
            return !v;
          });
        }}
        drafterOpen={drafterOpen}
        onToggleDrafter={() => {
          setSplitRatio(0.5);
          setDrafterOpen((v) => {
            if (!v) {
              setBrowserOpen(false);
              setReviewOpen(false);
            }
            return !v;
          });
        }}
        reviewOpen={reviewOpen}
        onToggleReview={() => {
          setSplitRatio(0.5);
          setReviewOpen((v) => {
            if (!v) {
              setBrowserOpen(false);
              setDrafterOpen(false);
            }
            // Opening the review pulls the Discussion sidecar with it (the
            // toggle can pin it back to the plan in a split); closing it
            // hands the sidecar back to the plan.
            setDiscussionPinned(v ? "plan" : "review");
            return !v;
          });
        }}
        companionOpen={companionOpen}
        onToggleCompanion={() => setCompanionOpen((v) => !v)}
        onOpenMemory={() => setMemoryInspectorOpen(true)}
        collabActive={!!collabShare || !!joinedRoom}
        canInvite={sessionReady && !!latest}
        onInvite={() => setInviteOpen(true)}
        onJoinSession={() => setJoinOpen(true)}
        canShare={sessionReady && !!latest}
        onShareSnapshot={() => setShareOpen(true)}
        splitActive={docOpen && (browserOpen || drafterOpen || reviewOpen)}
        splitVertical={splitVertical}
        onToggleSplitOrientation={() => {
          // Flipping orientation resets to 50/50 so a folded-away pane reappears.
          setSplitRatio(0.5);
          setSplitVertical((v) => !v);
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
      {joinedActive && joinedPresence && joinedRoom && !joinedRoom.revoked ? (
        <PresenceBar
          handle={joinedPresence}
          role="collaborator"
          onEnd={leaveJoined}
        />
      ) : !joinedActive &&
        sharePresence &&
        collabShare &&
        activeId === collabShare.sessionId ? (
        <PresenceBar
          handle={sharePresence}
          role="owner"
          onInvite={() => setInviteOpen(true)}
          onEnd={stopShare}
          onRevokePeer={(inviteHash) => revokeByHash(inviteHash)}
        />
      ) : null}
      <main className="relative flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden flex">
        {!sidebarCollapsed && (
        // Clip wrapper for the drawer reveal. In curtain state (the doc is at
        // its floor) it reserves only the flow width and lets the full-width
        // aside spill right OVER the doc, painted above it.
        <div
          className="shrink-0"
          style={{
            width: `${layout.sidebarFlowW}px`,
            overflow: layout.sidebarOverlayPx > 0 ? "visible" : "hidden",
            position: layout.sidebarOverlayPx > 0 ? "relative" : undefined,
            zIndex: layout.sidebarOverlayPx > 0 ? 25 : undefined,
            display: "flex",
            justifyContent: "flex-start",
            transition: sidebarSettling ? "width 160ms ease" : undefined,
          }}
        >
        <aside
          data-tour="sessions"
          className="flex flex-col shrink-0"
          style={{
            width: `${revealSidebarW}px`,
            ...(layout.sidebarOverlayPx > 0
              ? {
                  background: "var(--color-paper)",
                  boxShadow: "8px 0 24px rgba(0,0,0,0.18)",
                }
              : null),
          }}
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
              joined={joinedInfo}
              onSelectJoined={() =>
                joinedInfo && setActiveId(joinedInfo.key)
              }
              onLeaveJoined={leaveJoined}
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
        {/* In curtain state the flow boundary sits under the spilled aside, so
            the divider rides the curtain's visible right edge instead. */}
        {layout.sidebarOverlayPx > 0 && (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: `${-(layout.sidebarOverlayPx + 6)}px`,
              zIndex: 26,
              display: "flex",
            }}
          >
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
          </div>
        )}
        </div>
        )}
        {/* Always in flow (its 6px is part of the space model); when the
            sidebar curtains it is painted over, and the absolute copy above
            carries the affordance at the curtain's visible edge. */}
        <PaneDivider
          orientation="vertical"
          side="leading"
          label="sidebar"
          collapsed={sidebarCollapsed}
          dragging={sidebarDragging}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          onPointerDown={startSidebarDrag}
          hideChevron={latchActive || layout.sidebarOverlayPx > 0}
        />
        <div
          ref={docColumnRef}
          className="flex-1 overflow-hidden flex flex-col relative"
          style={{ background: "var(--color-paper)" }}
        >
          {/* Table-of-contents rail (Phase 2). Docked to the left of the
              document column: the scroller below reserves `TOC_RAIL_W` of left
              padding while this is open (see `tocDocked`), so the rail sits
              BESIDE the plan rather than floating over it — responsive when the
              sidebar narrows the column. Gated by `tocEligible`. */}
          {(() => {
            if (!tocEligible) return null;
            return tocOpen ? (
              <div
                className="rl-toc-rail"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: `${TOC_RAIL_W}px`,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--color-bg-elevated)",
                  borderRight: "1px solid var(--color-rule)",
                  boxShadow: "4px 0 16px rgba(0,0,0,0.12)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--color-rule)",
                  }}
                >
                  <span
                    className="font-sans"
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    Contents
                  </span>
                  <button
                    type="button"
                    onClick={() => setTocOpen(false)}
                    title="Hide contents"
                    aria-label="Hide contents"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--color-ink-muted)",
                      cursor: "pointer",
                      fontSize: "14px",
                      lineHeight: 1,
                    }}
                  >
                    ‹
                  </button>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  <PlanToc
                    sections={displaySections}
                    scopeSelector=".doc-article"
                  />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setTocOpen(true)}
                title="Show contents"
                aria-label="Show table of contents"
                className="font-sans"
                style={{
                  position: "absolute",
                  top: "10px",
                  left: "10px",
                  zIndex: 20,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  border: "1px solid var(--color-rule)",
                  borderRadius: "4px",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-ink)",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden>☰</span> Contents
              </button>
            );
          })()}
          {(() => {
            const documentBody =
              sidebarTab.kind === "folder" && activeFile ? (
            <FileViewer
              path={activeFile}
              onClose={handleCloseFile}
              onSaved={toastSaved}
            />
          ) : (
          <div
            className="rl-thin-scroll-y flex-1 overflow-y-auto"
            style={{
              paddingLeft: tocDocked ? `${TOC_RAIL_W}px` : undefined,
              transition: "padding-left 160ms cubic-bezier(0.4,0,0.2,1)",
            }}
          >
          <article
            ref={documentRef}
            data-tour="editor"
            className="doc-article mx-auto pl-16 pr-8 py-10"
            style={
              {
                maxWidth: "820px",
                "--rl-doc-zoom": docZoom,
              } as React.CSSProperties
            }
          >
            {/* Joined (collaborator) view: no local session, no markdown —
                the body hydrates from the mesh and the editor renders it
                with full track-changes co-editing. Kept MOUNTED (hidden)
                while another session is selected: the editor owns the
                provider, and unmounting it would drop us out of the room. */}
            {joinedRoom && collaboratorCollab && (
              <div style={{ display: joinedActive ? undefined : "none" }}>
                <Suspense fallback={null}>
                  <PlanEditor
                    key={`joined:${collabRevisionKey(joinedRoom.config)}`}
                    markdown=""
                    sections={[]}
                    comments={collabComments}
                    revisionKey={collabRevisionKey(joinedRoom.config)}
                    onAddComment={yjsBackend?.addComment}
                    onUpdateComment={yjsBackend?.updateComment}
                    onDeleteComment={yjsBackend?.deleteComment}
                    collab={collaboratorCollab}
                  />
                </Suspense>
              </div>
            )}
            {joinedActive && joinedRoom?.revoked ? (
              <EmptyState
                title="Access revoked"
                body={
                  <>
                    The session owner removed your invite — the live room is
                    no longer reachable from this instance.{" "}
                    <button
                      type="button"
                      onClick={leaveJoined}
                      style={{
                        textDecoration: "underline",
                        color: "var(--color-accent)",
                        cursor: "pointer",
                      }}
                    >
                      Leave the session
                    </button>
                  </>
                }
              />
            ) : joinedActive ? null : sidebarTab.kind === "folder" ? (
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
                  onHighlightClick={handleHighlightClick}
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
                    onHighlightClick={handleHighlightClick}
                    actionsRef={planActionsRef}
                    onLockedEdit={lockedEditToast}
                    collab={ownerCollab}
                  />
                </Suspense>
              )
            ) : (
              <EmptyState
                title="No plans yet"
                body={
                  <>
                    Open any project in a terminal, run{" "}
                    <code className="font-mono">claude</code>, and press{" "}
                    <code className="font-mono">shift+tab</code> to switch into
                    plan mode. When Claude finishes planning, the plan opens
                    here for review.
                    <br />
                    <button
                      type="button"
                      onClick={() => setHowItWorksOpen(true)}
                      style={{
                        marginTop: "12px",
                        fontSize: "13px",
                        color: "var(--color-info)",
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      New here? See how Redline works →
                    </button>
                  </>
                }
              />
            )}
          </article>
          </div>
              );
            const browserBody = (
              <BrowserPane
                onClose={() => setBrowserOpen(false)}
                visible={browserVisible}
                projectDir={sidebarTab.kind === "folder" ? sidebarTab.id : null}
                // Drop a plan/prompt drafted while browsing into a fresh Redline
                // plan session: close the browser overlay, confirm the target
                // repo, then launch the plan in the terminal (see handler).
                onSendToRedline={sendBrowserDraftToRedline}
                // Or open the reply in the Prompt Drafter (repo pre-guessed)
                // to shape it before sending.
                onSendToDrafter={sendBrowserToDrafter}
                // A synthesized mission brief seeds the Prompt Drafter.
                onSynthesizeToDrafter={seedDrafterFromMission}
                // Re-sync the native webview whenever a surrounding pane toggles
                // and reflows the slot without a drag (e.g. closing the comment
                // pane, which otherwise leaves the webview stranded at its old
                // size with a gap of blank space).
                layoutKey={`${paneCollapsed}|${sidebarCollapsed}|${docOpen}|${splitVertical}|${layout.curtainActive}`}
              />
            );
            const drafterBody = (
              <PromptDrafter
                draftId={drafterDraftId ?? ""}
                doc={drafterDoc}
                onDocChange={setDrafterDoc}
                onMarkdownChange={drafterMarkdownChange}
                projectOptions={projectOptions}
                selectedProject={drafterProject}
                onSelectedProjectChange={setDrafterProject}
                onLaunch={launchPromptDraft}
                chatOpen={drafterChatOpen}
                onChatOpenChange={setDrafterChatOpen}
              />
            );
            const reviewBody = (
              <ReviewPanel
                review={codeReview}
                projectOptions={projectOptions}
                onClose={() => setReviewOpen(false)}
              />
            );
            // The browser and drafter are mutually-exclusive "secondary" panes;
            // whichever is open splits against the document with the exact same
            // SplitPane (orientation toggle, ratio and fold-to-edge divider) the
            // browser has always used. With `docOpen` off, the secondary pane
            // takes the whole column; the 📄 toggle adds the document back.
            const secondaryBody = browserOpen
              ? browserBody
              : drafterOpen
                ? drafterBody
                : reviewOpen
                  ? reviewBody
                  : null;
            if (secondaryBody && docOpen)
              return (
                <SplitPane
                  vertical={splitVertical}
                  ratio={splitRatio}
                  onRatioChange={setSplitRatio}
                  onDraggingChange={setSplitDragging}
                  first={documentBody}
                  second={secondaryBody}
                />
              );
            if (secondaryBody) return secondaryBody;
            // No secondary pane open → the document is the default full view.
            return documentBody;
          })()}
          {/* Voice agent — entry point and drawer live ON the plan pane (not the
              Header), so it reads as a plan feature reached while working with
              the plan. Only over an actual plan (not the browser/drafter/folder
              viewer). */}
          {sessionReady &&
            latest &&
            !browserOpen &&
            !drafterOpen &&
            !reviewOpen &&
            !(sidebarTab.kind === "folder" && activeFile) && (
              <>
                {!voiceOpen && (
                  <button
                    type="button"
                    onClick={() => setVoiceOpen(true)}
                    title="Discuss the plan by voice"
                    aria-label="Discuss the plan by voice"
                    className="absolute flex items-center gap-1.5 rounded-full"
                    style={{
                      left: "16px",
                      bottom: "16px",
                      padding: "6px 12px",
                      fontSize: "13px",
                      background: "var(--color-bg-elevated)",
                      border: "1px solid var(--color-rule)",
                      color: "var(--color-ink)",
                      boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                      cursor: "pointer",
                      zIndex: 20,
                    }}
                  >
                    🎙️ Discuss
                  </button>
                )}
                {voiceOpen && (
                  <VoicePanel
                    // Remount cleanly if the active session changes (a revision
                    // arriving calls setActiveId) instead of mutating sessionId
                    // under a live warm session.
                    key={activeId ?? ""}
                    sessionId={activeId ?? ""}
                    markdown={latest.rawPlanMarkdown}
                    sections={sections}
                    onClose={() => setVoiceOpen(false)}
                  />
                )}
              </>
            )}
          {/* Drafter voice — the same 🎙️ drawer over the Prompt Drafter, keyed
              `drafter:<draft_id>` (the backend derives the kind from the key
              shape) and primed with the draft's markdown mirror. */}
          {drafterOpen && drafterDraftId && !reviewOpen && (
            <>
              {!drafterVoiceOpen && (
                <button
                  type="button"
                  onClick={() => setDrafterVoiceOpen(true)}
                  title="Discuss this draft by voice"
                  aria-label="Discuss this draft by voice"
                  className="absolute flex items-center gap-1.5 rounded-full"
                  style={{
                    left: "16px",
                    bottom: "60px",
                    padding: "6px 12px",
                    fontSize: "13px",
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-ink)",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                    cursor: "pointer",
                    zIndex: 20,
                  }}
                >
                  🎙️ Discuss
                </button>
              )}
              {drafterVoiceOpen && (
                <VoicePanel
                  key={drafterDraftId}
                  sessionId={`drafter:${drafterDraftId}`}
                  markdown={drafterMarkdown}
                  sections={drafterSections}
                  cwd={drafterProject}
                  onClose={() => setDrafterVoiceOpen(false)}
                />
              )}
            </>
          )}
          {/* Floating document-zoom control — pinned to the pane (doesn't scroll
              with the plan). Hidden over the folder file viewer. */}
          {!browserOpen && !drafterOpen && !reviewOpen && !(sidebarTab.kind === "folder" && activeFile) && zoomVisible && (
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
          // Always in flow (its 6px is part of the space model); when the
          // discussion pane curtains it is painted over, and the absolute
          // copy inside the pane wrapper carries the affordance at the
          // curtain's visible edge.
          <PaneDivider
            collapsed={paneCollapsed}
            dragging={isDragging}
            onToggle={() => setPaneCollapsed((c) => !c)}
            onPointerDown={startDrag}
            hideChevron={latchActive || layout.paneOverlayPx > 0}
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
                  width: `${layout.paneFlowW}px`,
                  overflow: layout.paneOverlayPx > 0 ? "visible" : "hidden",
                  position:
                    layout.paneOverlayPx > 0 ? "relative" : undefined,
                  zIndex: layout.paneOverlayPx > 0 ? 25 : undefined,
                  display: "flex",
                  justifyContent: "flex-end",
                  flexShrink: 0,
                  transition: paneSettling ? "width 160ms ease" : undefined,
                }
          }
        >
        {/* Curtain state: the divider copy rides the curtain's visible left
            edge (the in-flow divider is painted over). */}
        {!paneFullscreen && layout.paneOverlayPx > 0 && (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${-(layout.paneOverlayPx + 6)}px`,
              zIndex: 26,
              display: "flex",
            }}
          >
            <PaneDivider
              collapsed={paneCollapsed}
              dragging={isDragging}
              onToggle={() => setPaneCollapsed((c) => !c)}
              onPointerDown={startDrag}
              hideChevron={latchActive}
            />
          </div>
        )}
        <aside
          ref={sidebarRef as React.RefObject<HTMLElement>}
          data-tour="discussion"
          data-context={discussionContext}
          className={
            paneFullscreen
              ? "absolute inset-0 z-30 overflow-y-auto rl-discussion"
              : "overflow-y-auto border-l shrink-0 rl-discussion"
          }
          style={
            {
              background: "var(--color-paper)",
              borderColor: "var(--color-rule)",
              // Curtain state: read as painted above the doc.
              boxShadow:
                !paneFullscreen && layout.paneOverlayPx > 0
                  ? "-8px 0 24px rgba(0,0,0,0.18)"
                  : undefined,
              // Fullscreen lets the aside fill its absolute box (no fixed width).
              width: paneFullscreen ? undefined : `${revealPaneW}px`,
              // One place to drive every discussion's text size — descendants
              // read `--rl-discussion-zoom` via CSS, so the A−/A+ controls never
              // re-render the comment list.
              "--rl-discussion-zoom": discussionZoom,
            } as React.CSSProperties
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
            <span className="flex items-center gap-2">
              Discussion
              {discussionContext === "review" && (
                <span className="rl-review-source-chip normal-case" style={{ fontWeight: 500 }}>
                  ⌗ code review
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              {/* Split-screening a plan and a review: the sidecar can point at
                  either — this is the pin. */}
              {reviewOpen && planDiscussionAvailable && (
                <span className="rl-review-seg" role="group" aria-label="Discussion context">
                  <button
                    type="button"
                    data-active={discussionContext === "plan" ? "" : undefined}
                    onClick={() => setDiscussionPinned("plan")}
                  >
                    Plan
                  </button>
                  <button
                    type="button"
                    data-active={discussionContext === "review" ? "" : undefined}
                    onClick={() => setDiscussionPinned("review")}
                  >
                    Review
                  </button>
                </span>
              )}
              {/* Secondary count: keep it on one line, and drop it entirely when
                  the pane is too narrow to hold it (otherwise it wraps and looks
                  squished under "DISCUSSION"). */}
              {discussionContext === "plan" &&
                sidebarTab.kind === "sessions" &&
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
            {/* The sidecar pertains to what's on screen: the code review's
                annotations/questions when the review context is active, else
                the plan session's comments. Same pane, same fullscreen/zoom
                machinery — different grounding. */}
            {discussionContext === "review" ? (
              <ReviewDiscussionPane review={codeReview} />
            ) : sidebarTab.kind !== "sessions" ? (
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
                  onClick={() => setDetachDismissed(true)}
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
            <DiscussionZoomContext.Provider value={adjustDiscussionZoom}>
            {paneComments.map((c) => (
              <CommentCard
                key={`${session?.sessionId ?? ""}-${c.id}`}
                sessionId={session?.sessionId ?? ""}
                comment={c}
                focused={focusedCommentId === c.id}
                autoOpen={autoOpenCommentId === c.id}
                onAutoOpenConsumed={clearAutoOpen}
                onSelect={commentCallbacks.onSelect}
                onDelete={commentCallbacks.onDelete}
                onAccept={commentCallbacks.onAccept}
                onAcceptSuggestion={commentCallbacks.onAcceptSuggestion}
                onReopen={commentCallbacks.onReopen}
                onPromote={commentCallbacks.onPromote}
                submitInFlight={busy}
              />
            ))}
            </DiscussionZoomContext.Provider>
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
          {heldInFocusedTerm && (!termCollapsed || termFullscreen) && (
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
        sessionReady={sessionReady}
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
      {sendConfirm && (
        <SendToRedlineDialog
          markdown={sendConfirm.markdown}
          options={projectOptions}
          initialProject={sendConfirm.initialProject}
          onConfirm={confirmSendToRedline}
          onCancel={() => setSendConfirm(null)}
        />
      )}
      {toast && <ApproveToast message={toast} />}
      {inviteOpen && (
        <InviteDialog
          sharing={collabShare}
          peerCount={collabPeers}
          defaultDisplayName={relayDefaults.displayName}
          defaultSignaling={relayDefaults.signaling}
          liveRequests={reviewRequests.requests}
          connectedHashes={presentHashes}
          onCreateInvite={createLiveInvite}
          onRevoke={revokeRequest}
          onRemove={(id) => reviewRequests.remove(id)}
          mintCode={mintJoinCode}
          onStart={startShare}
          onStop={stopShare}
          onClose={() => setInviteOpen(false)}
        />
      )}
      {joinOpen && (
        <JoinDialog
          defaultDisplayName={relayDefaults.displayName}
          onJoin={joinRoom}
          onClose={() => setJoinOpen(false)}
        />
      )}
      {shareOpen && session && latest && (
        <ShareSnapshotDialog
          sessionId={session.sessionId}
          version={latest.versionNumber}
          ownerName={relayDefaults.displayName}
          currentSections={latest.sections}
          addComment={addEditorComment}
          onClose={() => setShareOpen(false)}
        />
      )}
      {memoryInspectorOpen && (
        <MemoryInspector
          onClose={() => setMemoryInspectorOpen(false)}
          activeSessionId={session?.sessionId ?? null}
          activeSessionName={session?.projectName ?? null}
        />
      )}
      {showReadme && <ReadmeModal onClose={() => setShowReadme(false)} />}
      {showFeedback && (
        <FeedbackModal onClose={() => setShowFeedback(false)} />
      )}
      {hookStatus &&
        skillStatus &&
        (!hookStatus.installed ||
          !skillStatus.installed ||
          setupPhase === "done") && (
          <HookSetupModal
            phase={
              !hookStatus.installed || !skillStatus.installed
                ? "setup"
                : "done"
            }
            hookStatus={hookStatus}
            skillStatus={skillStatus}
            onInstall={installIntegration}
            onDismiss={() => setSetupPhase("setup")}
            onShowHowItWorks={() => setHowItWorksOpen(true)}
            error={installError}
          />
        )}
      {howItWorksOpen && (
        <HowItWorksCard onClose={() => setHowItWorksOpen(false)} />
      )}
      {/* Onboarding tour: replay from the menu always, or auto-run once on first
          launch — but only after the hook/skill setup modal is out of the way,
          so the two never overlap. */}
      {(() => {
        const setupActive =
          !!hookStatus &&
          !!skillStatus &&
          (!hookStatus.installed ||
            !skillStatus.installed ||
            setupPhase === "done");
        const show = tourOpen || (!onboardingDone && !setupActive);
        if (!show) return null;
        return (
          <OnboardingTour
            onAnchorChange={handleTourAnchor}
            onClose={() => {
              setTourOpen(false);
              setOnboardingDone(true);
            }}
          />
        );
      })()}
      {/* The Companion — a root-level overlay drawer (sibling of the memory
          inspector), never part of the center-pane exclusivity dance. */}
      {companionOpen && companionCtl.active && (
        <CompanionDrawer
          companion={companionCtl.active}
          companions={companionCtl.companions}
          onSwitch={companionCtl.setActiveId}
          onNew={() => void companionCtl.create()}
          onDelete={(id) => void companionCtl.remove(id)}
          onClose={() => setCompanionOpen(false)}
        />
      )}
    </div>
    </MenuOverlayProvider>
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

function EmptyState({ title, body }: { title: string; body: ReactNode }) {
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
