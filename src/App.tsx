import { dropListener } from "./lib/dropListener";
import { useQueuedChatPlans } from "./hooks/useQueuedChatPlans";
import type { ChatPlanReceipt, ChatPlanRequest, ChatWorkbenchComposer } from "./components/ChatRoom";
import { CONTINUE_EVENT, continuationKey, continuationOrigin, prepareCompanionContinuation, type ContinuationMessage, type ContinueRequest, type ContinueDestination } from "./lib/conversationContinuation";
import { createPortal } from "react-dom";
import { createBoundedPortalHost } from "./components/PersistentPortalSlot";
import { HookConflictWarning } from "./components/HookConflictWarning";
import { useHookConflicts } from "./hooks/useHookConflicts";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { makeToast, RedlineToast, type ActiveToast, type ToastSpec } from "./components/RedlineToast";
import type { BrowserDownloadEvent } from "./lib/browserOutput";
import { DiscussionZoomContext } from "./components/DiscussionViewContext";
import { lazy, Suspense } from "react";
import { installExternalLinkHandler } from "./lib/externalLinks";
import { isClaudeWorking } from "./lib/claudeWorking";
import { heldPlanByTerminal, heldTerminalIds } from "./lib/heldTerminals";
import type { PlanEditorActions } from "./components/PlanEditor";
import type { PlanEditorCollab } from "./components/PlanEditor";
import { EmptyState } from "./components/EmptyState";
import { FrontDoor, BackendMenu as PlanningModelMenu } from "./components/FrontDoor";
import {
  applySeed,
  isEditableTarget,
  isSeedKey,
  seedStep,
  type LandingPhase,
} from "./lib/landing";
import { FRONT_DOOR_TEXT_KEY, type LaunchDestination } from "./lib/frontDoor";
import { readSharedDraft, writeSharedDraft } from "./hooks/useSharedDraft";
import { arrivalFocus, arrivalMessage, isWritingKey, ownDoorLaunch, writingNow } from "./lib/planArrival";
import { browserTarget, researchQuery, researchSearchUrl, researchSeed, ridesSubmit } from "./lib/planSearch";
import { NEWTAB as NEWTAB_URL } from "./lib/browserTitle";
import { withOptimisticComment } from "./lib/optimisticComment";
import { warmableChunk } from "./lib/warmableChunk";
import {
  attemptLaunch,
  attemptRun,
  composePrompt,
  extensionAddDirs,
  launchLiveness,
  projectForDoc,
  resolveLaunchProject,
  restoreInto,
  type DocProjectChoice,
  type LaunchOrigin,
  type LaunchRestore,
  type PendingLaunch,
  isGraduation,
  type ProjectChoice,
} from "./lib/launch";
import {
  providerRestoreBlockers,
  deriveReadiness,
  type PreflightStatus,
  type ReadinessInput,
  type ReadinessItem,
  HOOK_SILENCE_MS,
} from "./lib/readiness";
import {
  detachedBannerCopy,
  resolveRestoreHarness,
  restoreCopiedNote,
  restoreStartedNote,
  type RestoreHarness,
  type RestorePrep,
} from "./lib/restoreHarness";
import {
  canStartRestore,
  reduceRestore,
  restoreDeadlineIn,
  restoreView,
  type RestoreAttempt,
  type RestoreEvent,
} from "./lib/restoreAttempt";
import { useAutoResume, type AutoStart } from "./lib/useAutoResume";
import { useAutoNotice, useResumePills } from "./components/ResumePill";
const Footer = lazy(() => import("./components/Footer").then(m => ({ default: m.Footer })));
// The OS notifications and the Dock badge: renders nothing, and nothing in
// it is on the boot path.
const AttentionAlerts = lazy(() => import("./components/AttentionAlerts").then(m => ({ default: m.AttentionAlerts })));
import type { AlertTarget } from "./lib/attentionAlerts";
import { Header } from "./components/Header";
import { planBuildState, sessionMode } from "./lib/sessionMode";
// Carries the markdown→PM parser + block serializer (the heavy editor chain);
// only mounts when the share dialog opens.
const ShareSnapshotDialog = lazy(() =>
  import("./components/ShareSnapshotDialog").then((m) => ({
    default: m.ShareSnapshotDialog,
  })),
);
import { importSharedPlanFromUrl } from "./collab/importSharedLink";
import { deriveActiveSurface } from "./lib/activeSurface";
import {
  BROWSER_DOCK_KINDS,
  NO_BROWSER_DOCK,
  CONVERSATION_PIN_KEY,
  activeConversation,
  conversationContexts,
  dockScope, type DockScope,
  kindPill,
  migrateChatSurfaceOnce,
  pillKind,
  takeDockSeed,
  type ConversationKind,
} from "./lib/conversationContext";
import type {
  BrowserDockState,
  ChatPill,
} from "./lib/browseChatState";
import { DockContextStrip } from "./components/DockContextStrip";
// A live session's presence bar shows only while sharing or joined; its
// chunk loads then (about 5 kB of boot JS, W1).
import {
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
// Shown once, ever — the cleanest lazy win on the boot path (A0).
const OnboardingTour = lazy(() =>
  import("./components/OnboardingTour").then((m) => ({
    default: m.OnboardingTour,
  })),
);
import { PlanSearchBar, SelectionMenu } from "./components/SelectionMenu";
// Off the boot path, but warmed by the boot effect: the sessions tab is the
// sidebar's resting state, so its chunk is fetched under the parting doors
// rather than on first paint of the aside.
const loadSessionSidebar = () => import("./components/SessionSidebar");
const SessionSidebar = lazy(() =>
  loadSessionSidebar().then((m) => ({ default: m.SessionSidebar })),
);
import {
  suppressTerminalRevealFocus,
  tauriHandoffDeps,
} from "./lib/terminalSeams";
import {
  deliverToTerminal,
  PROMPT_TIMEOUT_MS,
  SHELL_PROMPT,
  type HandoffStep,
} from "./lib/terminalHandoff";
// The right rail's chrome and its collapsed edge strip (W4): one lazy chunk.
const RightRail = lazy(() => import("./workbench/RightRail").then((m) => ({ default: m.RightRail })));
const RailEdge = lazy(() => import("./workbench/RightRail").then((m) => ({ default: m.RailEdge })));
const SidebarEdge = lazy(() => import("./workbench/RightRail").then((m) => ({ default: m.SidebarEdge })));
// The rail's Discussion piles (W4): the plan's threads grouped by who owes what.
const FeedbackPanel = lazy(() => import("./components/plan/FeedbackPanel"));
// The rail's Files tab and ⌘P quick open (W4).
const FilesRail = lazy(() => import("./workbench/FilesRail"));
const QuickOpen = lazy(() => import("./workbench/QuickOpen"));
const ChangesRail = lazy(() => import("./workbench/ChangesRail"));
import { MenuOverlayProvider } from "./components/menuOverlay";
import type { DrafterSaveState } from "./components/PromptDrafter";
// Lazy: a settings pane. Its module also feeds MemorySurface (class tree +
// portability sections), so the chunk is shared with that surface's family.
const MemoryInspector = lazy(() =>
  import("./components/MemoryInspector").then((m) => ({
    default: m.MemoryInspector,
  })),
);
// Every lazy surface body's chunk, keyed by the surface that mounts it (the
// loaders live with their panes, `workbench/panes/*`). The boot effect
// prefetches the LANDING surface's entry the moment `initialSurface`
// resolves — the doors' choreography covers the fetch, so a lazy landing
// never blanks behind the parting plates (boot.test.ts pins this). Document
// warms the editor a held session would mount.
const SURFACE_CHUNK_LOADERS: Partial<
  Record<string, () => Promise<unknown>>
> = {
  document: loadPlanEditor,
  drafter: loadPromptDrafter,
  browser: loadBrowserPane,
  memory: loadMemorySurface,
  servers: loadServersPane,
  // Not a surface any more — the room is the conversation dock's Companion
  // body. Kept keyed here so the dock warms it through the same helper.
  chat: loadChatRoom,
};
function prefetchSurfaceChunk(surface: string): void {
  void SURFACE_CHUNK_LOADERS[surface]?.().catch(() => {});
}
import { useReview } from "./hooks/useReview";
import { useStableHandlers, useStableValue } from "./hooks/useStable";
import { keepEqual, keepEqualRows } from "./lib/keepEqual";
import { useTextClearance } from "./hooks/useTextClearance";
import { useDevServers } from "./hooks/useDevServers";
import {
  effectiveDiscussionContext,
  type DiscussionContext,
} from "./lib/discussionContext";
// Off the boot path: the voice dock opens on click, and its chunk (audio
// drivers + discussion surface) loads from disk in the same beat.
const VoicePanel = lazy(() =>
  import("./components/VoicePanel").then((m) => ({ default: m.VoicePanel })),
);
import type { ProjectOption } from "./components/ProjectPicker";
import { useFolderWorkspaces } from "./hooks/useFolderWorkspaces";
import { computeParagraphDiff } from "./diff";
import { blockIdByAnchorId } from "./editor/sectionMaps";
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
import { DEFAULT_THEME, THEMES, isThemeName } from "./theme/themes";
import { FONTS, SUGGESTED_FONT_FOR_THEME, isFontName } from "./theme/fonts";
import { reconcilePick, reconcileTheme } from "./theme/prefsSync";
import type { LintName } from "./theme/lint";
import { SUGGESTED_LINT_FOR_THEME, isLintName } from "./theme/lint";
import type { FontName } from "./theme/fonts";
import { usePersistedState } from "./theme/usePersistedState";
import { useResizablePane } from "./hooks/useResizablePane";
import { useAutoExitFullscreen } from "./hooks/useAutoExitFullscreen";
import { PaneDivider } from "./components/PaneDivider";
import { BoundaryFallback, ErrorBoundary } from "./components/ErrorBoundary";
import { useFrontDoorConversation } from "./hooks/useFrontDoorConversation";
import { hasChildOverlay, MonochatIsland } from "./components/MonochatIsland";
import { SurfaceChips } from "./components/SurfaceChips";
import {
  forgetSent,
  isChipPressed,
  surfaceChips,
  surfaceContextLabel,
  toggleChip,
  visibleChips,
  withContext,
  type BrowserIslandPage,
  type ChatAttachment,
  type ChipPresses,
  type ContextBlock,
  type SentContext,
} from "./lib/surfaceContext";
import { doorRecents, loadDoorTabs, type DoorRecent, type DoorTab } from "./lib/doorRecents";
import { MonochatContext } from "./components/MonochatContext";
// The terminal layer is fetched with its mount, not with the shell — see
// `terminalMounted` below — and a terminals pane's slot rides the same chunk.
// `import type` is erased, so the handle's type costs nothing.
const loadTerminalLayer = () => import("./workbench/TerminalLayer");
const TerminalLayer = lazy(() => loadTerminalLayer().then((m) => ({ default: m.TerminalLayer })));
import type { TerminalStatus, TerminalTabsHandle } from "./components/TerminalTabs";
const CloseWallDialog = lazy(() => import("./workbench/CloseWallDialog").then((m) => ({ default: m.CloseWallDialog })));
// Which terminal a session runs in, and what its CLI is doing
// (lib/sessionTerminals): the Agent tab, the sidebar's launch rows and their
// spinners read it. The dock pins itself over an Agent pane's CLI view
// (lib/stageDock).
import { attentionKinds, reduceLaunches, sidebarActivity, sidebarLaunches, useSessionTerminals, type FlowLaunch, type LaunchEvent, type LaunchProc } from "./lib/sessionTerminals";
import type { LivePty } from "./lib/terminalWorkspace";
// The comment composer opens on a gesture — a selection's menu — so it rides
// its own chunk (about 9.5 kB off the boot path), warmed the moment a
// selection shows that menu.
const loadCommentComposer = () => import("./components/CommentComposer");
const CommentComposer = lazy(() => loadCommentComposer().then((m) => ({ default: m.CommentComposer })));
import { FlashOverlay } from "./components/FlashOverlay";
// ⌘K's palette paints nothing until it opens, so it rides its own chunk,
// loaded on the first ⌘K.
const CommandPalette = lazy(() => import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
import { playInterceptBeep, DEFAULT_SOUND } from "./audio/beep";
import { buildResumeBuildCommand, buildResumeCommand, handoffPrompt } from "./lib/resumeCommand";
import { buildCommands } from "./lib/commands";
import { isCloseKey, isCloseWindowKey, isDockKey, isNeedsYouKey, isNewPlanKey, isNewTabKey, isPaletteKey, isQuickOpenKey, isRailToggleKey, isReopenTabKey, isSidebarToggleKey, isSnapBackKey, isZoomPaneKey, splitKeyOf, tabCycleKeyOf, tabIndexKeyOf, isSplitAnywhereKey } from "./lib/keymap";
import { loadDictation } from "./lib/dictationComposer";
import type { TalkContext } from "./audio/dictationHost";
import { isKnownTab, type NavTarget, type TabRequest } from "./lib/navTarget";
import { TOC_RAIL_W, TOC_RAIL_W_WIDE } from "./lib/tocRail";
import {
  defaultWorkspace,
  headerSurfaces,
  initialSurface,
  parseWorkspace,
  projectKind,
  readWorkspaceCache,
  registerProject,
  serializeWorkspace,
  setLanding,
  storeWorkspaceCache,
  surfaceEnabled,
  workspaceImmersive,
  workspaceLayout,
  type Surface,
  type ToggleableSurface,
  type Workspace,
} from "./config/workspace";
import {
  harnessHeaderSurfaces,
  harnessWorkspace,
  readActiveHarness,
  readHarnessArrangement,
  resolveHarnesses,
  storeActiveHarness,
  storeHarnessArrangement,
  type ActiveHarness,
  type HarnessEntry,
  type HarnessManifest,
} from "./lib/harness";
import { boxOf, type SwapRect } from "./lib/springSwap";
import { SpringSwap } from "./components/SpringSwap";
import { settingsRow } from "./components/SettingsMenu";
// A Settings row: lazy, in the rows' shared chunk (the header builds the rest).
const SurfacesPanel = settingsRow("SurfacesPanel");
import { NudgeCard } from "./components/NudgeCard";
import {
  dismissSuggestion,
  emptyNudgeState,
  parseNudgeState,
  recordLaunch,
  serializeNudgeState,
  suggestLanding,
  NUDGE_WINDOW_MS,
  type NudgeState,
} from "./lib/nudge";
import {
  DIVIDER_W,
  canonicalLayout,
  computePaneLayout,
  docMinFor,
  isLayoutAtRest,
  type PaneLayout,
} from "./lib/paneLayout";
import { SNAPBACK_SETTLE_MS } from "./lib/boot";
import { markOnce } from "./lib/bootMarks";
import { beginMeasure, endMeasure } from "./workbench/perf";
// The workbench (W1): the centre as per-session tab sets of typed panes.
// `store`, `persist` and the `view` selectors are the boot-path pieces
// beyond perf: App reads what the active tab shows straight off the state.
import { createWorkbenchStore, useWorkbench } from "./workbench/store";
import { bootToHome, migrateToWorkbenchOnce, persistWorkbench, readWorkbench, retireLegacyKeys } from "./workbench/persist";
import { activePanes, doorLands, findPane, focusedDoorDraftKey, kindForSurface, plateFace, selectFocusedDoorDestination, selectLayoutKey, selectStageView, selectVisibleCompanion, tileOf } from "./workbench/view";
import { needsYouTerminals, terminalStatus, wallStatus } from "./workbench/status";
import type { NeedReason } from "./lib/sessionGroups";
import { HOME_KEY, activeSessionOf, activeTabOf, layoutMinWidth, tabMinWidth, isDocumentKind, isSplit, launchIdOf, launchKey, paneIdsOf, planKey, sessionIdOf, singletonHolder, type AnyPane, type PaneInit, type PaneKind, type SessionKey, type WorkbenchState } from "./workbench/model";
import type { CliView } from "./components/agent/AgentPane";
import type { EdgeSessionTone } from "./workbench/RightRail";
import { doorDraftKey } from "./workbench/model";
import { NO_NARROW_OPEN, narrowLayoutInputs, responsivePose, settleNarrowOpen, type NarrowOpen } from "./workbench/poses";
import { RAIL_EDGE_W, SIDEBAR_EDGE_W, SIDEBAR_MIN_W, RAIL_MAX_W, RAIL_MEMORY_KEY, RAIL_MIN_W, clampRailWidth, clampSidebarWidth, parseRailMemory, railTabFor, railTabsFor, rememberRailTab, type RailMemory, type RailTab } from "./workbench/rail";
import type { OpenFileMode, WorkbenchAction } from "./workbench/reducer";
import type { OpenFileDetail } from "./lib/fileLinks";
import type { PaneContext } from "./workbench/WorkbenchStage";
// The stage and the reducer ride their own chunk, fetched as the app boots:
// the first frame needs the store and the stored state, not the actions
// that move it nor the strip that shows it (the doors cover the fetch).
const loadWorkbenchStage = () => import("./workbench/WorkbenchStage");
const WorkbenchStage = lazy(() => loadWorkbenchStage().then((m) => ({ default: m.WorkbenchStage })));
// The pane bodies (W6): one module per kind, each lazy where its body was.
import { AgentPaneView, CompanionPane, CompanionRoom, loadChatRoom } from "./workbench/panes/chat";
import { BrowserBody, BrowserPaneView, loadBrowserPane } from "./workbench/panes/browser";
import { DocZoomControl } from "./workbench/panes/docControls";
import { DoorPane } from "./workbench/panes/door";
import { DrafterPane, loadPromptDrafter, type DrafterRecovery } from "./workbench/panes/drafter";
import { FilePane } from "./workbench/panes/file";
import { MemoryPane, loadMemorySurface } from "./workbench/panes/memory";
import { PlanBody, PlanContentsRail, PlanPaneView, loadPlanEditor, loadPlanPane } from "./workbench/panes/plan";
import { ReviewPane } from "./workbench/panes/review";
import { ServersPane, loadServersPane } from "./workbench/panes/servers";
import { TerminalsPane } from "./workbench/panes/terminals";
import { Columns2 } from "lucide-react";
import { latestDisplayVersion } from "./lib/revisionVersions";
import { perfProbeOn, setPerfProbe } from "./lib/perfProbeSwitch";
import type { BootstrapState, DaemonState } from "./types";
import {
  integrationHealth,
  type HealthQuery,
  type IntegrationHealth,
} from "./lib/integrationHealth";
import { deferSkillUpdate, integrationNeedsRepair, repairIntegration, skillUpdateDeferred } from "./lib/integrationSetup";
import {
  clearDrafterShadow,
  drafterModeKey,
  readDrafterShadow,
  resolveDraftOpen,
  writeDrafterFlush,
  type DrafterSessionEntry,
} from "./lib/drafterCache";
import { useBootChoreography } from "./hooks/useBootChoreography";
/** Toggle the curtain attribute only on a real flip — `setAttribute` with an
 *  unchanged value still invalidates style, and this runs every drag frame. */
/** The parts of `ReadinessInput` that depend on WHICH launch is being judged.
 *  Everything else is closed over by `buildReadinessInput`, so the strip and
 *  the launch gate cannot drift apart. */
type ReadinessInputFor = (o: {
  preflight: PreflightStatus | null;
  /** The daemon is not known to have failed its bind. */
  daemonOk: boolean;
  projectPath: string | null;
  backend: Backend;
  now: number;
}) => ReadinessInput;

function setCurtain(el: HTMLElement | null, on: boolean): void {
  if (!el) return;
  if (on === (el.dataset.rlCurtain === "1")) return;
  if (on) el.dataset.rlCurtain = "1";
  else delete el.dataset.rlCurtain;
}

/** Write one geometry property, skipping the assignment when it already holds
 *  that value. A dock drag changes exactly one of these per frame; the other
 *  five would otherwise be re-assigned 120 times a second for nothing. */
function setGeom(
  el: HTMLElement | null,
  prop: "width" | "height" | "left" | "right",
  value: string,
): void {
  if (!el || el.style[prop] === value) return;
  el.style[prop] = value;
}
import { rafCoalesce } from "./lib/raf";
import {
  DOC_CTRL_ROW_W,
  DOC_PAD_R_NARROW,
  DOC_PAD_R_WIDE,
  docControlPose,
  DOC_MEASURE_MIN,
} from "./lib/docControl";
import {
  installWindowResizeSession,
  isResizing,
  onResizeSession,
} from "./lib/resizeSession";
import {
  buildPlanLaunchCommand,
  buildRunLaunchCommand,
  runSupported,
} from "./lib/planLaunchCommand";
import { useModelCatalogs } from "./hooks/useModelCatalogs";
import { guessProjectForPlan } from "./lib/guessProject";
import {
  agentLabelFor,
  defaultChoice as defaultBackendChoice,
  parseChoice as parseBackendChoice,
  type Backend,
  type BackendChoice,
} from "./lib/backendChoice";
import {
  deleteSource,
  importSourceFile,
  listSources,
  loadDraftDoc,
  loadShelf,
  migrateLegacyDraft,
  newDraft,
  persistDraftDoc,
  touchDraft,
  type BookshelfDraft,
  type DraftSource,
} from "./lib/bookshelf";
// Lazy: the shelf is a sheet over the drafter, opened on click.
// ── Feature islands (A0 / boot budget) ──────────────────────────────────────
//
// Everything here was a STATIC import of App, and every one of them is behind
// something the user does — not something they see. Together they were pulling
// the whole markdown-rendering stack onto the boot path: App → CommentCard →
// CommentThread → MarkdownView → markdown-it + highlight.js + entities +
// linkify-it, ~670 kB of source that a launch which never opens a comment
// never needed.
//
// The pattern is the same in each case: the TRIGGER stays static (a menu item,
// a keystroke, a surface tab), the BODY is fetched on first use.

/** The comment pane's card. Rendered only when a plan session is open and has
 *  comments — and it is the root of the markdown chain. Warmed when the
 *  composer opens, so the first card a launch shows lands in the same frame
 *  the composer closes (see `warmableChunk`). */
const commentCardChunk = warmableChunk(() =>
  import("./components/CommentCard").then((m) => ({ default: m.CommentCard })),
);
const CommentCard = lazy(commentCardChunk.load);
/** The review's discussion sidecar — a second markdown consumer. */
const ReviewDiscussionPane = lazy(
  () => import("./components/ReviewDiscussionPane"),
);
/** Modal bodies that are CLOSED at startup, by construction: each render site
 *  is `{flag && <Body/>}`, so a static import was pure boot cost. */
const ReadmeModal = lazy(() =>
  import("./components/ReadmeModal").then((m) => ({ default: m.ReadmeModal })),
);
const FeedbackModal = lazy(() =>
  import("./components/FeedbackModal").then((m) => ({
    default: m.FeedbackModal,
  })),
);
const InviteDialog = lazy(() =>
  import("./components/InviteDialog").then((m) => ({
    default: m.InviteDialog,
  })),
);
const JoinDialog = lazy(() =>
  import("./components/JoinDialog").then((m) => ({ default: m.JoinDialog })),
);
/** The unskippable first-run setup modal. Lazy is safe *because* the modal is
 *  now gated on `integrationReady` — it cannot render before the post-reveal
 *  probe answers, by which time this chunk is long since fetched. */
const IntegrationSetupDialog = lazy(() =>
  import("./components/IntegrationSetupDialog").then((m) => ({
    default: m.IntegrationSetupDialog,
  })),
);
const HookConflictModal = lazy(() =>
  import("./components/HookConflictModal").then((m) => ({ default: m.HookConflictModal })),
);
/** Ambient mode's decision countdown: shown only after a plan arrives in
 *  that mode, so nothing on the boot path needs it. */
const DecisionWindowBanner = lazy(() =>
  import("./components/DecisionWindowBanner").then((m) => ({ default: m.DecisionWindowBanner })),
);

// A confirmation that opens on a gesture, so its own chunk.
const SendToRedlineDialog = lazy(() => import("./components/SendToRedlineDialog").then((m) => ({ default: m.SendToRedlineDialog })));
import type { ManualPlanState } from "./components/PlanStateMenu";
const MoveToRepoDialog = lazy(() => import("./components/MoveToRepoDialog").then(m => ({ default: m.MoveToRepoDialog })));
import type { JSONContent } from "@tiptap/react";
import type {
  Comment,
  CommentType,
  CodexHookStatus,
  Companion,
  InterceptionMode,
  ModeEvent,
  NewCommentRequest,
  PlanDecisionWindowEvent,
  PlanReceivedEvent,
  ReviewSession,
  Section,
  SessionSummary,
  CombineBrief,
  CombinePreview,
  CombineSource,
} from "./types";

// The chat room's fold into the conversation dock (A3): a persisted
// `redline.mainSurface === "chat"` names a surface this build no longer
// renders.
migrateChatSurfaceOnce(localStorage);
// The workbench: its one-time migration from the keys it replaced (then
// retired, so nothing reads a stale surface or doc pin back), a synchronous
// read (the paint-cache rule), and boot on Home's door, with every change
// written back on a debounce.
migrateToWorkbenchOnce(localStorage);
retireLegacyKeys(localStorage);
// A cold launch lands on Home's door; a RELOAD (⌘R, HMR, the WebContent-
// crash reload) comes back where it was — the stored active set and its
// tab, over Home and over the manifest's landing. sessionStorage tells the
// two apart: it survives a reload of this webview and dies with the process
// (the rule `terminalWorkspace.ts` and the boot animation already use).
const WB_RELOAD_KEY = "redline.workbench.booted";
const wbReload = (() => {
  try {
    const again = sessionStorage.getItem(WB_RELOAD_KEY) === "1";
    sessionStorage.setItem(WB_RELOAD_KEY, "1");
    return again;
  } catch {
    return false;
  }
})();
const wb = createWorkbenchStore(!wbReload ? bootToHome(readWorkbench(localStorage)) : readWorkbench(localStorage), () => import("./workbench/reducer").then((m) => m.reduce));
persistWorkbench(wb, localStorage);
void loadWorkbenchStage().catch(() => {});
void loadPlanPane().catch(() => {});
let doorCounter = 0;
const selectActiveKey = (s: WorkbenchState) => s.activeKey;
/** What the tab on screen asks of the stage (D40): its focused pane's
 *  minimum, or its split's panes at theirs. */
const selectStageMin = (s: WorkbenchState) => {
  const set = s.sets[s.activeKey];
  return set ? tabMinWidth(activeTabOf(set), set.panes) : 0;
};
/** The tab on screen and its whole layout's minimum, zoom aside: what the
 *  stage's automatic zoom is measured against. */
const selectStageFit = (s: WorkbenchState) => {
  const set = s.sets[s.activeKey];
  const tab = set && activeTabOf(set);
  return tab ? `${s.activeKey}|${tab.id}|${layoutMinWidth(tab.root, set.panes)}` : "";
};
/** The widest the stage can be at this window, both side columns folded to
 *  their edges (D40): a split or a merge whose panes cannot all keep their
 *  minimums in it is refused; one that fits folds what it must. */
const stageRoom = () => window.innerWidth - SIDEBAR_EDGE_W - RAIL_EDGE_W - 2 * DIVIDER_W;
/** The quiet hint a refused split or merge leaves. */
const NO_ROOM_HINT = "No room for another pane here — widen the window";
const newDoorPaneId = () => `door-${Date.now().toString(36)}-${(doorCounter++).toString(36)}`;

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

// The Front Door's sentence, read and written WITHOUT subscribing to it: the
// composer owns it, and App touches it only when something is sent, cleared
// or handed back.
// Under the workbench each door pane has a draft of its own; App keeps the
// focused door's key here (set each render) so a launch reads and clears
// the sentence of the door it came from. Home's first door and a chat's
// compact composer share the Front Door's key.
let doorSentenceKey = FRONT_DOOR_TEXT_KEY;
const getFrontDoorText = () => readSharedDraft(doorSentenceKey);
const setFrontDoorText = (text: string) => writeSharedDraft(doorSentenceKey, text);
const selectFocusedDoorDraftKey = (state: WorkbenchState): string => focusedDoorDraftKey(state, FRONT_DOOR_TEXT_KEY);

function App() {
  // The Front Door. Every launch starts with it SHUT: on the document's empty
  // plate it rests there instead — headline, composer and recents in the
  // plate's free area — without taking the caret (typing with nothing focused
  // flows into it). Opening it is always a gesture: Shift+Enter, ⌘J, ⌘⇧N, a
  // press or a keystroke in the resting composer (D27 took the footer pill;
  // ⌘T, the palette and the sidebar's New tab open a door tab). The chat-surface seed is still
  // consumed so its key can't linger.
  const [frontDoorOpen, setFrontDoorOpen] = useState(() => {
    takeDockSeed(localStorage);
    return false;
  });
  // Fresh view of it for listeners: the open door is where you are, caret
  // or not, so a plan arriving flashes over it — unless it is the one you
  // launched from it (`doorLaunchRef`).
  const frontDoorOpenRef = useRef(frontDoorOpen);
  frontDoorOpenRef.current = frontDoorOpen;
  // The plan launch the open door is showing in place since its ⏎. When that
  // plan lands with nothing new begun in the door, the door hands off into it
  // (`doorHandoff`): it fades where it is while the plan springs out of its
  // composer. Cleared when the door closes or takes up a chat.
  const doorLaunchRef = useRef<string | null>(null);
  // Under the workbench: the door TAB a plan was launched from. When the
  // plan arrives the tab retires (the plan opens in its own set) unless it
  // is the set's only tab — Home always keeps a door.
  const doorLaunchTabRef = useRef<{ launchId: string; key: SessionKey; tabId: string } | null>(null);
  const noteDoorLaunchTab = useCallback((launchId: string | null | undefined) => {
    if (!launchId) return;
    const { key, set, tab } = activePanes(wb.getState());
    const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
    if (focused?.kind === "door" && tab) doorLaunchTabRef.current = { launchId, key, tabId: tab.id };
  }, []);
  const retireDoorLaunchTab = useCallback((launchId: string | null | undefined) => {
    const noted = doorLaunchTabRef.current;
    if (!noted || !launchId || noted.launchId !== launchId) return;
    doorLaunchTabRef.current = null;
    const set = wb.getState().sets[noted.key];
    if (!set || set.order.length < 2 || !set.tabs[noted.tabId]) return;
    wb.dispatch({ type: "closeTab", key: noted.key, tabId: noted.tabId });
  }, []);
  const [doorHandoff, setDoorHandoff] = useState(false);
  useEffect(() => {
    if (frontDoorOpen) setDoorHandoff(false);
    else doorLaunchRef.current = null;
  }, [frontDoorOpen]);
  // A place the user asked for on the surface they already stand on — a plan
  // from the palette, a recent, a chat's receipt, a notice's Open — is
  // navigation all the same. It is part of the door's navigation key
  // (`doorNavKey`), so whatever is open closes behind them and the caret
  // lands in the main area. A plan merely arriving never counts.
  const [doorTrip, setDoorTrip] = useState(0);
  const tripDoor = useCallback(() => setDoorTrip((n) => n + 1), []);
  // The door is up: open, or resting on the empty plate.
  const [doorVisible, setDoorVisible] = useState(false);
  // The island's polite status line: a launch handed off, a plan arrived. The
  // same words twice are nudged apart so a screen reader reads them again.
  const [doorNews, setDoorNews] = useState("");
  const announceDoor = useCallback((text: string) => setDoorNews(news => news === text ? `${text}\u00a0` : text), []);
  // One launch through the door at a time: a context read can make the
  // hand-off take a beat, and a second ⏎ inside it must not launch twice.
  const frontDoorLaunchingRef = useRef(false);
  // The browser tab the card would quote, as the pane reports it.
  const [browserIslandPage, setBrowserIslandPage] = useState<BrowserIslandPage | null>(null);
  // The context chips the user flipped, for the surface they flipped them on.
  const [chipPresses, setChipPresses] = useState<ChipPresses>({ surfaceKey: "", on: {} });
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  // The selected session: the workbench's active set (`StageView.activeId`),
  // plus the collab joined key — a room with no session key of its own —
  // kept beside it.
  const view = useWorkbench(wb, selectStageView);
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const activeId: string | null = joinedId ?? view.activeId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // The browser's owner filter (W5, lib/browserOwner): the session on screen
  // — its plan's, else the launch whose set is in front — tags the pages it
  // opens, and its browser pane lists them first. Home is no owner. One
  // workspace serves every session; this never swaps it.
  const wbActiveKey = useWorkbench(wb, selectActiveKey);
  const browserOwner: string | null = view.activeId ? planKey(view.activeId) : launchIdOf(wbActiveKey) ? wbActiveKey : null;
  const browserOwnerRef = useRef(browserOwner);
  browserOwnerRef.current = browserOwner;
  // The one writer, in both forms (`leaveJoined` passes an updater). D29: a
  // session is OPENED, never switched to — its Plan tab opens in the set on
  // screen, or comes forward if that set has it (`openInActive`); the strip
  // stays. "No session" is Home's set. The per-session sets stay behind the
  // strip: "Open as workspace" (`openWorkspace`) is the old switch.
  const setActiveId = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    const value = typeof next === "function" ? next(activeIdRef.current) : next;
    // "No session" is Home only on Home: a launch's set has no session id
    // either, and Home pressed there must still go Home.
    if (value === null && activeIdRef.current === null && wb.getState().activeKey === HOME_KEY) return;
    if (value && isJoinedSessionId(value)) {
      // `joined:<sid>:<threadStart>`: the room shows in the plan set of the
      // session it mirrors, its Plan tab in front.
      setJoinedId(value);
      const sid = value.split(":")[1];
      if (sid) wb.dispatch({ type: "selectSession", key: planKey(sid) });
      return;
    }
    setJoinedId(null);
    if (!value) {
      wb.dispatch({ type: "selectSession", key: HOME_KEY });
      return;
    }
    // A no-op when it is the tab in front: the load effect below keys on
    // `activeId`, so nothing loads twice.
    wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: value, version: null } } });
  }, []);
  /** A session's own pane (its Agent tab, a launch's), opened as a tab in
   *  the set on screen (D29). */
  const openSessionPane = useCallback((pane: PaneInit) => {
    setJoinedId(null);
    wb.dispatch({ type: "openInActive", pane });
  }, []);
  /** "Open as workspace" (D29): the session's own set, its Plan, Agent and
   *  Terminals tabs — the switch a row click used to be. */
  const openWorkspace = useCallback((sessionId: string) => {
    setJoinedId(null);
    wb.dispatch({ type: "selectSession", key: planKey(sessionId), defaults: { agentTerminalId: sessionTerminalsRef.current.get(sessionId) ?? null } });
  }, []);
  const sessionTerminalsRef = useRef<ReadonlyMap<string, string>>(new Map());
  // Count of open header dropdowns (theme, mode, alerts, download). Handed to
  // the browser pane (`menuOver`) so the native webview steps aside while a
  // menu is up — otherwise the OS-composited webview paints over the DOM
  // menu — behind a fresh picture of its page. Dropdowns register via the
  // MenuOverlayProvider / useMenuOverlay context.
  const [openMenuCount, setOpenMenuCount] = useState(0);
  const adjustMenuOverlay = useCallback(
    (delta: number) => setOpenMenuCount((c) => Math.max(0, c + delta)),
    [],
  );
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [movePlan, setMovePlan] = useState<ReviewSession | null>(null);
  // ── The four readiness axes ───────────────────────────────────────────────
  //
  // There used to be one global `loading` boolean covering everything boot
  // did, which is why a hook-file diff and a `codex --help` could hold the
  // front door shut. Four independent questions, four answers, and a surface
  // waits on exactly the one it needs:
  //
  //   shellReady        the core bootstrap resolved — a surface can render and
  //                     take a keystroke.                (`!loading`, below)
  //   sessionReady      the held plan is loaded.         (declared with it)
  //   integrationReady  hooks/skills/binaries answered.  (`preflight !== null`)
  //   terminalReady     the dock has a live PTY.         (the dock reports it)
  //
  // Nothing here is the boot ANIMATION, which gates none of them.
  const [loading, setLoading] = useState(true);
  /** The core bootstrap resolved. The front door renders and focuses on this
   *  and nothing else. */
  const shellReady = !loading;
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
  // Fresh view of it for the arrival rule, read inside a listener.
  const viewedVersionRef = useRef(viewedVersionNumber);
  viewedVersionRef.current = viewedVersionNumber;
  const [warning, setWarning] = useState<ResolutionWarning | null>(null);
  const [askModeViolation, setAskModeViolation] = useState<boolean>(false);
  // How far this window's daemon got binding :7676. Three states, not a
  // boolean: a bind in flight is not a failure, and the old boolean had to
  // default to `true` to avoid flashing a scary banner — which made the
  // optimistic guess indistinguishable from the real answer, so nothing could
  // legitimately WAIT for readiness. Rendering ignores this entirely; a
  // launch awaits `"ready"`, and only `"failed"` raises the banner.
  const [daemonState, setDaemonState] = useState<DaemonState>("starting");
  const daemonBound = daemonState !== "failed";
  // The detached banner's manual dismiss. The detached state itself is
  // derived from the active session's persisted `attachState` (see below) so
  // it survives app restarts and background-session detaches; this flag only
  // hides the banner until the next session switch / plan arrival.
  const [detachDismissed, setDetachDismissed] = useState<boolean>(false);
  // Most toasts are a bare confirmation string. A few report something the app
  // deliberately declined to do for you and must carry the way to do it, so the
  // state accepts the richer spec too.
  // ONE toast slot. Each toast carries an id and owns its own timer
  // (`RedlineToast`), so a call site only ever says what to show — and a
  // stale dismissal can never clear a newer toast.
  const [toast, setToastState] = useState<ActiveToast | null>(null);
  const toastSeq = useRef(0);
  const setToast = useCallback((t: string | ToastSpec | null, durationMs?: number | null) => {
    setToastState(t === null ? null : makeToast(t, ++toastSeq.current, durationMs));
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToastState((cur) => (cur?.id === id ? null : cur));
  }, []);
  const [codexHookStatus, setCodexHookStatus] =
    useState<CodexHookStatus | null>(null);
  // First-run setup modal: "setup" until an in-app install fully succeeds,
  // then "done" shows the one-time what-now explainer until dismissed.
  const [setupPhase, setSetupPhase] = useState<"setup" | "done">("setup");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const installBusyRef = useRef(false);
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [setupBackend, setSetupBackend] = useState<Backend | null>(null);
  const [setupProject, setSetupProject] = useState<string | null>(null);
  const [setupReviewInTerminal, setSetupReviewInTerminal] = useState(false);
  // The setup dialog opens by itself once, on a true first run; set aside
  // ("Later", "Done"), it never pops again. Later faults wait in the
  // composer as a fix-it chip, and the dialog comes back when ⏎ is blocked
  // on one or the chip is pressed.
  const [setupDismissed, setSetupDismissed] = usePersistedState("redline.setupDismissed", false);
  const setupContinuation = useRef<((ready: boolean) => void) | null>(null);
  // Why the dialog is up when a send raised it: "skill-stale" alone makes
  // "Later" an answer (send with the installed skills, remembered for the app
  // run) rather than a refusal, so a send can never loop on it.
  const [setupReason, setSetupReason] = useState<ReadinessItem["id"] | null>(null);
  const [skillDeferTick, setSkillDeferTick] = useState(0);
  const requestSetup = useCallback((backend: Backend, projectPath: string | null = null, reason: ReadinessItem["id"] | null = null): Promise<boolean> => {
    if (setupContinuation.current || installBusyRef.current) return Promise.resolve(false);
    setSetupPhase("setup"); setInstallError(null); setSetupBackend(backend); setSetupReason(reason);
    setSetupProject(projectPath); setSetupReviewInTerminal(false);
    return new Promise(resolve => { setupContinuation.current = resolve; });
  }, []);
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
  // Flow keeps its own, closed until asked for: the plan panel opens as the
  // boards draw it, and "☰ Contents" in its header is one click away.
  const [tocOpen, setTocOpen] = usePersistedState("redline.tocOpen", true);
  // Rail width: two snap points (230 / 340). `tocWide` is the persisted snap;
  // the transient width during a drag is written straight onto the rail and the
  // scroller, and release snaps to whichever point is nearer (see snapTocWide).
  const [tocWide, setTocWide] = usePersistedState("redline.tocWide", false);
  // Drag state is a boolean, not a width: the width itself is written straight
  // to the DOM so the plan column doesn't re-render per frame. This only
  // suppresses the settle transition for the duration of the drag.
  const [tocDragging, setTocDragging] = useState(false);
  const [flashEnabled, setFlashEnabled] = usePersistedState(
    "redline.flashOnIntercept.enabled",
    false,
  );
  const [flashColor, setFlashColor] = usePersistedState(
    "redline.flashOnIntercept.color",
    // Empty: the amber token (`flashPaint`), never a hard-coded red.
    "",
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
  // The four size keys below (plus BrowserPane's chat ratio) are written by
  // drag paths. Without a debounce every commit ran a synchronous
  // JSON.stringify + localStorage.setItem on the main thread mid-drag.
  const [sidebarWidthPref, setSidebarWidth] = usePersistedState(
    "redline.sidebar.width",
    240,
    { debounceMs: 250 },
  );
  // The shape flags below are the PERSISTED preference — what the user last
  // chose. The responsive poses (`workbench/poses.ts`) derive the names every
  // read site uses (`sidebarCollapsed`, …) further down; a resize never
  // writes the preference.
  const [sidebarCollapsedPref, setSidebarCollapsed] = usePersistedState(
    "redline.sidebar.collapsed",
    false,
  );
  // The right rail's width (W4: the Discussion pane became the rail). Read
  // through the rail's 280–600 px bounds, so a width stored before them is
  // never drawn outside.
  const [paneWidthPref, setPaneWidth] = usePersistedState(
    "redline.commentPane.width",
    320,
    { debounceMs: 250 },
  );
  const paneWidth = clampRailWidth(paneWidthPref);
  const [paneCollapsedPref, setPaneCollapsed] = usePersistedState(
    "redline.commentPane.collapsed",
    false,
  );
  const [paneFullscreenPref, setPaneFullscreen] = usePersistedState(
    "redline.commentPane.fullscreen",
    false,
  );
  // Which artifact the Discussion sidecar pertains to (plan comments vs the
  // code review's annotations/questions). Only consulted in a true split —
  // see `effectiveDiscussionContext`.
  const [discussionPinned, setDiscussionPinned] =
    usePersistedState<DiscussionContext>("redline.discussion.context", "plan");
  // What the active tab shows, in the manifest's vocabulary
  // (`workbench/view.ts`): a surface pane's kind, or "document" for the
  // plate's faces, a wall and an agent chat. It does NOT follow focus:
  // clicking the plan half of a plan + browser tile must not hide the
  // webview. A divider drag in the stage is a resize session: the browser
  // pane takes its picture, then steps aside for it (BrowserPane).
  const stageSurface: Surface = view.surface;
  // What the workbench does for `selectSurface(next)`, bound below once the
  // state it reads (the drafter's document, the review) exists.
  const openInWorkbenchRef = useRef<(next: Surface) => void>(() => {});
  const browserOpen = stageSurface === "browser";
  // The chat is ONE mounted room in two places: the door's slot while the
  // door holds it, the conversation dock's once it was carried out. The host
  // moves between them; the conversation in it never remounts.
  const [chatHost] = useState(() => createBoundedPortalHost("conversation"));
  const [chatDockSlot, setChatDockSlot] = useState<HTMLDivElement | null>(null);
  const [browserHost] = useState(() => createBoundedPortalHost("browser"));
  // The plan body is a per-session singleton like the browser (decision
  // D3): one editor, one pair of refs, mounted once in this host; a plan
  // pane shows its slot, and the visible, focused one holds it. A second
  // plan pane of the same session shows where it is and can bring it here.
  const [planHost] = useState(() => createBoundedPortalHost("plan"));
  const [planHolder, setPlanHolder] = useState<string | null>(null);
  const [browserHolder, setBrowserHolder] = useState<string | null>(null);
  const [browserMounted, setBrowserMounted] = useState(browserOpen);
  useEffect(() => { if (browserOpen) setBrowserMounted(true); }, [browserOpen]);
  const drafterOpen = stageSurface === "drafter";
  const reviewOpen = stageSurface === "review";
  const serversOpen = stageSurface === "servers";
  const memoryOpen = stageSurface === "memory";
  const chatOpen = stageSurface === "chat";
  // The one way any surface comes forward — the door's destinations, the
  // palette and every programmatic open funnel through here. Hands the
  // Discussion sidecar to the review on enter / back to the plan on leave.
  const selectSurface = useCallback(
    (next: Surface) => {
      if (next === "review" && stageSurface !== "review") {
        setDiscussionPinned("review");
      } else if (next !== "review" && stageSurface === "review") {
        setDiscussionPinned("plan");
      }
      openInWorkbenchRef.current(next);
    },
    [stageSurface, setDiscussionPinned],
  );
  // Fresh view of selectSurface for mount-once listeners (review-requested).
  const selectSurfaceRef = useRef(selectSurface);
  selectSurfaceRef.current = selectSurface;
  // The workspace manifest — ~/.redline/workspace.json, the file that makes
  // this build *yours*: which surfaces exist, header order, landing surface.
  // GUI–file duality: the file is the store, this state is the lens; every
  // customization gesture funnels through updateWorkspace, which rewrites the
  // file. The initializer reads the PAINT CACHE (the mirrored last-loaded
  // manifest text, localStorage — synchronous) so the very first render
  // composes the user's real header instead of the stock one; the
  // authoritative file read lands in the boot effect and confirms or
  // corrects it. Same contract as the theme cache in index.html.
  const [workspace, setWorkspace] = useState<Workspace>(
    () => readWorkspaceCache(localStorage) ?? defaultWorkspace(),
  );
  // Harness mode (A5) — one mechanism, two entry points: entered from the
  // Front Door (exit shown) or by a flavored build at boot (exit hidden).
  // Active state + the per-harness arrangement live in localStorage, NOT
  // workspace.json: the WebKit store is identifier-scoped so it splits per
  // flavor, while ~/.redline is HOME-resolved and shared — user state must
  // never direct another flavor's boot. Synchronous reads double as the
  // no-stock-header-flash fix; the boot effect re-resolves the manifest
  // from its source (fixture / ~/.redline/harnesses) and corrects the cache.
  const [activeHarness, setActiveHarness] = useState<ActiveHarness | null>(
    () => readActiveHarness(localStorage),
  );
  const [harnessDelta, setHarnessDelta] = useState<Workspace>(() => {
    const active = readActiveHarness(localStorage);
    return active
      ? readHarnessArrangement(localStorage, active.manifest.id)
      : {};
  });
  const [harnessList, setHarnessList] = useState<HarnessManifest[]>(() =>
    resolveHarnesses([]),
  );
  const activeHarnessRef = useRef(activeHarness);
  activeHarnessRef.current = activeHarness;
  // What the UI composes from: the harness's arrangement while inside one,
  // the user's own manifest otherwise. Layout knobs (snap-back overrides,
  // arrival opt-out) deliberately keep reading the STOCK manifest — they
  // are user chrome, not part of a harness's surface set.
  const effectiveWorkspace = useMemo(
    () =>
      activeHarness
        ? harnessWorkspace(activeHarness.manifest, harnessDelta)
        : workspace,
    [activeHarness, harnessDelta, workspace],
  );
  const updateWorkspace = useCallback(
    (fn: (ws: Workspace) => Workspace) => {
      // Inside a harness the same gestures arrange THE HARNESS: the result
      // persists per harness id in localStorage, and workspace.json — the
      // stock arrangement — is never written from harness mode.
      const active = activeHarnessRef.current;
      if (active) {
        setHarnessDelta((prev) => {
          const base = harnessWorkspace(active.manifest, prev);
          const next = fn(base);
          if (next === base) return prev;
          storeHarnessArrangement(localStorage, active.manifest.id, next);
          return next;
        });
        return;
      }
      setWorkspace((prev) => {
        const next = fn(prev);
        if (next !== prev) {
          const json = serializeWorkspace(next);
          storeWorkspaceCache(localStorage, json);
          void invoke("save_workspace", { json }).catch(() => {});
        }
        return next;
      });
    },
    [],
  );
  const headerSurfaceList = useMemo(
    () =>
      activeHarness
        ? harnessHeaderSurfaces(effectiveWorkspace, activeHarness.manifest)
        : headerSurfaces(effectiveWorkspace),
    [activeHarness, effectiveWorkspace],
  );
  // The door tab's "Open" destinations (W1): what the header radio used to
  // offer, so the manifest and a harness still say which surfaces exist.
  const doorOpenTargets = useMemo(
    () => headerSurfaceList.filter((s) => s.id !== "document" && s.id !== "chat").map((s) => ({ id: s.id, label: s.label })),
    [headerSurfaceList],
  );
  // Workspace-nudge bookkeeping (src/lib/nudge.ts): the launch-habit history
  // feeding the one quiet suggestion. Loaded with the other DB prefs; every
  // change writes back so "fires at most once" survives restarts.
  const [nudgeState, setNudgeState] = useState<NudgeState>(() =>
    emptyNudgeState(),
  );
  const saveNudgeState = useCallback((next: NudgeState) => {
    setNudgeState(next);
    void invoke("set_ui_pref", {
      key: "workspaceNudge",
      value: serializeNudgeState(next),
    }).catch(() => {});
  }, []);
  const nudgeStateRef = useRef(nudgeState);
  nudgeStateRef.current = nudgeState;
  // Launch-habit watcher: after boot settles, the FIRST surface switch inside
  // the watch window is this launch's habit sample. One sample per launch.
  const launchWatchRef = useRef<{
    from: Surface;
    startedAt: number;
    done: boolean;
  } | null>(null);
  useEffect(() => {
    const watch = launchWatchRef.current;
    if (!watch || watch.done) return;
    if (stageSurface === watch.from) return;
    watch.done = true;
    if (Date.now() - watch.startedAt <= NUDGE_WINDOW_MS) {
      saveNudgeState(recordLaunch(nudgeStateRef.current, stageSurface));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSurface]);
  const nudgeSuggestion = useMemo(
    () => suggestLanding(nudgeState, workspace),
    [nudgeState, workspace],
  );
  const voiceEnabled = surfaceEnabled(effectiveWorkspace, "voice");
  const chatEnabled = surfaceEnabled(effectiveWorkspace, "chat");
  // Fresh view of stageSurface for the boot-time landing decision.
  const stageSurfaceRef = useRef(stageSurface);
  stageSurfaceRef.current = stageSurface;
  // Enter a harness: pure recomposition — cache the manifest so the NEXT
  // launch's first render already composes it (no stock-header flash), load
  // this harness's saved arrangement, land on its landing surface. No
  // command runs on entry or exit (harness.test.ts pins the ban): a held
  // ExitPlanMode plan lives behind the daemon, and a path that never reaches
  // the daemon cannot strand it.
  const enterHarness = useCallback(
    (manifest: HarnessManifest, entry: HarnessEntry = "user") => {
      const active: ActiveHarness = {
        manifest,
        entry,
        returnSurface: stageSurfaceRef.current,
      };
      const delta = readHarnessArrangement(localStorage, manifest.id);
      storeActiveHarness(localStorage, active);
      setActiveHarness(active);
      setHarnessDelta(delta);
      const target = initialSurface(
        harnessWorkspace(manifest, delta),
        stageSurfaceRef.current,
      );
      prefetchSurfaceChunk(target);
      selectSurfaceRef.current(target);
    },
    [],
  );
  // Exit lands back where the user stood at entry — if stock Redline still
  // shows that surface; the document (always present) otherwise.
  const exitHarness = useCallback(() => {
    const leaving = activeHarnessRef.current;
    if (!leaving) return;
    storeActiveHarness(localStorage, null);
    setActiveHarness(null);
    setHarnessDelta({});
    const back = leaving.returnSurface;
    const target =
      back && headerSurfaces(workspace).some((d) => d.id === back)
        ? (back as Surface)
        : "document";
    prefetchSurfaceChunk(target);
    selectSurfaceRef.current(target);
  }, [workspace]);
  // A5a's edit loop. A link-installed harness is read THROUGH its link on
  // every scan, so a re-list is a re-read: re-resolving on window focus
  // means "edit harness.json in your editor, refocus Redline, the change
  // is live" — no watcher, no restart. The same pass corrects the active
  // harness (renamed → fresh manifest; unlinked/deleted → clean exit to
  // stock, with the eviction effect below rehoming a stranded surface).
  const harnessFlavorRef = useRef<string | null>(null);
  const harnessListJsonRef = useRef("");
  const bootstrapDoneRef = useRef(false);
  const applyHarnessResolution = useCallback(
    (installed: { id: string; json: string }[]): ActiveHarness | null => {
      const harnesses = resolveHarnesses(installed);
      const listJson = JSON.stringify(harnesses);
      if (listJson !== harnessListJsonRef.current) {
        harnessListJsonRef.current = listJson;
        setHarnessList(harnesses);
      }
      // The BUILD wins ("the build says which harness"): a flavored binary
      // boots into its harness with the exit hidden, and no user state can
      // redirect it. Otherwise a user-entered harness is re-resolved from
      // its source.
      const flavor = harnessFlavorRef.current;
      const cached = activeHarnessRef.current;
      let resolved: ActiveHarness | null = null;
      if (flavor) {
        const manifest = harnesses.find((h) => h.id === flavor) ?? null;
        resolved = manifest ? { manifest, entry: "boot" } : null;
      } else if (cached && cached.entry !== "boot") {
        const manifest =
          harnesses.find((h) => h.id === cached.manifest.id) ?? null;
        resolved = manifest ? { ...cached, manifest } : null;
      }
      // Unchanged resolution = no state churn: focus fires often, App
      // re-renders are not free, and the delta can only have moved through
      // updateWorkspace, which already set it.
      if (JSON.stringify(resolved) === JSON.stringify(cached)) {
        return cached;
      }
      storeActiveHarness(localStorage, resolved);
      setActiveHarness(resolved);
      setHarnessDelta(
        resolved
          ? readHarnessArrangement(localStorage, resolved.manifest.id)
          : {},
      );
      return resolved;
    },
    [],
  );
  const refreshHarnesses = useCallback(() => {
    if (!bootstrapDoneRef.current) return;
    void invoke<{ id: string; json: string }[]>("list_harnesses")
      .then(applyHarnessResolution)
      .catch(() => {});
  }, [applyHarnessResolution]);
  useEffect(() => {
    // Focus is the editor loop; the DOM event is the Extensions panel
    // announcing an install/unlink that happened without a refocus.
    window.addEventListener("focus", refreshHarnesses);
    window.addEventListener("redline:harnesses-changed", refreshHarnesses);
    return () => {
      window.removeEventListener("focus", refreshHarnesses);
      window.removeEventListener("redline:harnesses-changed", refreshHarnesses);
    };
  }, [refreshHarnesses]);
  // Hiding a surface you're standing on sends you to the document; the
  // header entry is already gone, so staying would strand the pane with no
  // way back. (Only manifest changes trigger this — programmatic opens like
  // review-requested still work on a hidden surface by design: a blocking
  // agent review must never be stranded by a cosmetic hide.) Reads the
  // EFFECTIVE manifest, so entering a harness that removes the surface you
  // are on bounces you to the document — the held plan's home — not into a
  // pane with no header entry.
  useEffect(() => {
    if (
      stageSurface !== "document" &&
      !surfaceEnabled(effectiveWorkspace, stageSurface as ToggleableSurface)
    ) {
      selectSurfaceRef.current("document");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveWorkspace]);
  // The Prompt Drafter — a Word-style authoring surface selected into the
  // center pane. Its draft (Tiptap JSON) and the project it launches into
  // persist across reloads.
  // The conversation's host is the rail's Talk tab (W4): it is "open" when
  // the rail shows Talk, and `conversationContext.ts` still decides WHICH
  // conversation it holds — the same shape `stageSurface` gave the center plate.
  const dockScopeRef = useRef<DockScope | null>(null);
  // The conversation the user asked to see as a ROOM rather than as the column
  // beside a surface — the kind, not a boolean, so the pose can be decided
  // before the context list exists (the mask is computed high up, and a read
  // above its block is a type error rather than a silently wrong value).
  // Never persisted, and cleared by `selectSurface`: coming back to the
  // document later must not find a room you did not ask to re-enter.
  // Which conversation the user pinned when a surface offers several. A
  // TIE-BREAK only (`activeConversation`), never an override: a pin naming a
  // kind this surface hasn't got is ignored rather than obeyed into an empty
  // dock.
  const [conversationPin, setConversationPin] = usePersistedState<
    ConversationKind | null
  >(CONVERSATION_PIN_KEY, null);
  // What the browser pane says is beside it: the discussion tab, the linked
  // thread, the mission. Ids only — the panels themselves stay in the pane and
  // are portalled into the dock's slot. Reset when the pane unmounts, so a
  // stale tab title can't label a context that is no longer on screen.
  const [browserDock, setBrowserDock] =
    useState<BrowserDockState>(NO_BROWSER_DOCK);
  // The dock's DOM node for those panels. State, not a ref: the pane needs to
  // re-render once the node exists, and a ref would never tell it.
  const [dockSlotEl, setDockSlotEl] = useState<HTMLDivElement | null>(null);
  // The rail's Discussion slot for a drafter pane (W4): the draft's comment
  // threads portal in; the page's margin keeps only their anchors.
  const [drafterDiscussionSlot, setDrafterDiscussionSlot] = useState<HTMLDivElement | null>(null);
  // A discussion is actually going on in the open voice panel (reported by it).
  // Refs, because the `plan-received` listener is mount-scoped on `activeId` and
  // must read both without re-subscribing on every keystroke of a conversation.
  const [discussionLive, setDiscussionLive] = useState(false);
  const discussionLiveRef = useRef(false);
  discussionLiveRef.current = discussionLive;
  // "The reviewer is mid-conversation about THIS plan" — the one case where an
  // intercepted plan for another session must not steal focus. Assigned from
  // the dock derivation far below, so it tracks the live context rather than
  // the raw open bit (the dock being up over a DRAFT is not that case).
  const planVoiceOpenRef = useRef(false);
  // Sessions whose intercepted plan we did NOT switch to (a live discussion was
  // in the way). Drives the sidebar's pulsing dot until the row is selected.
  // A one-shot glow on the sidebar row of a plan that arrived while you were
  // reading another one. Nonce'd so a second arrival glows again.
  const [arrivalGlow, setArrivalGlow] = useState<{ sessionId: string; nonce: number } | null>(null);
  const [unseenPlanIds, setUnseenPlanIds] = useState<Set<string>>(
    () => new Set(),
  );
  // When the user last typed into a text field (never the terminal): the
  // arrival rule's writing clock (lib/planArrival's `writingNow`).
  const typedAtRef = useRef(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (isWritingKey(event.target)) typedAtRef.current = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // The document itself lives in the DB now (the Bookshelf owns it) — this is
  // just the loaded copy for the open document, TAGGED with the id it belongs
  // to. The tag is the editor's mount gate: TipTap captures `content` once, at
  // creation, so mounting before the right doc is in hand would open a blank
  // (or someone else's) document over a real one — `forId` makes the
  // transient doc-switch hazard unrepresentable rather than merely guarded.
  const [drafterLoaded, setDrafterLoaded] = useState<{
    forId: string;
    doc: JSONContent | null;
  } | null>(null);
  // A third loading state: the app died between a keystroke and its write, and
  // the user has to choose which copy is the document. Rendered as a card in
  // place of the body — the same shape the "Opening…" gate already is.
  const [drafterRecovery, setDrafterRecovery] = useState<DrafterRecovery | null>(null);
  // Latest content ever on screen per draft id, for this app run. Written on
  // every persist flush; consulted before the DB on every open. In-session,
  // in-memory ≥ DB always — during the persist retry window the DB is behind,
  // and refetching there would resurrect the stale-remount data loss plus
  // spurious recovery prompts (see lib/drafterCache).
  const drafterSessionCache = useRef(new Map<string, DrafterSessionEntry>());
  // The open document's project, TAGGED with the document it belongs to.
  //
  // The untagged `string | null` this replaces conflated "the user explicitly
  // chose Home" with "I haven't loaded this document yet" — which is exactly
  // why the load effect guarded with `if (path)` and never reset, and why
  // switching from a document in /repo/x to one with none permanently
  // reassigned the second AND launched its prompt into the wrong cwd. Not
  // persisted: it is a projection of the row, and the row is the truth.
  const [drafterProject, setDrafterProject] = useState<DocProjectChoice>(null);
  // The repo the last successful launch shipped into — through ANY door, which
  // is why it is no longer `lastDrafterProject`. Seeds the next launch's
  // resolution when nothing more specific answers.
  const [lastLaunchProject, setLastLaunchProject] = usePersistedState<
    string | null
  >("redline.lastLaunchProject", null);
  // One-time seed from the key this replaced, so an existing user's last repo
  // isn't forgotten on upgrade. Runs once; a real launch overwrites it after.
  const lastLaunchSeeded = useRef(false);
  useEffect(() => {
    if (lastLaunchSeeded.current) return;
    lastLaunchSeeded.current = true;
    if (lastLaunchProject !== null) return;
    try {
      const old = localStorage.getItem("redline.drafter.project");
      const path = old ? (JSON.parse(old) as string | null) : null;
      if (path) setLastLaunchProject(path);
    } catch {
      /* absent or unparseable — nothing to carry forward */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── The floating launch composer (existing preference keys are retained) ──────────────────────────────────────────────────────
  // All of these are PERSISTED, not plain useState. A half-typed prompt has
  // to survive a surface switch, a pane toggle and a reload — a front door
  // that eats your sentence is exactly the small betrayal this whole surface
  // exists to remove. The pending launch itself deliberately does NOT
  // persist: a stale "Planning…" card must not outlive a restart.
  //
  // The sentence itself is not held here at all. It is the composer's shared
  // draft (FRONT_DOOR_TEXT_KEY, persisted on a debounce and on pagehide), so a
  // keystroke re-renders the composer instead of this whole shell; App reads
  // it through `getFrontDoorText` at the moment something is sent.
  const [frontDoorProject, setFrontDoorProject] =
    usePersistedState<ProjectChoice>("redline.frontDoor.project", null);
  const [frontDoorAttachments, setFrontDoorAttachments] = usePersistedState<
    string[]
  >("redline.frontDoor.attachments", []);
  // Plans handed over by the sidebar's Combine picker. Persisted for the same
  // reason the sentence and the attachments are — a restart that eats what you
  // set up is the small betrayal this surface exists to remove — but FILTERED
  // against the live session list wherever it is read, so a pill for a deleted
  // plan cannot survive a restart and then fail at launch.
  const [frontDoorCombineRaw, setFrontDoorCombine] = usePersistedState<
    CombineSource[]
  >("redline.frontDoor.combine", []);
  const [combinePreview, setCombinePreview] = useState<CombinePreview | null>(
    null,
  );
  // Read by `repayPending`, which runs long after the render that armed the
  // launch — it must see what the composer holds NOW, not at launch time, or
  // giving a sentence back would clobber whatever was typed since.
  const frontDoorAttachmentsRef = useRef(frontDoorAttachments);
  frontDoorAttachmentsRef.current = frontDoorAttachments;
  const frontDoorCombineRef = useRef(frontDoorCombineRaw);
  frontDoorCombineRef.current = frontDoorCombineRaw;
  // A ⏎ the LAUNCH path refused, for the door to render. Deliberately NOT
  // persisted and deliberately nonce-keyed: it is a reaction to one keystroke,
  // and pressing ⏎ twice against the same blocker has to nudge twice or the
  // second press reads as a no-op all over again.
  const [frontDoorRefusal, setFrontDoorRefusal] = useState<{
    item: ReadinessItem | null;
    reason: string | null;
    nonce: number;
  } | null>(null);
  // Where ⏎ sends. Sticky like the rest of the door's state — someone who
  // works by shaping long briefs first shouldn't re-pick it every session.
  const [frontDoorDest, setFrontDoorDest] = usePersistedState<LaunchDestination>(
    "redline.frontDoor.destination",
    "chat",
  );
  // WHICH harness ⏎ launches on. Sticky for the same reason the destination
  // is, and read by every door — the Drafter and the browser's "Send to
  // Redline" launch through the same `launchPlan`, so all three agree without
  // each carrying its own picker.
  const [frontDoorBackendRaw, setFrontDoorBackend] =
    usePersistedState<BackendChoice>(
      "redline.frontDoor.backend",
      defaultBackendChoice(),
    );
  const { catalogs: modelCatalogs, errors: modelErrors, status: modelStatus, request: requestModels } = useModelCatalogs();
  const frontDoorBackend = useMemo(
    // Discovery can omit a pinned model. Never silently switch the user's pick.
    () => parseBackendChoice(frontDoorBackendRaw),
    [frontDoorBackendRaw],
  );
  // ── The chat room ───────────────────────────────────────────────────────
  const { chatId, setChatId, chats, refreshChats } = useFrontDoorConversation();
  // The open conversation's name — the dock's tab label and the active-surface
  // cell's label, from one lookup.
  const currentChatIdRef = useRef(chatId);
  currentChatIdRef.current = chatId;
  const chatTitle =
    chats.find((c) => c.companionId === chatId)?.title ?? null;
  // A companion chat is a pane of the active tab (W2): the one ChatRoom
  // body shows there (its SingletonSlot takes the host), and the dock's
  // column shows it only while no pane does. The pane on screen is the
  // open conversation.
  const chatPane = useWorkbench(wb, selectVisibleCompanion);
  useEffect(() => {
    if (chatPane && chatPane !== chatId) setChatId(chatPane);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPane]);
  const chatTarget = chatPane ? null : chatDockSlot;
  // A move lays the host out afresh, and a scroller laid out afresh starts at
  // its top: carried between the room and the dock, the thread would open on
  // its first message. It keeps its place — the end if it was there.
  const chatScroll = useRef<{ thread: HTMLElement; top: number; end: boolean } | null>(null);
  useLayoutEffect(() => {
    const target = chatTarget;
    // No dock column for it: a pane's slot holds it, or nothing does.
    if (!target) return;
    target.appendChild(chatHost);
    const kept = chatScroll.current;
    chatScroll.current = null;
    if (kept?.thread.isConnected) kept.thread.scrollTop = kept.end ? kept.thread.scrollHeight : kept.top;
    return () => {
      if (chatHost.parentElement !== target) return;
      const thread = chatHost.querySelector<HTMLElement>("[data-chat-messages]");
      if (thread) chatScroll.current = { thread, top: thread.scrollTop, end: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4 };
      chatHost.remove();
    };
  }, [chatTarget, chatHost]);
  // The door's sentence, handed to the room to send as message 1. Ephemeral by
  // design — a seed that outlived a restart would re-send an old sentence into
  // a conversation that already has it.
  const [chatSeed, setChatSeed] = useState<{
    companionId: string;
    text: string;
    id?: string;
    autoSend?: boolean;
    target?: import("./lib/activeSurface").SurfaceInfo;
    /** What the card attached, read as the sentence left it. */
    context?: string | null;
  } | null>(null);
  // The mint is in flight. Holds a placeholder so the PREVIOUS conversation
  // can't flash up in the half-second before the new one exists — the same
  // guard `drafterOpening` is for the Drafter.
  const [chatOpening, setChatOpening] = useState(false);
  const chatCreation = useRef<Promise<Companion> | null>(null);

  // ONE pending launch, keyed by the door it came through. Not one per
  // surface: `deriveReadiness` takes a single `pendingSince`, so two states
  // would force App to fold them, and the 90s `hook-unapproved` nudge would
  // sometimes describe a launch nobody is watching. Never persisted — a stale
  // "Planning…" card must not outlive a restart.
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);
  const pendingLaunchRef = useRef(pendingLaunch);
  pendingLaunchRef.current = pendingLaunch;
  const launchedPlansRef = useRef(new Map<string, PendingLaunch>());
  const [chatReceipts, setChatReceipts] = useState<Record<string, ChatPlanReceipt>>({});
  const chatHandoffSeeds = useRef(new Map<string, { text: string; id: string }>());
  const [planSwap, setPlanSwap] = useState<{ launchId: string; from: SwapRect } | null>(null);
  // Focus + seed handoff from the type-to-start listener (see lib/landing.ts).
  const [frontDoorFocus, setFrontDoorFocus] = useState(0);
  // ── The door tab (W1) ─────────────────────────────────────────────────
  // ⌘T, the sidebar's New tab and "Plan a build" open a door tab in the
  // active set: a door pane with a draft of its own, the island landing on
  // it, the caret in its box. From a browser pane the door comes with the
  // Browser destination preselected. The pane ids ⌘T minted are remembered,
  // so an untouched one (nothing typed) closes again on Esc or when the
  // user goes elsewhere — a tab that never became anything is not kept.
  const doorDraftKeyNow = useWorkbench(wb, selectFocusedDoorDraftKey);
  const doorPaneDestination = useWorkbench(wb, selectFocusedDoorDestination);
  // A door tab converting into the destination picked in it: the pane
  // becomes that surface in place (its id, tab and focus kept), springing
  // out of the island's box. The browser gets no spring — a native webview
  // ignores DOM transforms — and the drafter has its own (`drafterSurface`).
  const convertedPaneRef = useRef<string | null>(null);
  const convertDoorPane = useCallback((init: PaneInit): boolean => {
    const { tab, set, panes } = activePanes(wb.getState());
    const door = panes.length === 1 && panes[0].kind === "door" ? panes[0] : null;
    if (!tab || !set || !door || tab.focusedPaneId !== door.id) return false;
    untouchedDoors.current.delete(door.id);
    // One of a kind: a surface the set already holds comes forward and the
    // door closes, rather than a second body (and a second Cosmos) mounting.
    if (init.kind !== "door" && init.kind !== "file" && init.kind !== "plan" && findPane(wb.getState(), init.kind)) {
      wb.dispatch({ type: "closeTab", tabId: tab.id });
      wb.dispatch({ type: "openSurface", kind: init.kind, data: init.kind === "drafter" || init.kind === "review" ? undefined : init.data });
      return true;
    }
    const from = boxOf(".rl-frontdoor-focus[data-visible='true'] .rl-fd-island");
    if (from && init.kind !== "browser") {
      convertedPaneRef.current = door.id;
      setSwapFrom(from);
    }
    wb.dispatch({ type: "replacePane", paneId: door.id, pane: init });
    // The door's own draft leaves with it; the shared sentence stays Home's.
    if (door.data.draftKey !== FRONT_DOOR_TEXT_KEY) writeSharedDraft(door.data.draftKey, "");
    return true;
  }, []);
  doorSentenceKey = doorDraftKeyNow;
  const wbActiveTabId = useWorkbench(wb, (st) => st.sets[st.activeKey]?.activeTabId ?? null);
  const untouchedDoors = useRef(new Set<string>());
  // ⌘T's door, for the mount-once key listener below.
  const openDoorTabRef = useRef<() => void>(() => {});
  const openDoorTab = useCallback(() => {
    beginMeasure("wb:new-tab-caret");
    const { set, tab } = activePanes(wb.getState());
    const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
    const paneId = newDoorPaneId();
    untouchedDoors.current.add(paneId);
    wb.dispatch({
      type: "openSurface",
      kind: "door",
      paneId,
      data: { draftKey: doorDraftKey(paneId), ...(focused?.kind === "browser" ? { destination: "browser" as const } : {}) },
    });
    setFrontDoorOpen(false);
    setFrontDoorFocus((n) => n + 1);
    // The measure ends when the caret rests in the door's box.
    const landed = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement) || !e.target.closest(".rl-fd-island")) return;
      endMeasure("wb:new-tab-caret");
      document.removeEventListener("focusin", landed, true);
    };
    document.addEventListener("focusin", landed, true);
    window.setTimeout(() => document.removeEventListener("focusin", landed, true), 2000);
  }, []);
  openDoorTabRef.current = openDoorTab;
  /** The tab at `key` is a ⌘T door nobody typed in, in a set with other
   *  tabs: close it. */
  const closeUntouchedDoor = useCallback((key: SessionKey, tabId: string | null) => {
    const state = wb.getState();
    const set = state.sets[key];
    const tab = tabId ? set?.tabs[tabId] : null;
    if (!set || !tab || set.order.length < 2 || isSplit(tab.root)) return false;
    const pane = set.panes[tab.focusedPaneId];
    if (pane?.kind !== "door" || !untouchedDoors.current.has(pane.id)) return false;
    if (readSharedDraft(pane.data.draftKey).trim()) return false;
    untouchedDoors.current.delete(pane.id);
    wb.dispatch({ type: "closeTab", key, tabId: tab.id });
    return true;
  }, []);
  // A door pane that has left the workbench (closed, converted, pruned)
  // takes its draft with it; the shared sentence stays Home's. Watched
  // on the store, so every way a door goes — the strip's ×, ⌘W, Esc, the
  // launch's handoff — forgets its key.
  useEffect(() => {
    const doors = (state: WorkbenchState) => {
      const out = new Map<string, string>();
      for (const set of Object.values(state.sets)) {
        if (!set) continue;
        for (const pane of Object.values(set.panes)) if (pane.kind === "door") out.set(pane.id, pane.data.draftKey);
        for (const entry of set.closed) for (const pane of entry.panes) if (pane.kind === "door") out.set(pane.id, pane.data.draftKey);
      }
      return out;
    };
    let known = doors(wb.getState());
    return wb.subscribe(() => {
      const now = doors(wb.getState());
      for (const [id, key] of known) if (!now.has(id) && key !== FRONT_DOOR_TEXT_KEY) writeSharedDraft(key, "");
      known = now;
    });
  }, []);
  const previousTabRef = useRef<{ key: SessionKey; tabId: string | null } | null>(null);
  useEffect(() => {
    const prev = previousTabRef.current;
    previousTabRef.current = { key: wbActiveKey, tabId: wbActiveTabId };
    if (!prev || (prev.key === wbActiveKey && prev.tabId === wbActiveTabId)) return;
    closeUntouchedDoor(prev.key, prev.tabId);
  }, [wbActiveKey, wbActiveTabId, closeUntouchedDoor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[role=menu], [role=dialog], .xterm, [data-rl-browser-tile]")) return;
      const state = wb.getState();
      if (closeUntouchedDoor(state.activeKey, state.sets[state.activeKey]?.activeTabId ?? null)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeUntouchedDoor]);
  // "Can this machine actually deliver a plan" — null until the first probe
  // resolves, which readiness reads as *unknown*, never as broken.
  const [preflight, setPreflight] = useState<PreflightStatus | null>(null);
  /** Post-reveal integration health has answered at least once. Null means
   *  "not asked yet", never "healthy" — every derivation from it is withheld
   *  rather than guessed at. */
  const integrationReady = preflight !== null;
  const selectedModelIdentity = frontDoorBackend.backend === "claude-code"
    ? preflight?.claude.identity ?? preflight?.claude.path ?? "unresolved"
    : frontDoorBackend.backend === "codex"
      ? preflight?.codex?.identity ?? `${preflight?.codex?.path ?? ""}|${preflight?.codex?.version ?? ""}`
      : preflight?.providers?.[frontDoorBackend.backend]?.identity ?? "unresolved";
  useEffect(() => {
    if (preflight) requestModels(frontDoorBackend.backend, selectedModelIdentity);
  }, [frontDoorBackend.backend, selectedModelIdentity, !!preflight, requestModels]);
  useEffect(() => {
    const refresh = () => { if (preflight && document.visibilityState === "visible") requestModels(frontDoorBackend.backend, selectedModelIdentity); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [frontDoorBackend.backend, selectedModelIdentity, !!preflight, requestModels]);

  // Both read at LAUNCH time, from inside `launchPlan` — the same discipline
  // `readinessRef` uses. The resolved codex path is what makes the codex arm
  // absolute rather than trusting `$PATH`, which on this machine still points
  // at a build with no `resume`.
  const preflightRef = useRef(preflight);
  preflightRef.current = preflight;
  const backendChoiceRef = useRef(frontDoorBackend);
  backendChoiceRef.current = frontDoorBackend;
  // Gates the 90s `/hooks` nudge: a plan that has ever landed proves the hook
  // works, so a later wait has some other cause and blaming it would be a lie.
  const [planEverArrived, setPlanEverArrived] = usePersistedState(
    "redline.planEverArrived",
    false,
  );
  // The draft's durable identity — keys its discussion agent, comments, voice
  // memory, and its lineage in the memory lake. The one drafter thing that
  // stays in localStorage: *which* document is open is a UI preference.
  const [drafterDraftId, setDrafterDraftId] = usePersistedState<string | null>(
    "redline.drafter.draftId",
    null,
  );
  // Render-fresh mirror for the persist handler: an outgoing doc's unmount
  // flush runs with its OLD closure (its own id — correct for the cache and
  // shadow), but must not clobber the INCOMING doc's `drafterLoaded`.
  const drafterDraftIdRef = useRef(drafterDraftId);
  drafterDraftIdRef.current = drafterDraftId;
  // The open document's project as a plain path, for everything that just
  // wants a cwd (the picker, the voice panel, the browser's repo guess). Null
  // here means EITHER "explicitly Home" or "not loaded" — which is fine for a
  // reader, and fatal for a writer, so the writers go through `projectForDoc`.
  const drafterProjectPath = useMemo(
    () => projectForDoc(drafterProject, drafterDraftId)?.path ?? null,
    [drafterProject, drafterDraftId],
  );
  // The picker's setter: a pick is always FOR the document on screen.
  const setDrafterProjectPath = useCallback(
    (path: string | null) => {
      const forId = drafterDraftIdRef.current;
      if (!forId) return;
      setDrafterProject({ forId, path });
    },
    [],
  );
  useEffect(() => {
    if (!drafterDraftId) setDrafterDraftId(crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafterDraftId]);
  // Every document open in the drafter (`drafterDraftId` stays the ACTIVE
  // one). A UI preference like the active id, so localStorage is right; the
  // editor still mounts only the active document via the keyed remount, so
  // extra open documents cost nothing at runtime.
  const [drafterOpenIds, setDrafterOpenIds] = usePersistedState<string[]>(
    "redline.drafter.openIds",
    [],
  );
  // Invariant: the active document is always in the open set. This is also
  // the ONE place an open is counted (`bookshelf_touch_draft`) — activating an
  // already-open document changes nothing here, so it never double-counts.
  useEffect(() => {
    if (!drafterDraftId || drafterOpenIds.includes(drafterDraftId)) return;
    setDrafterOpenIds([...drafterOpenIds, drafterDraftId]);
    void touchDraft(drafterDraftId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafterDraftId]);
  // Close a document (dropdown ✕): drop it from the set; if it was active,
  // activate its neighbour. Closing the last one leaves the active id null and
  // the mint effect above opens a fresh blank — the drafter never goes dark.
  //
  // Also the delete path's other half: `BookshelfView` deletes the ROW, and
  // without this the deleted document stays in the open set, keeps its tab, and
  // gets reopened by the mount effect as a zombie whose row no longer exists.
  // Evicting the caches here fixes the storage-leak half for free — a closed
  // document's session entry, crash shadow and mode key have nothing left to
  // shadow.
  const closeDrafterDoc = (id: string) => {
    drafterSessionCache.current.delete(id);
    clearDrafterShadow(id);
    try {
      localStorage.removeItem(drafterModeKey(id));
    } catch {
      /* storage unavailable — the key is moot either way */
    }
    const idx = drafterOpenIds.indexOf(id);
    if (idx < 0) return;
    const next = drafterOpenIds.filter((x) => x !== id);
    setDrafterOpenIds(next);
    if (drafterDraftId === id) {
      setDrafterDraftId(next[Math.min(idx, next.length - 1)] ?? null);
    }
  };
  // Open the active document: the in-session cache first (the latest content
  // ever on screen this run — a DB refetch during the persist retry window
  // would be BEHIND the screen), then the DB, after the one-time localStorage
  // migration has had its chance to put it there. The migration is idempotent
  // (its flag is a DB setting) and runs before the first read, so the very
  // first launch on a migrated build still opens the user's existing draft.
  // There is no separate loading flag: `drafterLoaded.forId` not matching the
  // active id IS the loading state.
  const bookshelfMigrated = useRef(false);
  useEffect(() => {
    if (!drafterDraftId) return;
    const forId = drafterDraftId;
    const entry = drafterSessionCache.current.get(forId) ?? null;
    if (entry) {
      // Seen this session — reopen exactly what was on screen, synchronously:
      // no fetch, no "Opening…" flash, and never a recovery prompt (the
      // shadow may be mid-flight, but the cache is what it shadows).
      setDrafterLoaded({ forId, doc: entry.json });
      // Unconditional and TAGGED. The old `if (path)` guard is what let doc
      // A's repo answer for doc B — a null here means "B chose Home", and the
      // tag is what makes that distinguishable from "B isn't loaded".
      setDrafterProject({ forId, path: entry.projectPath ?? null });
      setDrafterSaveState(null);
      return;
    }
    let alive = true;
    void (async () => {
      if (!bookshelfMigrated.current) {
        bookshelfMigrated.current = true;
        await migrateLegacyDraft();
      }
      const loaded = await loadDraftDoc(forId).catch(() => null);
      if (!alive) return;
      let parsed: JSONContent | null = null;
      try {
        parsed = loaded?.docJson ? (JSON.parse(loaded.docJson) as JSONContent) : null;
      } catch {
        // A corrupt body opens blank rather than crashing the pane; the
        // markdown mirror is still on disk and still readable by the agents.
        parsed = null;
      }
      // A row with a markdown mirror but no TipTap body — the Shipwright
      // lands documents this way, and templates seeded from markdown ride the
      // same path. Build the doc from the mirror rather than opening blank.
      if (!parsed && loaded?.docMarkdown.trim()) {
        try {
          const { planMarkdownToDoc } = await import("./editor/markdown/parser");
          parsed = planMarkdownToDoc(loaded.docMarkdown).toJSON() as JSONContent;
        } catch {
          parsed = null;
        }
        if (!alive) return;
      }
      // Crash recovery: a shadow newer than the DB row means the app died
      // between a keystroke and its write landing.
      //
      // This used to be a `window.confirm`, whose DECLINED branch cleared the
      // shadow — and WKWebView returns a silent `false` for it. So in the
      // packaged app the recovery prompt never appeared AND the unsaved work
      // was destroyed on the way past. It is a card in the pane now: a real
      // choice, rendered where the document would be, and the shadow survives
      // until the user makes it.
      const shadow = readDrafterShadow(forId);
      if (
        shadow &&
        resolveDraftOpen(entry, loaded?.updatedAt ?? 0, shadow.at) ===
          "shadow-prompt"
      ) {
        setDrafterRecovery({
          forId,
          shadow,
          stored: parsed,
          projectPath: loaded?.projectPath ?? null,
        });
        setDrafterProject({ forId, path: loaded?.projectPath ?? null });
        setDrafterSaveState(null);
        return;
      }
      setDrafterLoaded({ forId, doc: parsed });
      setDrafterProject({ forId, path: loaded?.projectPath ?? null });
      // The save indicator describes the OPEN document — don't carry the
      // previous one's "Saved · 2s ago" across a switch.
      setDrafterSaveState(null);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafterDraftId]);
  // A new document is being minted for this surface. Distinct from "loading a
  // document" (which the id tag already covers) because during a mint there is
  // no id to tag against yet — the previously-open document would otherwise
  // render for the half-second the round-trip takes.
  const [drafterOpening, setDrafterOpening] = useState(false);
  // The aperture a surface opens from — the island's box, measured on the
  // frame the user committed. Ephemeral by construction: the portal clears it
  // once it has opened, and a stale one would re-clip a live surface.
  // The island's box, measured on the gesture that opened the Drafter. It is
  // what the incoming surface springs FROM, and it is cleared the moment the
  // spring lands — a stale one would re-run the animation on the next render.
  //
  // Deliberately NOT a persisted "the drafter is open" flag. The Drafter has
  // its own surface and its own header tab; letting it take over the Document
  // slot meant the Front Door was gone on that tab until you found the way
  // back, and a persisted flag meant it was still gone after a reload.
  const [swapFrom, setSwapFrom] = useState<SwapRect | null>(null);
  // Arriving from the Front Door: keep the surface QUIET until the editor is
  // actually up. `swapFrom` cannot do this job — it has to clear when the
  // animation ends, because it is also what holds the editor's mount back, and
  // the editor is usually a beat behind the landing. That gap is where
  // "Opening the document…" appeared as a heading block in the top-left corner
  // and then vanished. During a spring arrival the loading state is the growth
  // itself; a sentence that shows up inside the surface as it opens and is
  // taken away again is worse than nothing at all.
  const [quietOpen, setQuietOpen] = useState(false);
  // Safety net: if the editor never comes up at all, the surface must not stay
  // silent forever. Leaving the drafter ends the arrival regardless.
  useEffect(() => {
    if (stageSurfaceRef.current !== "drafter") setQuietOpen(false);
  }, [stageSurface]);

  // The shelf, shown in place of the open document inside the same surface —
  // no fourth pane, and it inherits the pane's fullscreen and zoom.
  // Persisted: it was plain useState, so the shelf closed itself on every
  // remount — a surface switch and back, or a pane toggle, and you were back
  // in the document without asking to be.
  const [drafterShelfOpen, setDrafterShelfOpen] = usePersistedState(
    "redline.drafter.shelfOpen",
    false,
  );
  // The agent shelf (harness A3): the user's own agents, run against the open
  // document. A transient sheet — deliberately NOT persisted: reopening the
  // app inside the agent list instead of the document would be disorienting.
  const [agentShelfOpen, setAgentShelfOpen] = useState(false);
  // The shelf-agent run in flight, by name. Suggestions land through the
  // drafter's own listeners; this only claims the run's closing chat line
  // for a toast (the drafter's ✦ note is gated on ITS in-flight ref, so a
  // guest run would otherwise finish silently).
  const shelfRunLive = useRef<string | null>(null);
  // The open document's attached sources — the rows, not just a count.
  //
  // The backend for these has been complete and unreachable: `draft_source_add`
  // / `_import_file` / `_delete` and their typed wrappers had zero callers, so
  // the count was provably always 0 and the `· N src` chip could never render,
  // while this effect still fired a `listSources` invoke per document switch to
  // compute a constant. Building the other half is what makes it true.
  const [drafterSources, setDrafterSources] = useState<DraftSource[]>([]);
  const refreshDrafterSources = useCallback((id: string | null) => {
    if (!id) {
      setDrafterSources([]);
      return;
    }
    void listSources(id)
      .then((rows) => setDrafterSources(Array.isArray(rows) ? rows : []))
      .catch((err) => console.warn("draft_source_list failed", err));
  }, []);
  useEffect(() => {
    refreshDrafterSources(drafterDraftId);
  }, [drafterDraftId, drafterShelfOpen, refreshDrafterSources]);

  // Copy files in and attach them. `draft_source_import_file` copies at capture
  // time (a source the user later moves or trashes would break silently),
  // sanitizes the basename and enforces the size cap — all of which already
  // existed and had no way in.
  const attachDrafterFiles = useCallback(
    (paths: string[]) => {
      const id = drafterDraftIdRef.current;
      if (!id) return;
      void Promise.allSettled(paths.map((p) => importSourceFile(id, p))).then(
        (results) => {
          const failed = results.filter((r) => r.status === "rejected");
          if (failed.length > 0) {
            setToast(
              `Couldn't attach ${failed.length} file${failed.length === 1 ? "" : "s"}: ${
                (failed[0] as PromiseRejectedResult).reason
              }`, 8000,
            );
          }
          refreshDrafterSources(id);
        },
      );
    },
    [refreshDrafterSources],
  );
  // Templates, promoted out of the documents dropdown and onto the blank page —
  // the one moment a template is what you actually want. Loaded with the shelf,
  // refreshed when the shelf is opened (which is where they're made).
  const [drafterTemplates, setDrafterTemplates] = useState<BookshelfDraft[]>([]);
  useEffect(() => {
    void loadShelf()
      .then((shelf) =>
        setDrafterTemplates(shelf.drafts.filter((d) => d.isTemplate)),
      )
      .catch((err) => console.warn("bookshelf_list failed", err));
  }, [drafterShelfOpen]);
  // The same mint `DocumentsMenu` already performs: the copy is filed beside
  // its template and is an ordinary document from birth.
  const useDrafterTemplate = useCallback(
    (templateId: string) => {
      const t = drafterTemplates.find((d) => d.draftId === templateId);
      void newDraft(t?.folderId ?? null, undefined, null, templateId)
        .then(setDrafterDraftId)
        .catch((e) => {
          setToast(`Couldn't start from that template: ${e}`, 6000);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafterTemplates],
  );

  const removeDrafterSource = useCallback(
    (sourceId: string) => {
      const id = drafterDraftIdRef.current;
      setDrafterSources((list) => list.filter((s) => s.id !== sourceId));
      void deleteSource(sourceId).catch((err) => {
        setToast(`Couldn't remove that attachment: ${err}`, 6000);
        refreshDrafterSources(id);
      });
    },
    [refreshDrafterSources],
  );
  // The drafter's 🎙️ voice drawer + what it's primed with: the latest mirrored
  // markdown and its parsed Section tree (for the Guided Walkthrough).
  const [drafterMarkdown, setDrafterMarkdown] = useState("");
  const [drafterSections, setDrafterSections] = useState<Section[]>([]);
  // The open drafter's LIVE markdown getter — serialized on demand, so the
  // voice panel's per-turn mirror flush sends what's on screen rather than
  // the debounce-lagged `drafterMarkdown` above. Null while no editor is up.
  const drafterLiveMdRef = useRef<(() => string) | null>(null);
  const registerDrafterLiveMarkdown = useCallback(
    (get: (() => string) | null) => {
      drafterLiveMdRef.current = get;
      // Called with a getter on mount and null on unmount, which makes it the
      // precise "the editor is up" signal — no polling, no timeout.
      if (get) setQuietOpen(false);
    },
    [],
  );
  const getDrafterLiveMarkdown = useCallback(
    () => drafterLiveMdRef.current?.(),
    [],
  );
  // A shelf-agent run's endgame: its one-liner arrives on `draft-chat-done`
  // like any drafter turn, but the drafter's own handler is gated on the ✦
  // in-flight ref and ignores guest turns. While `shelfRunLive` names a run,
  // this claims the terminal event for a toast.
  useEffect(() => {
    let alive = true;
    const done = listen<{ draftId: string; body: string }>(
      "draft-chat-done",
      (e) => {
        if (!alive || !shelfRunLive.current) return;
        if (e.payload.draftId !== drafterDraftId) return;
        const name = shelfRunLive.current;
        shelfRunLive.current = null;
        const line = e.payload.body.trim();
        setToast(
          line
            ? `${name} — ${line}`
            : `${name} finished. Review its tracked changes in the document.`, 12_000,
        );
      },
    );
    const err = listen<{ draftId: string; error: string }>(
      "draft-chat-error",
      (e) => {
        if (!alive || !shelfRunLive.current) return;
        if (e.payload.draftId !== drafterDraftId) return;
        const name = shelfRunLive.current;
        shelfRunLive.current = null;
        setToast(`${name} failed: ${e.payload.error}`, 12_000);
      },
    );
    return () => {
      alive = false;
      void done.then(dropListener);
      void err.then(dropListener);
    };
  }, [drafterDraftId]);
  // Persist the open document: the TipTap fidelity source AND the markdown
  // mirror agents read via /v1/drafter/:id/doc, in one write on the drafter's
  // debounce (400ms idle, 2s max-wait). Three guarantees layered on the write:
  //
  // 1. The crash shadow lands in localStorage synchronously BEFORE the async
  //    invoke — a hard kill between keystroke and write loses nothing.
  // 2. A failed write is visible ("Unsaved — retrying") and retried with
  //    backoff — never a swallowed catch.
  // 3. The shadow clears only once the DB write confirms.
  const [drafterSaveState, setDrafterSaveState] =
    useState<DrafterSaveState | null>(null);
  // Monotonic write id: a stale attempt (superseded by a newer keystroke's
  // write) must neither clear the newer shadow nor overwrite its status.
  const drafterSaveSeq = useRef(0);
  const drafterRetryTimer = useRef<number | null>(null);
  const drafterFlushDeps = useMemo(
    () => ({
      storage: localStorage,
      cache: drafterSessionCache.current,
      persist: persistDraftDoc,
      now: Date.now,
    }),
    [],
  );
  const drafterPersist = useCallback(
    (json: JSONContent, markdown: string) => {
      setDrafterMarkdown(markdown);
      if (!drafterDraftId) return;
      const id = drafterDraftId;
      // The pick, but only if it belongs to THIS document. `upsert_draft`
      // writes `project_path` unconditionally, so a null reaching it must mean
      // "explicitly Home" and never "I don't know" — and the mount gate below
      // removes "I don't know" from the reachable states entirely.
      const project = projectForDoc(drafterProject, id)?.path ?? null;
      const seq = ++drafterSaveSeq.current;
      if (drafterRetryTimer.current !== null) {
        window.clearTimeout(drafterRetryTimer.current);
        drafterRetryTimer.current = null;
      }
      const attempt = (retriesLeft: number, delayMs: number) => {
        setDrafterSaveState({ kind: "saving" });
        // Shadow, then the in-session cache, then the DB — the order is the
        // contract and it lives in `writeDrafterFlush`, where it is testable.
        // The cache write is unconditionally under the flush's OWN id: an
        // outgoing doc's unmount flush lands under that doc (onPersist carries
        // its closure), which is exactly right.
        writeDrafterFlush(id, json, markdown, project, drafterFlushDeps)
          .then(() => {
            if (seq !== drafterSaveSeq.current) return; // a newer write owns the state
            clearDrafterShadow(id);
            setDrafterSaveState({ kind: "saved", savedAt: Date.now() });
          })
          .catch(() => {
            if (seq !== drafterSaveSeq.current) return;
            setDrafterSaveState({ kind: "retrying" });
            if (retriesLeft <= 0) return; // bounded: the shadow still holds the words
            drafterRetryTimer.current = window.setTimeout(() => {
              drafterRetryTimer.current = null;
              attempt(retriesLeft - 1, Math.min(delayMs * 2, 15_000));
            }, delayMs);
          });
      };
      attempt(5, 1000);
    },
    [drafterDraftId, drafterProject],
  );
  // Sections for the drafter voice walkthrough — parsed backend-side from the
  // mirrored markdown, only while the voice drawer is open.
  // A plan sent from the browser page-discussion agent, held for a repo-confirm
  // step (SendToRedlineDialog) before it launches into a terminal — so it never
  // silently lands in $HOME.
  const [sendConfirm, setSendConfirm] = useState<{
    markdown: string;
    initialProject: string | null;
    destination?: ContinueDestination;
    source?: ContinueRequest["source"];
    missionHandoff?: { missionId: string; handoffId: string; destination: "plan" | "run" };
  } | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const sendPendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Memory is plumbing: no per-surface toolbar panes anymore. One ephemeral,
  // read-mostly inspector (Lake / Catalog / Settings) behind the quiet pill.
  const [memoryInspectorOpen, setMemoryInspectorOpen] = useState(false);
  // The palette's front-door toggle. (⌘J is the rail's Talk now, W4.)
  const toggleDoor = useCallback(() => {
    setFrontDoorOpen(value => !value);
  }, []);
  // Visibility from the active tab's panes (a review beside a browser is on
  // screen though it is not the tab's "surface").
  const codeReview = useReview(view.visibleKinds.includes("review"));
  // The Localhost dashboard. Gated on the surface being selected: the scan
  // forks three subprocesses per tick, so it must not run behind another pane.
  const devServers = useDevServers(view.visibleKinds.includes("servers"));
  // What `selectSurface(next)` means in the workbench. "document" is the
  // way back: it brings the set's plan — or Home's door — forward. A surface
  // opens in a tab of its own, or, from a tile (the plan beside a surface),
  // in the tile's surface half; the drafter and the review are one pane per
  // set (App keeps which document / repo they show). "chat" is a companion
  // chat pane and never opens from here (the room's own routes do).
  const paneInitFor = (kind: Exclude<Surface, "document" | "chat">): PaneInit => {
    switch (kind) {
      case "browser": return { kind, data: { workspace: "regular" } };
      case "drafter": return { kind, data: { draftId: drafterDraftId ?? "" } };
      case "review": return { kind, data: { repo: codeReview.repo ?? "", source: codeReview.source } };
      default: return { kind, data: {} };
    }
  };
  openInWorkbenchRef.current = (next: Surface) => {
    const state = wb.getState();
    const { key, set, tab } = activePanes(state);
    if (next === "chat") return;
    if (next === "document") {
      // Never closes a pane (a surface's own ✕ does that): the session on
      // screen's Plan tab comes forward — the plan half of a tile keeps its
      // neighbour — or Home's door. Reads the state NOW, so a caller that
      // also opens a session (`setActiveId`) opens it first (D29: its Plan
      // tab in this set is the session on screen).
      const session = activeSessionOf(state);
      if (kindForSurface("document", key, session) === "plan" && session) {
        wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: session, version: null } } });
        return;
      }
      const door = findPane(state, "door");
      if (door) wb.dispatch({ type: "selectTab", tabId: door.tabId });
      else openDoorTab();
      return;
    }
    if (next === "drafter" || next === "review") {
      const open = findPane(state, next);
      if (open) {
        wb.dispatch({ type: "focusPane", paneId: open.pane.id });
        return;
      }
    }
    // From a door tab the destination takes the door's place.
    if (convertDoorPane(paneInitFor(next))) return;
    // From the tile, the surface half becomes the next surface: the plan
    // stays beside it (D24 — the tile is the tab's own layout, not a pin).
    const tile = tileOf(state);
    if (tile && tab && set) {
      if (tile.other.kind === next) {
        wb.dispatch({ type: "focusPane", paneId: tile.other.id });
        return;
      }
      wb.dispatch({ type: "replacePane", paneId: tile.other.id, pane: paneInitFor(next) });
      return;
    }
    const init = paneInitFor(next);
    wb.dispatch({ type: "openSurface", kind: next, data: init.data });
  };
  // The browser host's holder joins the key: moving the host between two
  // panes is a pure reparent, which no ResizeObserver sees, so the key is
  // the only thing that moves the native webview.
  const browserHeld = useWorkbench(wb, (s) => singletonHolder(s, "browser", browserHolder));
  const wbLayoutKey = `${useWorkbench(wb, selectLayoutKey)}|${browserHeld}`;
  // An agent asking for a code review (a `/redline-code-review` curl holding
  // for feedback) is news — never a move.
  // The review surface waits for you: a notice says so once, a footer chip
  // holds the way in until you go there (or the agent stops waiting), and
  // from another app the Dock bounces and a notification says it. The agent
  // waits either way; the hook itself adopts the repo/source/round.
  const [reviewNews, setReviewNews] = useState<"review" | null>(null);
  const reviewNewsRef = useRef(reviewNews);
  reviewNewsRef.current = reviewNews;
  const tellReview = useCallback(() => {
    const message = "Review ready";
    const there = stageSurfaceRef.current === "review";
    if (!there && reviewNewsRef.current) return;
    // Already on the review surface, it is on screen: only the OS is told.
    if (!there) {
      reviewNewsRef.current = "review";
      setReviewNews("review");
      setToast({
        message,
        tone: "info",
        action: { label: "Open", onAction: () => selectSurfaceRef.current("review") },
        ...(stageSurfaceRef.current === "browser" ? { placement: "top" as const } : {}),
      });
    }
    void import("./lib/osNotice")
      .then(({ noticeWhenAway }) => noticeWhenAway(message, "An agent is waiting for your code review in Redline."))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const p = listen("review-requested", () => {
      if (alive) tellReview();
    });
    return () => {
      alive = false;
      void p.then(dropListener);
    };
  }, [tellReview]);
  // Over once you go to the review surface, or once the agent stops
  // waiting on a review nobody opened.
  useEffect(() => {
    if (stageSurface === "review") setReviewNews(null);
  }, [stageSurface]);
  useEffect(() => {
    if (!codeReview.holdActive) setReviewNews(null);
  }, [codeReview.holdActive]);
  // Sessions whose approval was rescinded (unapprove_plan) this app session —
  // their restore prompt carries the "your stand-down is void" sentence so a
  // resumed claude doesn't obey a stale build-later stand-down in its context.
  const [rescindedIds, setRescindedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Document zoom (content font-scale, not webview zoom). Persisted; clamped
  // 0.8–1.6. Driven by the in-pane control and Cmd +/-/0 shortcuts.
  const [docZoom, setDocZoom] = usePersistedState("redline.docZoom", 1);
  // Wide view: drop the article's measure so the text fills the pane instead of
  // sitting in a centred column with empty gutters either side. Persisted, and
  // a preference rather than a default — the narrow measure is the better read
  // for sustained prose, but a plan full of tables and code wants the room.
  const [docWide, setDocWide] = usePersistedState("redline.docWide", false);
  const [docMeasure, setDocMeasure] = usePersistedState("redline.docMeasure", DOC_MEASURE_MIN);
  // The article's right padding, px (`pr-8` in normal view). Wide view widens it
  // to `pl-16`'s 64: the floating control lives in that gutter, and at full-bleed
  // width there is no empty margin left to host it otherwise. Shared with the
  // overlap effect below, so the two can't disagree about where the text ends.
  const docPadR = docWide ? DOC_PAD_R_WIDE : DOC_PAD_R_NARROW;

  // First-run onboarding tour. The flag persists so the tour auto-runs once;
  // `tourOpen` force-shows it (menu replay) regardless of the flag.
  const [onboardingDone, setOnboardingDone] = usePersistedState(
    "redline.onboardingDone",
    false,
  );
  const [tourOpen, setTourOpen] = useState(false);
  // ⌘K command palette (A5). Open state only — the registry is the
  // paletteCommands memo below, and both wired globals (⌘K, ⌘⇧0) are
  // matched by lib/keymap so the combos live in one place.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Whether the responsiveness probe runs — its only switch is the palette.
  const [perfProbe, setPerfProbeShown] = useState(perfProbeOn);
  // Doors-open boot (A2): main.tsx armed the closed frame before React
  // mounted; this parts the plates after the reveal. Purely decorative — it
  // reports only whether the plates are mid-flight (the native browser
  // webview has to hide for that composition transition), and nothing
  // actionable is allowed to wait on it.
  const { bootAnimating } = useBootChoreography();

  // The first surface the user can actually act on. `loading` clears when the
  // core bootstrap has resolved — session summaries in, held session (if any)
  // loaded — which is the same moment the front door takes focus. Nothing in
  // this condition is a probe, a repair, or an animation.
  useEffect(() => {
    if (shellReady) markOnce("rl:actionable");
  }, [shellReady]);

  // Warm the Drafter's chunk once the shell is actionable and the main thread
  // is free. Nothing on the boot path changes — this is a dynamic import at
  // idle, so the size budget is untouched — but it removes the one difference
  // between the first trip from the Front Door and every later one: on a cold
  // chunk the spring animates a Suspense fallback and then the real editor
  // arrives mid-flight, which is precisely the first-run jank.
  useEffect(() => {
    if (!shellReady) return;
    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    const run = () => void loadPromptDrafter().catch(() => {});
    if (idle) {
      const id = idle(run, { timeout: 3000 });
      return () =>
        (
          window as Window & { cancelIdleCallback?: (h: number) => void }
        ).cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(run, 1200);
    return () => window.clearTimeout(t);
  }, [shellReady]);
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
  // The floating zoom control lives in the right gutter. It never LEAVES a
  // plan document — once the (centered) text column grows wide enough to reach
  // it, it stands up into the same narrow column it takes in wide view instead
  // of dropping out. Driven by the overlap effect below.
  const [zoomStacked, setZoomStacked] = useState(false);
  const zoomCtrlRef = useRef<HTMLDivElement | null>(null);
  // Mirrors `zoomStacked` for the recompute closure, which must not re-run on
  // its own output.
  const zoomStackedRef = useRef(false);
  // The control's remembered ROW width. Only ever written from a row-posed
  // control: see the measurement note in the effect.
  const zoomCtrlW = useRef(DOC_CTRL_ROW_W);
  // The pose, as the render reads it. Wide view always stacks (there is no
  // horizontal gutter left at full bleed); a narrow pane stacks because the
  // row would land on the text.
  const zoomColumn = docWide || zoomStacked;
  // Cmd/Ctrl +/-/0 zoom the document. These combos aren't text input, so we
  // claim them globally (and preventDefault the browser's own page zoom).
  // ⌘⇧0 snap-back (A3) and ⌘K palette (A5) are matched by lib/keymap — the
  // snap-back matcher uses e.code because Shift rewrites e.key ("0" → ")")
  // on US layouts; the shift guard on plain "0" keeps layouts where it
  // doesn't from firing both. Through a ref: snapBack is defined below the
  // terminal state it writes, and the listener mounts once.
  const snapBackRef = useRef<() => void>(() => {});
  const openFrontDoorRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setDocZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 100) / 100));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setDocZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 100) / 100));
      } else if (isSnapBackKey(e)) {
        e.preventDefault();
        snapBackRef.current();
      } else if (e.key === "0" && !e.shiftKey) {
        e.preventDefault();
        setDocZoom(1);
      } else if (isPaletteKey(e)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (isNewPlanKey(e)) {
        // Back to the front door from anywhere, including a surface whose
        // sessions sidebar is masked. Through a ref for the same reason as
        // snap-back: this listener mounts once and openFrontDoor is defined
        // below the selection state it clears.
        e.preventDefault();
        openFrontDoorRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    // The same globals pressed in a web page, which this document never
    // hears: browser_signals.js forwards ⌘K, ⌘⇧N and ⌘⇧0 and BrowserPane
    // re-raises them here. ⌘K is the palette everywhere, a page's own ⌘K
    // included; the page chat keeps its own entry (the address bar's Chat).
    const palette = () => setPaletteOpen((v) => !v);
    const newPlan = () => openFrontDoorRef.current();
    const snapBack = () => snapBackRef.current();
    window.addEventListener("redline:palette", palette);
    window.addEventListener("redline:new-plan", newPlan);
    window.addEventListener("redline:snap-back", snapBack);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("redline:palette", palette);
      window.removeEventListener("redline:new-plan", newPlan);
      window.removeEventListener("redline:snap-back", snapBack);
    };
  }, [setDocZoom]);

  // ⌘W (File ▸ Close, a native menu item so it reaches the app while a
  // browser page has focus) closes from the inside out: a browser pane's
  // page first (BrowserPane closes it on the window event; its last page
  // closes the pane through `onClose`), else the focused pane of a split,
  // else the tab. Never the window: ⌘⇧W is the window, and the reducer
  // refills a set whose last tab closed, so Home always keeps a door.
  // ── Closing a terminal wall ──────────────────────────────────────────────
  // Every terminal's state and label, as the one TerminalTabs derives them:
  // the tab dots, the sidebar's terminal rows and this prompt read them.
  const [termStatuses, setTermStatuses] = useState<ReadonlyMap<string, TerminalStatus>>(() => new Map());
  const termStatusesRef = useRef(termStatuses);
  termStatusesRef.current = termStatuses;
  // A wall closing with something still running in it: Terminate or Keep
  // running. Nothing is ever hidden on its own — a kept terminal stays under
  // its session in the sidebar until a click puts it back on a wall.
  const [wallClose, setWallClose] = useState<{ key: SessionKey; tabId: string | null; walls: string[]; tiles: string[]; running: string[] } | null>(null);
  const finishWallClose = useCallback((close: { key: SessionKey; tabId: string | null; walls: string[]; tiles: string[] }, keep: boolean) => {
    for (const paneId of close.walls) wb.dispatch({ type: "closeWall", key: close.key, paneId, keep });
    if (!keep) terminalsRef.current?.closeTerminals(close.tiles);
    // The rest of a closed tab (a document tiled beside the wall) goes too.
    if (close.tabId && wb.getState().sets[close.key]?.tabs[close.tabId]) wb.dispatch({ type: "closeTab", key: close.key, tabId: close.tabId });
  }, []);
  /** Close a tab (its strip ×) or a pane (⌘W inside a split), asking first
   *  when a wall in it still has something running — decided on a sample
   *  taken now, never on what the fleet poll last happened to see, and with
   *  anything unsampled counted as running. */
  const requestClose = useCallback(async (target: { tabId: string } | { paneId: string }) => {
    const state = wb.getState();
    const key = state.activeKey;
    const set = state.sets[key];
    if (!set) return;
    const paneIds = "tabId" in target ? (set.tabs[target.tabId] ? paneIdsOf(set.tabs[target.tabId].root) : []) : [target.paneId];
    const walls = paneIds.map((id) => set.panes[id]).filter((p): p is Extract<AnyPane, { kind: "terminals" }> => p?.kind === "terminals");
    if (walls.length === 0) {
      if ("tabId" in target) wb.dispatch({ type: "closeTab", tabId: target.tabId });
      else wb.dispatch({ type: "closePane", paneId: target.paneId });
      return;
    }
    const tiles = walls.flatMap((w) => w.data.tiles);
    const handle = terminalsRef.current;
    let running: string[] = tiles;
    try {
      if (handle) running = await handle.runningNow(tiles);
    } catch {
      /* unread: ask */
    }
    const close = { key, tabId: "tabId" in target ? target.tabId : null, walls: walls.map((w) => w.id), tiles };
    if (running.length === 0) finishWallClose(close, false);
    else setWallClose({ ...close, running: running.map((id) => termStatusesRef.current.get(id)?.label ?? "terminal") });
  }, [finishWallClose]);
  const closeTabRequest = useCallback((tabId: string) => void requestClose({ tabId }), [requestClose]);
  const closePaneRequest = useCallback((paneId: string) => void requestClose({ paneId }), [requestClose]);
  // The pane menu's Split right / down, as ⌘D / ⌘⇧D outside a wall.
  const noRoomHint = useCallback(() => setToast(NO_ROOM_HINT, 3000), [setToast]);
  const splitFocusedWithDoor = useCallback((direction: "row" | "column") => {
    const before = wb.getState();
    const { tab } = activePanes(before);
    if (!tab) return;
    const paneId = newDoorPaneId();
    wb.dispatch({ type: "splitPane", paneId: tab.focusedPaneId, direction, pane: { kind: "door", data: { draftKey: doorDraftKey(paneId) } }, newPaneId: paneId, room: stageRoom() });
    if (wb.getState() === before) setToast(NO_ROOM_HINT, 3000);
  }, [setToast]);
  const closeFromInside = useCallback(() => {
    const { set, tab } = activePanes(wb.getState());
    if (!set || !tab) return;
    const focused = set.panes[tab.focusedPaneId];
    if (focused?.kind === "browser") {
      window.dispatchEvent(new CustomEvent("redline:browser-close-page"));
      return;
    }
    void requestClose(isSplit(tab.root) ? { paneId: tab.focusedPaneId } : { tabId: tab.id });
  }, [requestClose]);
  /** Close the active tab's pane of `kind` (a surface's own ✕ or Exit). */
  const closeSurfacePane = useCallback((kind: PaneKind) => {
    const { tab, panes } = activePanes(wb.getState());
    const pane = panes.find((p) => p.kind === kind);
    if (!tab || !pane) return;
    if (isSplit(tab.root)) wb.dispatch({ type: "closePane", paneId: pane.id });
    else wb.dispatch({ type: "closeTab", tabId: tab.id });
  }, []);
  // Every event the native menu emits for the workbench has exactly one
  // listener, here: File ▸ New Tab, Reopen Closed Tab, Close, Close Window,
  // and the Tabs submenu. BrowserPane keeps only menu-print;
  // browser_signals.js forwards the rest from a page.
  useEffect(() => {
    const tabs = (action: WorkbenchAction) => wb.dispatch(action);
    const subs = [
      listen("menu-new-tab", () => openDoorTabRef.current()),
      listen("menu-close-tab", closeFromInside),
      // File ▸ Print… (⌘⌥P): the focused pane — its page when it is a
      // browser, else the plan or the file it shows.
      listen("menu-print", () => printFocusedRef.current()),
      listen("menu-close-window", () => void getCurrentWindow().close()),
      listen("menu-reopen-tab", () => tabs({ type: "reopenClosed" })),
      // ⌘1–9 through the menu record the switch like every other path.
      listen<number>("menu-tab-index", (e) => {
        beginMeasure("wb:tab-switch");
        tabs({ type: "selectTabIndex", index: e.payload });
      }),
      listen<number>("menu-tab-cycle", (e) => {
        beginMeasure("wb:tab-switch");
        tabs({ type: "cycleTab", delta: e.payload < 0 ? -1 : 1 });
      }),
    ];
    // A page's ⌘⌥← / ⌘⌥→, forwarded by BrowserPane.
    const fromPage = (e: Event) => {
      beginMeasure("wb:tab-switch");
      tabs({ type: "cycleTab", delta: (e as CustomEvent<number>).detail < 0 ? -1 : 1 });
    };
    window.addEventListener("redline:workbench-tab-cycle", fromPage);
    // The same chords from the keyboard, on `e.code` and in the capture
    // phase, ahead of xterm: the native menu normally takes them first (a
    // browser page focused or not), but a page with no native menu still
    // has them. ⌘-only — Ctrl+T, Ctrl+W and friends are the terminal's.
    const onKey = (e: KeyboardEvent) => {
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (isNewTabKey(e)) {
        claim();
        openDoorTabRef.current();
      } else if (isReopenTabKey(e)) {
        claim();
        tabs({ type: "reopenClosed" });
      } else if (isCloseWindowKey(e)) {
        claim();
        void getCurrentWindow().close();
      } else if (isCloseKey(e)) {
        claim();
        closeFromInside();
      } else {
        const index = tabIndexKeyOf(e);
        const delta = tabCycleKeyOf(e);
        if (index !== null) {
          claim();
          beginMeasure("wb:tab-switch");
          tabs({ type: "selectTabIndex", index });
        } else if (delta !== null) {
          claim();
          beginMeasure("wb:tab-switch");
          tabs({ type: "cycleTab", delta });
        }
      }
    };
    // ⌘⇧↩ zooms (and puts back): a zoomed tab comes back first; in a wall
    // of two tiles or more it is the focused tile, as the tile header's
    // double-click; elsewhere in a split, the focused pane fills the tab.
    // Capture phase: in a terminal xterm would take the Return. A lone pane
    // has nothing to zoom, and the key is left alone.
    const zoomFocused = (): boolean => {
      const { set, tab } = activePanes(wb.getState());
      if (!set || !tab) return false;
      const focused = set.panes[tab.focusedPaneId];
      if (tab.zoomed) wb.dispatch({ type: "zoomPane" });
      else if (focused?.kind === "terminals" && focused.data.tiles.length > 1) terminalsRef.current?.toggleZoomFocused();
      else if (isSplit(tab.root)) wb.dispatch({ type: "zoomPane" });
      else return false;
      return true;
    };
    const onZoomKey = (e: KeyboardEvent) => {
      if (!isZoomPaneKey(e) || !zoomFocused()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // The same chords pressed in a web page, forwarded (browser_signals.js →
    // BrowserPane): the browser is the focused pane, never a wall.
    const fromPagePaneKey = (e: Event) => {
      const value = (e as CustomEvent<string>).detail;
      if (value === "zoom-pane") zoomFocused();
      else if (value === "split" || value === "split-anywhere") splitFocusedWithDoor("row");
      else if (value === "split-down") splitFocusedWithDoor("column");
    };
    window.addEventListener("redline:pane-key", fromPagePaneKey);
    // ⌘D / ⌘⇧D: inside a wall ⌘D adds a tile; anywhere else they split the
    // focused pane right / down with a door. ⌘\ splits right with a door
    // everywhere, a wall included. Bubble phase, and only for an event
    // nobody took: CodeMirror's ⌘D (next occurrence) prevents the default
    // first and keeps it.
    const onSplitKey = (e: KeyboardEvent) => {
      const anywhere = isSplitAnywhereKey(e);
      const dir = anywhere ? "row" : splitKeyOf(e);
      if (!dir || e.defaultPrevented) return;
      const { set, tab } = activePanes(wb.getState());
      if (!set || !tab) return;
      e.preventDefault();
      if (!anywhere && dir === "row" && set.panes[tab.focusedPaneId]?.kind === "terminals") {
        terminalsRef.current?.addTileHere();
        return;
      }
      const paneId = newDoorPaneId();
      const before = wb.getState();
      wb.dispatch({ type: "splitPane", paneId: tab.focusedPaneId, direction: dir, pane: { kind: "door", data: { draftKey: doorDraftKey(paneId) } }, newPaneId: paneId, room: stageRoom() });
      if (wb.getState() === before) setToast(NO_ROOM_HINT, 3000);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onZoomKey, true);
    window.addEventListener("keydown", onSplitKey);
    void invoke("set_workbench_menu", { enabled: true }).catch(() => {});
    return () => {
      for (const p of subs) void p.then(dropListener);
      window.removeEventListener("redline:workbench-tab-cycle", fromPage);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keydown", onZoomKey, true);
      window.removeEventListener("redline:pane-key", fromPagePaneKey);
      window.removeEventListener("keydown", onSplitKey);
    };
  }, [closeFromInside, splitFocusedWithDoor]);


  // A browser download or page save landed (or failed): Safari's notice, with
  // Open / Show in Finder. Native, so it fires for background tabs too; the
  // toast builder loads on the first download, never at boot.
  useEffect(() => {
    const p = listen<BrowserDownloadEvent>("browser-download", (e) => {
      void import("./lib/browserOutput").then((m) => setToast(m.downloadToast(e.payload)));
    });
    return () => {
      void p.then(dropListener);
    };
  }, [setToast]);

  // The first React commit — a themed shell now exists in the DOM. A layout
  // effect, so it lands on the commit itself rather than a frame later.
  useLayoutEffect(() => markOnce("rl:first-commit"), []);

  // Reveal the native window once the first themed frame has painted (the
  // window starts hidden), so launch never shows a flash of white. Two rAFs:
  // the first schedules after layout, the second after that frame commits.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        markOnce("rl:reveal-call");
        void invoke("show_main_window")
          .then(() => markOnce("rl:reveal-done"))
          .catch(() => {});
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // Project-folder explorer: open folders (sidebar tabs), the active tab, the
  // file shown in the center pane, and the linked-nav toggle.
  const {
    openFolders,
    sidebarTab,
    linkNav,
    openFolder,
    selectSessions,
    selectFolder,
    setActiveFile,
  } = useFolderWorkspaces();
  // The document plate wears three faces — the Front Door, a plan, and a
  // file — and the conversation dock tells a plan (which has a discussion)
  // from a file (which has none) by it. A file is a pane: the focused file
  // pane's path, and the plate's face follows the focused pane (a door tab
  // in a session is the door; a plan beside a browser is the plan).
  const activeFile = view.activeFile;
  const plateMode = plateFace(view, activeId);
  const plateModeRef = useRef(plateMode);
  plateModeRef.current = plateMode;
  const currentDockScope = dockScope(stageSurface, plateMode);
  dockScopeRef.current = currentDockScope;

  // ── Sessions and their terminals ──────────────────────────────────────────
  //
  // A session exists from the moment it launches: `flowLaunches` records the
  // launches whose plan has not arrived (the sidebar's pending rows, the
  // launch sets' Agent tabs); the terminal map is fed by the hooks
  // (`term-attention`), the engine (`convo-bound`), held plans and arrivals.
  // An Agent pane showing its PTY (its CLI view): the terminal dock is
  // pinned over that pane's box and shows that one terminal alone — the
  // same attachment the dock already holds, never a second one.
  const [cliView, setCliView] = useState<CliView | null>(null);
  const [flowLaunches, setFlowLaunches] = useState<readonly FlowLaunch[]>([]);
  const flowLaunchesRef = useRef(flowLaunches);
  flowLaunchesRef.current = flowLaunches;
  const noteFlowLaunch = useCallback(
    (event: LaunchEvent) => setFlowLaunches((prev) => reduceLaunches(prev, event)),
    [],
  );
  const {
    terminals: sessionTerminals,
    attention: terminalAttention,
    titles: terminalTitles,
    bind: bindSessionTerminals,
  } = useSessionTerminals(true);
  sessionTerminalsRef.current = sessionTerminals;
  const terminalKinds = useMemo(() => attentionKinds(terminalAttention), [terminalAttention]);
  // Every dock terminal currently holding a plan: the backend pins each held
  // POST to the terminal whose claude sent it, so the "plan intercepted" strip
  // renders inside exactly those tabs — never in a sibling tab, and never for
  // plans intercepted from external terminals. A *set*, not a boolean about the
  // focused tab: in a split dock each pane answers for itself, and approving
  // one pane's plan must leave the other pane's strip standing.
  const heldTermIds = useStableValue(useMemo(() => heldTerminalIds(summaries), [summaries]));
  // A held plan names the terminal its CLI is waiting in.
  useEffect(() => {
    bindSessionTerminals(
      summaries.flatMap((s) =>
        s.heldTerminalId ? [{ sessionId: s.sessionId, terminalId: s.heldTerminalId }] : [],
      ),
    );
  }, [summaries, bindSessionTerminals]);
  // The handoff: a launch's plan arriving binds its session to the launch's
  // terminal and retires the launch row — the same conversation, now with a
  // plan. The general arrival rule (the `plan-received` listener below)
  // decides everything else, the launch set's rekey included.
  useEffect(() => {
    const unlisten = listen<PlanReceivedEvent>("plan-received", (e) => {
      const { launchId, sessionId } = e.payload;
      const launch = launchId
        ? flowLaunchesRef.current.find((l) => l.launchId === launchId)
        : undefined;
      if (!launch) return;
      bindSessionTerminals([{ sessionId, terminalId: launch.terminalId }]);
      noteFlowLaunch({ type: "arrived", launchId: launch.launchId });
    });
    return () => {
      void unlisten.then(dropListener);
    };
  }, [bindSessionTerminals, noteFlowLaunch]);
  // The sidebar's launch rows: `launches`, with `activeLaunchId`.
  // A launch row spins on what its terminal reads, the way its Agent tab's
  // dot does (`terminalStatus`); nothing heard yet is still starting.
  const flowSidebarLaunches = useMemo(
    () => sidebarLaunches(flowLaunches, terminalKinds, terminalTitles).map((l) =>
      l.working && terminalKinds.has(l.terminalId) && termStatuses.has(l.terminalId) && terminalStatus(l.terminalId, { states: termStatuses }) !== "working" ? { ...l, working: false } : l),
    [flowLaunches, terminalKinds, terminalTitles, termStatuses],
  );
  // Live terminal ids. Null until the dock first reports — an absent report
  // must never read as "the terminal is gone".
  const [liveTermIds, setLiveTermIds] = useState<string[] | null>(null);
  // Its spinners, from the CLIs' own hooks.
  const { working: hookWorking, needs: hookNeeds } = useMemo(
    () => sidebarActivity(sessionTerminals, terminalAttention, flowLaunches),
    [sessionTerminals, terminalAttention, flowLaunches],
  );
  // Its "Needs you": a row needs you exactly when its terminal is in the
  // one needs-you set (`terminalStatus` says "needs"), whatever its last
  // hook said — a permission answered in the card, a build that finished,
  // an agent that died are not; an open question and a held plan are. The
  // hook's reason names which, when it has one.
  const flowNeeds = useMemo(() => {
    const out: Record<string, NeedReason> = {};
    const src = { states: termStatuses, attention: terminalKinds, held: heldTermIds, live: liveTermIds };
    const read = (key: string, terminalId: string) => {
      if (terminalStatus(terminalId, src) === "needs") out[key] = hookNeeds[key] ?? "Question";
    };
    for (const [sessionId, terminalId] of sessionTerminals) read(`plan:${sessionId}`, terminalId);
    for (const l of flowLaunches) read(`launch:${l.terminalId}`, l.terminalId);
    return out;
  }, [sessionTerminals, flowLaunches, hookNeeds, termStatuses, terminalKinds, heldTermIds, liveTermIds]);
  // A row spins only while its terminal reads "working" the way its tab dot
  // and its nested row do (`terminalStatus`): the hooks' `working` outlives a
  // turn held on your review (the CLI is blocked in the hook, no Stop comes)
  // and an agent the wall has seen back at its prompt. A launch nothing has
  // been heard from yet is still starting, which is work.
  const flowWorking = useMemo(() => {
    const out = new Set<string>();
    for (const key of hookWorking) {
      const term = key.startsWith("plan:") ? sessionTerminals.get(key.slice(5)) : key.startsWith("launch:") ? key.slice(7) : undefined;
      if (!term || !terminalKinds.has(term) || terminalStatus(term, { states: termStatuses, attention: terminalKinds, held: heldTermIds }) === "working") out.add(key);
    }
    return out.size === hookWorking.size ? hookWorking : out;
  }, [hookWorking, sessionTerminals, terminalKinds, termStatuses, heldTermIds]);
  // The launch on screen: the active `launch:` set's terminal (its Agent tab).
  const wbLaunchId = launchIdOf(wbActiveKey);
  // Pages in the browser that could not load (BrowserPane reports the count).
  const [browserNeeds, setBrowserNeeds] = useState(0);
  const activeLaunchId = wbLaunchId ? flowLaunches.find((l) => l.launchId === wbLaunchId)?.terminalId ?? null : null;
  // Each session's "Resuming…" (lib/autoResumeController publishes it).
  const resumePillsNow = useResumePills();
  // What the tab strip says about a pane beyond its kind: a plan's own
  // title and version, and its status in the shared vocabulary (the
  // session's terminal needs you / is working, from `sidebarActivity`).
  const describePane = useCallback((pane: AnyPane) => {
    // The browser wears the amber dot while a page in it could not load
    // (BrowserPane's `onNeedsChange`), as a terminal that needs you does.
    if (pane.kind === "browser") return { status: browserNeeds > 0 ? ("needs" as const) : undefined };
    // A wall wears the worst of its tiles, in the one vocabulary the fleet
    // derives (TerminalTabs' `onStatesChange`).
    if (pane.kind === "terminals") return { status: wallStatus(pane.data.tiles, termStatuses) };
    // An Agent tab wears its terminal's state: the fleet's derivation once
    // the layer has reported it, the CLI's own hooks until then.
    // (`terminalStatus`, the same read the sidebar's rows make: a held plan
    // is the agent waiting on you, never its stale `working`).
    if (pane.kind === "chat" && pane.data.source === "agent") {
      const status = terminalStatus(pane.data.terminalId, { states: termStatuses, attention: terminalKinds, held: heldTermIds });
      return { status: status === "idle" ? undefined : status };
    }
    if (pane.kind !== "plan") return {};
    const summary = summaries.find((x) => x.sessionId === pane.data.sessionId);
    const key = `plan:${pane.data.sessionId}`;
    const version = summary?.revisions.length ? latestDisplayVersion(summary.revisions, summary.latestVersion) : null;
    // A resume running reads as work and a failed one as needing you, ahead
    // of what the dead terminal last said (lib/autoResume's `resumePill`).
    const resume = resumePillsNow.get(pane.data.sessionId);
    return {
      // A title the user gave the tab wins (`paneTitle` reads it).
      title: pane.titleOverride ? undefined : summary ? `${summary.titleOverride || summary.planTitle || summary.projectName || "Plan"}${version ? ` v${version}` : ""}` : undefined,
      status: resume ? (resume.tone === "working" ? ("working" as const) : ("needs" as const)) : flowNeeds[key] ? ("needs" as const) : flowWorking.has(key) ? ("working" as const) : summary?.attachState === "detached" ? ("exited" as const) : undefined,
    };
  }, [summaries, flowNeeds, flowWorking, terminalKinds, termStatuses, heldTermIds, resumePillsNow, browserNeeds]);
  // The strip's right-hand cluster: the tile as a contextual entry — the
  // session's plan beside the surface in this tab, or the surface alone.
  const stageTile = (() => {
    const { panes } = activePanes(wb.getState());
    const doc = panes.find((p) => isDocumentKind(p.kind));
    const surface = panes.find((p) => !isDocumentKind(p.kind) && p.kind !== "terminals" && p.kind !== "chat");
    // Named for what the document half is: the plan, a door or a file.
    if (doc && surface) return { tiled: true as const, docId: doc.id, docName: doc.kind === "plan" ? "plan" : doc.kind === "door" ? "door" : "file" };
    if (!doc && surface && activeId) return { tiled: false as const, surfaceId: surface.id };
    return null;
  })();
  const stageActions = stageTile ? (
    <button
      type="button"
      className="rl-wb-right-btn"
      title={stageTile.tiled ? `Untile the ${stageTile.docName}` : "Tile the plan alongside"}
      aria-label={stageTile.tiled ? `Untile the ${stageTile.docName}` : "Tile the plan alongside"}
      aria-pressed={stageTile.tiled}
      onClick={() => {
        if (stageTile.tiled) wb.dispatch({ type: "closePane", paneId: stageTile.docId });
        else if (activeId) {
          const before = wb.getState();
          wb.dispatch({ type: "splitPane", paneId: stageTile.surfaceId, direction: "row", pane: { kind: "plan", data: { sessionId: activeId, version: null } }, before: true, room: stageRoom() });
          if (wb.getState() === before) setToast(NO_ROOM_HINT, 3000);
        }
      }}
    >
      <Columns2 size={16} aria-hidden />
    </button>
  ) : null;


  // ---- The shell's shape ----------------------------------------------------
  //
  // The persisted flags, through the responsive poses. The names below are
  // what every read site downstream (layoutFlagsRef, computePaneLayout, the
  // JSX guards, browserVisible, the useResizablePane wiring) reads; a read
  // that sits ABOVE this block is a TypeScript error, never a silently wrong
  // value.
  // The window's width, committed once a resize settles (`onResizeSession`
  // below). Each side pane's max is "up to the other pane", and it decides
  // the responsive poses (D18).
  const [winWidth, setWinWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  // No surface masks the side columns (W4). The sidebar and the rail stay
  // however the user left them on every pane (⌘B / ⌘⌥B); what a surface with
  // no document in front still changes is only the arrival rule — a plan
  // arriving there waits in a notice instead of taking the screen (the
  // manifest's `layout.immersive: false` opts out). Review is not such a
  // surface: its rail holds the review threads, and a plan there comes
  // forward as on a document. Neither is the tile, whose plan is on screen.
  const surfaceInFront = stageSurface !== "document" && stageSurface !== "review" && !view.hasDocument && workspaceImmersive(workspace);
  const paneMaskedRef = useRef(surfaceInFront);
  paneMaskedRef.current = surfaceInFront;
  // Responsive poses (D18, workbench/poses.ts): below 1100 px the rail folds
  // to its edge, below 900 px the sidebar to its icon pose. Opening one while
  // narrow is kept for the narrow spell; past the breakpoint the stored
  // preference applies again. A resize never writes the preference.
  const [narrowOpen, setNarrowOpen] = useState<NarrowOpen>(NO_NARROW_OPEN);
  // What the tab on screen asks of the stage (D40): a split folds the side
  // columns it cannot sit beside, as a narrow window does, and gives them
  // back when it closes.
  const stageMin = useWorkbench(wb, selectStageMin);
  // A window that cannot hold the tab's split at its panes' minimums — the
  // side columns folded — zooms the focused pane instead of squeezing them;
  // wide enough again, that zoom clears (a user's own ⌘⇧↩ stays).
  const stageFit = useWorkbench(wb, selectStageFit);
  useEffect(() => {
    if (stageFit) wb.dispatch({ type: "fitStage", room: winWidth - SIDEBAR_EDGE_W - RAIL_EDGE_W - 2 * DIVIDER_W });
  }, [winWidth, stageFit]);
  useEffect(() => setNarrowOpen((open) => settleNarrowOpen(open, winWidth, stageMin)), [winWidth, stageMin]);
  const pose = responsivePose({ winWidth, sidebarCollapsed: sidebarCollapsedPref, paneCollapsed: paneCollapsedPref, narrowOpen, stageMin });
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const narrowOpenRef = useRef(narrowOpen);
  narrowOpenRef.current = narrowOpen;
  const { docMin: narrowDocMin, overlayFirst: narrowOverlayFirst } = narrowLayoutInputs(pose, narrowOpen);
  const narrowInputs = useMemo(() => ({ docMin: narrowDocMin, overlayFirst: narrowOverlayFirst }), [narrowDocMin, narrowOverlayFirst]);
  const { sidebarCollapsed, paneCollapsed } = pose;
  // A folded rail is never fullscreen underneath.
  const paneFullscreen = paneFullscreenPref && !paneCollapsed;
  /** Fold or open a side column: the narrow opening while narrow, else the
   *  user's preference. Every gesture goes through these two. */
  const setRailFolded = useCallback((folded: boolean) => {
    if (poseRef.current.railNarrow) setNarrowOpen((o) => (o.rail === !folded ? o : { ...o, rail: !folded }));
    else setPaneCollapsed(folded);
  }, [setPaneCollapsed]);
  const setSidebarFolded = useCallback((folded: boolean) => {
    if (poseRef.current.sidebarNarrow) setNarrowOpen((o) => (o.sidebar === !folded ? o : { ...o, sidebar: !folded }));
    else setSidebarCollapsed(folded);
  }, [setSidebarCollapsed]);
  // A document face on screen: the plate alone, or the tile's plan half.
  const docVisible = stageSurface === "document" || view.hasDocument;

  const revealSidebar = useCallback(() => {
    setSidebarFolded(false);
  }, [setSidebarFolded]);
  const revealPane = useCallback(() => {
    setRailFolded(false);
  }, [setRailFolded]);
  // "Show me the terminals": this set's wall comes forward, or — with none —
  // a terminal opens in the session's project, on a wall of its own. The
  // intent to use them mounts the layer now rather than at the next idle
  // callback.
  const openTerminalRef = useRef<(cwd: string | null) => Promise<string | null>>(async () => null);
  const sessionCwdRef = useRef<string | null>(null);
  sessionCwdRef.current = session?.projectPath || null;
  const revealTerm = useCallback(() => {
    setTerminalMounted(true);
    const state = wb.getState();
    const set = state.sets[state.activeKey];
    if (set && Object.values(set.panes).some((p) => p.kind === "terminals")) wb.dispatch({ type: "openSurface", kind: "terminals" });
    else void openTerminalRef.current(sessionCwdRef.current);
  }, []);
  // The user-driven toggles read the EFFECTIVE value to pick their direction:
  // masked, the pane reads as closed, so the gesture means "open" — which is
  // what the user pressing ⇧← at a hidden sidebar is asking for.
  const toggleSidebar = useCallback(() => {
    setSidebarFolded(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarFolded]);
  const togglePane = useCallback(() => {
    // Folding a fullscreen rail lands on the edge strip, not on a hidden
    // fullscreen the next ◨ would resurrect.
    if (!paneCollapsed) setPaneFullscreen(false);
    setRailFolded(!paneCollapsed);
  }, [paneCollapsed, setRailFolded, setPaneFullscreen]);
  // ---- The right rail (W4) ----------------------------------------------------
  // The Discussion pane became the rail: one column whose tabs follow the
  // FOCUSED pane's kind (`workbench/rail.ts`), on the pane's own geometry —
  // its width, its collapse (now the edge strip of tab icons) and its
  // fullscreen. The tab last picked is remembered per kind, so a plan and a
  // browser each come back to the tab they were left on.
  const [railMemoryStored, setRailMemory] = usePersistedState<RailMemory>(RAIL_MEMORY_KEY, {});
  const railMemory = useMemo(() => parseRailMemory(railMemoryStored), [railMemoryStored]);
  const railKind: PaneKind = view.focusedKind ?? "door";
  const railKindRef = useRef(railKind);
  railKindRef.current = railKind;
  const railTabs = railTabsFor(railKind);
  const railTab = railTabFor(railKind, railMemory);
  const selectRailTab = useCallback(
    (tab: RailTab) => setRailMemory((stored) => rememberRailTab(parseRailMemory(stored), railKindRef.current, tab)),
    [setRailMemory],
  );
  // The conversation is up when the rail shows Talk (W4: the dock's body
  // lives there now).
  const dockOpen = !paneCollapsed && railTab === "talk";
  const talkShownRef = useRef(dockOpen);
  talkShownRef.current = dockOpen;
  // Sections for the drafter voice walkthrough — parsed backend-side from
  // the mirrored markdown, only while Talk shows the draft's voice.
  useEffect(() => {
    if (!(dockOpen && stageSurface === "drafter" && drafterDraftId)) return;
    let alive = true;
    void invoke<Section[]>("parse_markdown_sections", {
      markdown: drafterMarkdown,
    })
      .then((s) => alive && setDrafterSections(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dockOpen, stageSurface, drafterDraftId, drafterMarkdown]);
  /** The drafter's Comments toggle and a new comment: its threads in the
   *  rail's Discussion. */
  const showDrafterDiscussion = useCallback(() => {
    selectRailTab("discussion");
    revealPane();
  }, [selectRailTab, revealPane]);
  /** Open the rail on `tab` (an edge-strip icon, ⌘J's Talk). */
  const openRailTab = useCallback(
    (tab: RailTab) => {
      selectRailTab(tab);
      revealPane();
    },
    [selectRailTab, revealPane],
  );
  // ⌘B / ⌘⌥B: the sidebar and the rail, caught in the capture phase so a
  // terminal never sees them. ⌘B is bold in rich text (the plan, the
  // drafter, CodeMirror), so an editable target keeps it; ⌘⌥B is the rail's
  // everywhere. A focused web page forwards both as page signals
  // (browser_signals.js), with the same editable-target rule on its side.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isRailToggleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        togglePane();
        return;
      }
      if (!isSidebarToggleKey(e)) return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("redline:toggle-sidebar", toggleSidebar);
    window.addEventListener("redline:toggle-plan-panel", togglePane);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("redline:toggle-sidebar", toggleSidebar);
      window.removeEventListener("redline:toggle-plan-panel", togglePane);
    };
  }, [toggleSidebar, togglePane]);


  // A3 snap-back: one gesture returns the shell to its canonical resting
  // arrangement — the shape a fresh install's doors open onto — and a second
  // gesture from rest CLOSES the panes (full-bleed document). The cycle is
  // messy → canonical → closed → canonical…, with "at rest" derived from the
  // live flags (isLayoutAtRest), never stored, so it can't go stale when
  // other flows force panes open. Values go through the proven persisted
  // setters, so persistence and the state→geometry pass follow for free;
  // `data-rl-snapback` rides <html> for ~320ms so the discrete jumps travel
  // as one short fold (no resize session is open, so the data-rl-resizing
  // suppression can't fight it; reduced motion never sets the attribute).
  // Voice is deliberately untouched — voice is first-class, and snap-back
  // must never kill an active discussion. A hand-edited workspace.json
  // `layout` block adjusts the target (GUI–file duality; see
  // workspaceLayout).
  const snapBackTimer = useRef(0);
  const snapBack = useCallback(() => {
    const target = canonicalLayout(
      window.innerWidth,
      window.innerHeight,
      workspaceLayout(workspace),
    );
    // Everything below reads the *Pref flags, not the posed ones: the at-rest
    // cycle has to describe the user's real layout, not a narrow window's.
    if (
      isLayoutAtRest(
        {
          sidebarCollapsed: sidebarCollapsedPref,
          paneCollapsed: paneCollapsedPref,
          paneFullscreen: paneFullscreenPref,
          surface: stageSurface,
        },
        target,
      )
    ) {
      // Already canonical → close. Intentionally instant, with NO
      // data-rl-snapback attribute: collapsing unmounts the sidebar/pane
      // clips, so the settle transition would have nothing to animate and
      // the snap-glow would fire on vanishing plates. Widths and heights
      // stay persisted for the next reopen; everything-closed is not
      // at-rest, so the next press snaps back and the cycle completes.
      setSidebarCollapsed(true);
      setPaneCollapsed(true);
      return;
    }
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const html = document.documentElement;
      html.setAttribute("data-rl-snapback", "");
      window.clearTimeout(snapBackTimer.current);
      snapBackTimer.current = window.setTimeout(
        () => html.removeAttribute("data-rl-snapback"),
        SNAPBACK_SETTLE_MS,
      );
    }
    setSidebarWidth(target.sidebarWidth);
    setSidebarCollapsed(false);
    setPaneWidth(target.paneWidth);
    setPaneCollapsed(false);
    setPaneFullscreen(false);
    selectSurface(target.surface);
  }, [
    workspace,
    selectSurface,
    setSidebarWidth,
    setSidebarCollapsed,
    setPaneWidth,
    setPaneCollapsed,
    setPaneFullscreen,
    // The at-rest check reads the live persisted flags; snapBackRef exists
    // precisely so the mount-once ⌘⇧0 listener sees this fresh closure.
    sidebarCollapsedPref,
    paneCollapsedPref,
    paneFullscreenPref,
    stageSurface,
  ]);
  snapBackRef.current = snapBack;
  const [termTabCount, setTermTabCount] = useState(1);
  // A session's terminal, learnt: its set (when it has one) gets an Agent
  // tab for it — quietly, beside the plan, and once: the set remembers the
  // terminal (`agentsFilled`), so a tab the user closed stays closed — and
  // loses one for a terminal that is gone and no longer the session's (a
  // restore into a fresh PTY).
  useEffect(() => {
    for (const [sessionId, terminalId] of sessionTerminals) {
      // Every set's Agent pane of this session follows its agent to the
      // terminal it runs in now — a sidebar row put it in the set that was
      // on screen (D29), not only the session's own.
      wb.dispatch({ type: "followAgent", sessionId, terminalId });
      const state = wb.getState();
      const key = planKey(sessionId);
      const set = state.sets[key];
      if (!set) continue;
      wb.dispatch({ type: "ensureDefaults", key, defaults: { agentTerminalId: terminalId } });
      if (!liveTermIds) continue;
      for (const pane of Object.values(set.panes)) {
        if (pane.kind === "chat" && pane.data.source === "agent" && pane.data.terminalId !== terminalId && !liveTermIds.includes(pane.data.terminalId)) {
          wb.dispatch({ type: "closePane", key, paneId: pane.id });
        }
      }
    }
  }, [sessionTerminals, liveTermIds]);
  // Fork (the Agent pane's header): the CLI session continues in a new
  // terminal of its own, this one left as it is. Claude's `--fork-session`
  // gives the copy a session id of its own, so a plan it writes is a new
  // session here. Its conversation opens as an Agent tab beside this one.
  const forkCliSession = async (cliSessionId: string, projectPath: string | null) => {
    if (!/^[\w.-]+$/.test(cliSessionId)) return;
    const id = await openTerminal(projectPath, true);
    if (!id) {
      setToast("Couldn't open a terminal to fork into", 6000);
      return;
    }
    const delivery = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: `claude --resume ${cliSessionId} --fork-session\r` }]);
    if (!delivery.ok) {
      setToast(`Couldn't fork the session (${delivery.stage}): ${delivery.reason}`, 6000);
      return;
    }
    wb.dispatch({ type: "openSurface", kind: "chat", data: { source: "agent", terminalId: id, sessionId: null } });
  };
  // Resume (a tile's ▾, on an agent terminal whose CLI is no longer
  // running): the same conversation in a fresh terminal, bound to the
  // session before the CLI starts, as a restore is, and shown.
  const resumeCliSession = async (sessionId: string, projectPath: string | null) => {
    if (!/^[\w.-]+$/.test(sessionId)) return;
    const id = await openTerminal(projectPath);
    if (!id) {
      setToast("Couldn't open a terminal to resume in", 6000);
      return;
    }
    bindSessionTerminals([{ sessionId, terminalId: id }]);
    const delivery = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: `claude --resume ${sessionId}\r` }]);
    if (!delivery.ok) setToast(`Couldn't resume the session (${delivery.stage}): ${delivery.reason}`, 6000);
  };
  // The tile menu's names and session verbs, stable for the memoized layer.
  const sessionLabels = useMemo(() => new Map(summaries.map((x) => [planKey(x.sessionId), x.titleOverride || x.planTitle || x.projectName || "Plan"])), [summaries]);
  // Claude's sessions only: fork and resume are `claude --resume` verbs.
  const agentSessions = useMemo(() => {
    const codex = new Set(summaries.filter((x) => x.backend === "codex").map((x) => x.sessionId));
    return new Map([...sessionTerminals].filter(([sessionId]) => !codex.has(sessionId)).map(([sessionId, terminalId]) => [terminalId, sessionId]));
  }, [sessionTerminals, summaries]);
  const terminalSessionActionRef = useRef<(kind: "fork" | "resume", terminalId: string) => void>(() => {});
  terminalSessionActionRef.current = (kind, terminalId) => {
    const sessionId = agentSessions.get(terminalId);
    if (!sessionId) return;
    const projectPath = summaries.find((x) => x.sessionId === sessionId)?.projectPath || null;
    void (kind === "fork" ? forkCliSession(sessionId, projectPath) : resumeCliSession(sessionId, projectPath));
  };
  const terminalSessionAction = useCallback((kind: "fork" | "resume", terminalId: string) => terminalSessionActionRef.current(kind, terminalId), []);
  const liveTermIdsRef = useRef(liveTermIds);
  liveTermIdsRef.current = liveTermIds;
  // How many dock terminals need you (TerminalTabs owns which): the footer
  // chip, and whether ⌘⇧J has anywhere to go.
  const [, setTermNeedYou] = useState(0);
  // THE needs-you set (`needsYouTerminals`): every live terminal whose one
  // status (`terminalStatus` — the wall's derivation once it has reported,
  // else the hooks App re-read from the daemon's snapshot, a held plan
  // reading as needing you) is "needs". The rows, the tab dots, the top
  // bar's "N need you" and ⌘⇧J all read this one value, so none of them
  // can disagree (the last walk's NEEDS YOU rows under "0 need you", and
  // ⌘⇧J landing on a finished build). A finished turn is not in it.
  const hookLoud = useMemo(
    () => needsYouTerminals([...termStatuses.keys(), ...terminalKinds.keys(), ...heldTermIds], { states: termStatuses, attention: terminalKinds, held: heldTermIds, live: liveTermIds }),
    [terminalKinds, termStatuses, liveTermIds, heldTermIds],
  );
  const hookLoudRef = useRef(hookLoud);
  hookLoudRef.current = hookLoud;
  const loudCount = hookLoud.length;
  // The top bar's "N need you": the same set.
  const termNeedYou = loudCount;
  // ⌘⇧J's gate: the same set.
  const termNeedYouRef = useRef(loudCount);
  termNeedYouRef.current = loudCount;
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
      // The tab the user was on comes back when the step moves on.
      const before = wb.getState();
      const key = before.activeKey;
      const tabId = before.sets[key]?.activeTabId ?? null;
      const backToTab = () => {
        if (tabId) wb.dispatch({ type: "selectTab", key, tabId });
      };
      if (anchor === "terminals-tab") {
        // The set's wall (and so its tab) comes forward when it has one; with
        // none the step is a centred card, as the Agent step is. The tour
        // never opens a terminal nobody asked for.
        if (findPane(before, "terminals")) {
          wb.dispatch({ type: "openSurface", kind: "terminals" });
          tourRevealRestore.current = backToTab;
        }
      } else if ((anchor === "editor" || anchor === "plan-verbs") && activeId && findPane(before, "plan")) {
        // The plan and its verbs are the Plan tab's: the session on
        // screen's, in this set (D29).
        wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: activeId, version: null } } });
        tourRevealRestore.current = backToTab;
      } else if ((anchor === "sessions" || anchor === "new-tab") && sidebarCollapsed) {
        revealSidebar();
        tourRevealRestore.current = () => setSidebarFolded(true);
      } else if (anchor === "rail" && paneCollapsed) {
        revealPane();
        tourRevealRestore.current = () => setRailFolded(true);
      } else if (anchor === "landing" && !doorVisible) {
        // The composer is only measurable while the door is up — resting on
        // the empty plate, or open anywhere else.
        setFrontDoorOpen(true);
        tourRevealRestore.current = () => setFrontDoorOpen(false);
      }
    },
    [
      activeId,
      doorVisible,
      sidebarCollapsed,
      paneCollapsed,
      setSidebarCollapsed,
      setPaneCollapsed,
      revealSidebar,
      revealPane,
    ],
  );

  // Follow the active terminal's live working directory: when it `cd`s into a
  // new folder, auto-open that folder as a sidebar tab, and — when linked nav
  // is engaged — bring the tab forward. The dock's fleet poll reads every
  // visible tile's cwd in one `lsof` and reports the focused one's here, with
  // its id, so a focus change can never pair one terminal with another's
  // folder; the shell runs no `lsof` loop of its own. `linkNav` is read
  // through a ref so a toggle flip doesn't replay the last report.
  const [termCwd, setTermCwd] = useState<{ id: string; dir: string } | null>(null);
  const handleFocusedCwd = useCallback(
    (id: string, dir: string) =>
      setTermCwd((prev) => (prev?.id === id && prev.dir === dir ? prev : { id, dir })),
    [],
  );
  const linkNavRef = useRef(linkNav);
  linkNavRef.current = linkNav;
  // Per-folder memory of the last file viewed in each folder. Activating a
  // folder — by focusing a terminal sitting in it (linked nav), `cd`ing there,
  // or clicking its sidebar tab — reopens whatever file you last had open in
  // that folder, so every project keeps its place. Keyed by folder path; a ref
  // because it's written from handlers and read from the cwd follow.
  const folderFileRef = useRef<Map<string, string | null>>(new Map());
  // Reverse of folder→file: which terminal currently lives in each folder, so
  // clicking a folder tab can focus its terminal. Each terminal maps to exactly
  // one folder (its live cwd); the cwd follow keeps it pruned.
  const folderTermRef = useRef<Map<string, string>>(new Map());
  // Per-terminal context: the folder this terminal lives in and the file last
  // viewed *from* it. Switching terminal tabs restores this instantly (no
  // wait for the next cwd read), so each terminal holds its own place even
  // when several share a project. Stale ids are harmless — activeTermId only
  // ever points at live tabs.
  const termCtxRef = useRef<
    Map<string, { folder: string | null; file: string | null }>
  >(new Map());
  // ── Deferred terminal dock (boot budget) ───────────────────────────────
  //
  // `TerminalTabs` used to mount with the shell: it loads xterm, spawns a PTY,
  // and starts polling cwds — all while the front door is still coming up, for
  // a dock most launches don't touch until after they've typed a sentence.
  //
  // Now the dock renders as a fixed-geometry SHELL (the plate, the divider,
  // the height the layout owns) and the tabs mount once, on the first of:
  //   * an idle callback after the first actionable frame,
  //   * the user opening/focusing the dock,
  //   * a launch that needs a terminal — which awaits the mount rather than
  //     racing it (`ensureTerminalReady`).
  // Once mounted it is never unmounted: a surface change that took the dock
  // away would kill every PTY in it and lose the scrollback.
  const [terminalMounted, setTerminalMounted] = useState(false);
  // A pane asking for its PTY wants the dock now, not at the next idle.
  useEffect(() => {
    if (cliView) setTerminalMounted(true);
  }, [cliView]);
  const terminalsRef = useRef<TerminalTabsHandle | null>(null);
  /** Where a dictation with nowhere to type goes (set beside the dock's
   *  contexts below). */
  const talkRef = useRef<TalkContext | null>(null);
  /** Resolvers waiting for the dock's imperative handle to exist. */
  const terminalWaitersRef = useRef<((h: TerminalTabsHandle | null) => void)[]>(
    [],
  );
  /** Callback ref: the handle's arrival is the signal a queued launch needs,
   *  and a ref object cannot announce itself. */
  const attachTerminals = useCallback((handle: TerminalTabsHandle | null) => {
    terminalsRef.current = handle;
    if (!handle) return;
    const waiting = terminalWaitersRef.current;
    terminalWaitersRef.current = [];
    for (const resolve of waiting) resolve(handle);
  }, []);
  /** Mount the dock if it isn't, and resolve once a PTY can be opened in it.
   *
   *  This is the queue the plan calls for: launch intent that arrives before
   *  xterm exists waits for it instead of being dropped. Bounded — a dock that
   *  never mounts must surface as "couldn't open a terminal", the failure the
   *  launch path already handles, not as a launch that hangs forever. */
  const ensureTerminalReady = useCallback(
    (timeoutMs = 5000): Promise<TerminalTabsHandle | null> => {
      if (terminalsRef.current) return Promise.resolve(terminalsRef.current);
      setTerminalMounted(true);
      return new Promise((resolve) => {
        let settled = false;
        const once = (h: TerminalTabsHandle | null) => {
          if (settled) return;
          settled = true;
          resolve(h);
        };
        terminalWaitersRef.current.push(once);
        window.setTimeout(() => once(terminalsRef.current), timeoutMs);
      });
    },
    [],
  );
  /** Show a terminal in the set on screen (D29: never a switch of the
   *  strip), hailed once that has painted. A session's agent terminal is its
   *  Agent tab (where its questions are), opened as a tab here, unless the
   *  raw PTY is what was asked for; any other terminal comes onto a wall of
   *  this set (one wall per PTY: it leaves the one it was on). */
  const showTerminal = useCallback((id: string, focus = false, raw = false) => {
    setTerminalMounted(true);
    const state = wb.getState();
    const owner = state.owners[id];
    const agent = owner && !raw
      ? Object.values(state.sets[owner]?.panes ?? {}).find((p): p is Extract<AnyPane, { kind: "chat" }> => p.kind === "chat" && p.data.source === "agent" && p.data.terminalId === id)
      : undefined;
    if (owner && agent) {
      openSessionPane({ kind: "chat", data: agent.data });
      return;
    }
    wb.dispatch({ type: "revealTerminal", ptyId: id, key: state.activeKey });
    requestAnimationFrame(() => {
      terminalsRef.current?.hailTerminal(id);
      if (focus) terminalsRef.current?.focusTerminal(id);
    });
  }, []);
  /** Open a terminal in `cwd` and, unless it is machinery (`background`: a
   *  restore, a launch the door's pill tracks), show it. Null when no
   *  terminal could be opened. */
  const openTerminal = useCallback(async (cwd: string | null, background = false): Promise<string | null> => {
    const id = (await ensureTerminalReady())?.openSessionTerminal(cwd) ?? null;
    if (id && !background) showTerminal(id);
    return id;
  }, [ensureTerminalReady, showTerminal]);
  openTerminalRef.current = openTerminal;

  // Mount the terminal dock once the shell is actionable and the main thread
  // is free. Idle, not immediate: xterm's chunk plus a PTY spawn plus the cwd
  // poll is real work, and the point of deferring it was to keep it off the
  // frame the user is waiting for. Any explicit intent (opening the dock, a
  // launch) beats this timer — see `ensureTerminalReady`.
  useEffect(() => {
    if (!shellReady || terminalMounted) return;
    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    const run = () => setTerminalMounted(true);
    if (!idle) {
      const t = window.setTimeout(run, 400);
      return () => window.clearTimeout(t);
    }
    const id = idle(run, { timeout: 2000 });
    return () =>
      (
        window as Window & { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback?.(id);
  }, [shellReady, terminalMounted]);

  // A wall on screen needs its terminals now, not at the next idle beat.
  const wallOnScreen = view.visibleKinds.includes("terminals");
  useEffect(() => {
    if (wallOnScreen) setTerminalMounted(true);
  }, [wallOnScreen]);
  // Terminals that are gone leave every wall (a relaunch, a closed shell),
  // so no wall points at a PTY that is not there; once the layer has said
  // which are live, never before.
  useEffect(() => {
    if (!liveTermIds) return;
    const state = wb.getState();
    const sessions = (Object.keys(state.sets) as SessionKey[]).map(sessionIdOf).filter((sid): sid is string => sid !== null);
    wb.dispatch({ type: "prune", liveSessions: sessions, livePtys: liveTermIds });
  }, [liveTermIds]);

  // The dock is live: xterm is loaded and a PTY can be opened in it. The
  // hold-to-dictate key loads on the same idle beat — a chunk the first
  // paint never needs.
  useEffect(() => {
    if (!terminalMounted) return;
    markOnce("rl:terminal-ready");
    void loadDictation().then((m) => m.installDictation(() => talkRef.current));
  }, [terminalMounted]);

  // ⌘⇧J and the footer's "N need you": reveal the dock (out from under the
  // front door, like any "show me the terminal") and let it land on the next
  // terminal that needs you. Nothing happens when nothing does.
  const jumpToNeedsYou = useCallback(() => {
    if (termNeedYouRef.current === 0) return;
    setFrontDoorOpen(false);
    // Across sessions: the one that needs you comes forward, its wall and
    // its tile with it, then the tile is hailed and takes the caret.
    void ensureTerminalReady().then((dock) => {
      const target = dock?.nextNeedsYou() ?? hookLoudRef.current[0] ?? null;
      if (target) showTerminal(target, true);
    });
  }, [ensureTerminalReady, showTerminal]);
  // Capture phase, like the Shift+arrow pane keys below: xterm's handler sits
  // on its helper textarea, so this runs first and the shell never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNeedsYouKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      jumpToNeedsYou();
    };
    // ⌘⇧J pressed in a web page, forwarded (browser_signals.js).
    const fromPage = () => jumpToNeedsYou();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("redline:needs-you", fromPage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("redline:needs-you", fromPage);
    };
  }, [jumpToNeedsYou]);


  // Switch the sidebar to a folder and reopen the file last viewed there. The
  // single path for "this folder is now active", whatever triggered it. Does
  // NOT touch terminal focus — that's the caller's concern (the cwd follow is
  // itself terminal-driven; a tab click adds the focus via selectFolderTab).
  const activateFolder = useCallback(
    (path: string) => {
      selectFolder(path);
      setActiveFile(folderFileRef.current.get(path) ?? null);
    },
    [selectFolder, setActiveFile],
  );


  // Shift + arrows toggle the side columns (← sidebar, → rail), aliases of
  // ⌘B / ⌘⌥B. A capture-phase window
  // listener so the keystroke is caught — and swallowed — even when the xterm
  // terminal has focus (its handler sits on a bubble-phase helper textarea, so
  // capture runs first and stopPropagation keeps the shell from seeing the
  // escape sequence). Real editors (Tiptap, composer inputs) keep native
  // Shift+Arrow text selection; the xterm helper textarea is exempted so the
  // hotkeys still fire there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      // ⇧↓ went with the bottom dock: in a terminal it is the shell's again.
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight"
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
          toggleSidebar();
          break;
        case "ArrowRight":
          togglePane();
          break;
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    // The toggles close over the EFFECTIVE flags to pick their direction, so
    // the listener re-subscribes when one flips.
    toggleSidebar,
    togglePane,
  ]);

  useEffect(() => {
    if (!termCwd) return;
    const { id: termId, dir } = termCwd;
    let cancelled = false;
    void (async () => {
      // A terminal sitting in $HOME (where new shells spawn) or the filesystem
      // root isn't "a project" — don't surface those as folder tabs. The user
      // has to `cd` into an actual project for it to open.
      if ((await isUninterestingDir(dir)) || cancelled) return;
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
      // clobber the per-terminal restore on every tab switch (a switch is a
      // new report, so it always lands here) — with two terminals in one
      // folder, both tabs would converge on whichever file was opened last
      // anywhere in that folder.
      // Flow has no folder tabs and no file viewer on the stage: following
      // the terminal there would swap the plan for "Browsing files".
      if (linkNavRef.current) {
        selectFolder(dir);
        setActiveFile(file ?? folderFileRef.current.get(dir) ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [termCwd, openFolder, selectFolder, setActiveFile]);

  // Opening/closing a file records it as the active folder's remembered file
  // (so the folder reopens on it) AND as the active terminal's remembered file
  // when that terminal lives in the folder (so switching terminals restores
  // each one's own place).
  const handleOpenFile = useCallback(
    (path: string, mode: OpenFileMode = "preview") => {
      setActiveFile(path);
      // A file opens as a pane in the current set (the one already open with
      // that path comes forward): previewed, pinned or in a tab of its own
      // (W4's Files rail rules).
      wb.dispatch({ type: "openFile", path, mode });
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
    closeSurfacePane("file");
    if (sidebarTab.kind === "folder") {
      folderFileRef.current.set(sidebarTab.id, null);
      if (activeTermId) {
        const ctx = termCtxRef.current.get(activeTermId);
        if (ctx?.folder === sidebarTab.id) {
          termCtxRef.current.set(activeTermId, { ...ctx, file: null });
        }
      }
    }
  }, [setActiveFile, sidebarTab, activeTermId, closeSurfacePane]);

  // Terminal tab switch → instantly restore that terminal's folder + file
  // (the cwd report above follows within a fleet tick; this is immediate).
  // Respects the linked-nav toggle exactly like the cwd follow does, and falls
  // back to the folder's own memory when this terminal hasn't viewed a file
  // yet.
  useEffect(() => {
    if (!activeTermId || !linkNavRef.current) return;
    const ctx = termCtxRef.current.get(activeTermId);
    if (!ctx?.folder) return;
    selectFolder(ctx.folder);
    setActiveFile(ctx.file ?? folderFileRef.current.get(ctx.folder) ?? null);
  }, [activeTermId, selectFolder, setActiveFile]);

  const documentRef = useRef<HTMLElement | null>(null);
  // File ▸ Print… on the focused pane. A browser pane prints its page
  // (BrowserPane); a plan prints its document and a file its text, through
  // the app's own print panel (lib/printPane); anything else says so.
  const printFocused = () => {
    const { set, tab } = activePanes(wb.getState());
    const pane = set && tab ? set.panes[tab.focusedPaneId] : undefined;
    if (pane?.kind === "browser") {
      window.dispatchEvent(new Event("redline:browser-print"));
      return;
    }
    void import("./lib/printPane").then(async (m) => {
      try {
        if (pane?.kind === "file") {
          const text = await m.readPrintableFile(pane.data.path);
          if (text === null) { setToast("This file can't be printed from here", 4000); return; }
          await m.printPane({ kind: "file", path: pane.data.path, text });
          return;
        }
        const element = documentRef.current;
        if (pane?.kind === "plan" && element) {
          await m.printPane({ kind: "plan", element });
          return;
        }
        setToast("Print works on a plan, a file or a web page — focus one first", 4000);
      } catch (err) {
        setToast(`Print failed: ${err}`, 6000);
      }
    });
  };
  const printFocusedRef = useRef(printFocused);
  printFocusedRef.current = printFocused;
  const sidebarRef = useRef<HTMLElement | null>(null);
  const docColumnRef = useRef<HTMLDivElement | null>(null);
  // The two elements the contents-rail drag resizes directly.
  const tocRailRef = useRef<HTMLDivElement | null>(null);
  const docScrollerRef = useRef<HTMLDivElement | null>(null);
  // The collapsed rail's "☰ Contents" button, which drops to a bare burger
  // when the text column reaches it.
  const tocBtnRef = useRef<HTMLButtonElement | null>(null);

  // `winWidth` is declared with the responsive poses, above (D18).
  // Read through the sidebar's hard stop (D38), so a width stored before it
  // is never drawn below 200 px.
  const sidebarWidth = clampSidebarWidth(sidebarWidthPref);

  // The row's space model: the stage floors at its hard stop (D38/D40), the
  // columns give it room back down to their own minimums, and only what is
  // left — a column opened by hand while narrow — curtains. Stateless — it
  // appears and retracts continuously as widths / window / collapse change.
  // Memoized because it is destructured straight into effect deps below: a
  // fresh object literal per render re-ran those effects (and rebuilt their
  // ResizeObservers) on every unrelated state change in this component.
  const layout = useMemo(
    () =>
      computePaneLayout({
        winWidth,
        sidebarWidth,
        sidebarCollapsed,
        paneWidth,
        paneCollapsed,
        paneFullscreen,
        // The same inputs the live path (`applyLiveLayout`) measures with.
        paneEdgeW: RAIL_EDGE_W,
        sidebarEdgeW: SIDEBAR_EDGE_W,
        sidebarMin: SIDEBAR_MIN_W,
        paneMin: RAIL_MIN_W,
        stageMin,
        ...narrowInputs,
      }),
    [
      stageMin,
      winWidth,
      sidebarWidth,
      sidebarCollapsed,
      paneWidth,
      paneCollapsed,
      paneFullscreen,
      narrowInputs,
    ],
  );

  // ---- The live layout path -------------------------------------------------
  //
  // A divider drag must not re-render this component. Instead the drag writes
  // the derived geometry to CSS custom properties on the shell root and the
  // sizing sites read them with `var(...)`, exactly as `--rl-discussion-zoom`
  // already does for text size. React state is still the source of truth
  // BETWEEN drags: a layout effect re-writes the same variables from state
  // after every render, so the inline write is simply the freshest value.
  //
  // Two things genuinely need a render because they add or remove DOM rather
  // than resize it — the curtain's extra divider copy and hiding the native
  // browser webview. Those are tracked as booleans and committed
  // only when one actually flips, at most a couple of times per drag.
  // Each live size is written DIRECTLY onto the one element that uses it.
  //
  // The obvious-looking alternative — one set of custom properties on the shell
  // root — is a trap: a custom property is inherited, so changing one on an
  // ancestor invalidates style for its whole subtree. Setting them on the root
  // meant every drag frame asked the engine to recompute style for the entire
  // document (plan editor, discussion list, file tree, terminals), which is far
  // more expensive than the React render it replaced. Writing
  // `el.style.width` touches exactly one element.
  const sidebarClipRef = useRef<HTMLDivElement | null>(null);
  const sidebarAsideRef = useRef<HTMLElement | null>(null);
  const sidebarCurtainDivRef = useRef<HTMLDivElement | null>(null);
  const paneClipRef = useRef<HTMLDivElement | null>(null);
  const paneAsideRef = useRef<HTMLElement | null>(null);
  const paneCurtainDivRef = useRef<HTMLDivElement | null>(null);
  const liveSizeRef = useRef({ sidebarWidth, paneWidth, winWidth });
  const stageMinRef = useRef(stageMin);
  stageMinRef.current = stageMin;
  const layoutFlagsRef = useRef({
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
  });
  layoutFlagsRef.current = {
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
  };
  // The freshest layout, live during a drag, for anything that must read real
  // geometry mid-drag instead of the render-time `layout`, which is frozen
  // for the duration.
  const liveLayoutRef = useRef<PaneLayout>(layout);
  const [liveFlags, setLiveFlags] = useState({
    curtain: layout.curtainActive,
    curtainL: layout.sidebarOverlayPx > 0,
    curtainR: layout.paneOverlayPx > 0,
  });

  const applyLiveLayout = useCallback(
    (over?: Partial<{
      sidebarWidth: number;
      paneWidth: number;
      winWidth: number;
    }>) => {
      const sizes = liveSizeRef.current;
      if (over) Object.assign(sizes, over);
      const f = layoutFlagsRef.current;
      const l = computePaneLayout({
        winWidth: sizes.winWidth,
        sidebarWidth: sizes.sidebarWidth,
        sidebarCollapsed: f.sidebarCollapsed,
        paneWidth: sizes.paneWidth,
        paneCollapsed: f.paneCollapsed,
        paneFullscreen: f.paneFullscreen,
        // A collapsed rail keeps its edge strip of tab icons in flow.
        paneEdgeW: RAIL_EDGE_W,
        // A collapsed sidebar keeps its icon pose (D18).
        sidebarEdgeW: SIDEBAR_EDGE_W,
        // Hard stops (D38): a short stage takes room back from the columns,
        // never below their minimums.
        sidebarMin: SIDEBAR_MIN_W,
        paneMin: RAIL_MIN_W,
        stageMin: stageMinRef.current,
        // Narrow, a column opened by hand curtains over a readable document;
        // the default narrow pose never does (D18).
        ...narrowLayoutInputs(poseRef.current, narrowOpenRef.current),
      });
      liveLayoutRef.current = l;

      // Drawer-reveal geometry: the clip (outer) tracks the live width while
      // the content (inner aside) stays pinned at min so it is revealed rather
      // than reflowed.
      setGeom(sidebarClipRef.current, "width", `${l.sidebarFlowW}px`);
      // The aside never draws below its hard stop (D38): a reveal narrower
      // than that clips it rather than reflowing it.
      setGeom(
        sidebarAsideRef.current,
        "width",
        `${Math.max(l.sidebarW, SIDEBAR_MIN_W)}px`,
      );
      setGeom(
        sidebarCurtainDivRef.current,
        "right",
        `${-(l.sidebarOverlayPx + DIVIDER_W)}px`,
      );
      // Fullscreen makes the clip `display: contents` — no box to size, and a
      // stale width left on it would be resurrected on the way out.
      setGeom(
        paneClipRef.current,
        "width",
        f.paneFullscreen ? "" : `${l.paneFlowW}px`,
      );
      setGeom(
        paneAsideRef.current,
        "width",
        f.paneFullscreen ? "" : `${clampRailWidth(l.paneW)}px`,
      );
      setGeom(
        paneCurtainDivRef.current,
        "left",
        `${-(l.paneOverlayPx + DIVIDER_W)}px`,
      );
      // Discrete curtain styling (overflow / stacking / the drop shadow that
      // reads as "painted over the doc") is a CSS rule keyed on this attribute,
      // so crossing the threshold re-styles without a render. Set on the clips
      // themselves, not the root, so the selector match stays local — and only
      // on a real flip, since an attribute write invalidates either way.
      setCurtain(sidebarClipRef.current, l.sidebarOverlayPx > 0);
      setCurtain(paneClipRef.current, !f.paneFullscreen && l.paneOverlayPx > 0);
      // The two things a variable cannot express: an extra divider node at
      // the curtain's visible edge, and hiding the native browser webview.
      // Committed only when one actually flips.
      const next = {
        curtain: l.curtainActive,
        curtainL: l.sidebarOverlayPx > 0,
        curtainR: l.paneOverlayPx > 0,
      };
      setLiveFlags((prev) =>
        prev.curtain === next.curtain &&
        prev.curtainL === next.curtainL &&
        prev.curtainR === next.curtainR
          ? prev
          : next,
      );
    },
    [],
  );

  // State → geometry, after every render. Cheap (a handful of style writes on
  // known elements, no reads, no forced layout) and it makes React state the
  // single source of truth the moment a drag ends.
  //
  // Mid-drag it re-applies the LIVE sizes instead of adopting state: an
  // unrelated render (a plan arriving, a poll landing) must not snap the pane
  // back to where it was when the drag started.
  useLayoutEffect(() => {
    if (!isResizing()) {
      liveSizeRef.current = { sidebarWidth, paneWidth, winWidth };
    }
    applyLiveLayout();
  });

  // Native window resizing rides the same path. There is no `pointerup` to end
  // it, so `installWindowResizeSession` opens a session on the first event and
  // closes it on a settle timer; `winWidth` state is committed once, then.
  useEffect(() => {
    const uninstall = installWindowResizeSession();
    const onResize = rafCoalesce(() =>
      applyLiveLayout({ winWidth: window.innerWidth }),
    );
    const off = onResizeSession((active) => {
      if (!active) setWinWidth(window.innerWidth);
    });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      onResize.cancel();
      off();
      uninstall();
    };
  }, [applyLiveLayout]);

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

  // Stand the floating zoom pill UP the moment the document text would reach
  // it. The article is centered with a max width, so on a wide pane there's an
  // empty right gutter to host the control as a row; as the pane narrows the
  // text column grows toward the right edge — once its text (minus the
  // article's right padding) reaches the control's left edge, the row gives way
  // to the narrow column, which fits in a gutter a fraction of the size. What
  // never happens is the control leaving. Recomputed on any pane resize via a
  // ResizeObserver on the scroll container. Re-runs on the surface switches /
  // doc-pin toggles too: those unmount and remount the document, giving a fresh
  // ref/observer — otherwise the pose would stay stale after another surface is
  // switched back off.
  useEffect(() => {
    const article = documentRef.current;
    const container = article?.parentElement ?? null;
    if (!article || !container) {
      // No article to clear — the Drafter, which occupies the plate with its
      // own editor. Nothing to overlap, so take the roomy pose. (This used to
      // hide the control outright, which is why the Drafter had no zoom.)
      zoomStackedRef.current = false;
      setZoomStacked(false);
      return;
    }
    const recompute = () => {
      const a = article.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      // The live element is the best width source — but only while it is posed
      // as a row. Stacked (or in wide view, where it always stacks) it measures
      // the OTHER pose, and feeding that ~30px back into "does the row fit?"
      // answers yes, flips it to a row, which instantly doesn't fit, which
      // flips it back — forever. So the row width is remembered, and only a row
      // updates it; the constant covers the frames before the first one.
      const measured = zoomCtrlRef.current?.offsetWidth;
      if (measured && !docWide && !zoomStackedRef.current)
        zoomCtrlW.current = measured;
      const stacked =
        docControlPose({
          articleRight: a.right,
          containerRight: c.right,
          padRight: docPadR,
          rowWidth: zoomCtrlW.current,
        }) === "column";
      zoomStackedRef.current = stacked;
      setZoomStacked(stacked);
    };
    recompute();
    // Three forced-layout reads and a possible render — worth nothing while a
    // divider is mid-flight, since the answer is about where things come to
    // rest. Skipped for the duration and recomputed once the drag ends;
    // rAF-coalesced otherwise so a burst of observer fires costs one pass.
    const onGeometry = rafCoalesce(() => {
      if (isResizing()) return;
      recompute();
    });
    const ro = new ResizeObserver(onGeometry);
    ro.observe(container);
    // The ARTICLE too, not just its container. Its own measure changes
    // without the pane moving — wide view, and the front door dropping the
    // 820px column entirely — and those are exactly the moments the answer
    // flips. Observing it here beats threading each cause through the deps
    // (the front-door one is derived from `sessionReady`, which is declared
    // far below this effect). Safe from feedback: the control is absolutely
    // positioned and out of flow, so mounting it never resizes the article.
    ro.observe(article);
    const off = onResizeSession((active) => {
      if (!active) recompute();
    });
    return () => {
      ro.disconnect();
      onGeometry.cancel();
      off();
    };
    // `docPadR` is in the deps because toggling the view changes BOTH sides of
    // the comparison in the same commit — the article's padding and the
    // control's own width — and the ResizeObserver only sees the container,
    // which didn't move.
  }, [
    sidebarTab,
    activeFile,
    activeId,
    stageSurface,
    view.hasDocument,
    docPadR,
    docWide,
    docMeasure,
  ]);

  // Bidirectional focus between in-doc highlights and sidebar cards. Single
  // source of truth: card click sets it; highlight click sets it; effects
  // mirror the change in each direction.
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  // Bumped on every deliberate "take me to this comment" gesture so the
  // editor's focus effect re-fires even when the id is unchanged (re-click,
  // already-centered target) — the flash is the visible acknowledgement.
  const [focusNonce, setFocusNonce] = useState(0);
  const focusComment = useCallback((id: string) => {
    setFocusedCommentId(id);
    setFocusNonce((n) => n + 1);
  }, []);
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
  // A comment the composer just SENT (saved + discuss): its thread sends the
  // comment as its first message once, then clears this.
  const [autoDiscussCommentId, setAutoDiscussCommentId] = useState<string | null>(null);
  const clearAutoDiscuss = useCallback(() => setAutoDiscussCommentId(null), []);

  // Appearance prefs live in the DB (`app_settings`) so a fork or second
  // machine carries them; localStorage is only the pre-paint cache. This mount
  // effect reconciles DB vs local: a valid DB value wins (and marks the pick
  // explicit), otherwise a real local pick migrates into the DB. The one-time
  // migration is idempotent — once the DB row exists it simply wins.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let prefs: {
        theme?: string | null;
        font?: string | null;
        lint?: string | null;
        workspaceNudge?: string | null;
      };
      try {
        prefs = await invoke("get_ui_prefs");
      } catch {
        return;
      }
      if (cancelled) return;
      setNudgeState(parseNudgeState(prefs.workspaceNudge));
      const setPref = (key: string, value: string) => {
        void invoke("set_ui_pref", { key, value }).catch(() => {});
      };
      // THEME — the DB name wins when it resolves; otherwise the local pick
      // migrates into the DB (rules in prefsSync.ts). readStoredTheme() only
      // returns built-ins, which the pre-paint bootstrap already applied.
      const themeDecision = reconcileTheme({
        db: prefs.theme,
        local: readStoredTheme(),
        resolves: isThemeName,
        appliedAtBoot: true,
        fallback: DEFAULT_THEME,
      });
      // The guard re-narrows prefsSync's plain strings to the closed unions —
      // every branch inside reconcileTheme already resolved through it.
      if (themeDecision.apply && isThemeName(themeDecision.apply)) {
        setTheme(themeDecision.apply);
        applyTheme(themeDecision.apply);
        storeTheme(themeDecision.apply);
      }
      if (themeDecision.writeDb) setPref("theme", themeDecision.writeDb);
      // FONT — gated on hasStoredFont(): only an explicit pick migrates, so
      // the suggested-companion-font rule keeps meaning "untouched".
      const fontDecision = reconcilePick({
        db: prefs.font,
        local: readStoredFont(),
        hasExplicitLocal: hasStoredFont(),
        isValid: isFontName,
      });
      if (fontDecision.apply && isFontName(fontDecision.apply)) {
        setFont(fontDecision.apply);
        applyFont(fontDecision.apply);
        storeFont(fontDecision.apply);
      }
      if (fontDecision.writeDb) setPref("font", fontDecision.writeDb);
      // LINT — identical rule to font.
      const lintDecision = reconcilePick({
        db: prefs.lint,
        local: readStoredLint(),
        hasExplicitLocal: hasStoredLint(),
        isValid: isLintName,
      });
      if (lintDecision.apply) {
        const next = lintDecision.apply as LintName;
        setLint(next);
        applyLint(next);
        storeLint(next);
      }
      if (lintDecision.writeDb) setPref("lint", lintDecision.writeDb);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onThemeChange = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
    void invoke("set_ui_pref", { key: "theme", value: name }).catch(() => {});
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
    void invoke("set_ui_pref", { key: "font", value: name }).catch(() => {});
  };

  const onLintChange = (name: LintName) => {
    setLint(name);
    applyLint(name);
    storeLint(name);
    void invoke("set_ui_pref", { key: "lint", value: name }).catch(() => {});
  };

  // Hard stops (D38): a drag stops where the stage would fall below its
  // floor beside the other column as drawn, and never below its own
  // minimum (past which it snaps shut). The rail also keeps its 600 px
  // ceiling.
  const seams = 2 * DIVIDER_W + docMinFor(winWidth, stageMin || undefined);
  const sidebarMaxW = Math.max(
    SIDEBAR_MIN_W,
    winWidth - (paneCollapsed ? RAIL_EDGE_W : layout.paneW) - seams,
  );
  const paneMaxW = Math.min(
    RAIL_MAX_W,
    Math.max(RAIL_MIN_W, winWidth - (sidebarCollapsed ? SIDEBAR_EDGE_W : layout.sidebarW) - seams),
  );

  const {
    isDragging: sidebarDragging,
    startDrag: startSidebarDrag,
    settling: sidebarSettling,
  } = useResizablePane({
    width: layout.sidebarW || sidebarWidth,
    onWidthChange: setSidebarWidth,
    onLiveSize: (w) => applyLiveLayout({ sidebarWidth: w }),
    side: "leading",
    min: SIDEBAR_MIN_W,
    max: sidebarMaxW,
    // Drag the document over the sidebar past its hard stop → snap it shut.
    onCollapse: () => setSidebarFolded(true),
    // Drag the divider of a collapsed sidebar to re-open it as a drawer.
    collapsed: sidebarCollapsed,
    onExpand: revealSidebar,
  });

  const {
    isDragging,
    startDrag,
    settling: paneSettling,
  } = useResizablePane({
    width: layout.paneW || paneWidth,
    onWidthChange: setPaneWidth,
    onLiveSize: (w) => applyLiveLayout({ paneWidth: w }),
    min: RAIL_MIN_W,
    max: paneMaxW,
    // Same for the rail on the right edge.
    onCollapse: () => setRailFolded(true),
    collapsed: paneCollapsed,
    onExpand: revealPane,
  });


  // The Discussion sidecar's context. Plan comments need the doc pane on a
  // sessions tab; the review context needs the Code Review pane open. In a
  // true split the header toggle (discussionPinned) decides.
  const planDiscussionAvailable =
    docVisible;
  const discussionContext = effectiveDiscussionContext(
    reviewOpen,
    planDiscussionAvailable,
    discussionPinned,
  );

  const [selection, clearSelection] = useTextSelection(
    documentRef,
    composing === null,
  );
  useEffect(() => {
    if (selection) void loadCommentComposer().catch(() => {});
  }, [selection]);
  // Imperative bridge to the lazily-mounted PlanEditor so the SelectionMenu's
  // Strike action can run an editor command without owning the editor.
  const planActionsRef = useRef<PlanEditorActions | null>(null);

  async function refreshSummaries(): Promise<SessionSummary[]> {
    // The sets that existed when this read began: a set made or selected
    // while the read was in flight is not "absent", it is newer than the
    // list — only a session this read positively no longer lists, among
    // those it could have listed, is gone.
    const setsBefore = new Set(Object.keys(wb.getState().sets));
    try {
      const list = await invoke<SessionSummary[]>("list_sessions");
      // Every read is a fresh list. Keep the previous one, or each row that
      // didn't change, so the sidebar's memoized rows and everything derived
      // from `summaries` skip the render. Rows pair by id: a bumped session
      // re-sorts to the top.
      setSummaries((prev) => keepEqualRows(prev, list, (s) => s.sessionId));
      // Sets whose session is gone go with it (a joined room's mirrored set
      // stays while joined); terminals are not the workbench's yet (W3).
      // Never the active set, and never a set newer than this read.
      {
        const state = wb.getState();
        const live = list.map((s) => s.sessionId);
        const joined = activeIdRef.current && isJoinedSessionId(activeIdRef.current) ? activeIdRef.current.split(":")[1] : null;
        if (joined) live.push(joined);
        for (const key of Object.keys(state.sets) as SessionKey[]) {
          const sid = sessionIdOf(key);
          if (sid && (key === state.activeKey || !setsBefore.has(key))) live.push(sid);
        }
        // Every session that exists, for the Plan tabs opened in other sets
        // (D29): one for a session that went closes with it.
        const known = [...live, ...list.map((s) => s.sessionId)];
        wb.dispatch({ type: "prune", liveSessions: live, livePtys: liveTermIdsRef.current ?? Object.keys(state.owners), knownSessions: known });
      }
      return list;
    } catch (err) {
      console.error("list_sessions failed", err);
      return [];
    }
  }
  const setPlanState = async (id: string, state: ManualPlanState) => {
    try {
      await invoke("set_plan_state", { sessionId: id, state });
      await refreshSummaries();
      if (id === activeId) await loadSession(id);
    } catch (error) { setToast(String(error), 6000); }
  };
  const openMovePlan = async (id: string) => {
    try { setMovePlan(await invoke<ReviewSession>("get_session", { id })); }
    catch (error) { setToast(String(error), 6000); }
  };
  const moveSessionProject = async (id: string, path: string) => {
    await invoke("set_session_project", { sessionId: id, projectPath: path });
    await refreshSummaries();
    if (id === activeId) await loadSession(id);
    setToast(`Moved to ${path.split("/").filter(Boolean).pop() ?? path}`);
  };


  async function renameSession(id: string, title: string) {
    try { await invoke("rename_session", { sessionId: id, title }); await refreshSummaries(); }
    catch (error) { setToast(String(error), 6000); }
  }
  async function archiveSession(id: string, archived: boolean) {
    try {
      await invoke("archive_session", { sessionId: id, archived });
      await refreshSummaries();
      // Archived, it leaves the strip it was a tab of (D29); its own set
      // goes the way it always went.
      if (archived) wb.dispatch({ type: "dropSessionPanes", sessionIds: [id] });
      if (archived && id === activeId && wb.getState().activeKey === planKey(id)) { setActiveId(null); setSession(null); }
    } catch (error) { setToast(String(error), 6000); }
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
    // Its tabs in other sets close (D29). Standing in its own set, the
    // stage goes Home and the next session opens there, as a tab.
    wb.dispatch({ type: "dropSessionPanes", sessionIds: [id] });
    if (id === activeId && wb.getState().activeKey === planKey(id)) {
      const next = list[0]?.sessionId ?? null;
      setActiveId(null);
      if (next) setActiveId(next);
      else setSession(null);
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
      // A re-read that changed nothing keeps the session object, and one that
      // changed a comment keeps every revision, section list and comment it
      // didn't touch — so the editor, the cards and the memos keyed on them
      // stay put.
      setSession((prev) => keepEqual(prev, full));
    } catch (err) {
      console.error("get_session failed", err);
    }
  }

  // ── Core bootstrap ────────────────────────────────────────────────────────
  //
  // ONE call, and it answers exactly one question: what should the first
  // actionable frame show? Session summaries, the held session (if any), the
  // interception mode, the daemon's bind state, the workspace manifest and the
  // installed harnesses — everything that decides *which surface renders and
  // what is on it*.
  //
  // What is deliberately NOT here: whether the hook is installed, whether the
  // skill is stale, whether `claude`/`codex`/curl are present and new enough.
  // Those decide whether a *launch* will work, which is a question with a much
  // later deadline — and answering them spawns child processes, one of which
  // (`codex --help`, behind an interactive login shell on an exotic install)
  // could be the single slowest thing on the machine. They ran inside this
  // effect's `Promise.all`, so the front door was gated on the slowest probe.
  // They now run after the reveal, in `integrationHealth`.
  useEffect(() => {
    (async () => {
      const boot = await invoke<BootstrapState>("bootstrap_state").catch(
        (err) => {
          // The shell still has to come up. Cached preferences already
          // composed the first frame; empty defaults here mean the front door
          // with no projects rather than a window that never resolves.
          console.error("bootstrap_state failed", err);
          return null;
        },
      );
      const list = boot?.sessions ?? [];
      setSummaries(list);
      if (boot) {
        setMode(boot.mode as InterceptionMode);
        setDaemonState(boot.daemon);
      }
      const ws = parseWorkspace(boot?.workspace ?? null);
      setWorkspace(ws);
      // Refresh the paint cache from the authoritative read — the file is
      // the store, the cache is next launch's first frame.
      storeWorkspaceCache(localStorage, boot?.workspace ?? null);
      // Harness resolution. The boot pass and every later refresh (window
      // focus, an install landing) share applyHarnessResolution: a
      // user-entered harness from last session is RE-RESOLVED from its
      // source, so an edited manifest shows fresh and a deleted one exits
      // cleanly to stock Redline.
      harnessFlavorRef.current = boot?.harnessFlavor ?? null;
      const resolved = applyHarnessResolution(boot?.harnesses ?? []);
      const harnessDeltaNow = resolved
        ? readHarnessArrangement(localStorage, resolved.manifest.id)
        : {};
      // Boot lands on the FRONT DOOR, not on the last plan you happened to
      // read. Opening Redline is nearly always "I want to build something",
      // and the plans are one click away in the sidebar either way.
      //
      // One carve-out: a session still HELD is Claude literally paused mid-
      // run waiting on your verdict. Burying that behind a prompt box would
      // leave an agent blocked with nothing on screen saying so, so a held
      // plan still claims the plate. The backend picks it from the same list
      // it returned, so the routing target is always in the list it routes
      // within.
      // A reload keeps the set it was on (`wbReload`): no held plan and no
      // landing moves it; its own session loads.
      const held = wbReload ? sessionIdOf(wb.getState().activeKey) : boot?.heldSessionId ?? null;
      if (!wbReload) setActiveId(held);
      await loadSession(held);
      if (held) markOnce("rl:session-ready");
      // Landing: "last" (default) keeps the persisted surface — today's
      // behavior. A fixed or per-project landing overrides it; a landing on
      // a disabled surface falls back to the document. Inside a harness the
      // HARNESS's arrangement decides (its landing, its surface set) — the
      // stock manifest's say resumes at exit.
      const target = resolved
        ? initialSurface(
            harnessWorkspace(resolved.manifest, harnessDeltaNow),
            stageSurfaceRef.current,
          )
        : initialSurface(
            ws,
            stageSurfaceRef.current,
            list[0]?.projectPath ?? null,
          );
      // Warm what boot is about to show while the doors are still parting:
      // the landing surface's chunk, and the sessions sidebar (the aside's
      // resting tab). Dynamic imports — the size budget never sees them.
      prefetchSurfaceChunk(target);
      void loadSessionSidebar().catch(() => {});
      if (target !== stageSurfaceRef.current && !wbReload) {
        selectSurfaceRef.current(target);
      }
      // Boot has settled — the next surface switch (if soon) is this
      // launch's habit sample for the landing nudge.
      launchWatchRef.current = {
        from: target,
        startedAt: Date.now(),
        done: false,
      };
      bootstrapDoneRef.current = true;
      markOnce("rl:core-bootstrap");
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
    const tutorialUnlisten = listen("menu-open-tutorial", () => setTourOpen(true));
    return () => {
      void readmeUnlisten.then(dropListener);
      void feedbackUnlisten.then(dropListener);
      void tutorialUnlisten.then(dropListener);
    };
  }, []);

  // Event subscriptions
  useEffect(() => {
    const planUnlisten = listen<PlanReceivedEvent>("plan-received", (e) => {
      const payload = e.payload;
      // A plan has now demonstrably reached Redline on this machine, so the
      // front door's `/hooks` nudge is retired for good — and this launch, if
      // it was one, is over.
      setPlanEverArrived(true);
      setPendingLaunch(previous => !payload.launchId || previous?.launchId === payload.launchId ? null : previous);
      const arrivingLaunch = payload.launchId ? launchedPlansRef.current.get(payload.launchId) ?? null : null;
      if (payload.launchId) launchedPlansRef.current.delete(payload.launchId);
      const graduated = isGraduation(arrivingLaunch, payload);
      // A restore landed. Completed off the EVENT, not off a session-id match:
      // `restored` is set only for a re-presentation the daemon rebound to a
      // plan it was holding, and there is at most one restore in flight
      // app-wide — so the attempt closes even when claude came back under a
      // rekeyed live session id and the sentinel is what tied the two together.
      setRestoreAttempt((a) =>
        reduceRestore(a, { type: "plan-received", restored: payload.restored }),
      );
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
              `${pending} pending comment${pending === 1 ? "" : "s"} carried over — Send to ${
                resolveRestoreHarness({
                  backend: list.find((s) => s.sessionId === payload.sessionId)
                    ?.backend,
                }).label
              } when ready`,
            );
          }
        }
        // Where a new plan lands is one rule (`arrivalFocus`): it takes focus
        // unless you are in the middle of something else — writing, or
        // reading another plan, a file or an older version of this one.
        // (A new version of the plan already selected lands in place.)
        // Taking focus never opens the discussion pane or dock, nor the door
        // or its card, and never closes them: they stay as the user left them.
        const focusIntercepted = () => {
          selectSessions();
          setActiveId(payload.sessionId);
          // Land on the clean latest. Someone parked on an older version
          // gets here only through Open: the arrival itself flashes for them.
          setViewedVersionNumber(null);
          void loadSession(payload.sessionId);
        };
        // Open or Review, pressed on the notice: a gesture, so the door and
        // its card step aside for the plan, as for any trip the user asks for.
        const openArrival = () => {
          tripDoor();
          // The session first: the plan's set is what "document" acts on.
          focusIntercepted();
          selectSurfaceRef.current("document");
        };
        // At the top on the browser, where the native page covers the corner.
        const notice = (message: string, label: string) => setToast({
          message,
          tone: "info",
          action: { label, onAction: openArrival },
          ...(stageSurfaceRef.current === "browser" ? { placement: "top" as const } : {}),
        });
        // A door that sent this very launch is never "writing", caret in its
        // box or not: its ⏎ asked for this plan, so it arrives on screen —
        // from a door tab it springs out of the box and the door retires.
        // Only while the user is STILL on that door tab: someone who ⌘T'd
        // another door and is typing in it is busy — the launch door retires
        // quietly, the plan's set gets its Plan tab without being selected
        // (D1's "elsewhere"), and the row's pulse carries the news.
        const launchDoor = !!payload.launchId && doorLaunchTabRef.current?.launchId === payload.launchId ? doorLaunchTabRef.current : null;
        const wbNow = wb.getState();
        // The launch's own set (its Agent tab, and the door it came through):
        // it becomes the plan's set, the door its Plan tab (D1: selected
        // when the user is on it, inserted quietly when not).
        const launchSetKey = payload.launchId ? launchKey(payload.launchId) : null;
        const launchSet = launchSetKey && wbNow.sets[launchSetKey] ? launchSetKey : null;
        const ownLaunch = !!launchSet && wbNow.activeKey === launchSet;
        const ownDoorTab = !!launchDoor && launchDoor.key === wbNow.activeKey && wbNow.sets[launchDoor.key]?.activeTabId === launchDoor.tabId;
        if (launchSet) {
          doorLaunchTabRef.current = null;
          wb.dispatch({ type: "rekeySession", from: launchSet, to: planKey(payload.sessionId) });
        } else if (launchDoor && !ownDoorTab) {
          retireDoorLaunchTab(payload.launchId);
          wb.dispatch({ type: "ensureDefaults", key: planKey(payload.sessionId) });
        }
        const writing = !ownDoorTab && !ownLaunch && (frontDoorOpenRef.current || writingNow(document.activeElement, typedAtRef.current, Date.now()));
        const title = list.find((item) => item.sessionId === payload.sessionId)?.planTitle ?? null;
        if (graduated && arrivingLaunch?.chatId) {
          const chatId = arrivingLaunch.chatId;
          const title = list.find(item => item.sessionId === payload.sessionId)?.planTitle ?? "Plan";
          setChatReceipts(previous => ({ ...previous, [chatId]: { ...previous[chatId], instruction: previous[chatId]?.instruction ?? "", status: "done", launchId: payload.launchId ?? undefined, sessionId: payload.sessionId, title } }));
          // The chat turns into its plan in place only while you sit idle
          // in it: the agent picks the moment, minutes later.
          const receipt = `[data-chat-plan-receipt="${CSS.escape(chatId)}"]`;
          if (!writing && dockScopeRef.current === "home" && currentChatIdRef.current === chatId && document.querySelector(receipt)) {
            const from = boxOf(receipt);
            if (from) setPlanSwap({ launchId: payload.launchId!, from });
            selectSurfaceRef.current("document");
            focusIntercepted();
          } else {
            notice("Your chat became a plan", "Open");
          }
          return;
        }
        // A new version of the plan already selected is news of its own.
        const revision = payload.sessionId === activeId;
        const focus = arrivalFocus({
          activeId,
          sessionId: payload.sessionId,
          surface: stageSurfaceRef.current,
          plateMode: plateModeRef.current,
          viewedVersion: viewedVersionRef.current,
          writing,
          ownDoorLaunch: ownDoorLaunch({
            open: frontDoorOpenRef.current,
            showing: doorLaunchRef.current,
            draft: getFrontDoorText(),
            attachments: frontDoorAttachmentsRef.current.length,
            typedAt: typedAtRef.current,
            choosing: hasChildOverlay(),
          }, payload.launchId, Date.now()),
        });
        if (focus === "handoff") {
          // The plan you launched with ⏎ from the door you are still in: that
          // was the gesture, and this is what it asked for. The door hands
          // off into it — the plan springs out of the composer its sentence
          // left while the door fades where it is — and the caret goes to the
          // plan. Said politely, as any arrival on screen is.
          const from = boxOf(".rl-frontdoor-focus[data-open='true'] .rl-fd-island");
          if (from) setPlanSwap({ launchId: payload.launchId!, from });
          setDoorHandoff(true);
          setFrontDoorOpen(false);
          retireDoorLaunchTab(payload.launchId);
          focusIntercepted();
          selectSurfaceRef.current("document");
          announceDoor(arrivalMessage(title));
          return;
        }
        if (focus === "focus" && !paneMaskedRef.current) {
          // On the document surface: on screen now. From the Front Door the
          // plate turns into the plan, which is the point of launching one.
          // No toast says so, so the island does, to a screen reader.
          // From a resting door tab the plan springs out of its box, and
          // the door tab it came through retires.
          if (payload.launchId && doorLaunchTabRef.current?.launchId === payload.launchId) {
            const from = boxOf(".rl-frontdoor-focus .rl-fd-island");
            if (from) setPlanSwap({ launchId: payload.launchId, from });
            retireDoorLaunchTab(payload.launchId);
          } else if (ownDoorTab) {
            const from = boxOf(".rl-frontdoor-focus .rl-fd-island");
            if (from) setPlanSwap({ launchId: payload.launchId!, from });
          }
          // The plan itself, as a tab of the set on screen (D29): its Plan
          // tab comes forward, beside the launch's Agent tab when that is
          // here (rekeySession put it there).
          focusIntercepted();
          announceDoor(arrivalMessage(title, revision));
          return;
        }
        if (focus === "focus") {
          // A masked surface (browser, memory): the plan becomes what you
          // come back to — a Plan tab in this set, behind the surface you
          // chose, which is not yanked away (D29); the notice's Review
          // brings it forward.
          wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: payload.sessionId, version: null } }, activate: false });
          setViewedVersionNumber(null);
          void loadSession(payload.sessionId);
          notice(arrivalMessage(title, revision), "Review");
          return;
        }
        // flash — you are in the middle of something else. Nothing moves:
        // the row pulses until it is opened (and glows once), and the notice
        // offers the switch we declined. The pill wears nothing for it: the
        // row and the notice already say it, and the plan is first under
        // Plans the next time the door opens. A new version of the plan
        // already selected is not a new row: its data refreshes under the
        // version you are on, and the row only glows.
        if (revision) void loadSession(payload.sessionId);
        else setUnseenPlanIds((prev) => {
          if (prev.has(payload.sessionId)) return prev;
          const next = new Set(prev);
          next.add(payload.sessionId);
          return next;
        });
        setArrivalGlow({ sessionId: payload.sessionId, nonce: Date.now() });
        notice(arrivalMessage(title, revision), "Open");
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
      setDaemonState("failed");
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
    // Run-lifecycle beacons repaint the sessions-pane chip.
    const runStateUnlisten = listen<{ sessionId: string }>(
      "run-state-changed",
      () => {
        void refreshSummaries();
      },
    );
    // 0d: a plan was answered `allow` without being captured. A skipped
    // capture otherwise renders identically to "no plan was ever submitted" —
    // which is how the sentinel-prose bug survived undetected — so say so.
    const passedThroughUnlisten = listen<{ sessionId: string; reason: string }>(
      "plan-passed-through",
      (e) => {
        setToast({
          message:
            `A plan from session ${e.payload.sessionId.slice(0, 8)}… was passed ` +
            `through WITHOUT capture: ${e.payload.reason}`,
          tone: "info",
        }, 15000);
      },
    );
    const modeUnlisten = listen<ModeEvent>("mode-changed", (e) => {
      setMode(e.payload.mode);
    });
    const decisionUnlisten = listen<PlanDecisionWindowEvent>(
      "plan-decision-window",
      (e) => {
        // Ambient mode auto-approves after a 20s countdown the user didn't
        // start. If they launched from the front door seconds ago they are
        // demonstrably sitting there watching — the strongest possible signal
        // that they intend to review — so claim the window instead of racing
        // it, and skip the banner entirely. `claim_review` converts the held
        // POST to a full review by design, and claiming is strictly the safe
        // direction: the worst case is a plan getting reviewed rather than
        // auto-approved.
        if (pendingLaunchRef.current) {
          void invoke<boolean>("claim_review", {
            sessionId: e.payload.sessionId,
          }).catch((err) => console.error("claim_review failed", err));
          return;
        }
        setDecisionWindow(e.payload);
        // A short window is useless unseen, so from another app the Dock
        // bounces and a notification says so. Never by un-minimizing or
        // bringing Redline to the front: going there is the user's move.
        const seconds = Math.max(0, Math.ceil((e.payload.deadlineMs - Date.now()) / 1000));
        void import("./lib/osNotice")
          .then(({ noticeWhenAway }) => noticeWhenAway(`Plan v${e.payload.version} ready`, `Auto-approving in ${seconds}s unless you open it in Redline.`))
          .catch(() => {});
      },
    );
    return () => {
      void planUnlisten.then(dropListener);
      void detachedUnlisten.then(dropListener);
      void bindFailedUnlisten.then(dropListener);
      void commentsUnlisten.then(dropListener);
      void statusUnlisten.then(dropListener);
      void runStateUnlisten.then(dropListener);
      void passedThroughUnlisten.then(dropListener);
      void modeUnlisten.then(dropListener);
      void decisionUnlisten.then(dropListener);
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
      if (unlisten) dropListener(unlisten);
    };
  }, []);

  // When user clicks a session in the sidebar, reload it. Clear any stale
  // session object up front so the next paint doesn't flash the previous
  // session's plan/comments while get_session is in flight — otherwise the
  // memoised threadRevisions/allComments still point at the old session.
  // The last few sessions shown, by id (D29): Plan tabs of several sessions
  // share one set now, and a tab switch between them — or out to a door and
  // back — shows the one it had at once while the read refreshes it,
  // instead of a blank plate for the round trip.
  const sessionCacheRef = useRef(new Map<string, ReviewSession>());
  useEffect(() => {
    if (!session) return;
    const cache = sessionCacheRef.current;
    cache.delete(session.sessionId);
    cache.set(session.sessionId, session);
    while (cache.size > 6) cache.delete(cache.keys().next().value!);
  }, [session]);
  useEffect(() => {
    if (activeId) {
      setSession((prev) => (prev?.sessionId === activeId ? prev : sessionCacheRef.current.get(activeId) ?? null));
      void loadSession(activeId);
      setWarning(null);
      setAskModeViolation(false);
      setDetachDismissed(false);
      // Landing on the session is what "seen" means — drop its pulse.
      setUnseenPlanIds((prev) => {
        if (!prev.has(activeId)) return prev;
        const next = new Set(prev);
        next.delete(activeId);
        return next;
      });
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
  // The end of `wb:session-switch`: the loaded session matches the clicked
  // id and this commit has painted it. A no-op unless a sidebar click began
  // the measure (the Performance targets in docs/perf-budget.md).
  useEffect(() => {
    if (sessionReady) endMeasure("wb:session-switch");
  }, [sessionReady, activeId]);

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
  // Memoized because `?? []` allocated a fresh empty array on every render,
  // which invalidated `blockIdByAnchor` below and PlanEditor's `anchors` memo —
  // turning every unrelated state change in this component into anchor work.
  const sections = useMemo(() => latest?.sections ?? [], [latest]);
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
  const threadCommentsRef = useRef<Comment[]>([]);
  threadCommentsRef.current = threadComments;
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
      // Awareness changes on every remote cursor move; the set of who is
      // here almost never does.
      setPresentHashes((prev) => keepEqual(prev, next));
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
    serversOpen,
    memoryOpen,
    chatOpen,
    chatId,
    chatTitle,
    activeId,
    planTitle: activeSummary?.planTitle ?? null,
    planProject: activeSummary?.projectPath ?? null,
    activeTab: null,
    reviewId: codeReview.activeReviewId,
    reviewRepo: codeReview.repo,
    drafterDraftId,
    drafterProject: drafterProjectPath,
    activeFile,
    plateMode,
    hasTerminal: termTabCount > 0,
  });
  const activeSurfaceKey = `${activeSurface.kind}\u0000${activeSurface.id ?? ""}\u0000${
    activeSurface.label ?? ""
  }\u0000${activeSurface.detail ?? ""}`;
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
  // Built afresh every render, so kept by value for the memoized sidebar.
  const joinedInfo = useStableValue(useJoinedSession(joinedRoom, joinedPresence));
  const joinedActive = !!joinedInfo && activeId === joinedInfo.key;

  // Is there an actual DOCUMENT on the plate right now? The zoom / wide-view
  // rail and the article's reading measure both exist to serve one, and on
  // the front door there is none — nothing to zoom, no column to widen. The
  // rail rendered there was a control wired to nothing that still moved the
  // hero when you touched it.
  const docSurfaceActive = sessionReady || joinedActive;

  // Width of the table-of-contents rail. Snap constants live in lib/tocRail so
  // the rail and the left space it reserves in the document scroller stay in
  // lockstep. The RESTING width is state; during a drag the width is written
  // straight onto the rail and the doc scroller — this handle relayouts the
  // entire plan text column every frame, so it is the one that matters most
  // after the terminal.
  const tocRailW = tocWide ? TOC_RAIL_W_WIDE : TOC_RAIL_W;
  // The TOC rail applies only over a plainly-displayed plan document (a real
  // session, latest or historical, with headings) — never the folder viewer, a
  // joined shadow session, or while a secondary pane (browser/drafter/review)
  // shares the column. When eligible + open it becomes an in-flow panel: the
  // document scroller reserves `TOC_RAIL_W` on its left so the rail docks
  // beside the plan instead of floating over it.
  const tocEligible =
    !joinedActive &&
    sessionReady &&
    stageSurface === "document" &&
    displaySections.length > 0;
  const tocDocked = tocEligible && tocOpen;

  // The collapsed rail's "☰ Contents" button yields to the text the same way
  // the zoom control does — but by shedding its label rather than vanishing,
  // since it is the only way back to the rail. 64 is the article's pl-16, i.e.
  // where its text starts rather than where its box does. `tocDocked` and
  // `tocEligible` are in the deps because the button only exists while the rail
  // is closed: without them the observer would never attach to a button that
  // appeared after mount.
  useTextClearance({
    ctrlRef: tocBtnRef,
    textRef: documentRef,
    textInset: 64,
    flag: "rlBurger",
    // Pin the label's real width for the collapse to animate against. Scoped to
    // the button, not the shell root: a custom property is inherited, and one
    // set high up invalidates style for everything beneath it.
    onMeasure: (el) => {
      const label = el.querySelector<HTMLElement>(".rl-toc-btn-label");
      if (!label) return;
      // +1 because scrollWidth is an integer: a 50.4px label clamped to a
      // measured 50px starts overflowing, which reads back as 51 and then 50
      // again, rewriting the property every frame of a drag. The pixel of slack
      // is the difference between a fixed point and a wobble.
      const w = `${label.scrollWidth + 1}px`;
      if (el.style.getPropertyValue("--rl-toc-label-w") !== w)
        el.style.setProperty("--rl-toc-label-w", w);
    },
    // `docWide` for the same reason it's in the zoom control's deps: switching
    // views moves the text column's left edge from "centred" to the pane's edge
    // without resizing the scroller the observer watches, so the measurement has
    // to be asked for rather than waited on.
    deps: [tocDocked, tocEligible, stageSurface, activeId, activeFile, docWide, docMeasure],
  });

  // The conversation dock's contexts. It sits at PLATE level — a sibling of
  // the whole surface pane, not of the document body — so the same column
  // serves whichever surface is selected; all that changes per surface is
  // which conversations exist beside it.
  //
  // App decides what is DISCUSSABLE (a plan needs its markdown to have
  // arrived); the lib decides which conversations belong to a surface and
  // which one leads. That split is the point: the precedence is unit-tested
  // and App only wires.
  const planDiscussable = sessionReady && !!latest;
  // Talk is never empty (W4): a pane with no conversation of its own — a
  // terminal wall, a file, an Agent tab, a review, a door without a chat —
  // hosts the conversation of where it sits, asked of the same
  // `conversationContexts`: inside a session its plan's voice, on Home the
  // Companion chat (its room lands through chatHost).
  const dockContexts = useMemo(() => {
    const inputs = {
      voiceEnabled,
      chatEnabled,
      surface: stageSurface,
      plateMode,
      activeId: planDiscussable ? activeId : null,
      planTitle: activeSummary?.planTitle ?? null,
      drafterDraftId,
      drafterTitle: null,
      browseId: browserDock.browseId,
      browseTitle: browserDock.title,
      browsePill: browserDock.pill,
      cartId: browserDock.cartId,
      missionId: browserDock.missionId,
      missionTitle: browserDock.missionTitle,
      companionId: chatId,
      companionTitle: chatTitle,
    };
    const own = conversationContexts(inputs);
    if (own.length > 0) return own;
    const where = conversationContexts({ ...inputs, surface: "document", plateMode: planDiscussable && activeId ? "plan" : "door" });
    // A companion chat already on screen as a pane is that conversation; the
    // rail does not mirror it (one room, one host).
    return chatPane ? where.filter((c) => c.kind !== "companion") : where;
  }, [
    voiceEnabled,
    chatEnabled,
    stageSurface,
    plateMode,
    planDiscussable,
    activeId,
    activeSummary?.planTitle,
    drafterDraftId,
    browserDock,
    chatId,
    chatTitle,
    chatPane,
    ]);
  const dockContext = activeConversation(dockContexts, conversationPin);
  const dockContextKeyRef = useRef<string | null>(null);
  dockContextKeyRef.current = dockContext?.key ?? null;
  // Two poses, one thread. The plate is "at rest" only on the Front Door —
  // nothing of its own to cover — which is exactly what makes the door a way
  // IN to a conversation rather than a place you navigate away from.
  // The room's occupant must be the conversation the room was opened for. If
  // the user switches contexts from inside it — to one that cannot be a room,
  // or simply to another — the room folds back into the column rather than
  // quietly showing something else at plate scale.
  // One source of truth for the JSX and for the surrounding layout, so the
  // dock and the divider can never disagree about whether the
  // column is up.
  const voiceDocked = dockOpen && dockContext != null;
  const planVoiceOpen = voiceDocked && dockContext?.kind === "voice";
  planVoiceOpenRef.current = planVoiceOpen;
  // The conversation a dictation with nowhere to type becomes a turn in: the
  // plan's or the Drafter's voice, whether or not its panel is open. Read when
  // a dictation starts, so it is a ref, never a dependency.
  const talk = dockContexts.find((c) => c.kind === "voice" || c.kind === "drafter");
  talkRef.current = talk
    ? {
        key: talk.key,
        markdown: talk.kind === "drafter" ? () => getDrafterLiveMarkdown() || drafterMarkdown : () => latest?.rawPlanMarkdown ?? "",
        cwd: talk.kind === "drafter" ? drafterProjectPath : null,
      }
    : null;
  // Putting the conversation away — from the column or from the room. One
  // action, because "close" must not mean two different things depending on
  // the pose: whichever you were in, you end up back where you were without it.
  // A chat carried into the dock was pinned there; putting the dock away
  // gives the column back to the surface's own conversation (the Discuss
  // pill reopens the plan's voice, not the chat — it is still in the door).
  // In the rail (W4) putting it away turns the rail to the pane's own first
  // other tab — the rail stays where the user left it, open or folded.
  const railTabsRef = useRef(railTabs);
  railTabsRef.current = railTabs;
  const closeDock = useCallback(() => {
    selectRailTab(railTabsRef.current.find((t) => t !== "talk") ?? "files");
    setConversationPin(pin => (pin === "companion" ? null : pin));
  }, [setConversationPin, selectRailTab]);
  const openDock = useCallback(() => openRailTab("talk"), [openRailTab]);
  // ⌘J: the rail's Talk — open it there, or put it away when it is what
  // shows. A focused web page forwards ⌘J as its `toggle-monochat` signal.

  const toggleTalk = useCallback(() => {
    if (talkShownRef.current) closeDock();
    else openDock();
  }, [closeDock, openDock]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDockKey(e)) return;
      e.preventDefault();
      toggleTalk();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("redline:toggle-monochat", toggleTalk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("redline:toggle-monochat", toggleTalk);
    };
  }, [toggleTalk]);
  // The Discuss pill opens the plan's own discussion — its voice — never a
  // chat carried out of the door's room that rides along beside it. A pin
  // left by that carry (the home dock shut by walking to a plan) is dropped.
  const openDiscussion = useCallback(() => {
    setConversationPin(pin => (pin === "companion" ? null : pin));
    openDock();
  }, [setConversationPin, openDock]);
  // Which of the browser pane's four panels the dock is showing, in the pane's
  // own vocabulary. Null whenever the column is closed or holding another
  // surface's conversation — which is exactly when the pane must not portal.
  const dockPill = voiceDocked ? kindPill(dockContext?.kind ?? null) : null;
  const openDockPill = useCallback(
    (pill: ChatPill) => {
      const kind = pillKind(pill);
      if (!kind) return;
      setConversationPin(kind);
      openRailTab("talk");
    },
    [setConversationPin, openRailTab],
  );
  // BrowserPane remains mounted with its durable pages. Keep its dock
  // description too; conversationContexts only exposes it on the browser.
  // The dock's bodies are lazy chunks. Warm the room's when the COLUMN opens
  // rather than at the instant the Companion tab is picked, so stepping
  // sideways into it doesn't blank for a beat.
  useEffect(() => {
    if (dockOpen && currentDockScope === "home" && chatEnabled) prefetchSurfaceChunk("chat");
  }, [dockOpen, currentDockScope, chatEnabled]);
  // Go to a surface AND a tab inside it. `selectSurface` keeps its signature —
  // it is the one surface mutator and taking a second argument would make
  // every one of its ~30 call sites answer a question it doesn't have — so the
  // tab travels as a separate nonce'd REQUEST that the surface honours once.
  // A tab the surface doesn't have is dropped here rather than sent and
  // ignored, so a stale palette entry can't strand anyone.
  const [tabRequest, setTabRequest] = useState<TabRequest | null>(null);
  const navigateTo = useCallback(
    (t: NavTarget) => {
      selectSurfaceRef.current(t.surface as Surface);
      if (isKnownTab(t.surface, t.tab))
        setTabRequest({ tab: t.tab!, nonce: Date.now() });
    },
    [],
  );
  const dockReachable = dockContexts.length > 0;

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
    // The room's map changes under every collaborator edit; keep each comment
    // (and the list) that a change didn't touch.
    const read = () => {
      const next = yjsBackend.list();
      setCollabComments((prev) => keepEqual(prev, next));
    };
    read();
    return yjsBackend.observe(read);
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
  // returned Comment), expand its card inside the discussion pane. The pane
  // stays closed until the user opens it, and the plan stays where the user
  // is reading: focusing the comment would scroll to it mid-conversation. The
  // voice panel's confirmation offers Show for that.
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
    if (fresh) setAutoOpenCommentId(fresh.id);
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
      // An unpromoted research comment is a pointer to what was found, not
      // feedback — it never rides a Send.
      threadComments.filter(ridesSubmit),
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
  // (`heldTermIds`, every dock terminal holding a plan, is declared with the
  // terminal map above: the tab dots and the sidebar's rows read it too.)
  // The same linkage carrying the plan's *name*, so the tab bar's repo popover
  // can say which piece of work each held terminal is sitting on rather than
  // only that it is held. Both are kept by value, so a summaries read that
  // moved no hold leaves the memoized dock alone.
  const heldPlanTitles = useStableValue(useMemo(() => heldPlanByTerminal(summaries), [summaries]));
  // Detached is *derived* from the active session's persisted attach state —
  // the backend records detachment (drop-guard, failed submit, startup sweep
  // for POSTs orphaned by a restart), so this survives restarts and detaches
  // that fire while another session is in the foreground. `detachDismissed`
  // only mutes the banner; the disabled submit/approve gating stays.
  const activeDetached =
    summaries.find((s) => s.sessionId === activeId)?.attachState ===
    "detached";
  const detached = activeDetached && !detachDismissed;
  // A restore in flight — a RECORD, not a flag, and a state machine rather
  // than a pile of setState calls. Every rule that matters about it is a rule
  // about ORDER (a stale handoff failure landing after a retry; a summary
  // refresh beating the event that already closed it), so the whole lifecycle
  // lives in `lib/restoreAttempt` where order can be pinned by a test.
  const [restoreAttempt, setRestoreAttempt] = useState<RestoreAttempt | null>(
    null,
  );
  const onRestore = (ev: RestoreEvent) =>
    setRestoreAttempt((a) => reduceRestore(a, ev));
  const {
    attempt: attemptHere,
    restoring,
    failure: restoreFailure,
  } = restoreView(restoreAttempt, activeId);
  // A stuck attempt would leave the reviewer watching a status line forever, so
  // it expires — into a VISIBLE failure rather than back into the original
  // banner. Silently reverting is indistinguishable from never having clicked,
  // which is how one quietly-dead restore became three live claudes.
  useEffect(() => {
    if (!restoreAttempt || restoreAttempt.phase === "failed") return;
    // Reattached: the restore landed. (`plan-received` closes it too, and
    // usually first — this is the backstop for a summary refresh that wins.)
    const state =
      summaries.find((sx) => sx.sessionId === restoreAttempt.sessionId)
        ?.attachState ?? null;
    const settled = reduceRestore(restoreAttempt, {
      type: "attach-state",
      sessionId: restoreAttempt.sessionId,
      state,
    });
    if (settled !== restoreAttempt) {
      // Through the reducer, not the value read here: a step taken since
      // this render (the terminal dispatched) must not be written over.
      onRestore({ type: "attach-state", sessionId: restoreAttempt.sessionId, state });
      return;
    }
    const timer = window.setTimeout(
      () =>
        onRestore({
          type: "timeout",
          error:
            "The reopened session hasn't answered in two minutes. It may " +
            "still be thinking — or it may have stopped at a prompt.",
        }),
      restoreDeadlineIn(restoreAttempt, Date.now()),
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreAttempt, summaries]);

  // A legacy row — no `sessions.backend`, because it predates the column or its
  // hook never sent a provider — cannot be restored until someone says which
  // harness holds the conversation. The id proves nothing: current Codex issues
  // UUID session ids indistinguishable from Claude's, so sniffing the shape
  // would be a coin flip dressed as a decision. So the banner asks. Keyed by
  // session, because two legacy reviews must not inherit each other's pick.
  const [harnessChoices, setHarnessChoices] = useState<
    Record<string, RestoreHarness>
  >({});

  // The harness this detached review restores on. ONE derivation, read by the
  // banner, the embedded-terminal restore and the clipboard fallback alike —
  // the three cannot disagree about which binary resumes the conversation.
  const restoreDecision = useMemo(
    () =>
      resolveRestoreHarness({
        backend: session?.backend,
        choice: activeId ? harnessChoices[activeId] : null,
      }),
    [session?.backend, activeId, harnessChoices],
  );
  // The same derivation for any session: the automatic resume restores one
  // that may not be on screen. The one on screen reads the memo above.
  const restoreDecisionFor = (s: { sessionId: string; backend?: string | null }) =>
    s.sessionId === activeId
      ? restoreDecision
      : resolveRestoreHarness({ backend: s.backend, choice: harnessChoices[s.sessionId] });

  // What stands between this review and its plan coming back. Derived, never
  // stored: `applyReadinessFix` re-probes, the answer lands in `preflight`, and
  // the row clears itself without the reviewer re-clicking anything. Shown in
  // the banner BEFORE the click, because a restore that can't return the plan
  // spends a terminal, dismisses the banner, and leaves nothing to show for it.
  const detachedCopy = useMemo(
    () => detachedBannerCopy(restoreDecision),
    [restoreDecision],
  );

  // What the banner says while a restore is in flight. Same copy the toast used
  // to carry, from the same place — `restoreHarness` owns every reviewer-facing
  // sentence about a restore so the two paths cannot drift. `history` is only
  // known once `prepare_restore` has answered, and `unchecked` is the honest
  // reading before then: nobody has looked yet.
  const restoreStatus = restoring
    ? restoreStartedNote(restoreDecision, {
        cwd: null,
        relocated: false,
        primed: false,
        history: attemptHere?.history ?? "unchecked",
      }).message
    : null;

  const [restoreHealth, setRestoreHealth] = useState<{ backend: Backend; preflight: PreflightStatus; codexHook: boolean } | null>(null);
  useEffect(() => {
    if (!detached) return;
    let alive = true;
    void integrationHealth.ensure({ backend: restoreDecision.harness, extension: false }).then((health) => {
      if (alive) setRestoreHealth({ backend: restoreDecision.harness, preflight: health.preflight, codexHook: health.codexHook?.installed ?? false });
    }).catch(() => {});
    return () => { alive = false; };
  }, [detached, restoreDecision.harness, preflight]);
  const restoreBlockers = useMemo(
    () => restoreHealth?.backend === restoreDecision.harness
      ? providerRestoreBlockers(restoreDecision.harness, restoreHealth.preflight, restoreHealth.codexHook)
      : [],
    [restoreDecision.harness, restoreHealth],
  );
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
  // `building` or `landed`; anything else the cut run feature left reads as
  // not built.
  const activeRunState = planBuildState(
    summaries.find((s) => s.sessionId === session?.sessionId)?.runState,
  );

  // A highlight clicked in the plan brings its thread forward: the rail
  // turns to Discussion (it never opens a folded rail — the card waits there).
  // Voice stays first-class: while a voice conversation is live in Talk the
  // rail never leaves it — the mark's words go into Talk's composer as
  // context instead (VoicePanel's `redline:talk-context`).
  useEffect(() => {
    if (!focusedCommentId || railKindRef.current !== "plan") return;
    if (talkShownRef.current && discussionLiveRef.current) {
      const c = threadCommentsRef.current.find((x) => x.id === focusedCommentId);
      const text = c?.selection?.quotedText || c?.body || "";
      const key = dockContextKeyRef.current;
      if (key && text) window.dispatchEvent(new CustomEvent("redline:talk-context", { detail: { key, text } }));
      return;
    }
    selectRailTab("discussion");
  }, [focusedCommentId, focusNonce, selectRailTab]);
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
  }, [focusedCommentId, focusNonce]);

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
    // action appears to do nothing when the pane is collapsed (or masked).
    revealPane();
    // Saving it renders a card; fetch the card's chunk while the user types.
    commentCardChunk.warm();
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

  // Search from the plan. The bar keeps its own copy of the selection: the
  // editor's selection collapses the moment the bar's input takes focus.
  const [planSearch, setPlanSearch] = useState<{ sessionId: string; selection: NonNullable<typeof selection> } | null>(null);
  const beginPlanSearch = () => {
    if (!selection || !session) return;
    setPlanSearch({ sessionId: session.sessionId, selection });
    clearSelection();
  };
  // ⏎ in the bar: a new browser tab on a web search for the passage, its chat
  // seeded and sent, and — once the pane reports the tab's thread — an
  // anchored research comment that links back to it (`onBrowserOpenConsumed`).
  const runPlanSearch = (instruction: string) => {
    const s = planSearch;
    setPlanSearch(null);
    if (!s) return;
    const { selection: sel } = s;
    const query = researchQuery(sel.text, instruction);
    const url = researchSearchUrl(sel.text, instruction);
    const title = summaries.find((x) => x.sessionId === s.sessionId)?.planTitle ?? null;
    pendingResearchRef.current = {
      sessionId: s.sessionId,
      request: {
        type: "question",
        anchorId: sel.anchorId,
        blockId: blockIdByAnchor.get(sel.anchorId),
        body: `Searched: ${query}`,
        selection:
          sel.charEnd > sel.charStart
            ? { charStart: sel.charStart, charEnd: sel.charEnd, quotedText: sel.text, subBlockId: sel.subBlockId }
            : undefined,
        research: { query, browseId: "", url },
      },
    };
    setBrowserOpenRequest({ url, nonce: Date.now(), chat: { text: researchSeed(sel.text, instruction, title) } });
    selectSurface("browser");
  };
  // "View result →" on a research comment: wake its tab with the chat open,
  // or reopen the search if that tab has since been closed.
  const viewResearch = useCallback((c: Comment) => {
    if (!c.research) return;
    setBrowserOpenRequest({ url: c.research.url ?? researchSearchUrl(c.research.query, ""), nonce: Date.now(), focusBrowseId: c.research.browseId });
    selectSurfaceRef.current("browser");
  }, []);

  // Cross out the selection: strike it in place exactly like the Delete key
  // (Word-style `rl_del` track change), driven through the editor's
  // `strikeSelection` command. The struck text round-trips through the
  // accept-all serializer as an [edit] with the span deleted — same outcome
  // as before, but the user sees an immediate strikethrough instead of a
  // composer with an empty field.
  const beginCrossOut = () => {
    if (!selection) return;
    // Reveal the pane so the resulting struck-edit card is visible.
    revealPane();
    planActionsRef.current?.strikeSelection();
    clearSelection();
  };

  const submitComment = async (req: NewCommentRequest, opts: { discuss: boolean } = { discuss: false }) => {
    if (!session) return;
    const sessionId = session.sessionId;
    try {
      const saved = await invoke<Comment>("add_comment", {
        sessionId,
        // Resolve the stable blockId from the comment's anchor so the in-doc
        // highlight decoration (keyed by blockId) paints — without it the
        // highlight never renders and the highlight↔card focus bridge is dead.
        request: {
          ...req,
          blockId: req.blockId ?? blockIdByAnchor.get(req.anchorId),
        },
      });
      // `add_comment` already returned the saved comment, so put it on the
      // session now rather than after the comments-changed → get_session round
      // trip: React batches this with closing the composer, and the two swap
      // in one frame (no gap, no empty-state flash on a fresh revision).
      if (saved?.id) {
        setSession((prev) => withOptimisticComment(prev, sessionId, saved));
      }
      setComposing(null);
      // Send = save + discuss: the new card starts its own discussion once.
      if (opts.discuss && saved?.id) {
        setAutoDiscussCommentId(saved.id);
        setFocusedCommentId(saved.id);
      }
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

  /** Resolves false when the update did not land — a card showing the edit
   *  ahead of the reload puts the saved text back. */
  const updateComment = async (
    commentId: string,
    update: import("./types").UpdateCommentRequest,
  ): Promise<boolean> => {
    if (!session) return false;
    try {
      await invoke<Comment>("update_comment", {
        sessionId: session.sessionId,
        commentId,
        update,
      });
      return true;
    } catch (err) {
      console.error("failed to update comment", err);
      return false;
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
      setToast("Plan approved", 3500);
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

  // "Approve, build later": approved, the agent stands down in plan mode, and
  // the plan waits here as "approved · not built" with Build and Reopen.
  const approvePlanLater = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      await invoke("approve_plan_later", { sessionId: session.sessionId });
      setToast("Plan approved — build it from here when you're ready");
      void refreshSummaries();
    } catch (err) {
      console.error("approve_plan_later failed", err);
      if (isDetachError(err)) {
        setDetachDismissed(false);
        void refreshSummaries();
      } else setToast(`Approve failed: ${err}`, null);
    } finally {
      setBusy(false);
    }
  };

  // Building an approved plan: the agent that wrote it ("same", resuming its
  // session in a building mode) or a hand-off to the other harness, which
  // reads the approved plan from a file. Cursor/Antigravity are not offered
  // (their non-plan flags are unverified).
  const planHarness: Backend = restoreDecision.harness;
  const buildTargets = useMemo(() => {
    if (session?.status !== "approved") return [];
    const targets: { id: string; label: string; detail?: string }[] = [];
    if (runSupported(planHarness))
      targets.push({ id: "same", label: `with ${agentLabelFor(planHarness)}`, detail: "resumes the session that wrote the plan" });
    for (const b of ["claude-code", "codex"] as const) {
      if (b !== planHarness) targets.push({ id: b, label: `with ${agentLabelFor(b)}`, detail: "a fresh session reads the approved plan" });
    }
    return targets;
  }, [session?.status, planHarness]);

  const buildApproved = async (targetId: string) => {
    if (!session || busy) return;
    const sessionId = session.sessionId;
    const projectPath = session.projectPath || null;
    const version = session.revisions[session.revisions.length - 1]?.versionNumber ?? 1;
    setBusy(true);
    try {
      if (targetId === "same") {
        const health = await integrationHealth
          .ensure({ backend: planHarness, extension: false, projectPath })
          .catch(() => null);
        // Where `--resume` can find the conversation — WITHOUT the restore's
        // plan-file prime, which would overwrite the plan the agent is about
        // to implement.
        const cwd = await invoke<string | null>("resume_startup_cwd", {
          sessionId,
          projectPath,
          backend: planHarness,
        }).catch(() => projectPath);
        const cmd = `${buildResumeBuildCommand(sessionId, new Date(), cwd, version, {
          backend: planHarness,
          claudeBin: health?.preflight.claude.path ?? preflightRef.current?.claude.path ?? null,
          codexBin: health?.preflight.codex?.path ?? preflightRef.current?.codex?.path ?? null,
          model: session.model,
          effort: session.effort,
        }, projectPath)}\r`;
        suppressTerminalRevealFocus();
        const id = await openTerminal(projectPath, true);
        if (!id) {
          setToast("Couldn't open a terminal to build in", 6000);
          return;
        }
        // The build is this session's conversation from now on: bound before
        // the resumed CLI starts (as a restore is), so the Agent tab finds its
        // terminal the moment it exists.
        bindSessionTerminals([{ sessionId, terminalId: id }]);
        void import("./components/agent/convo/api").then((api) => api.convoPrebind(id, sessionId)).catch(() => {});
        const delivery = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: cmd }]);
        if (!delivery.ok) {
          setToast(`Couldn't start the build (${delivery.stage}): ${delivery.reason}`, 6000);
          return;
        }
        await invoke("mark_plan_build", { sessionId, harness: planHarness, mode: "same" });
        // Out of sight, as this session's conversation: the toast is the way
        // to it (its Agent tab, else a wall).
        setToast({ message: `Building with ${agentLabelFor(planHarness)} in this session's Agent tab`, action: { label: "Show", onAction: () => showTerminal(id) } });
      } else {
        const path = await invoke<string>("write_plan_handoff", { sessionId });
        const r = await launchPlan({
          mode: "run",
          origin: "plan-handoff",
          choice: { backend: targetId as Backend, model: null, effort: null },
          prompt: handoffPrompt(path),
          projectPath,
          draftId: null,
          addDirs: [path.slice(0, path.lastIndexOf("/"))],
          restore: { kind: "none" },
        });
        if (!r.ok) {
          setToast(`Couldn't hand off the build — ${r.reason}`, 6000);
          return;
        }
        await invoke("mark_plan_build", { sessionId, harness: targetId, mode: "handoff" });
      }
      void refreshSummaries();
    } catch (err) {
      setToast(`Couldn't start the build: ${err}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  // Reopen for review: rescind the approval, then restore the session so the
  // plan comes back held, in review, with its comments — the stand-down it
  // was given is declared void in the restore trigger.
  const reopenApproved = async () => {
    if (!session) return;
    if (await unapproveSession(session.sessionId)) await restorePlanSessionWith({ rescinded: true });
  };

  // B3: rescind the approval — back to review, detached, ledger supersession
  // backend-side. The rescinded set feeds the restore prompt's "your
  // stand-down is void" sentence.
  const unapproveSession = async (sessionId: string): Promise<boolean> => {
    try {
      await invoke("unapprove_plan", { sessionId });
      setRescindedIds((prev) => {
        const next = new Set(prev);
        next.add(sessionId);
        return next;
      });
      void refreshSummaries();
      setToast(
        "Approval rescinded — the session is back in review. Restore reattaches it.", 7000,
      );
      return true;
    } catch (err) {
      setToast(`Un-approve failed: ${err}`, 6000);
      return false;
    }
  };

  // A5: the single-step verified handoff shared by every "open a terminal
  // and type a command" path — spawn-verified, write-checked, loud on
  // failure. Replaces the identical blind setTimeout(pty_write, 900) pattern
  // that let a failed delivery render as success. The failure toast is
  // persistent (Dismiss, never a timer): a spawn timeout surfaces at +15s,
  // after the user has already looked away — an 8s auto-dismiss is how these
  // failures kept escaping diagnosis. With a sessionId the handoff also
  // journals its breadcrumbs (handoff_spawned/…/handoff_failed).
  const typeIntoTerminal = (
    id: string,
    data: string,
    failNote: string,
    sessionId?: string | null,
    /** Set when `id` is a shell that just spawned: hold the write until it has
     *  drawn its prompt, so the command is echoed once rather than twice. See
     *  `SHELL_PROMPT`. Costs no wall-clock — a shell mid-rc could not have run
     *  the command yet either way. */
    freshShell?: boolean,
    /** Take the failure instead of the toast. Set by callers that already own
     *  a place to say it — the restore banner, which has to move to its
     *  `failed` phase rather than leave a status line spinning behind a toast
     *  the reviewer dismissed. */
    onFailure?: (stage: string, reason: string) => void,
  ) => {
    const journal = (stage: string, detail?: string) => {
      if (!sessionId) return;
      void invoke("record_handoff_event", {
        sessionId,
        stage,
        detail: detail ?? null,
      }).catch(() => {});
    };
    const deps = sessionId ? { ...tauriHandoffDeps, journal } : tauriHandoffDeps;
    const step: HandoffStep = freshShell
      ? {
          stage: "launch",
          data,
          awaitBefore: SHELL_PROMPT,
          awaitTimeoutMs: PROMPT_TIMEOUT_MS,
          // A prompt we failed to recognise is not a reason to wait longer —
          // write immediately and wear the double echo.
          fallbackSettleMs: 0,
        }
      : { stage: "launch", data };
    void deliverToTerminal(deps, id, [step]).then((r) => {
      if (!r.ok) {
        journal("handoff_failed", `${r.stage}: ${r.reason}`);
        if (onFailure) {
          onFailure(r.stage, r.reason);
          return;
        }
        setToast({
          message: `${failNote} (${r.stage}): ${r.reason}`,
          action: { label: "Dismiss", onAction: () => setToast(null) },
        });
      }
    });
  };

  // Ask the backend where this conversation actually lives — and, for Claude,
  // whether it lives anywhere at all. Never throws the restore away on failure:
  // the plan's project path is the guess this used to make unconditionally, so
  // falling back to it is a return to the old behaviour rather than a dead end.
  //
  // The fallback claims `unchecked`, not `available`. Preparation failing is
  // precisely the case where we have no answer about the transcript, and the
  // one thing `history` must never do is manufacture one — `missing` is spent
  // on a real warning ("resuming as a fresh conversation") that would be a lie
  // here, and `available` would suppress that warning when it was deserved.
  const resolveResumeCwd = async (
    sessionId: string,
    projectPath: string | null | undefined,
    backend: string | null | undefined,
  ): Promise<RestorePrep> => {
    const fallback: RestorePrep = {
      cwd: projectPath || null,
      history: "unchecked",
      relocated: false,
      primed: false,
    };
    try {
      const r = await invoke<RestorePrep>("prepare_restore", {
        sessionId,
        projectPath: projectPath || null,
        // Load-bearing: the Claude arm reads `~/.claude` for a transcript, a
        // startup cwd and a plan file to prime. A Codex thread has none of the
        // three, so running it would spend the lookups to arrive at "missing"
        // — and then tell a Codex reviewer their session has no transcript.
        backend: backend || null,
      });
      return r ?? fallback;
    } catch {
      return fallback;
    }
  };

  // Refuse a restore that cannot return the plan, and say what's in the way.
  // The banner already renders these rows with their fix buttons; this is the
  // click-time backstop for the gap between a stale probe and the button state.
  const checkRestoreHealth = async (harness: RestoreHarness = restoreDecision.harness): Promise<PreflightStatus | null> => {
    try {
      const health = await integrationHealth.refresh({ backend: harness, extension: false });
      setRestoreHealth({ backend: harness, preflight: health.preflight, codexHook: health.codexHook?.installed ?? false });
      const [first] = providerRestoreBlockers(harness, health.preflight, health.codexHook?.installed);
      if (first) { setToast(`${first.label} — restore can't bring the plan back until that's fixed.`); return null; }
      return health.preflight;
    } catch (error) { setToast(`Could not check the planning provider: ${error}`); return null; }
  };

  /** Bring a restore's terminal on screen, on request.
   *
   *  Promotes the EXISTING background terminal into the focused tile — never a
   *  second terminal and never a second resume, which is the whole reason the
   *  attempt record carries its id. Focus is deliberately not suppressed here
   *  (unlike an automatic reveal): the reviewer asked to go there. */
  const showRawTerminal = async (terminalId: string | null) => {
    if (!terminalId) return;
    await ensureTerminalReady();
    showTerminal(terminalId, false, true);
  };

  // One-click recovery for a detached plan: resume the exact conversation that
  // wrote it, with a compact control event that re-establishes the held
  // ExitPlanMode. Because the resumed session keeps the same session_id, its
  // POST reattaches to this review — comments, revisions and reopen history
  // intact (no phantom new review).
  //
  // The terminal it runs in is BACKGROUND. Restoring is machinery, not a place
  // to work: the old path yanked the dock open and put the reviewer in front of
  // a resumed session replaying its own control messages, which is exactly the
  // raw replay this rework exists to stop presenting as conversation. The
  // banner they are already reading becomes the progress surface, and
  // "Show raw terminal" is there for when they want the machinery.
  // `rescinded` is passed by Reopen, which rescinds and restores in one
  // gesture — before `rescindedIds` has re-rendered into this closure.
  //
  // `target` is the automatic resume's (lib/useAutoResume): a session that is
  // not necessarily the one on screen, read off its summary. A click restores
  // the session on screen. Either way the same body runs, so the one-at-a-time
  // rule and every step below hold for both. Says whether it started.
  const restorePlanSession = () => restorePlanSessionWith({});
  // The ref covers the awaits before the attempt is recorded: a click and the
  // automatic timer landing together must not both get past the check below.
  const restoreBusyRef = useRef(false);
  const restorePlanSessionWith = async (opts: { rescinded?: boolean; target?: SessionSummary }): Promise<AutoStart> => {
    if (restoreBusyRef.current) return "busy";
    restoreBusyRef.current = true;
    try {
      return await restoreOnce(opts);
    } finally {
      restoreBusyRef.current = false;
    }
  };
  const restoreOnce = async (opts: { rescinded?: boolean; target?: SessionSummary }): Promise<AutoStart> => {
    const t = opts.target ?? session;
    if (!t) return "blocked";
    // One at a time. See `RestoreAttempt`. A failed attempt is not in flight —
    // its Retry comes back through here.
    if (!canStartRestore(restoreAttempt)) return "busy";
    const decision = restoreDecisionFor(t);
    // Nothing spent until the round trip can actually complete: a Codex restore
    // missing its binary, sign-in, plan profile or Stop hook opens a terminal
    // that runs, looks healthy, and never gives the plan back. The blocker's
    // own fix is already on screen.
    const restoreProbe = await checkRestoreHealth(decision.harness);
    if (!restoreProbe) return "blocked";
    const sessionId = t.sessionId;
    const projectPath = t.projectPath || null;
    onRestore({ type: "start", sessionId, at: Date.now() });
    // The banner is the status surface now, so it must NOT be dismissed — the
    // old path hid it and left the reviewer with a terminal and no narrator.
    if (sessionId === activeId) setDetachDismissed(false);
    const fail = (error: string) =>
      onRestore({ type: "fail", sessionId, error });

    // Where the conversation can actually be resumed from — for Claude, the cwd
    // it STARTED in, which is not always the plan's project path (a session
    // launched from `~` and `cd`'d into the repo files its transcript under
    // `~`). Resolved against the transcripts on disk; falls back to the project
    // path, which is also where the Codex arm starts and ends.
    const target = await resolveResumeCwd(
      sessionId,
      projectPath,
      decision.harness,
    );
    const cmd = `${buildResumeCommand(
      sessionId,
      new Date(),
      target.cwd,
      rescindedIds.has(sessionId) || !!opts.rescinded,
      target.primed,
      // A Codex thread id handed to `claude --resume` does not error — it
      // silently starts a FRESH session, which then writes the sentinel under
      // an id Redline never held. For a legacy row with no stored provenance
      // this is the reviewer's own pick, defaulting to Claude.
      {
        backend: decision.harness,
        claudeBin: restoreProbe.claude.path,
        codexBin: restoreProbe.codex?.path ?? null,
        cursorBin: restoreProbe.providers?.cursor?.path ?? null,
        antigravityBin: restoreProbe.providers?.antigravity?.path ?? null,
        model: t.model,
        effort: t.effort,
      },
    )}\r`;

    // AWAITED, not fired: this arms two one-shots the restore depends on — the
    // plan side (so the re-presentation is labeled "vN restored" instead of
    // counted as a fresh version) and the prompt side (so the resumed session's
    // first submission is answered with the hidden protocol and kept out of the
    // lake). Both are consumed by events the command itself triggers, so
    // dispatching first is a race with the arming that is supposed to precede
    // it. It used to be a bare `void invoke(...)`.
    try {
      await invoke("arm_restore", { sessionId });
    } catch (e) {
      fail(`Couldn't arm the restore: ${String(e)}`);
      return "started";
    }

    // The terminal opens in the PLAN's directory — the one the reviewer thinks
    // in — and the command's own `cd` takes it wherever the transcript lives.
    const id = await openTerminal(projectPath, true);
    if (!id) {
      fail("Couldn't open a terminal to resume in.");
      return "started";
    }
    // The plan's conversation is this terminal's from now on — bound before
    // the resumed CLI's SessionStart, so it binds the moment it does. In
    // either shell: the workbench's per-session Agent tab reads this binding.
    bindSessionTerminals([{ sessionId, terminalId: id }]);
    void import("./components/agent/convo/api").then((api) => api.convoPrebind(id, sessionId)).catch(() => {});
    onRestore({
      type: "dispatched",
      sessionId,
      terminalId: id,
      history: target.history,
    });
    typeIntoTerminal(
      id,
      cmd,
      "Couldn't type the resume command",
      sessionId,
      true,
      (stage, reason) =>
        fail(`Couldn't type the resume command (${stage}): ${reason}`),
    );
    return "started";
  };

  // An interrupted plan session comes back on its own: the agent behind a
  // plan in review died (or its PTY exited) and the reviewer didn't stop it.
  // The rules, the backoff and the loop guard are `lib/autoResume`; the
  // restore is the one above, so a click and the timer share one slot.
  const autoNoticeHere = useAutoNotice(activeId);
  // A plan session whose CLI kept running in a terminal Redline adopted after
  // a quit is not detached in any sense that a Restore could fix: resuming
  // it would run the conversation twice. Live terminal, agent in front (or
  // not yet sampled) = still running.
  const agentStillRunning = (sessionId: string): string | null => {
    const t = sessionTerminalsRef.current.get(sessionId);
    if (!t || !liveTermIdsRef.current?.includes(t)) return null;
    const st = termStatusesRef.current.get(t);
    return st?.state === "exited" ? null : st?.label ?? "its terminal";
  };
  const autoResume = useAutoResume({
    summaries,
    restoreAttempt,
    sessionTerminals,
    isLegacy: (s) => {
      const d = restoreDecisionFor(s);
      return d.legacy && !d.chosen;
    },
    start: (sessionId) => {
      if (agentStillRunning(sessionId)) return Promise.resolve("blocked" as const);
      const target = summaries.find((s) => s.sessionId === sessionId);
      return target ? restorePlanSessionWith({ target }) : Promise.resolve("blocked" as const);
    },
  });

  // Candidate project directories for the drafter's launch picker: every review
  // session's project, each open folder workspace, and every folder registered
  // in the workspace manifest (project_create writes there, so a created
  // project is visible before any plan ever lands in it), deduped by path.
  // Kept by value: every summaries read re-derives it, and the dock and the
  // door take it as a prop.
  const projectOptions = useStableValue(useMemo<ProjectOption[]>(() => {
    const seen = new Map<string, ProjectOption>();
    const add = (path: string, name: string, source: ProjectOption["source"]) => {
      if (!path) return;
      const key = path.replace(/\/+$/, "") || "/";
      if (!seen.has(key)) seen.set(key, { path, name, source });
    };
    for (const s of summaries) add(s.projectPath, s.projectName, "session");
    for (const f of openFolders) add(f.path, f.name, "folder");
    for (const path of Object.keys(workspace.projects ?? {})) {
      const base = path.replace(/\/+$/, "");
      add(path, base.slice(base.lastIndexOf("/") + 1) || path, "workspace");
    }
    return [...seen.values()];
  }, [summaries, openFolders, workspace]));

  // Kinds of projects created THIS session, written synchronously at
  // creation. The workspace registration lands via queued state, but the
  // create-and-plan path launches in the same continuation — a launch that
  // read only `workspace` would miss the brand-new pack's type and skip its
  // --add-dir grants exactly once, on the launch the folder was made for.
  const createdKindsRef = useRef<Record<string, "extension" | "harness">>({});

  // A pending launch DIED — the terminal it was running in went away before a
  // plan ever arrived. Pay back whatever the surface handed over, because
  // retyping a sentence you already wrote is the small betrayal this door
  // exists to remove: the Front Door gave its sentence up and is owed it; the
  // Drafter never took the document away and is owed nothing.
  //
  // Exactly ONE caller, and the name says why. Deliberate dismissal is not a
  // death: "start something else" and displacing an older launch both leave
  // the plan running in its own tile, and refilling the composer there is the
  // unwanted refill — the sentence coming back after you sent it on purpose.
  const repayPending = (p: PendingLaunch | null, note?: string) => {
    if (!p) return;
    if (p.restore.kind === "composer") {
      const next = restoreInto(
        {
          text: getFrontDoorText(),
          attachments: frontDoorAttachmentsRef.current,
          combine: frontDoorCombineRef.current,
        },
        p.restore,
      );
      setFrontDoorText(next.text);
      setFrontDoorAttachments(next.attachments);
      // A dead combine that handed back only the sentence would silently
      // drop the plans it was about.
      setFrontDoorCombine(next.combine ?? []);
    }
    if (note) {
      setToast(note);
    }
  };

  // Read at LAUNCH time, from definitions that sit below `launchPlan` in the
  // body — the same ref discipline `readinessRef` already uses so the gate is
  // one law with one construction site.
  const readinessInputRef = useRef<ReadinessInputFor>(() => {
    throw new Error("readiness input builder read before it was defined");
  });
  const applyHealthRef = useRef<(h: IntegrationHealth) => void>(() => {});

  /** Wait for the daemon's bind to actually resolve, bounded.
   *
   *  Shell rendering treats a bind in flight as fine — it is. A launch cannot:
   *  starting a session in a window that owns no port sends the resulting plan
   *  to whichever instance does, and the user watches a card spin over
   *  nothing. Bounded because the opposite failure (a launch stranded behind a
   *  bind that never resolves) is just as bad; on timeout we proceed on
   *  "starting", which is not a blocker. */
  const ensureDaemonReady = useCallback(
    async (timeoutMs = 4000): Promise<DaemonState> => {
      const started = Date.now();
      for (;;) {
        const state = await invoke<DaemonState>("daemon_state").catch(
          // No command (tests, a browser preview) is not a failed bind.
          () => "ready" as DaemonState,
        );
        if (state !== "starting") {
          setDaemonState(state);
          return state;
        }
        if (Date.now() - started > timeoutMs) return "starting";
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    },
    [],
  );

  // THE launch. One impure function behind every door: it spawns the terminal,
  // types `claude --permission-mode plan` with the prompt (the spawn-verified
  // handoff — no timing guess; the write is checked), records the lineage, and
  // sets the pending state the surface renders its card from.
  //
  // The readiness gate here is a BACKSTOP. Surfaces still call `attemptLaunch`
  // themselves so they can order their own steps (render the blocker inside
  // their own island, hold the ⏎ to carry through). This catches the door that
  // forgets — which is exactly how the Drafter shipped with zero preflight.
  const launchPlan = async (req: {
    choice?: BackendChoice;
    /** `run` is "Just run it": the same terminal, handoff and lineage, but a
     *  direct session (`buildRunLaunchCommand`) — the harness-only gate, no
     *  plan claim, no pending plan card. Default `plan`. */
    mode?: "plan" | "run";
    origin: LaunchOrigin;
    background?: boolean;
    prompt: string;
    projectPath: string | null;
    draftId: string | null;
    /** The chat this graduated from, when it graduated from one. Makes the
     *  spawned plan session a CHILD of the conversation in the session tree —
     *  months later, "why did we build this" walks back from the plan to the
     *  talk that produced it. */
    chatId?: string | null;
    /** Extra read grants (`--add-dir`) — the approved plan's hand-off dir. */
    addDirs?: string[];
    /** What the prompt LAKE should hold, when that is not what gets typed.
     *  Only Combine passes it — see the invoke below. */
    recordBody?: string | null;
    /** The human's own words inside `recordBody`, for the lexical index. */
    userText?: string | null;
    restore: LaunchRestore;
  }): Promise<
    | { ok: true; terminalId: string; launchId: string }
    // `blocked` carries the readiness item itself, not just its label: a door
    // that can render the fix where the user is looking should not have to
    // re-derive which fault it was from a sentence.
    | { ok: false; reason: string; blocked?: ReadinessItem; retryable?: boolean }
  > => {
    const trimmed = req.prompt.trim();
    if (!trimmed) return { ok: false, reason: "nothing to launch" };
    const run = req.mode === "run";
    // A run edits files: it never falls back to $HOME the way a plan may.
    if (run && !req.projectPath) return { ok: false, reason: "Pick a project to run this in" };

    // What kind of launch is this? Answered from the workspace registry alone
    // — no probe needed — and it decides both the backend and what has to be
    // probed for, so it comes first.
    const kind =
      projectKind(workspace, req.projectPath) ??
      (req.projectPath
        ? (createdKindsRef.current[req.projectPath] ?? null)
        : null);
    // ONE stored choice for all three doors. The front door owns the picker;
    // the Drafter and the browser's "Send to Redline" launch through this same
    // function, so they agree without each growing a control of their own.
    //
    // An extension launch stays on Claude no matter what is stored: its
    // `--add-dir` grants are read grants under plan mode, and Codex's
    // `--add-dir` is a WRITE grant that contradicts `-s read-only`.
    const choice =
      kind === "extension"
        ? { backend: "claude-code" as const, model: null, effort: null }
        : req.choice ?? backendChoiceRef.current;
    if (run && !runSupported(choice.backend))
      return { ok: false, reason: `"Just run it" isn't available for ${choice.backend} yet` };

    // ── The launch boundary ─────────────────────────────────────────────────
    //
    // Shell rendering never waits for integration health or for the daemon.
    // A launch must. This is the seam where "the shell came up fast" stops
    // being a licence to start a session on unverified ground:
    //
    //   * the probe is scoped to THIS launch (its backend, its target kind),
    //     not to whatever the front door's picker happens to show — the
    //     browser's "Send to Redline" can launch into a different project
    //     than the one on screen;
    //   * it goes through the same shared service, so a launch moments after
    //     boot reuses the post-reveal probe instead of starting a second one;
    //   * the gate is derived from the FRESH payload, not from React state,
    //     which would still hold the pre-await value on this tick.
    //
    // If the probe fails outright, `health` is null and the gate falls back to
    // the last derived readiness — a launch is not refused because a probe
    // errored, only because it answered with a blocker.
    const health = await integrationHealth
      .ensure({ backend: choice.backend, extension: kind === "extension", projectPath: req.projectPath })
      .catch((err) => {
        console.error("integration health failed at launch", err);
        return null;
      });
    if (!health) return { ok: false, reason: "Could not check the selected planning provider. Try again.", retryable: true };
    applyHealthRef.current(health);
    // A window that owns no port captures no plans: the session would run and
    // its plan would land in a different instance. Bounded — a bind that never
    // resolves must not strand the launch either.
    const daemon = await ensureDaemonReady();
    const gate = (run ? attemptRun : attemptLaunch)(
      health
        ? deriveReadiness(
            { ...readinessInputRef.current({
              preflight: health.preflight,
              daemonOk: daemon !== "failed",
              projectPath: req.projectPath,
              backend: choice.backend,
              now: Date.now(),
            }), requireIntegration: true, codexHookInstalled: health.codexHook?.installed },
          )
        : readinessRef.current,
    );
    if (gate.kind === "blocked" && gate.item.fix?.kind === "install-integration") {
      if (await requestSetup(choice.backend, req.projectPath, gate.item.id)) return launchPlan({ ...req, choice });
      return { ok: false, reason: gate.item.label, blocked: gate.item };
    }
    if (gate.kind === "blocked")
      return { ok: false, reason: gate.item.label, blocked: gate.item };

    // An extension-pack target gets the staged ABI/SDK/template dirs granted
    // via --add-dir: the contract it builds against lives outside its cwd.
    // Read from the payload just awaited, so an extension launch can no longer
    // grant nothing because the door's cached probe never asked.
    const addDirs = [
      ...extensionAddDirs(
        kind,
        health?.preflight.extension ?? preflightRef.current?.extension ?? null,
      ),
      ...(req.addDirs ?? []),
    ];
    const launchId = crypto.randomUUID();
    const bins = {
      "claude-code": health.preflight.claude.path,
      codex:
        health?.preflight.codex?.path ??
        preflightRef.current?.codex?.path ??
        null,
      cursor: health?.preflight.providers?.cursor?.path ?? null,
      antigravity: health?.preflight.providers?.antigravity?.path ?? null,
    };
    const cmd = `${
      run
        ? buildRunLaunchCommand(trimmed, req.projectPath, addDirs, choice, bins, launchId)
        : buildPlanLaunchCommand(trimmed, req.projectPath, addDirs, choice, bins, launchId)
    }\r`;
    // The launch runs out of sight: its Agent tab, the door's flight pill
    // and its sidebar row are the ways to it, so a launch never pulls the
    // user off the tab they are on.
    const terminalId = await openTerminal(req.projectPath, true);
    // No terminal means the command was never typed and nothing will ever
    // arrive. Report it — `PendingLaunch.terminalId` is non-nullable precisely
    // so "spinning on a launch that never happened" cannot be constructed.
    if (!terminalId) return { ok: false, reason: "couldn't open a terminal", retryable: true };

    // Polis ledger: record the launched prompt (the plan session doesn't exist
    // yet, so this is the only place its body is first-class). `origin` is
    // ground truth for the lake's `surface`, and a `draftId` makes the eventual
    // plan session a CHILD of that document — the ingest hook links them when
    // the spawned session first fires. The `.catch` is the point: this used to
    // be a bare `void invoke(...)`, so a failed ledger write was 100% silent.
    const startedAt = Date.now();
    const recordError = await invoke("record_plan_launch", {
      launchId,
      markdown: trimmed,
      projectPath: req.projectPath,
      draftId: req.draftId,
      chatId: req.chatId ?? null,
      origin: req.origin,
      // Combine alone records something other than what it typed: the brief
      // is up to 120 KB of concatenated machine-written plans, and a
      // `CorpusRole::User` row is permanently uncompactable. What reaches the
      // lake is the human's typed context plus the source hashes.
      recordBody: req.recordBody ?? null,
      userText: req.userText ?? null,
      // The door's own pick — known here and nowhere else. A launch left on
      // the backend default sends nulls, and the transcript backfill answers
      // instead.
      backend: choice.backend,
      model: choice.model,
      effort: choice.effort,
    }).then(() => null).catch((err: unknown) => String(err));
    if (recordError) return { ok: false, reason: `Could not record the plan launch: ${recordError}`, retryable: true };

    const pending: PendingLaunch = { launchId, chatId: req.chatId ?? undefined, origin: req.origin, prompt: trimmed, startedAt, terminalId, projectPath: req.projectPath, draftId: req.draftId, restore: req.restore };
    // Register before typing: an immediate intercept must be able to match the
    // launch. A run sends no plan, so it registers nothing for an intercept to
    // match and claims no decision window.
    if (!run) launchedPlansRef.current.set(launchId, pending);
    const delivery = await deliverToTerminal(tauriHandoffDeps, terminalId, [{ stage: "launch", data: cmd }]);
    if (!delivery.ok) {
      launchedPlansRef.current.delete(launchId);
      return { ok: false, reason: `Couldn't type the ${run ? "run" : "plan launch"} (${delivery.stage}): ${delivery.reason}`, retryable: delivery.stage === "spawn" };
    }
    // The session exists from here, before any plan row does: the launch
    // registry feeds the sidebar's pending rows.
    noteFlowLaunch({
      type: "launched",
      launch: { launchId, terminalId, prompt: trimmed, startedAt, projectPath: req.projectPath, mode: run ? "run" : "plan", harness: choice.backend === "codex" ? "codex" : "claude", command: cmd },
    });
    // The workbench: the launch is a session from here — a `launch:` set
    // holding its Agent tab, behind the strip, rekeyed to the plan when it
    // arrives. Asked for in the foreground it is a tab of the set on screen
    // (D29: the strip never switches): the door it came through becomes its
    // Agent tab in place, and the plan lands beside it (rekeySession). A
    // background launch gets its set without moving anyone.
    {
      const key = launchKey(launchId);
      wb.dispatch({ type: "ensureDefaults", key, defaults: { agentTerminalId: terminalId } });
      if (!req.background) {
        const agent: PaneInit = { kind: "chat", data: { source: "agent", terminalId, sessionId: null } };
        const { set, tab, panes } = activePanes(wb.getState());
        const door = tab && set && panes.length === 1 && panes[0].kind === "door" && tab.focusedPaneId === panes[0].id ? panes[0] : null;
        if (door) {
          untouchedDoors.current.delete(door.id);
          wb.dispatch({ type: "replacePane", paneId: door.id, pane: agent });
        } else openSessionPane(agent);
      }
    }
    if (run) {
      // A run sends no plan to claim: its Agent tab is its status.
      setLastLaunchProject(req.projectPath!);
      setToast(req.background ? { message: "Run started in a background terminal", placement: "top" } : { message: "Running in its Agent tab", action: { label: "Show", onAction: () => showTerminal(terminalId) } });
      return { ok: true, terminalId, launchId };
    }

    // The displaced launch is NOT repaid. It is still running in its own
    // terminal tile with its own plan on the way; handing its sentence back
    // into the composer would drop a stale prompt on top of the one that just
    // shipped. `pendingLaunch` is a single slot — the older launch's status
    // lives in its tile, one click away.
    setReadinessNow(startedAt);
    if (launchedPlansRef.current.has(launchId)) setPendingLaunch(pending);
    if (req.projectPath) setLastLaunchProject(req.projectPath);
    setToast(req.background ? { message: "Plan started in a background terminal", placement: "top" } : { message: "Planning in its Agent tab", action: { label: "Show", onAction: () => showTerminal(terminalId) } });
    return { ok: true, terminalId, launchId };
  };

  // "Run" on a Localhost card: bring a dev server back without hunting for the
  // command. Same spawn-verified handoff as launchPlan.
  // No `cd` prefix — openSessionTerminal spawns the PTY *in* that directory,
  // and prefixing one would break on a path the shell would need quoted.
  const runDevServer = async (projectPath: string, runCommand: string) => {
    const cmd = runCommand.trim();
    if (!cmd) return;
    suppressTerminalRevealFocus();
        const id = await openTerminal(projectPath);
    if (id) {
      typeIntoTerminal(id, `${cmd}\r`, "Couldn't start the dev server");
    }
    setToast("Starting the dev server in a Terminals tab");
  };

  // "Open" on a Localhost card: bring the browser surface forward with a tab on
  // that URL. Handed to BrowserPane as a nonce-keyed PROP rather than an emitted
  // event — BrowserPane only mounts when the browser surface is selected, so an
  // event fired at selection time would race its own listener's subscription and
  // be dropped.
  const [browserOpenRequest, setBrowserOpenRequest] = useState<{
    url: string;
    nonce: number;
    chat?: { text: string };
    focusBrowseId?: string;
    quiet?: boolean;
    owner?: string | null;
  } | null>(null);
  // Search from the plan, mid-flight: the anchored passage waiting for the
  // browser to report which thread it opened, so the research comment can
  // link to it. One at a time — it is consumed on the very next open.
  const pendingResearchRef = useRef<{
    sessionId: string;
    request: NewCommentRequest;
  } | null>(null);
  const onBrowserOpenConsumed = (browseId: string | null) => {
    setBrowserOpenRequest(null);
    const pending = pendingResearchRef.current;
    pendingResearchRef.current = null;
    if (!pending || !browseId) return;
    void invoke<Comment>("add_comment", {
      sessionId: pending.sessionId,
      request: { ...pending.request, research: { ...pending.request.research!, browseId } },
    }).catch((err) => setToast(`Couldn't link the search to the plan: ${err}`, 6000));
  };
  const openUrlInBrowser = (url: string) => {
    // The page is the session's that asked (a door, a plan, a card).
    setBrowserOpenRequest({ url, nonce: Date.now(), owner: browserOwnerRef.current });
    selectSurface("browser");
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
      guessProjectForPlan(markdown, projectOptions) ??
      folder ??
      drafterProjectPath ??
      lastLaunchProject;
    setFrontDoorText(markdown);
    setFrontDoorProject({ path: initialProject });
    // A plan to launch, so the door's composer.
    setFrontDoorDest("plan");
    setFrontDoorOpen(true);
    setFrontDoorFocus(value => value + 1);
  };

  useEffect(() => {
    const continueConversation = (event: Event) => {
      if (sendPendingRef.current) return;
      const detail = (event as CustomEvent<ContinueRequest>).detail;
      if (!detail?.source?.messageIds.length || !detail.markdown?.trim()) return;
      const folder = sidebarTab.kind === "folder" ? sidebarTab.id : null;
      selectSurface("document");
      setSendError(null);
      setSendConfirm({ markdown: detail.markdown, initialProject: guessProjectForPlan(detail.markdown, projectOptions) ?? folder ?? lastLaunchProject, source: detail.source, destination: detail.destination ?? "drafter" });
    };
    window.addEventListener(CONTINUE_EVENT, continueConversation);
    return () => window.removeEventListener(CONTINUE_EVENT, continueConversation);
  }, [sidebarTab, projectOptions, lastLaunchProject]);

  // Repo confirmed in SendToRedlineDialog: bring the document pane forward and
  // launch the held plan in a terminal scoped to the chosen repo.
  const runContinuation = async ({ markdown, source, destination, project, missionHandoff, harness }: { markdown: string; source?: ContinueRequest["source"]; destination: ContinueDestination; project: string | null; harness?: BackendChoice; missionHandoff?: { missionId: string; handoffId: string; destination: "plan" | "run" } }) => {
    if (sendPendingRef.current || !markdown.trim()) throw new Error("Another continuation is starting; try again in a moment.");
    let handoff = missionHandoff;
    if (destination === "run" && !project) throw new Error("Choose a project to build in.");
    sendPendingRef.current = true; setSendPending(true); setSendError(null);
    let claimToken: string | undefined;
    let preparedDraftId: string | null = null;
    let claimSettled = false;
    try {
      if (source?.conversationKind !== "companion") selectSurface("document");
      if (source) {
        const prepared = await invoke<{ id: string; scopeId: string; draftId: string }>("conversation_prepare_handoff", { request: { ...source, idempotencyKey: await continuationKey(source, markdown, destination), body: markdown, destination } });
        preparedDraftId = prepared.draftId;
        if (destination === "drafter") {
          // The brief is already durable. A receipt failure must neither hide it
          // nor pretend the save failed; retry only the receipt, never the save.
          const receipt = { missionId: prepared.scopeId, workspaceId: prepared.scopeId, op: "deliverHandoff", handoffId: prepared.id, destinationId: prepared.draftId };
          const recordReceipt = () => invoke("mission_foundation", { request: receipt });
          const receiptFailed = (error: unknown) => setToast({ message: `Brief saved; its delivery receipt needs retry: ${String(error)}`, action: { label: "Retry receipt", onAction: () => { void recordReceipt().then(() => setToast(null)).catch(receiptFailed); } } });
          await recordReceipt().catch(receiptFailed);
          setSendConfirm(null); setDrafterDraftId(prepared.draftId); setDrafterShelfOpen(false); selectSurface("drafter");
          return;
        }
        handoff = { missionId: prepared.scopeId, handoffId: prepared.id, destination };
      }
      if (handoff) {
        const claim = await invoke<{ claimed: boolean; claimToken?: string; handoff: { status: string; destinationId?: string; draftId?: string } }>("mission_foundation", { request: { missionId: handoff.missionId, workspaceId: handoff.missionId, op: "claimHandoff", handoffId: handoff.handoffId } });
        if (!claim.claimed || !claim.claimToken) {
          let unavailable: string | null = null;
          if (claim.handoff.status === "delivered" && claim.handoff.destinationId) {
            try {
              const live = await invoke<boolean>("pty_is_live", { id: claim.handoff.destinationId });
              if (!live) throw new Error("The original plan terminal is no longer available.");
              await showRawTerminal(claim.handoff.destinationId); setSendConfirm(null);
              return;
            } catch (error) { unavailable = String(error); }
          }
          setSendError(unavailable ?? `This handoff is already ${claim.handoff.status}; it has not been launched again.`);
          const savedDraftId = preparedDraftId ?? claim.handoff.draftId;
          if (savedDraftId) setToast({ message: "The source brief remains saved.", action: { label: "Open saved brief", onAction: () => { setSendConfirm(null); setDrafterDraftId(savedDraftId); setDrafterShelfOpen(false); selectSurface("drafter"); } } });
          return;
        }
        claimToken = claim.claimToken;
        preparedDraftId ??= claim.handoff.draftId ?? null;
      }
      const result = await launchPlan({
        mode: destination === "run" ? "run" : "plan", choice: harness,
        origin: source ? continuationOrigin(source.conversationKind) : "browser", prompt: markdown, projectPath: project,
        // Preserve the actual saved brief's lineage; unrelated open drafts
        // are never inherited by a direct browser-reply launch.
        draftId: preparedDraftId,
        chatId: source?.conversationKind === "companion" ? source.conversationId : null,
        restore: { kind: "none" },
      });
      if (result.ok) {
        claimSettled = true; setSendConfirm(null);
        if (handoff) {
          const receipt = { missionId: handoff.missionId, workspaceId: handoff.missionId, op: "deliverHandoff", handoffId: handoff.handoffId, destinationId: result.terminalId, claimToken };
          const recordReceipt = () => invoke("mission_foundation", { request: receipt });
          const receiptFailed = (error: unknown) => setToast({ message: `Session started; its delivery receipt needs retry: ${String(error)}`, action: { label: "Retry receipt", onAction: () => { void recordReceipt().then(() => setToast(null)).catch(receiptFailed); } } });
          await recordReceipt().catch(receiptFailed);
        }
      } else {
        if (handoff) {
          await invoke("mission_foundation", { request: { missionId: handoff.missionId, workspaceId: handoff.missionId, op: "releaseHandoff", handoffId: handoff.handoffId, claimToken, retryable: !!result.blocked || !!result.retryable, error: result.reason } });
          claimSettled = true;
        }
        setSendError(`Couldn't launch the plan — ${result.reason}`);
      }
      return result;
    } catch (error) {
      // An unexpected failure after claiming may have crossed the launch
      // boundary. Preserve an uncertain receipt instead of risking a replay.
      if (handoff && claimToken && !claimSettled) await invoke("mission_foundation", { request: { missionId: handoff.missionId, workspaceId: handoff.missionId, op: "releaseHandoff", handoffId: handoff.handoffId, claimToken, retryable: false, error: String(error) } }).catch(() => {});
      setSendError(`${preparedDraftId ? "The brief is saved, but continuation failed" : "Could not save the brief"}: ${String(error)}`);
      throw error;
    } finally { sendPendingRef.current = false; setSendPending(false); }
  };

  const confirmSendToRedline = async (project: string | null) => {
    if (!sendConfirm) return;
    try { await runContinuation({ ...sendConfirm, destination: sendConfirm.destination ?? sendConfirm.missionHandoff?.destination ?? "plan", project }); }
    catch (error) { setSendError(String(error)); }
  };
  const continueChat = async (request: ChatPlanRequest, destination: "plan" | "run") => {
    const { companionId, instruction } = request;
    setChatReceipts(previous => ({ ...previous, [companionId]: { kind: destination, status: "starting", instruction } }));
    try {
      const brief = await prepareCompanionContinuation(companionId, request.messages, instruction, text => {
        let seed = chatHandoffSeeds.current.get(companionId);
        if (!seed || seed.text !== text) {
          seed = { text, id: crypto.randomUUID() };
          chatHandoffSeeds.current.set(companionId, seed);
        }
        return invoke<ContinuationMessage>("companion_handoff_seed", {
          companionId, messageId: seed.id, text, projectPath: request.project?.path ?? null,
        });
      });
      const project = resolveLaunchProject(brief.markdown, request.project, { projectOptions, openFolder: null, lastLaunchProject });
      const result = await runContinuation({ ...brief, destination, project, harness: request.harness });
      setChatReceipts(previous => previous[companionId]?.status === "done" && result?.ok && previous[companionId]?.launchId === result.launchId ? previous : ({ ...previous, [companionId]: result?.ok ? { kind: destination, status: "planning", instruction, terminalId: result.terminalId, launchId: result.launchId } : { kind: destination, status: "error", instruction, error: result && !result.ok ? result.reason : "The brief is saved; its existing launch is already claimed.", blocked: result && !result.ok ? result.blocked : undefined } }));
    } catch (error) { setChatReceipts(previous => ({ ...previous, [companionId]: { kind: destination, status: "error", instruction, error: String(error) } })); }
  };

  const continueChatAsPlan = (request: ChatPlanRequest) => continueChat(request, "plan");
  const continueChatAsRun = (request: ChatPlanRequest) => continueChat(request, "run");

  const queuedChatPlans = useQueuedChatPlans(request => { void continueChatAsPlan(request); }, (request, error) => {
    setChatReceipts(previous => ({ ...previous, [request.companionId]: { kind: "plan", status: "error", instruction: request.instruction, error } }));
    setToast({ message: error, action: { label: "Open chat", onAction: () => openChat(request.companionId) } });
  });

  // Seed the Prompt Drafter with agent-authored markdown and pre-select the
  // repo guessed from the plan text, so the drafter's picker already shows the
  // right project when the user ships it with "Send to Claude Code". Shared by
  // the mission "→ Drafter" and browser "Open in Drafter" paths.
  //
  // Mints a real Bookshelf document and opens it BY ID. The old in-place doc
  // seeding never changed `drafterDraftId`, so it never remounted the editor —
  // it only appeared to work because the body happened to be unmounted when
  // the surface was deselected, and with multiple open documents it breaks
  // outright.
  const openDrafterWithMarkdown = async (markdown: string) => {
    if (!markdown.trim()) return;
    // Grow on the frame of the keypress. The mint and the first persist are a
    // database round-trip and they used to gate this, so the key did nothing at
    // all until they landed; they now happen while the island is growing.
    //
    // NOT a surface switch. The Drafter renders inside the Front Door's island,
    // which is what lets the growth be one continuous element instead of an
    // animation across an unmount.
    //
    // `drafterOpening` keeps the previously-open document from flashing up in
    // the half-second before the new one exists.
    setDrafterOpening(true);
    selectSurface("drafter");
    let json: JSONContent;
    try {
      const { planMarkdownToDoc } = await import("./editor/markdown/parser");
      json = planMarkdownToDoc(markdown).toJSON() as JSONContent;
    } catch {
      // Fall back to a single text block if the parser import/parse fails.
      json = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: markdown }] }],
      } as unknown as JSONContent;
    }
    // No pre-set of `drafterProject` here: the pick belongs to a document, and
    // the document this mints doesn't exist yet. Setting it now would be the
    // same bleed one function up — the new row is created WITH the project, and
    // the load effect tags the pick when it opens.
    const project =
      guessProjectForPlan(markdown, projectOptions) ??
      drafterProjectPath ??
      lastLaunchProject;
    try {
      const id = await newDraft(null, undefined, project);
      await persistDraftDoc(id, markdown, json, project);
      setDrafterShelfOpen(false);
      setDrafterDraftId(id); // the load effect reads it back and remounts
    } catch {
      // The mint failed (DB unavailable?) — fall back to seeding the open
      // document in place so the content is at least on screen. Seed the
      // session cache too, so navigating away doesn't lose the brief.
      const forId = drafterDraftId ?? "";
      drafterSessionCache.current.set(forId, {
        json,
        projectPath: project,
        at: Date.now(),
      });
      setDrafterLoaded({ forId, doc: json });
      // MUST be updated too, and tagged: without it the drafter hangs on
      // "Opening…" (the mount gate compares the pick's `forId` to the active
      // id, and an untagged pick never matches).
      setDrafterProject({ forId, path: project });
    } finally {
      setDrafterOpening(false);
    }
  };

  // "Synthesize → Drafter" from a mission: the orchestrator's brief becomes a
  // drafter doc the user shapes and then ships to Claude Code.
  const seedDrafterFromMission = async (markdown: string) => {
    await openDrafterWithMarkdown(markdown);
    if (!markdown.trim()) return;
    setToast("Mission brief opened in the drafter ✍️");
  };

  // The synthesize handoff listens at APP level, not in MissionChat: the
  // orchestrator keeps synthesizing after the user switches surfaces, and the
  // brief must still open the Drafter when the panel that requested it is
  // long unmounted. The backend owns the pending-synthesize flag and emits
  // this exactly once per synthesis turn.
  const seedDrafterFromMissionRef = useRef(seedDrafterFromMission);
  seedDrafterFromMissionRef.current = seedDrafterFromMission;
  useEffect(() => {
    const p = listen<{ missionId: string; body: string; draftId?: string; handoffId?: string }>(
      "mission-synthesize-done",
      (e) => {
        if (e.payload.draftId) {
          setDrafterDraftId(e.payload.draftId);
          setDrafterShelfOpen(false);
          selectSurface("drafter");
          if (e.payload.handoffId) void invoke("mission_foundation", { request: { missionId: e.payload.missionId, workspaceId: e.payload.missionId, op: "deliverHandoff", handoffId: e.payload.handoffId, destinationId: e.payload.draftId } }).catch((error) => setToast(`Brief saved; delivery needs retry: ${String(error)}`));
        } else void seedDrafterFromMissionRef.current(e.payload.body);
      },
    );
    return () => {
      void p.then(dropListener);
    };
  }, []);

  // "Open in Drafter" from a browser page-discussion reply — same seeding, with
  // the target repo pre-guessed, so the user reviews + picks the repo there.
  const sendBrowserToDrafter = async (markdown: string) => {
    await openDrafterWithMarkdown(markdown);
    if (!markdown.trim()) return;
    setToast("Reply opened in the drafter ✍️");
  };

  // Fallback for a Claude running in a terminal Redline doesn't own: copy the
  // resume command so the user can paste it into their own terminal.
  const copyRestoreCommand = async () => {
    if (!session) return;
    // The same gate as the embedded path. A command that can't return the plan
    // is no better on the clipboard than in Redline's own terminal — worse, in
    // fact: it fails in a shell where nothing is watching for the answer.
    const restoreProbe = await checkRestoreHealth();
    if (!restoreProbe) return;
    // Same one-shot arming as restorePlanSession, and awaited for the same
    // reason: the reviewer can paste the moment the clipboard is written, and
    // both one-shots (the "vN restored" label, and the resumed session's first
    // prompt getting the hidden protocol) have to be in place before the
    // command can run.
    try {
      await invoke("arm_restore", { sessionId: session.sessionId });
    } catch (e) {
      console.error("arm_restore failed", e);
    }
    const target = await resolveResumeCwd(
      session.sessionId,
      session.projectPath,
      restoreDecision.harness,
    );
    void navigator.clipboard?.writeText(
      buildResumeCommand(
        session.sessionId,
        new Date(),
        target.cwd,
        rescindedIds.has(session.sessionId),
        target.primed,
        {
          backend: restoreDecision.harness,
          claudeBin: restoreProbe.claude.path,
          codexBin: restoreProbe.codex?.path ?? null,
        cursorBin: restoreProbe.providers?.cursor?.path ?? null,
        antigravityBin: restoreProbe.providers?.antigravity?.path ?? null,
        model: session.model,
        effort: session.effort,
        },
      ),
    );
    const note = restoreCopiedNote(restoreDecision, target);
    setToast(note.message, note.ms);
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
    setToast(`Saved ${name}`, 3500);
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
    // A press on the banner, which rises over the door: a trip the user
    // asked for, so the door and its card step aside for the plan.
    tripDoor();
    selectSurfaceRef.current("document");
    selectSessions();
    setActiveId(dw.sessionId);
    void loadSession(dw.sessionId);
    setDecisionWindow(null);
  };

  const approveFromDecision = async () => {
    const dw = decisionWindow;
    if (!dw) return;
    try {
      await invoke("approve_plan", { sessionId: dw.sessionId });
      setToast("Plan approved", 3500);
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
    setToast("Resolve the agent suggestion on this block first", 3000);
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
  // closures would defeat that by minting a new function every render.
  const commentCallbacks = useStableHandlers({
    // Always-set (never toggle-to-null): re-clicking a card re-centers and
    // re-flashes its highlight instead of silently clearing the focus.
    onSelect: focusComment,
    onDelete: deleteComment,
    onUpdate: updateComment,
    onAccept: acceptResolution,
    onAcceptSuggestion: acceptAgentSuggestion,
    onReopen: reopenResolution,
    onPromote: promoteToChange,
  });
  // Stable so PlanEditor / HistoricalRevisionView don't re-bind their highlight
  // click handler on every App render (notably ~60×/s during a divider drag).
  const handleHighlightClick = focusComment;

  // Installs both pieces of the Redline integration. The hook (a JSON merge
  // into the user's settings.json) and the skill (a whole-file write) have
  // independent failure modes — install each in its own try/catch so one
  // failing still installs the other. Failures render inline in the setup
  // modal (which is unskippable, so it must own its error display); full
  // success advances it to the post-install explainer.
  //
  // `showExplainer` is false when the front door's readiness strip calls this
  // as a RECOVERY (the hook was removed after a successful first run). That
  // path must not take the screen over with a post-install explainer the user
  // has already read once — it reports through the ordinary toast instead.
  const installIntegration = async (showExplainer = true, backend: Backend = frontDoorBackend.backend) => {
    if (installBusyRef.current) return false;
    installBusyRef.current = true; setInstallBusy(true); setInstallError(null);
    try {
      if (backend === "codex" && !preflight?.codex?.usable) {
        setInstallProgress("Installing the official Codex CLI…");
        await invoke("install_codex_cli");
      }
      const result = await repairIntegration(backend,
        step => invoke(step.command, step.args),
        async () => {
          integrationHealth.invalidate();
          const health = await integrationHealth.refresh({ backend, extension: false, projectPath: setupProject });
          applyHealthRef.current(health);
          return health.preflight;
        }, setInstallProgress);
      if (!result.verified) { setInstallError(result.errors.join("\n")); return false; }
      const continuation = setupContinuation.current;
      setupContinuation.current = null;
      if (continuation) { setSetupBackend(null); continuation(true); }
      else if (showExplainer) setSetupPhase("done");
      return true;
    } catch (error) {
      setInstallError(String(error));
      return false;
    } finally {
      installBusyRef.current = false; setInstallBusy(false); setInstallProgress(null);
    }
  };

  // A native child webview paints on top of all React DOM, so when a
  // full-pane overlay is up the browser must be hidden underneath it. Mirrors
  // the setup-modal / tour gating used in the JSX below.
  // The first-run modal. `integrationReady` leads deliberately: the reason
  // the modal is withheld is that the probe has not answered yet — not that
  // a variable happens to be null. Withholding is the whole point:
  // integration health resolves AFTER the reveal, so without this the modal
  // would flash in the beat before the answer arrives. It shows by itself
  // only on a true first run — nothing reviewed on this machine yet and the
  // dialog never set aside — and otherwise only when asked for
  // (`setupBackend`: a blocked ⏎, the composer's fix-it chip).
  const selectedSetupBackend = setupBackend ?? frontDoorBackend.backend;
  const firstRun = !setupDismissed && !planEverArrived && summaries.length === 0;
  const setupModalActive = !setupReviewInTerminal && (!!setupBackend || integrationReady &&
    (setupPhase === "done" || (firstRun && integrationNeedsRepair(selectedSetupBackend, preflight))));
  const dismissSetup = () => {
    if (installBusyRef.current) return;
    // "Later" on a skills update is an answer: remembered until the app's next
    // launch, and the send that raised the dialog goes on with the installed
    // skills (its gate re-derives with the deferral and passes).
    const skillsOnly = setupReason === "skill-stale" && setupPhase === "setup";
    if (skillsOnly) { deferSkillUpdate(selectedSetupBackend); setSkillDeferTick((n) => n + 1); }
    setSetupDismissed(true); setSetupPhase("setup"); setSetupBackend(null); setSetupReason(null); setInstallError(null);
    const continuation = setupContinuation.current; setupContinuation.current = null; continuation?.(skillsOnly);
  };
  // First-run auto-start waits for the doors to finish — the tour's spotlight
  // is measured against plate geometry, and a coachmark pinned to a plate
  // that is still travelling points at nothing. This is the one legitimate
  // reason to read the choreography: it is about where things ARE, not about
  // when the user may act.
  const tourActive =
    (tourOpen || (!onboardingDone && !setupModalActive && !bootAnimating));
  // The open door hides the page.
  const browserOverlayActive =
    frontDoorOpen ||
    !!sendConfirm ||
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
  // draggable over the browser, exactly as they are over the document. (The
  // stage's own dividers and a tab dragged over the stage are resize
  // sessions the browser pane handles itself: picture first, then hidden.)
  // A curtained side pane paints over the doc column in React DOM — which the
  // native webview would ignore (it always paints above). Hide the browser
  // while any curtain is up, exactly like under modals and drags.
  // And hidden while the boot doors are mid-flight: the native webview
  // ignores DOM transforms and would paint over the moving plates.
  // Flow's terminal wall covers the plate in DOM without changing the
  // browser slot's rect, so the only fix is hiding the native webview — it
  // would otherwise paint above the wall.
  const browserVisible =
    browserOpen &&
    !bootAnimating &&
    !browserOverlayActive &&
    !sidebarDragging &&
    !isDragging &&
    !liveFlags.curtain &&
    // A fullscreen rail covers the stage; the native webview paints above
    // React DOM and would show through it.
    !paneFullscreen;

  // Close the terminal a launch is running in and the launch is over: the PTY
  // dies with the tile, so no plan is ever coming. Without this the Planning
  // card spins forever over nothing — the precise failure this surface was
  // built to eliminate, reintroduced one layer up.
  //
  // `liveTermIds` is null until the dock first reports, so a launch can never
  // be cancelled by the absence of a report — and, per `launchLiveness`, not by
  // the FIRST report either, which is always the pre-launch one: the dock's id
  // reporter is a child effect that queues its new list in the same flush this
  // one runs in. A terminal is dead only once the dock vouched for it and a
  // later report dropped it.
  //
  // Keyed on `startedAt` so one launch's confirmation can never vouch for the
  // next; the object identity changes on `lineageError` alone, which must not
  // reset it.
  const launchConfirmedRef = useRef<{ startedAt: number; confirmed: boolean } | null>(
    null,
  );
  useEffect(() => {
    const died = (
      f: { startedAt: number; terminalId: string } | null,
      ref: { current: { startedAt: number; confirmed: boolean } | null },
    ): boolean => {
      if (!f) {
        ref.current = null;
        return false;
      }
      if (ref.current?.startedAt !== f.startedAt) {
        ref.current = { startedAt: f.startedAt, confirmed: false };
      }
      const seen = ref.current;
      const live = launchLiveness(f.terminalId, liveTermIds, seen.confirmed);
      seen.confirmed = live.confirmed;
      return !live.alive;
    };
    const dead: PendingLaunch[] = [];
    // Its agent gone before the plan (the launch reads stopped) is the same
    // end as its terminal closing: the flight pill stops counting (LAST2).
    const stopped = !!pendingLaunch && flowLaunches.some((l) => l.terminalId === pendingLaunch.terminalId && l.stopped);
    if (died(pendingLaunch, launchConfirmedRef) || stopped) {
      setPendingLaunch(null);
      dead.push(pendingLaunch!);
    }
    // Give the sentence back, for the door that took one — the ONE place the
    // pay-back fires. This is the involuntary case: the launch did not survive
    // and nobody chose that, so the composer is refilled ready to re-send. The
    // Drafter's document never left the screen, so its restore is `none`.
    for (const p of dead) repayPending(p, stopped ? "Claude stopped before its plan arrived" : "Launch cancelled — that terminal was closed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTermIds, pendingLaunch, flowLaunches]);
  // Flow's launches obey the same law: one whose terminal closed is gone
  // from the stage and the sidebar, since no plan can come from a dead PTY.
  useEffect(() => {
    noteFlowLaunch({ type: "terminals", live: liveTermIds });
  }, [liveTermIds, noteFlowLaunch]);
  // A launch whose agent dies before its plan (killed, crashed, quit) leaves
  // its shell alive, so the rule above never fires: it read "launching"
  // forever, the flight pill kept counting, and its row could not go
  // (LAST2). The wall's fleet poll keeps sampling a waiting launch's
  // terminal (`watchIds`) and reports each sample (`onProcs`); the shell
  // back in front is the launch stopped (`procs`).
  const waitingLaunchIds = useStableValue(useMemo(() => flowLaunches.filter((l) => !l.stopped).map((l) => l.terminalId), [flowLaunches]));
  // The same samples say which ports each terminal's processes listen on:
  // a dev server under a session's own terminal wears a chip on that
  // session's row, and only there (D44). Kept by value, so a sample that
  // moved no port renders nothing.
  const [termPorts, setTermPorts] = useState<ReadonlyMap<string, readonly number[]>>(() => new Map());
  const noteLaunchProcs = useCallback(
    (rows: readonly (LaunchProc & { ports?: readonly number[] })[], at: number) => {
      noteFlowLaunch({ type: "procs", rows, at });
      setTermPorts((prev) => {
        const next = new Map(rows.filter((r) => Array.isArray(r.ports) && r.ports.length > 0).map((r) => [r.id, r.ports!] as const));
        const same = next.size === prev.size && [...next].every(([id, ports]) => prev.get(id)?.join(",") === ports.join(","));
        return same ? prev : next;
      });
    },
    [noteFlowLaunch],
  );
  // Retry on a launch stopped before its plan: its own command, typed again
  // into the same terminal (the same launch, so the plan still finds its
  // set and its row).
  const retryLaunch = async (terminalId: string) => {
    const launch = flowLaunchesRef.current.find((l) => l.terminalId === terminalId);
    if (!launch?.command) return;
    noteFlowLaunch({ type: "retried", terminalId, at: Date.now() });
    const delivery = await deliverToTerminal(tauriHandoffDeps, terminalId, [{ stage: "launch", data: launch.command }]);
    if (!delivery.ok) setToast({ message: `Couldn't start it again: ${delivery.reason}`, tone: "warning" });
  };
  // "Remove launch": the row goes, and its set stops being the one on
  // screen. Its terminal stays, a plain shell, for whoever wants it.
  const removeLaunch = (terminalId: string) => {
    const launch = flowLaunchesRef.current.find((l) => l.terminalId === terminalId);
    noteFlowLaunch({ type: "removed", terminalId });
    if (pendingLaunchRef.current?.terminalId === terminalId) setPendingLaunch(null);
    if (launch && wb.getState().activeKey === launchKey(launch.launchId)) wb.dispatch({ type: "selectSession", key: HOME_KEY });
  };

  // The `/hooks` nudge is the only time-based item: it appears once a launch
  // has waited HOOK_SILENCE_MS for its plan. One timer for that moment — not
  // a 5 s clock re-rendering the whole app while a launch is pending.
  const [readinessNow, setReadinessNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pendingLaunch) return;
    const due = pendingLaunch.startedAt + HOOK_SILENCE_MS + 50 - Date.now();
    const t = setTimeout(() => setReadinessNow(Date.now()), Math.max(0, due));
    return () => clearTimeout(t);
  }, [pendingLaunch]);

  // Where ⏎ would launch, as the composer last reported it: the composer
  // resolves it from its own sentence, so this changes when the target does
  // and never per keystroke. A launch resolves afresh from the text it sends.
  const [frontDoorResolvedProject, setFrontDoorResolvedProject] = useState<string | null>(null);
  const frontDoorOpenFolder = sidebarTab.kind === "folder" ? sidebarTab.id : null;
  const resolveFrontDoorProject = (text: string) =>
    resolveLaunchProject(text, frontDoorProject, {
      projectOptions,
      openFolder: frontDoorOpenFolder,
      lastLaunchProject,
    });

  // ── Integration health ────────────────────────────────────────────────────
  //
  // "Will a launch actually work on this machine" — hooks, skills, binaries,
  // curl. Everything here can spawn a child process, and none of it decides
  // what renders, so it runs AFTER the first actionable frame. It used to sit
  // in the boot `Promise.all`, which made the front door wait on the slowest
  // probe on the machine before it would take a keystroke.
  //
  // The question is scoped to the launch that ⏎ would actually make: a Claude
  // user's machine is never asked about codex, and only an extension target
  // pays for `rustup target list`. `lib/integrationHealth` shares one
  // in-flight probe across boot, this effect, the focus refresh and the launch
  // gate, so four askers still produce one round trip.
  const healthQuery = useMemo<HealthQuery>(
    () => ({
      backend:
        projectKind(workspace, frontDoorResolvedProject) === "extension"
          ? // An extension launch is forced back onto Claude at the door (its
            // `--add-dir` grants have no read-only Codex analogue), so asking
            // about codex here would probe for a launch that cannot happen.
            "claude-code"
          : frontDoorBackend.backend,
      extension:
        projectKind(workspace, frontDoorResolvedProject) === "extension",
    }),
    [workspace, frontDoorResolvedProject, frontDoorBackend.backend],
  );
  const hookConflicts = useHookConflicts(healthQuery.backend, frontDoorResolvedProject, shellReady);
  const applyHealth = useCallback((health: IntegrationHealth) => {
    setPreflight(health.preflight);
    setCodexHookStatus(health.codexHook);
    markOnce("rl:integration-ready");
  }, []);

  // The probe itself: after the shell is actionable, at idle. `mode` is part
  // of the answer, so a mode change re-probes; so does a change of launch
  // target, because that changes the QUESTION (a different backend, or an
  // extension's toolchain).
  useEffect(() => {
    if (!shellReady) return;
    let cancelled = false;
    const run = () => {
      void integrationHealth
        .ensure(healthQuery)
        .then((health) => {
          if (cancelled) return;
          applyHealth(health);
          // Drift is repaired through the same verified setup operation for
          // every provider; no parallel background writer races the dialog.
        })
        .catch((err) => console.error("integration health failed", err));
    };
    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (!idle) {
      const t = window.setTimeout(run, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    }
    const id = idle(run, { timeout: 1500 });
    return () => {
      cancelled = true;
      (
        window as Window & { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback?.(id);
    };
  }, [shellReady, mode, healthQuery, applyHealth]);

  // The things measured here — a hook file, a binary, curl — are edited
  // OUTSIDE Redline while it sits in the background, so coming back is the
  // moment to look again. The service's freshness window does the throttling
  // that an ad-hoc timestamp ref used to.
  useEffect(() => {
    const onFocus = () => {
      void hookConflicts.refresh();
      void integrationHealth
        .ensure(healthQuery)
        .then(applyHealth)
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [healthQuery, applyHealth, hookConflicts.refresh]);

  // ONE construction site for the readiness derivation's input.
  //
  // It has two callers with different arguments: the strip (the front door's
  // current target, from React state) and the launch gate (THIS launch's
  // target, from a payload just awaited — React state still holds the
  // pre-await value on that tick). They must not drift, so the parts that
  // depend on the launch are parameters and everything else is closed over.
  const buildReadinessInput = useCallback<ReadinessInputFor>(
    ({ preflight: pf, daemonOk, projectPath, backend, now }) => {
      const isExtension = projectKind(workspace, projectPath) === "extension";
      return {
        requireIntegration: true,
        // The live `mode` beats the probe's snapshot: `mode-changed` lands
        // long before the re-probe it triggers resolves.
        preflight: pf ? { ...pf, mode } : null,
        daemonBound: daemonOk,
        hookModalActive: setupModalActive,
        planEverArrived: planEverArrived || summaries.length > 0,
        pendingSince: pendingLaunch?.startedAt ?? null,
        now,
        projectCount: projectOptions.length,
        // The toolchain item fires only when the launch would actually land
        // in an extension-pack project.
        targetIsExtension: isExtension,
        // …and the codex items only when it would actually launch on Codex.
        // An extension target is forced back onto Claude at the door (its
        // `--add-dir` grants have no read-only Codex analogue), so it is NOT
        // a codex launch however the picker is set.
        targetIsCodex: backend === "codex" && !isExtension,
        targetBackend: isExtension ? "claude-code" : backend,
        targetModel: backendChoiceRef.current.model,
        codexHookInstalled: codexHookStatus?.installed,
        // Read at call time, not closed over: the send that "Later" resumes
        // re-derives its gate on the same tick the deferral is recorded.
        skillUpdateDeferred: skillUpdateDeferred(isExtension ? "claude-code" : backend),
      };
    },
    [
      mode,
      setupModalActive,
      planEverArrived,
      summaries.length,
      pendingLaunch,
      projectOptions.length,
      workspace,
      codexHookStatus?.installed,
    ],
  );
  readinessInputRef.current = buildReadinessInput;
  applyHealthRef.current = applyHealth;

  const readiness = useMemo(
    () =>
      deriveReadiness(
        buildReadinessInput({
          preflight,
          daemonOk: daemonBound,
          projectPath: frontDoorResolvedProject,
          backend: frontDoorBackend.backend,
          now: readinessNow,
        }),
      ),
    [
      buildReadinessInput,
      skillDeferTick,
      preflight,
      daemonBound,
      frontDoorResolvedProject,
      frontDoorBackend.backend,
      readinessNow,
    ],
  );
  // `launchPlan`'s backstop gate reads this at call time, from a definition
  // that sits above it in the body.
  const readinessRef = useRef(readiness);
  readinessRef.current = readiness;

  // Pills, filtered against the session list as it is NOW. Persistence keeps a
  // combination across a restart; this keeps it honest — a plan deleted in the
  // meantime is not something the launch can still merge.
  const frontDoorCombine = useMemo(
    () =>
      frontDoorCombineRaw.filter((c) =>
        summaries.some((s) => s.sessionId === c.sessionId),
      ),
    [frontDoorCombineRaw, summaries],
  );

  // Re-preview whenever the set changes — seeded from the sidebar, and again
  // after every removal, since the warnings and the size refusal are both
  // properties of the SET, not of any one pill.
  useEffect(() => {
    if (frontDoorCombine.length === 0) {
      setCombinePreview(null);
      return;
    }
    let alive = true;
    void invoke<CombinePreview>("combine_preview", {
      sessionIds: frontDoorCombine.map((c) => c.sessionId),
    })
      .then((p) => {
        if (alive) setCombinePreview(p);
      })
      .catch((err) => {
        console.error("combine_preview failed", err);
        if (alive) setCombinePreview(null);
      });
    return () => {
      alive = false;
    };
  }, [frontDoorCombine]);

  // The sidebar's Combine picker landing at the front door. Does exactly what
  // "＋ Plan a build" does — clears the selection so the door is on screen —
  // and seeds the pills; the composer there becomes the place to add context.
  const beginCombine = async (sessionIds: string[]) => {
    let preview: CombinePreview;
    try {
      preview = await invoke<CombinePreview>("combine_preview", { sessionIds });
    } catch (err) {
      setToast(`Couldn't read those plans — ${String(err)}`, 6000);
      return;
    }
    // The same door "＋ Plan a build" opens — surface, tab and viewed version
    // included, not just a cleared selection.
    openFrontDoorRef.current();
    setFrontDoorCombine(preview.sources);
    setCombinePreview(preview);
    // Seed the project as an EXPLICIT pick, never null: `ProjectChoice`'s
    // wrapper exists precisely because null means "re-guess from the prompt
    // text on every keystroke", and left null `guessProjectForPlan` would
    // drift the target away as the user types their instruction.
    if (preview.defaultProjectPath) {
      setFrontDoorProject({ path: preview.defaultProjectPath });
    }
  };

  // ⏎ with plans pilled. The brief is composed at THIS moment, not at preview
  // time, so it reflects any revision that landed in between.
  const launchCombine = async (projectOverride?: string) => {
    const pills = frontDoorCombine;
    if (pills.length === 0) return;
    const text = getFrontDoorText();
    const instruction = text.trim();
    const sessionIds = pills.map((c) => c.sessionId);
    let composed: CombineBrief;
    try {
      composed = await invoke<CombineBrief>("combine_brief", {
        sessionIds,
        instruction,
      });
    } catch (err) {
      // The oversize refusal arrives here too — it is an Err, deliberately,
      // because a brief that cannot be carried whole must never be carried at
      // all, and a confident merge of half a plan is the worst outcome here.
      setFrontDoorRefusal((prev) => ({
        item: null,
        reason: String(err).replace(/^Error:\s*/, ""),
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      return;
    }
    const project = projectOverride ?? resolveFrontDoorProject(text);
    const r = await launchPlan({
      origin: "combine",
      prompt: composed.brief,
      recordBody: composed.record,
      userText: instruction || null,
      projectPath: project,
      draftId: null,
      chatId: null,
      restore: {
        kind: "composer",
        text,
        attachments: frontDoorAttachments,
        combine: pills,
      },
    });
    if (!r.ok) {
      setToast(`Couldn't launch the combination — ${r.reason}`, 6000);
      setFrontDoorRefusal((prev) => ({
        item: r.blocked ?? null,
        reason: r.blocked ? null : r.reason,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      return;
    }
    // (The `plan_combine` journal breadcrumb is written Rust-side by
    // `combine_brief`, where the composition actually happens.)
    setFrontDoorText("");
    setFrontDoorAttachments([]);
    setFrontDoorCombine([]);
    setCombinePreview(null);
    return r.launchId;
  };

  // ── What the island attaches ───────────────────────────────────────────
  // Two keys, for two questions. The chips are about WHAT is on screen, so
  // their presses reset whenever that changes — a plan arriving included.
  // The door and the card close only when the user goes somewhere — another
  // surface, or a place on this one they asked for (`doorTrip`): a plan
  // landing selects itself on every surface, and that must not shut a door
  // someone is typing in. The draft id only names a place while the Drafter
  // is showing. Off it, the id still changes — a first launch mints one in an
  // effect — and that must not read as anything at all.
  const islandSurfaceKey = `${stageSurface}:${activeId ?? ""}:${stageSurface === "drafter" ? drafterDraftId ?? "" : ""}`;
  const doorNavKey = `${stageSurface}:${stageSurface === "drafter" ? drafterDraftId ?? "" : ""}:${doorTrip}`;
  const contextChips = surfaceChips(activeSurface, {
    page: browserIslandPage,
    tasks: !!browserDock.cartId,
    file: plateMode === "file" ? activeFile : null,
    draft: !!drafterDraftId,
    diff: codeReview.repo && codeReview.diff ? { repo: codeReview.repo } : null,
  });
  // Reads every pressed chip's source at the moment something is sent — one
  // block per chip, so a caller can tell an unchanged block from a new one.
  // A source that fails is left out rather than failing the send, and so is
  // everything when the builders themselves can't load. Never rejects.
  const gatherContext = async (destination: LaunchDestination): Promise<ContextBlock[]> => {
    const pressed = visibleChips(contextChips, destination).filter((chip) => isChipPressed(chip, chipPresses, islandSurfaceKey));
    if (pressed.length === 0) return [];
    const builders = await import("./lib/contextBlocks").catch(() => null);
    if (!builders) return [];
    const { diffBlock, draftBlock, fileBlock, pageBlock, taskListBlock } = builders;
    const read = async (id: ContextBlock["id"]): Promise<ContextBlock | null> => {
      switch (id) {
        case "page": {
          const page = browserIslandPage;
          if (!page) return null;
          const selection = await invoke<string>("browser_snapshot", { label: page.label })
            .then((raw) => { const value = JSON.parse(raw); return typeof value.selection === "string" ? value.selection : ""; })
            .catch(() => "");
          return pageBlock({ ...page, selection });
        }
        case "tasks": {
          const [view, { renderListMarkdown }] = await Promise.all([
            invoke<import("./types").BrowseListView | null>("browse_list_get", { browseId: browserDock.cartId }),
            import("./lib/browseList"),
          ]);
          return view ? taskListBlock(renderListMarkdown(view.list, view.items)) : null;
        }
        case "file":
          return activeFile ? fileBlock(activeFile) : null;
        case "draft": {
          // Live first: the mirror is debounce-lagged, the database more so.
          const markdown = getDrafterLiveMarkdown() || drafterMarkdown || (drafterDraftId ? (await loadDraftDoc(drafterDraftId)).docMarkdown : "");
          return markdown.trim() ? draftBlock(markdown) : null;
        }
        case "diff":
          return codeReview.repo && codeReview.diff
            ? diffBlock({ repo: codeReview.repo, source: codeReview.source, base: codeReview.base, sha: codeReview.sha, files: codeReview.diff, annotations: codeReview.annotations, questions: codeReview.questions })
            : null;
      }
    };
    const blocks = await Promise.all(pressed.map((chip) => read(chip.id).catch(() => null)));
    return blocks.filter((block): block is ContextBlock => block !== null);
  };

  const launchFromFrontDoor = async (projectOverride?: string) => {
    // Plans pilled → this is a combination, and the composer's text is context
    // on top of them rather than the thing being launched. The plans are its
    // context, so the chips sit this one out.
    if (frontDoorCombine.length > 0) {
      const launchId = await launchCombine(projectOverride);
      // Launched from the open door, it is handed off into like any plan.
      if (launchId && frontDoorOpenRef.current) doorLaunchRef.current = launchId;
      noteDoorLaunchTab(launchId);
      return;
    }
    const text = getFrontDoorText(), attachments = frontDoorAttachments;
    const prompt = composePrompt(text, attachments);
    if (!prompt || frontDoorLaunchingRef.current) return;
    // From the browser the session starts in the background: the page stays
    // up, and the door's flight pill is how you go and watch it.
    const browser = stageSurface === "browser";
    const project = projectOverride ?? resolveFrontDoorProject(text);
    frontDoorLaunchingRef.current = true;
    try {
      const r = await launchPlan({
        mode: "plan",
        origin: browser ? "browser-island" : "front-door",
        background: browser,
        prompt: withContext(prompt, await gatherContext("plan")),
        projectPath: project,
        // The front door has no document, and inheriting the active Drafter's id
        // would file this plan under an unrelated draft.
        draftId: null,
        // It owes the sentence back: the composer clears because the text MOVED
        // into the card. The sentence alone — the chips are still pressed.
        restore: { kind: "composer", text, attachments },
      });
      if (!r.ok) {
        // At the top on the browser, where the native page would cover a
        // toast in the corner.
        const message = `Couldn't launch the plan — ${r.reason}`;
        setToast(browser ? { message, placement: "top" } : message, 6000);
        // And say it INSIDE the island. A toast in the corner is easy to miss
        // when your eyes are on the sentence you just pressed ⏎ on — which is
        // the whole "the text just sits there" report — and it carries no fix
        // button. This lands the blocker where the door's own gate already puts
        // one, and nudges the island either way.
        setFrontDoorRefusal((prev) => ({
          item: r.blocked ?? null,
          reason: r.blocked ? null : r.reason,
          nonce: (prev?.nonce ?? 0) + 1,
        }));
        return;
      }
      // The prompt now lives on the Planning card; a stale copy left in the
      // composer would relaunch on the next ⏎.
      setFrontDoorText("");
      setFrontDoorAttachments([]);
      // A plan launched from the open door: the door shows it in place, and
      // hands off into the plan when it lands (`doorLaunchRef`).
      if (frontDoorOpenRef.current) doorLaunchRef.current = r.launchId;
      noteDoorLaunchTab(r.launchId);
      announceDoor("Plan launched. Redline is planning it in the terminal.");
    } finally {
      frontDoorLaunchingRef.current = false;
    }
  };

  // The Front Door's island opening into the Drafter's page.
  //
  // Two things made this a route change instead of an expansion. First, it
  // awaited the mint AND the first persist before `selectSurface` ever ran — so
  // the key did nothing for a database round-trip and then the surface
  // hard-cut. Second, even after the cut there was no relationship between the
  // glass slab you had been typing in and the sheet that replaced it.
  //
  // Now: measure the island, switch on the same frame, and let one slab travel
  // from the island's box to the page's box while the mint happens behind it.
  //
  // The attached context lands in the document below a rule, so it reads as
  // what the draft is about rather than as part of what you wrote.
  const drafterFromFrontDoor = () => {
    const prompt = composePrompt(getFrontDoorText(), frontDoorAttachments);
    if (!prompt || frontDoorLaunchingRef.current) return;
    // Measured HERE, synchronously, while the island is still on screen — one
    // render later it is gone. This is the box the Drafter springs out of:
    // the door's composer (a chat's in the dock is not the one sending).
    const from = boxOf(".rl-frontdoor-focus[data-visible='true'] .rl-fd-island");
    frontDoorLaunchingRef.current = true;
    // Everything else lands in ONE batch once the context is read, so the
    // card never shows a cleared composer while the Drafter is on its way.
    void gatherContext("drafter").then((blocks) => {
      setSwapFrom(from);
      setQuietOpen(true);
      void openDrafterWithMarkdown(withContext(prompt, blocks, { rule: true }));
      setFrontDoorOpen(false);
      setFrontDoorText("");
      setFrontDoorAttachments([]);
    }).finally(() => { frontDoorLaunchingRef.current = false; });
  };

  // The Front Door's composer opening into a CHAT, inside the room: the
  // sentence you were typing becomes the first turn of the thread around it.
  //
  // The mint is awaited, but nothing waits on the await: `chatOpening` holds
  // the composer back for the round-trip rather than letting the previous
  // conversation flash up in the half-second before the new one exists.
  // The chat room's agent is a warm `claude` (companion_warm.rs). Spawn it
  // when the Chat destination is picked, before the first ⏎, so turn one
  // skips the CLI boot; the room's first turn adopts it. Claude only; Codex
  // stays per-turn. ONE cwd for the pre-warm and the room, or they never match.
  const chatCwd = activeSurface.projectPath ?? (sidebarTab.kind === "folder" ? sidebarTab.id : null);
  const chatPrewarmKey =
    doorVisible && frontDoorDest === "chat" && frontDoorBackend.backend === "claude-code"
      ? JSON.stringify([chatCwd, frontDoorBackend])
      : null;
  useEffect(() => {
    if (!chatPrewarmKey) return;
    void invoke("companion_prewarm", { companionId: null, cwd: chatCwd, harness: frontDoorBackend }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPrewarmKey]);

  // A chat's attachments travel out of band, so the bubble shows only what was
  // typed, and once per version: what each chat has already been handed is
  // remembered by block, and only a new or changed block goes again — with
  // every pressed block alongside, which the backend uses for a send that
  // starts a fresh CLI session (a rotation). The room runs on the door's
  // harness, so a provider switch there starts the record over. Every send is
  // recorded, blocks or not — see `forgetSent`.
  const chatContextSent = useRef(new Map<string, SentContext>());
  const chatAttachment = async (companionId: string, blocks: ContextBlock[]): Promise<ChatAttachment | null> => {
    const builders = await import("./lib/contextBlocks").catch(() => null);
    return builders ? builders.unsentAttachment(chatContextSent.current, companionId, frontDoorBackend.backend, blocks) : null;
  };

  const chatFromFrontDoor = async () => {
    if (chatOpening || frontDoorLaunchingRef.current || (chatSeed && chatSeed.autoSend !== false)) return;
    const text = getFrontDoorText();
    const prompt = composePrompt(text, frontDoorAttachments);
    if (!prompt) return;
    frontDoorLaunchingRef.current = true;
    setChatOpening(true);
    // The door GROWS into the chat in place — the composer you were typing in
    // is the bottom of the thread you are now inside — and `selectSurface` is
    // deliberately not called, because nothing is being navigated away from.
    // A plan launched from it earlier then lands as any other would.
    doorLaunchRef.current = null;
    try {
      // The provisional title is the opening sentence, trimmed to 80 by
      // `companion_create`. It is a placeholder, not a name: the backend
      // replaces it with a real one after the first reply lands, unless the
      // user renames it themselves first. The chips are read alongside the
      // mint, as the sentence leaves the composer.
      const [chat, blocks] = await Promise.all([
        invoke<Companion>("companion_create", { title: text.trim() }),
        gatherContext("chat"),
      ]);
      const context = (await chatAttachment(chat.companionId, blocks))?.context;
      setChatId(chat.companionId);
      // The door becomes the chat in place — a pane of this set, springing
      // out of the island's box; a door with no tab of its own opens one.
      if (!convertDoorPane({ kind: "chat", data: { source: "companion", companionId: chat.companionId } })) wb.dispatch({ type: "openSurface", kind: "chat", data: { source: "companion", companionId: chat.companionId } });
      setFrontDoorOpen(false);
      // The room sends it, not App — see `ChatRoomProps.seed` for why that
      // ordering is what keeps the first bubble from flickering out.
      setChatSeed({ companionId: chat.companionId, text: prompt, id: crypto.randomUUID(), target: activeSurface, context });
      localStorage.setItem(`rl.chatProject.${chat.companionId}`, JSON.stringify(frontDoorProject));
      refreshChats();
      setFrontDoorText("");
      setFrontDoorAttachments([]);
    } catch (e) {
      // The sentence is still in the composer — nothing was taken away.
      setToast(`Couldn't start the chat — ${e}`, 6000);
      setFrontDoorOpen(false);
    } finally {
      frontDoorLaunchingRef.current = false;
      setChatOpening(false);
    }
  };

  // Open an existing conversation (a recent-chat pill, or the room's own
  // `Chats ▾`). The dock comes forward wherever the user happens to be — a
  // conversation is not a place you navigate to any more.
  const openChat = (id: string, opts: { inPlace?: boolean } = {}) => {
    doorLaunchRef.current = null;
    setFrontDoorDest("chat");
    setChatId(id);
    setChatSeed(null);
    setSwapFrom(null);
    setFrontDoorOpen(false);
    // Its pane: picked in a door, the door tab becomes it; from a sidebar
    // row (`inPlace: false`, D29) it is a tab of its own in the set on
    // screen, or the one that set has comes forward.
    const pane = { kind: "chat" as const, data: { source: "companion" as const, companionId: id } };
    if (opts.inPlace === false) wb.dispatch({ type: "openInActive", pane });
    else if (!convertDoorPane(pane)) wb.dispatch({ type: "openSurface", kind: "chat", data: pane.data });
  };
  // A notification answered (useAttentionAlerts): what it was about comes
  // forward through the workbench's own routes, as a tab of the set on
  // screen (D29) — a terminal as its Agent tab or on a wall, a plan as its
  // Plan tab, a chat as its room.
  const revealAlertRef = useRef<(target: AlertTarget) => void>(() => {});
  revealAlertRef.current = (target) => {
    setFrontDoorOpen(false);
    if (target.type === "terminal") {
      showTerminal(target.terminalId, true);
      return;
    }
    if (target.type === "plan") {
      setActiveId(target.sessionId);
      return;
    }
    // A chat: its room, as a tab of the set on screen (D29).
    openChat(target.companionId, { inPlace: false });
  };
  const revealAlert = useCallback((target: AlertTarget) => revealAlertRef.current(target), []);
  // The first conversation, from the dock's empty state. No seed and no
  // spring: the sentence-shaped way in is the Front Door's.
  const startChat = useCallback(() => {
    setChatOpening(true);
    const pending = chatCreation.current ?? invoke<Companion>("companion_create", { title: null });
    chatCreation.current = pending;
    void pending
      .then((chat) => {
        setChatId(chat.companionId);
        refreshChats();
      })
      .catch((e) => {
        setToast(`Couldn't start the chat — ${e}`, 6000);
      })
      .finally(() => { if (chatCreation.current === pending) chatCreation.current = null; setChatOpening(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshChats]);

  // A chat graduating. The reply to the handoff turn IS the brief, and this
  // listens at APP level rather than in the room for the same reason the
  // mission's synthesis does: the distillation keeps running after the user
  // switches surfaces, and the handoff must still land when the panel that
  // asked for it is long unmounted.
  // Sending from the Drafter. The document STAYS — visible, editable, exactly
  // where it was. The front door clears its composer because the sentence moved
  // into the card; a document is not a sentence, and taking it away (or locking
  // it behind a spinner) would be the worst possible translation of that idea.
  // The bar morphs into the launch card above it instead, so what changes is
  // the receipt, not the work.
  const launchFromDrafter = async (markdown: string, project: string | null) => {
    const r = await launchPlan({
      origin: "drafter",
      prompt: markdown,
      projectPath: project,
      draftId: drafterDraftId,
      // Nothing to give back: the document never left.
      restore: { kind: "none" },
    });
    if (!r.ok) {
      setToast(`Couldn't launch the plan — ${r.reason}`, 6000);
    }
  };

  // Each fix is a one-line reuse of a path App already owns. Resolving true
  // means the fault is cleared, which is what lets a refused ⏎ carry through
  // instead of making the user press it again.
  const applyReadinessFix = async (item: ReadinessItem): Promise<boolean> => {
    // A fix's whole point is that the answer just changed, so the cache is
    // dropped and the probe re-run — never the freshness window's cached
    // "still broken", which would tell the user their fix did nothing.
    const reprobe = () => {
      integrationHealth.invalidate();
      void integrationHealth
        .refresh(healthQuery)
        .then(applyHealth)
        .catch((err) => console.error("integration health failed", err));
    };
    try {
      switch (item.fix?.kind) {
        case "resume-mode":
          await changeMode("active");
          reprobe();
          return true;
        case "install-integration": {
          const ok = await requestSetup(item.fix.backend ?? frontDoorBackend.backend);
          reprobe();
          return ok;
        }
        case "locate-claude":
        case "locate-codex":
        case "locate-provider": {
          // The dialog plugin is already in the boot chunk (ProjectPicker),
          // so this import costs nothing beyond the await.
          const { open } = await import("@tauri-apps/plugin-dialog");
          const picked = item.fix.path ?? await open({ directory: false, multiple: false });
          if (typeof picked !== "string") return false;
          if (item.fix.kind === "locate-provider") {
            await invoke("set_provider_bin_override", { backend: item.fix.backend, path: picked });
          } else await invoke(
            item.fix.kind === "locate-codex"
              ? "set_codex_bin_override"
              : "set_claude_bin_override",
            { path: picked },
          );
          reprobe();
          return true;
        }
        default:
          // `new-project` is answered by the door's own naming step, and
          // `copy-hooks` is a CopyChip — neither reaches here.
          return false;
      }
    } catch (err) {
      console.error("readiness fix failed", item.id, err);
      setToast(String(err), 6000);
      return false;
    }
  };

  const createFrontDoorProject = async (
    name: string,
    kind?: "extension" | "harness",
  ): Promise<string | null> => {
    try {
      const path = await invoke<string>("project_create", {
        parent: null,
        name,
        kind: kind ?? null,
      });
      // The other half of creation: register the folder in the workspace
      // manifest so it is visible (picker, guess, readiness) before any plan
      // lands in it — and typed, so an extension launch gets its dir grants.
      // The ref first — synchronously — so the create-and-plan launch that
      // follows in this same continuation already sees the type.
      if (kind) createdKindsRef.current[path] = kind;
      updateWorkspace((ws) => registerProject(ws, path, kind));
      // A harness project was link-installed by its creation (A5a): pull
      // the fresh list now so its Front Door chip appears with the toast,
      // not at the next refocus.
      if (kind === "harness") refreshHarnesses();
      setFrontDoorProject({ path });
      setToast(`Created ${path}`);
      return path;
    } catch (err) {
      setToast(String(err), 8000);
      return null;
    }
  };

  // A4 — the landing's type-to-start handoff. Typing on the empty document
  // plate, with nothing focused, engages the door resting there and carries
  // the keystrokes into its composer: from the first printable key until the
  // composer takes focus, keydowns buffer here (lib/landing.ts is the pure
  // machine) and the composer drains the buffer in a LAYOUT effect, so the
  // handoff is lossless.
  // Eligible only where nothing else owns keys — a modal up, a focused input,
  // or the terminal (isEditableTarget catches xterm's hidden textarea) must
  // never have its typing hijacked.
  // Under the workbench "the empty plate" is a door pane with the focus:
  // a wall, a file or a hidden tab's door must never turn typing meant for
  // them (a tile's ▾ filter, a terminal) into a door.
  const landingTypeEligible =
    stageSurface === "document" &&
    view.focusedKind === "door" &&
    !loading &&
    !activeId &&
    !joinedActive &&
    !frontDoorOpen &&
    !browserOverlayActive &&
    !hookConflicts.dialogOpen &&
    !sendConfirm;
  const landingTypeEligibleRef = useRef(false);
  landingTypeEligibleRef.current = landingTypeEligible;
  const landingPhaseRef = useRef<LandingPhase>("idle");
  const landingSeedRef = useRef("");
  // Back to the front door. Boot auto-selects the most recent plan (:2413)
  // and nothing else ever clears the selection, so without an explicit way
  // to deselect, the door is unreachable for anyone who has ever reviewed
  // anything — it would only ever show on a virgin install. This is that way.
  const openFrontDoor = useCallback(() => {
    setFrontDoorDest("plan");
    // "Plan a build" is a door tab in the active set.
    openDoorTab();
  }, [openDoorTab]);
  // Fresh view of it for the mount-once ⌘⇧N listener.
  openFrontDoorRef.current = openFrontDoor;

  // Type-to-start's destination. The composer is ALWAYS mounted while the
  // door is up, so the cross-surface mount race the seed buffer was built for
  // doesn't arise here — the nonce just tells it to take focus and drain.
  const startDraftFromLanding = useCallback(() => {
    setFrontDoorOpen(true);
    setFrontDoorFocus((n) => n + 1);
  }, []);
  // Handed to the front-door composer AND to PromptDrafter; consuming resets
  // the handoff, so a later click away from the editor can't revive a stale
  // buffer.
  const consumeLandingSeed = useCallback(() => {
    landingPhaseRef.current = "idle";
    const seed = landingSeedRef.current;
    landingSeedRef.current = "";
    return seed;
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const phase = landingPhaseRef.current;
      if (phase === "idle" && !landingTypeEligibleRef.current) return;
      const action = seedStep(phase, {
        printable: isSeedKey(e),
        erase: e.key === "Backspace",
        editable: isEditableTarget(e.target as HTMLElement | null),
      });
      if (action === "ignore") return;
      if (action === "release") {
        // The editor owns input now — never swallow its keystroke.
        landingPhaseRef.current = "idle";
      } else {
        e.preventDefault();
      }
      if (action === "start") landingPhaseRef.current = "handoff";
      landingSeedRef.current = applySeed(landingSeedRef.current, action, e.key);
      if (action === "start") startDraftFromLanding();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startDraftFromLanding]);

  // The ⌘K registry (A5): assembled from the same closed lists the header
  // renders — headerSurfaceList (manifest-hidden surfaces never appear),
  // THEMES/FONTS, the live session summaries — over the app's proven
  // setters. lib/commands.ts stays pure; every closure lives here.
  // onThemeChange/onFontChange are redefined per render, so they're
  // deliberately not deps — the values they close over that matter to a
  // *later* click (theme, font) are.
  const paletteCommands = useMemo(
    () =>
      buildCommands({
        surfaces: headerSurfaceList,
        currentSurface: stageSurface,
        sessions: summaries.map((s) => ({
          id: s.sessionId,
          title: s.planTitle || s.projectName || "Untitled plan",
          project: s.projectName,
        })),
        themes: THEMES.map(({ name, label }) => ({ name, label })),
        currentTheme: theme,
        fonts: FONTS.map(({ name, label }) => ({ name, label })),
        currentFont: font,
        harnesses: activeHarness
          ? []
          : harnessList.map((h) => ({ id: h.id, name: h.name })),
        activeHarness: activeHarness
          ? {
              name: activeHarness.manifest.name,
              exitHidden: activeHarness.entry === "boot",
            }
          : null,
        // The dock's contents from where the user is standing. Not a global
        // index — which conversations exist is a property of the surface, and
        // offering one this surface hasn't got would land in an empty column.
        conversations: dockContexts.map((c) => ({
          kind: c.kind,
          label: c.label,
        })),
        currentConversation: voiceDocked ? (dockContext?.kind ?? null) : null,
        chats: chats.slice(0, 8).map((c) => ({ id: c.companionId, title: c.title })),
        perfProbe,
        actions: {
          // ⌘K "Plan a build" lands on the front door, which is now the
          // primary way to start one. The Drafter is still one hop away
          // there, behind `Plan ▾ → Draft a document first`.
          draftNewPlan: openFrontDoor,
          // ⌘T by name: a door tab in the set on screen.
          newTab: openDoorTab,
          // Each a trip the user asked for, even to where they already
          // are: the door and its card step aside (`doorTrip`).
          openSession: (id) => {
            tripDoor();
            selectSessions();
            setActiveId(id);
            selectSurfaceRef.current("document");
          },
          // Ids come back from the deps' own closed list, so the lookup both
          // validates and re-types them — no cast, nothing free-typed.
          selectSurface: (id) => {
            const d = headerSurfaceList.find((s) => s.id === id);
            if (d) { tripDoor(); selectSurfaceRef.current(d.id); }
          },
          navigateTo: (t) => {
            const d = headerSurfaceList.find((s) => s.id === t.surface);
            if (d) { tripDoor(); navigateTo({ surface: d.id, tab: t.tab }); }
          },
          // ⌘J's own: the rail's Talk. The door has its own entry.
          toggleDock: toggleTalk,
          toggleDoor,
          openConversation: (kind) => {
            const hit = dockContexts.find((c) => c.kind === kind);
            if (!hit) return;
            if (kindPill(hit.kind)) setConversationPin(hit.kind);
            openRailTab("talk");
          },
          openChat,
          // Home, by name: the ⌂ left the top bar (D26) — it is the
          // sidebar's first Place, and this.
          goHome: () => {
            tripDoor();
            setActiveId(null);
          },
          snapBack,
          toggleSidebar,
          toggleDiscussion: togglePane,
          toggleTerminal: revealTerm,
          setTheme: (name) => {
            if (isThemeName(name)) onThemeChange(name);
          },
          setFont: (name) => {
            if (isFontName(name)) onFontChange(name);
          },
          zoomReset: () => setDocZoom(1),
          replayTour: () => setTourOpen(true),
          togglePerfProbe: () => {
            void setPerfProbe(!perfProbe);
            setPerfProbeShown(!perfProbe);
          },
          enterHarness: (id) => {
            const manifest = harnessList.find((h) => h.id === id);
            if (manifest) enterHarness(manifest);
          },
          exitHarness,
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      headerSurfaceList,
      stageSurface,
      summaries,
      activeId,
      theme,
      font,
      perfProbe,
      harnessList,
      activeHarness,
      enterHarness,
      exitHarness,
      openFrontDoor,
      snapBack,
      selectSessions,
      toggleSidebar,
      togglePane,
      revealTerm,
      setDocZoom,
      toggleTalk,
      toggleDoor,
    ],
  );

  // The conversation's BODY, built once and hosted in either pose: the dock's
  // column, or the plate itself. One definition, because they are the same
  // conversation — the Companion you glance at from the browser and the room
  // you sink into from the Front Door are one thread at two scales, and
  // building them separately is how they would drift apart.
  // Lazy chunk: the host renders empty for the load beat, then the panel
  // mounts — the column's width is ref-owned, so nothing shifts.
  const dockBody = dockContext ? (
    <Suspense fallback={null}>
      {BROWSER_DOCK_KINDS.includes(dockContext.kind) ? (
        // The browser pane portals its own panel in here. An empty
        // node is the right thing to render while it is loading or
        // between tabs — the column is the pane's, and only the
        // pane knows what belongs in it.
        <div ref={setDockSlotEl} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />
      ) : dockContext.kind === "companion" ? (
        chatOpening ? (
          <div className="px-4 py-4"><EmptyState title="Chat" body="Starting a conversation…" /></div>
        ) : !chatId ? (
          <div className="px-4 py-4"><EmptyState
            title="Companion"
            body={
              "One conversation that follows you across every " +
              "surface — the plan, the browser, a review, your " +
              "memory. Start it here, or say something at the " +
              "front door."
            }
            action={{
              label: "Start a conversation",
              onAction: startChat,
            }}
          /></div>
        ) : (
          // The chat itself, carried out of the door: its host lands here.
          <div ref={setChatDockSlot} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />
        )
      ) : (
      <VoicePanel
        onOpenChat={openChat}
        // Remount cleanly when the conversation changes (a revision
        // arriving calls setActiveId; switching contexts changes the
        // kind) instead of mutating sessionId under a live warm
        // session.
        key={dockContext.key}
        sessionId={dockContext.key}
        markdown={
          dockContext.kind === "drafter"
            ? drafterMarkdown
            : (latest?.rawPlanMarkdown ?? "")
        }
        sections={
          dockContext.kind === "drafter" ? drafterSections : sections
        }
        // The drafter's mirror is debounce-lagged, so its panel gets
        // a live getter; a plan revision is already whole when it
        // arrives and has none.
        cwd={
          dockContext.kind === "drafter" ? drafterProjectPath : null
        }
        liveMarkdown={
          dockContext.kind === "drafter"
            ? getDrafterLiveMarkdown
            : null
        }
        // Only the plan's conversation can be the one an incoming
        // revision must not interrupt.
        onActivityChange={
          dockContext.kind === "voice" ? setDiscussionLive : undefined
        }
        onClose={closeDock}
      />
      )}
    </Suspense>
  ) : null;

  // The rail's badges: the Discussion tab counts the answers waiting on you
  // (amber), else the marks riding the next Send. Nothing else is counted
  // here — a count for a tab that is not shown would mean polling for it.
  const railWaiting = threadComments.filter((c) => c.status === "resolved").length;
  // A review pane's Discussion is its review threads, so it counts those;
  // only a plan's counts the plan's marks.
  const reviewThreadCount = codeReview.annotations.length + codeReview.questions.length;
  const railCounts = useMemo(
    () => ({ discussion: railKind === "review" ? reviewThreadCount : railKind === "plan" ? railWaiting || pendingComments.length : 0 }),
    [railKind, reviewThreadCount, railWaiting, pendingComments.length],
  );
  const railAttention = useMemo(() => ({ discussion: railKind === "plan" && railWaiting > 0 }), [railKind, railWaiting]);
  // The version the plan pane shows: the Discussion piles are read on it.
  const railShownVersion = isViewingHistorical && viewedRevision ? viewedRevision.versionNumber : (latest?.versionNumber ?? 1);
  // The rail's other tabs. Talk is still the conversation dock's column
  // beside the pane until the dock's body moves in; Files and Changes land
  // with their own bodies.
  // The Files tab's root: the session's project (or the launch's) — on
  // Home, the folder picked among the open ones and recent projects.
  const railLaunch = launchIdOf(wbActiveKey) ? flowLaunches.find((l) => l.launchId === launchIdOf(wbActiveKey)) ?? null : null;
  const railSessionRoot = activeId ? (session?.sessionId === activeId ? session.projectPath : summaries.find((x) => x.sessionId === activeId)?.projectPath) ?? null : railLaunch?.projectPath ?? null;
  const railHomeRoots = useMemo(() => {
    const out: string[] = [];
    for (const f of openFolders) if (!out.includes(f.path)) out.push(f.path);
    for (const x of summaries) if (x.projectPath && !out.includes(x.projectPath) && out.length < 12) out.push(x.projectPath);
    return out;
  }, [openFolders, summaries]);
  const [railHomeRootPick, setRailHomeRootPick] = usePersistedState<string | null>("redline.rail.filesRoot", null);
  const railHomeRoot = railHomeRootPick && railHomeRoots.includes(railHomeRootPick) ? railHomeRootPick : railHomeRoots[0] ?? null;
  const railFilesRoot = wbActiveKey === HOME_KEY ? railHomeRoot : railSessionRoot;
  // ⌘P: go to a file under the rail's root.
  const [quickOpenRoot, setQuickOpenRoot] = useState<string | null>(null);
  const railFilesRootRef = useRef(railFilesRoot);
  railFilesRootRef.current = railFilesRoot;
  const openQuickOpen = useCallback(() => {
    const root = railFilesRootRef.current;
    if (root) setQuickOpenRoot(root);
    else setToast({ message: "No project folder to search here yet.", tone: "info" });
  }, []);
  // `file:line` links (W4): a terminal's ⌘-click, a conversation's tool
  // row — every one arrives as this event and opens through `openFile`.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenFileDetail>).detail;
      if (!d?.path) return;
      setActiveFile(d.path);
      wb.dispatch({ type: "openFile", path: d.path, line: d.line, mode: d.mode ?? "preview", at: Date.now() });
    };
    // lib/fileLinks' OPEN_FILE_EVENT, spelt here so the module stays off the
    // boot path (fileLinks.test pins the two together).
    window.addEventListener("redline:open-file", onOpen);
    return () => window.removeEventListener("redline:open-file", onOpen);
  }, [setActiveFile]);
  // ⌘P: the native menu's Go to File (menu-quick-open), and the same chord
  // where no menu took it first. Print moved to ⌘⌥P.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isQuickOpenKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      openQuickOpen();
    };
    window.addEventListener("keydown", onKey, true);
    const unlisten = listen("menu-quick-open", () => openQuickOpen());
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void unlisten.then(dropListener);
    };
  }, [openQuickOpen]);
  // A Changes row: that file's diff, in the Review pane over the working tree.
  const [reviewFocus, setReviewFocus] = useState<{ path: string; nonce: number } | null>(null);
  const openRailDiff = (repo: string, path: string) => {
    codeReview.setSource("uncommitted");
    void codeReview.openReview(repo, "uncommitted");
    setReviewFocus({ path, nonce: Date.now() });
    selectSurface("review");
  };
  const railOtherBody: ReactNode =
    railTab === "files" ? (
      <Suspense fallback={null}>
        <FilesRail
          root={railFilesRoot}
          roots={wbActiveKey === HOME_KEY ? railHomeRoots : undefined}
          onPickRoot={(path) => {
            // The door's project follows the pick; the centre does not — a
            // root pick never brings a terminal forward (no linked nav here).
            setRailHomeRootPick(path);
            setFrontDoorProject({ path });
            activateFolder(path);
          }}
          activeFile={activeFile}
          onOpenFile={handleOpenFile}
          onQuickOpen={openQuickOpen}
        />
      </Suspense>
    ) : railTab === "talk" ? (
      // Talk (W4): the conversation dock's body, moved into the rail — the
      // plan's or the draft's voice, the browser's page chat, task list and
      // mission (portalled in through `dockSlotEl`), Home's chat.
      // `dockContext.key` is the identity: switching conversations remounts
      // the body rather than mutating a warm session under it, and for the
      // voice-capable kinds that same key is what `voice.rs` dispatches on.
      dockContext ? (
        <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden" data-rail-talk={dockContext.kind}>
          {/* Only when the pane offers a genuine choice. Selecting sets the
              PIN, a tie-break: it follows you to the next pane that has the
              same kind and is ignored by every pane that hasn't. */}
          <DockContextStrip
            contexts={browserOpen ? dockContexts.map((context) => ({
              ...context,
              label: ({ browse: "Page chat", browselist: "Task list", mission: "Mission", companion: "Chat" } as Partial<Record<ConversationKind, string>>)[context.kind] ?? context.label,
            })) : dockContexts}
            activeKey={dockContext.key}
            onSelect={(d) => { const pill = kindPill(d.kind); if (pill) openDockPill(pill); else setConversationPin(d.kind); }}
          />
          <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">
          {dockBody}
          </div>
        </div>
      ) : (
        <div className="rl-rail-empty">
          Talk follows what is on screen: a plan or a draft (by voice or typed), the browser's pages, or Home's chat. This pane has no conversation of its own.
        </div>
      )
    ) : (
      <Suspense fallback={null}>
        <ChangesRail repo={railFilesRoot} onOpenDiff={openRailDiff} onNotice={(message) => setToast({ message, tone: "warning" })} />
      </Suspense>
    );

  const monochatRouting = useMemo(() => ({ harness: frontDoorBackend, conversationId: chatId }), [frontDoorBackend, chatId]);

  // The door's one flight pill: its own plan launch. Built once per launch,
  // not per render: the composer reads a new object as a new launch.
  const frontDoorFlight = useMemo(
    () => (pendingLaunch?.origin === "front-door" || pendingLaunch?.origin === "browser-island" ? pendingLaunch : null),
    [pendingLaunch],
  );
  // The welcome's pills: the way back into recent plans, chats and browser
  // tabs. Tabs are ranked research-first against the unresolved plans, read
  // from the saved workspaces whenever the door shows (the lazy browser pane
  // may never have mounted this launch). Keyed on the unresolved plans'
  // identity, not the summaries array, which every poll replaces.
  const [doorTabs, setDoorTabs] = useState<DoorTab[]>([]);
  const unresolvedKey = summaries
    .filter((s) => s.status === "in_review")
    .map((s) => `${s.sessionId}:${s.updatedAt}`)
    .join(",");
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;
  useEffect(() => {
    if (!doorVisible) return;
    let live = true;
    void loadDoorTabs(invoke, summariesRef.current)
      .then((tabs) => { if (live) setDoorTabs(tabs); })
      .catch(() => {});
    return () => { live = false; };
  }, [doorVisible, frontDoorOpen, unresolvedKey]);
  const doorRecentItems = useMemo(
    () => doorRecents({ plans: summaries, chats, tabs: doorTabs }),
    [summaries, chats, doorTabs],
  );
  // A recent jumps back the way the sidebar's rows do (D29): as a tab of
  // the set on screen, or that set's tab for it comes forward — a chat its
  // room, a plan its Plan tab, a page the browser. A ⌘T door nobody typed
  // in, which the recent was picked from, steps aside. (The chat chip used
  // the door's own in-place conversion, a different route from the rows'.)
  const openDoorRecent = (r: DoorRecent) => {
    const before = wb.getState();
    const from = { key: before.activeKey, tabId: before.sets[before.activeKey]?.activeTabId ?? null };
    tripDoor();
    setFrontDoorOpen(false);
    if (r.kind === "chat") openChat(r.id, { inPlace: false });
    else if (r.kind === "plan") setActiveId(r.id);
    else {
      // By thread. A plan's explicit research link reopens with its answer
      // (the same as "View result"); any other tab comes back quietly.
      setBrowserOpenRequest({ url: r.url ?? "", nonce: Date.now(), focusBrowseId: r.id, quiet: !r.research });
      selectSurface("browser");
    }
    closeUntouchedDoor(from.key, from.tabId);
  };
  // On screen in the dock's column — the same room, at column scale.
  const chatDocked = !chatPane && !!chatId && voiceDocked && dockContext?.kind === "companion";
  // One composer in two places — the door's own (resting or open) and a
  // chat's compact composer (D27) — each a FrontDoor on its draft.
  // A door tab's Open target: the browser takes the sentence as an address
  // or a search; the others open at once with the sentence kept.
  const openDoorTarget = (id: string, text: string) => {
    if (id === "browser") {
      // An empty sentence opens the browser's new tab (its omnibox focused).
      const url = text.trim() ? browserTarget(text) : NEWTAB_URL;
      if (!convertDoorPane({ kind: "browser", data: { workspace: "regular" } })) selectSurface("browser");
      setBrowserOpenRequest({ url, nonce: Date.now() });
      return;
    }
    if (doorOpenTargets.some((t) => t.id === id)) selectSurface(id as Surface);
  };
  const setDoorDestination = (next: LaunchDestination) => {
    setFrontDoorDest(next);
    const { set, tab } = activePanes(wb.getState());
    const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
    if (focused?.kind === "door") wb.dispatch({ type: "replacePane", paneId: focused.id, pane: { kind: "door", data: { ...focused.data, destination: next } } });
  };
  const renderMonochatComposer = (where: "door" | "chat", accessories?: React.ReactNode, workbench?: ChatWorkbenchComposer) => {
    const shown = where === "door" ? doorVisible : !!chatPane || chatDocked;
    const destination = where === "chat" ? "chat" : frontDoorDest;
    return (
              <FrontDoor
                visible={shellReady && shown}
                floating
                welcome={where === "door"}
                recents={doorRecentItems}
                onOpenRecent={openDoorRecent}
                chips={<SurfaceChips
                  chips={visibleChips(contextChips, destination)}
                  pressed={(chip) => isChipPressed(chip, chipPresses, islandSurfaceKey)}
                  onToggle={(chip) => setChipPresses((presses) => toggleChip(presses, islandSurfaceKey, chip))}
                />}
                // The door's composer is the island's to focus: every summons
                // puts the caret in it. A chat the room holds takes it on
                // every summons.
                autoFocusOnShow={where === "chat" && !!chatPane}
                chatPending={chatOpening || !!(chatSeed && chatSeed.autoSend !== false)}
                accessories={accessories}
                workbench={workbench}
                choice={frontDoorProject}
                onChoiceChange={setFrontDoorProject}
                projectOptions={projectOptions}
                openFolder={frontDoorOpenFolder}
                lastLaunchProject={lastLaunchProject}
                onResolvedProjectChange={setFrontDoorResolvedProject}
                attachments={frontDoorAttachments}
                onAttachmentsChange={setFrontDoorAttachments}
                combine={frontDoorCombine}
                onCombineChange={setFrontDoorCombine}
                combinePreview={combinePreview}
                readiness={readiness}
                onFix={applyReadinessFix}
                // Only ITS launch: one pending state serves every door, so the
                // front door must not render a card for the Drafter's launch.
                pending={frontDoorFlight}
                onLaunch={(project) => void launchFromFrontDoor(project)}
                // A refusal from App's own backstop gate, so the fix lands in
                // the island rather than only in a corner toast.
                refusal={frontDoorRefusal}
                onDrafter={drafterFromFrontDoor}
                onChat={() => void chatFromFrontDoor()}
                chatEnabled={surfaceEnabled(effectiveWorkspace, "chat")}
                // A door tab's Open targets, and the destination the pane
                // remembers (a door opened from a browser pane starts on
                // Browser); the global default follows every pick.
                openTargets={where === "door" ? doorOpenTargets : undefined}
                onOpenTarget={where === "door" ? openDoorTarget : undefined}
                destination={where === "door" ? (doorPaneDestination ?? frontDoorDest) : frontDoorDest}
                onDestinationChange={where === "door" ? setDoorDestination : setFrontDoorDest}
                backend={frontDoorBackend}
                onBackendChange={setFrontDoorBackend}
                modelCatalogs={modelCatalogs}
                modelError={modelErrors[frontDoorBackend.backend]}
                modelStatus={modelStatus[frontDoorBackend.backend]}
                onRefreshModels={() => requestModels(frontDoorBackend.backend, selectedModelIdentity, true)}
                providerInfo={frontDoorBackend.backend === "claude-code" ? preflight?.claude : frontDoorBackend.backend === "codex" ? preflight?.codex ?? undefined : preflight?.providers?.[frontDoorBackend.backend]}
                onNeedModels={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)}
                // Dismissing the flight pill retires the INDICATOR, nothing
                // else: the plan keeps running in its tile and the composer —
                // already blank, already usable — stays blank. No pay-back.
                onCancelPending={() => setPendingLaunch(null)}
                // The flight pill's other half: go watch it. Reveal the dock, focus
                // the tile the plan is running in, and glow it once so the
                // eye lands on the right one of fourteen.
                onRevealPending={() => {
                  const p = frontDoorFlight;
                  if (!p) return;
                  setFrontDoorOpen(false);
                  showTerminal(p.terminalId);
                }}
                onCreateProject={createFrontDoorProject}
                // The handoff is the door's alone: a card or a chat on the
                // same sentence must not take the caret or the seed with it.
                focusNonce={where === "door" ? frontDoorFocus : 0}
                // The door's composer is the focused door pane's draft; the
                // card and a chat keep the Front Door's shared sentence.
                draftKey={where === "door" ? doorSentenceKey : undefined}
                consumeSeed={consumeLandingSeed}
                // Recent chats — the contextual way back into a conversation,
                // in the door alone: never in a chat's composer. Bounded: this
                // is a way in, not an index; the room's own `Chats ▾` holds the
                // full list.
                chats={where === "door" ? chats
                  .slice(0, 4)
                  .map((c) => ({ id: c.companionId, title: c.title })) : undefined}
                onOpenChat={where === "door" ? openChat : undefined}
              />
    );
  };

  // The sidebar's chat rows and a project group's "+".
  const flowSidebarHandlers = useStableHandlers({
    // A project's "+": a door tab pointed at that folder.
    onNewSessionIn: (path: string) => {
      setFrontDoorProject({ path });
      openDoorTab();
    },
    // A chat row (D29): its room as a tab of the set on screen, never in
    // place of the door that was in front.
    onSelectChat: (id: string) => openChat(id, { inPlace: false }),
    onRenameChat: (id: string, title: string) => {
      invoke("companion_rename", { companionId: id, title, byUser: true })
        .then(refreshChats, (e) => setToast(String(e), 6000));
    },
    onArchiveChat: (id: string, archived: boolean) => {
      invoke("archive_companion", { companionId: id, archived }).then(() => {
        if (archived && id === chatId) { setChatId(null); setChatSeed(null); }
        refreshChats();
      }, (e) => setToast(String(e), 6000));
    },
    onDeleteChat: (id: string) => {
      invoke("companion_delete", { companionId: id }).then(() => {
        if (id === chatId) { setChatId(null); setChatSeed(null); }
        refreshChats();
      }, (e) => setToast(String(e), 6000));
    },
  });
  // What the sidebar reads beyond the sessions: the launches (every launch
  // until its plan arrives or its terminal closes, the one on screen active),
  // their spinners and needs, and the chats.
  const flowSidebarData = useMemo(
    () => ({
      launches: flowSidebarLaunches,
      activeLaunchId,
      working: flowWorking,
      needs: flowNeeds,
      // Chats are rows in both shells (the frame's "○ Billing chat"): the
      // open one reads selected while the door's room holds it.
      chats,
      activeChatId: chatPane,
    }),
    [chatPane, chats, flowSidebarLaunches, activeLaunchId, flowWorking, flowNeeds],
  );
  // The workbench sidebar's own data (W1): which Place reads selected, the
  // Localhost ports beside it, and each session's terminals
  // in the shared status vocabulary — its agent's terminal from
  // `useSessionTerminals`, its state from the CLI's own hooks.
  // The Place on screen (D30): Localhost or the Browser when one is the
  // focused pane, else Home on Home's set.
  const sidebarPlace = view.focusedKind === "servers" ? "servers" as const : view.focusedKind === "browser" ? "browser" as const : wbActiveKey === HOME_KEY ? "home" as const : null;
  // Read off the Localhost scan (see `ptyKey` below for when it runs).
  // Sorted, deduped and kept by value: a scan that finds the same servers
  // (each 15 s while Localhost is up, in whatever order lsof lists them)
  // must not re-render or repaint the sidebar.
  // The ports the Localhost scan lists: the browser's "dev server" mark is
  // for these alone.
  const devServerPorts = useStableValue(useMemo(() => [...new Set((devServers.scan?.running ?? []).map((r) => r.port))].sort((a, b) => a - b), [devServers.scan]));
  const sidebarPorts = useStableValue(useMemo(() => [...new Set((devServers.scan?.running ?? []).map((r) => r.port))].sort((a, b) => a - b).map((p) => `:${p}`), [devServers.scan]));
  // The servers' ports chips (W7): once on their project's header, and on a
  // session's row only for a server under its own terminal (lib/sessionPorts,
  // D44). The scan runs while Localhost is on
  // screen and otherwise once per event — boot, and a PTY appearing,
  // exiting or starting to serve (the wall's own process sample) — never on
  // a clock. The scan is kept by value, so an unchanged sweep is no render.
  const ptyKey = useMemo(() => [...(liveTermIds ?? [])].sort().join(" ") + "|" + [...termStatuses].filter(([, t]) => t.state === "serving" || t.state === "exited").map(([id]) => id).sort().join(" "), [liveTermIds, termStatuses]);
  const rescanServers = devServers.rescan;
  useEffect(() => { rescanServers(); }, [ptyKey, rescanServers]);
  // Every terminal a session owns sits under its row — its agent's, the
  // shells opened in its tabs, and the ones kept running after their wall
  // closed — and Home's under Home (key ""). One status vocabulary, from the
  // one derivation TerminalTabs makes (`onStatesChange`); the hooks'
  // attention stands in until the layer has mounted.
  const wbOwners = useWorkbench(wb, (st) => st.owners);
  const wbStowed = useWorkbench(wb, (st) => st.stowed);
  // Terminals the helper kept while Redline was closed (lib/keptMeta): when
  // each started, for the sidebar's "running since" until it reports again.
  const [adoptedSince, setAdoptedSince] = useState<ReadonlyMap<string, number>>(() => new Map());
  const handleAdopted = useCallback((list: readonly LivePty[]) => {
    setAdoptedSince(new Map(list.filter((p) => p.kept && p.alive && p.startedAt).map((p) => [p.id, p.startedAt!])));
    void import("./lib/keptMeta").then(({ adoptedBinds }) => {
      const binds = adoptedBinds(list);
      bindSessionTerminals(binds);
      for (const { sessionId, terminalId } of binds) void import("./components/agent/convo/api").then((api) => api.convoPrebind(terminalId, sessionId)).catch(() => {});
    });
  }, [bindSessionTerminals]);
  // Every live terminal's placement goes to the helper as it changes, so a
  // relaunch puts it back (keyed by value: a status tick is no write).
  const keptMetaKey = useMemo(() => {
    if (!liveTermIds) return "";
    const bySession = new Map([...sessionTerminals].map(([sid, tid]) => [tid, sid]));
    return JSON.stringify(liveTermIds.map((id) => ({ id, meta: { owner: wbOwners[id], sessionId: bySession.get(id), title: terminalTitles.get(id) || termStatuses.get(id)?.label } })));
  }, [liveTermIds, sessionTerminals, wbOwners, terminalTitles, termStatuses]);
  useEffect(() => {
    if (keptMetaKey) void import("./lib/keptMeta").then((m) => m.syncKeptMeta(JSON.parse(keptMetaKey))).catch(() => {});
  }, [keptMetaKey]);
  const sidebarTerminals = useMemo(() => {
    const out: Record<string, { id: string; title: string; status: "needs" | "working" | "idle" | "exited"; kept?: boolean; ports?: readonly number[]; since?: number }[]> = {};
    const listed = new Set<string>();
    // The rows a terminal can nest under: a current plan's (an archived or
    // deleted one has no row on screen) and a pending launch's own row,
    // which IS its agent terminal. Anything else — a launch's terminal whose
    // row went, a shell a launch set opened, a session with no row — sits
    // under Home, so no terminal, kept or not, is ever only in the ▾ menu.
    const rows = new Set(summaries.filter((x) => !x.archivedAt).map((x) => x.sessionId));
    const launchRows = new Set(flowSidebarLaunches.map((l) => l.terminalId));
    const push = (row: string, terminalId: string, fallback: string) => {
      if (listed.has(terminalId)) return;
      listed.add(terminalId);
      const known = termStatuses.get(terminalId);
      const status = terminalStatus(terminalId, { states: termStatuses, attention: terminalKinds, held: heldTermIds, live: liveTermIds });
      const kept = wbStowed.includes(terminalId);
      const ports = termPorts.get(terminalId);
      // Kept through a quit and quiet since: "running since <time>".
      const since = terminalKinds.has(terminalId) ? undefined : adoptedSince.get(terminalId);
      (out[row] ??= []).push({ id: terminalId, title: terminalTitles.get(terminalId) || known?.label || fallback, status, ...(kept ? { kept } : {}), ...(ports ? { ports } : {}), ...(since ? { since } : {}) });
    };
    for (const [sessionId, terminalId] of sessionTerminals) {
      if (rows.has(sessionId)) push(sessionId, terminalId, "claude");
      else if (!liveTermIds || liveTermIds.includes(terminalId)) push("", terminalId, "claude");
    }
    for (const [terminalId, owner] of Object.entries(wbOwners)) {
      if (liveTermIds && !liveTermIds.includes(terminalId)) continue;
      const sessionId = sessionIdOf(owner);
      if (sessionId && rows.has(sessionId)) push(sessionId, terminalId, "terminal");
      // A launch's own agent is its row; a kept one shows nested all the same.
      else if (launchIdOf(owner) && launchRows.has(terminalId) && !wbStowed.includes(terminalId)) continue;
      else push("", terminalId, sessionId || launchIdOf(owner) ? "claude" : "terminal");
    }
    // Kept with no owner on record (a reload that lost it): Home's.
    for (const terminalId of wbStowed) {
      if (!listed.has(terminalId) && (!liveTermIds || liveTermIds.includes(terminalId))) push("", terminalId, "terminal");
    }
    return out;
  }, [sessionTerminals, terminalKinds, terminalTitles, liveTermIds, termStatuses, wbOwners, wbStowed, heldTermIds, summaries, flowSidebarLaunches, termPorts, adoptedSince]);

  // The memoized sidebar and browser pane get identity-stable handlers (see
  // `commentCallbacks`), so they render when their data changes and not on
  // every shell render.
  // The sidebar's icon pose (D18): each session a status dot.
  const sidebarEdgeSessions = useMemo(
    () =>
      summaries.slice(0, 24).map((x) => {
        const term = sessionTerminals.get(x.sessionId);
        const tone: EdgeSessionTone = (term && terminalKinds.get(term) === "needs-you") || unseenPlanIds.has(x.sessionId) ? "needs" : x.status === "in_review" ? "review" : x.status === "approved" ? "done" : "idle";
        return { id: x.sessionId, title: x.planTitle?.trim() || x.projectName, tone, active: x.sessionId === activeId };
      }),
    [summaries, sessionTerminals, terminalKinds, unseenPlanIds, activeId],
  );
  const sidebarHandlers = useStableHandlers({
    onSelect: (id: string) => {
      // `wb:session-switch`: the click to the stage showing the session
      // (ended once `sessionReady` flips, below). A re-click of the open
      // session is not a switch.
      if (id !== activeId) beginMeasure("wb:session-switch");
      setActiveId(id);
    },
    onSelectJoined: () => joinedInfo && setActiveId(joinedInfo.key),
    // A row's ports chip: the server in a browser tab, as Localhost's cards.
    onOpenPort: (url: string) => openUrlInBrowser(url),
    // The Places (W1, D30): Home is the workbench's Home set (its door
    // lands); the Browser and Localhost open — or come forward — as tabs of
    // the set on screen.
    onSelectPlace: (place: "home" | "browser" | "servers") => {
      if (place === "home") {
        tripDoor();
        setActiveId(null);
        return;
      }
      selectSurface(place);
    },
    // A session's terminal row: its agent terminal is its Agent tab (one
    // pane per terminal, opened again it comes forward); any other comes
    // forward on its wall — its session, its wall, its tile, hailed — and a
    // kept terminal (no wall) back onto one.
    onSelectTerminal: (sessionId: string, terminalId: string) => {
      if (sessionTerminals.get(sessionId) === terminalId) {
        openSessionPane({ kind: "chat", data: { source: "agent", terminalId, sessionId } });
        return;
      }
      showTerminal(terminalId);
    },
    // A pending launch's row: its Agent tab, opened in the set on screen
    // (D29); its own set waits behind the strip for the plan to arrive.
    onSelectLaunch: (terminalId: string) => {
      const launch = flowLaunches.find((l) => l.terminalId === terminalId);
      if (launch) {
        wb.dispatch({ type: "ensureDefaults", key: launchKey(launch.launchId), defaults: { agentTerminalId: terminalId } });
        openSessionPane({ kind: "chat", data: { source: "agent", terminalId, sessionId: null } });
        return;
      }
      showTerminal(terminalId);
    },
    onRemoveLaunch: (terminalId: string) => removeLaunch(terminalId),
    // A row's "Open as workspace" (D29): the session's own set, the switch.
    onOpenWorkspace: (sessionId: string) => openWorkspace(sessionId),
    onNewTab: openDoorTab,
    onCombine: (ids: string[]) => void beginCombine(ids),
    onDelete: deleteSession,
    onRename: renameSession,
    onArchive: archiveSession,
    onSetPlanState: (id: string, state: ManualPlanState) => void setPlanState(id, state),
    onMoveProject: (id: string) => void openMovePlan(id),
    onExport: exportRevision,
    onSelectRevision: (sessionId: string, versionNumber: number | null) => {
      // The sidebar fires this for the row click. The session it points at
      // might not be the active one yet — flip activeId first so the pane
      // mounts the right session before the viewed-version applies.
      if (sessionId !== activeId) {
        beginMeasure("wb:session-switch");
        setActiveId(sessionId);
      }
      setViewedVersionNumber(versionNumber);
    },
  });
  const browserHandlers = useStableHandlers({
    onOpenDraft: (draftId: string) => { setDrafterDraftId(draftId); setDrafterShelfOpen(false); selectSurface("drafter"); },
    onMissionContinue: (missionId: string, destination: "plan", body: string, handoffId: string) => {
      const folder = sidebarTab.kind === "folder" ? sidebarTab.id : null;
      selectSurface("document");
      setSendError(null);
      setSendConfirm({ markdown: body, initialProject: guessProjectForPlan(body, projectOptions) ?? folder ?? lastLaunchProject, missionHandoff: { missionId, handoffId, destination } });
    },
    onClose: () => closeSurfacePane("browser"),
    // Drop a plan/prompt drafted while browsing into a fresh Redline plan
    // session: close the browser overlay, confirm the target repo, then
    // launch the plan in the terminal (see handler).
    onSendToRedline: sendBrowserDraftToRedline,
    // Or open the reply in the Prompt Drafter (repo pre-guessed) to shape it
    // before sending.
    onSendToDrafter: sendBrowserToDrafter,
    // A synthesized mission brief seeds the Prompt Drafter.
    onSynthesizeToDrafter: seedDrafterFromMission,
    // Cleared once acted on — a request that lingers replays on every
    // remount (the pane's nonce guard resets with it).
    onOpenRequestConsumed: onBrowserOpenConsumed,
    onCloseDock: () => closeDock(),
    // The new-tab page's "Ask Memory" and its footer links.
    onOpenMemory: () => selectSurface("memory"),
  });

  // The comment composer, while a mark is being written: the discussion
  // pane's on classic, the plan panel's (or its Feedback tab's) in flow.
  const commentComposer = composing ? (
    <Suspense fallback={null}>
    <CommentComposer
      type={composing.type}
      sessionId={activeId ?? ""}
      anchorId={composing.anchorId}
      selectedText={composing.selectedText}
      charStart={composing.charStart}
      charEnd={composing.charEnd}
      subBlockId={composing.subBlockId}
      presetRevised={composing.presetRevised}
      sections={latest?.sections}
      onCancel={() => setComposing(null)}
      onSubmit={submitComment}
    />
    </Suspense>
  ) : null;

  // The Agent pane's Talk: the dock's conversation — the plan's voice panel
  // once there is a plan. A launch with no plan yet has no voice of its own,
  // so Talk says when it will.
  const flowTalk = () => {
    if (voiceDocked) closeDock();
    else if (dockReachable) openDiscussion();
    else setToast({ message: "Talk opens on the plan as soon as it arrives.", tone: "info" });
  };
  // The Agent pane's props, identity-stable: AgentPane and the conversation
  // under it are memoized, and the shell re-renders on every focus flip and
  // divider frame. Handlers go through refs; the active session's plan state
  // and recorded model are values kept equal across unrelated renders.
  const agentPaneHandlers = useStableHandlers({
    onTalk: flowTalk,
    // Its session's Plan tab, in the set on screen (D29): an Agent tab
    // opened in Home brings its plan there too.
    onOpenPlan: () => {
      const sid = activeSessionOf(wb.getState());
      if (sid) wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: sid, version: null } } });
    },
    onFork: (cliSessionId: string, projectPath: string | null) => void forkCliSession(cliSessionId, projectPath),
    // The Stopped card's Retry on an agent that died mid-build: resume the
    // same conversation to carry on the approved plan.
    onRetryBuild: () => void buildApproved("same"),
    // Its Retry on a plan in review whose agent died: the plan's Restore.
    onRetryReview: () => void restorePlanSession(),
    // On a launch stopped before its plan: its command again.
    onRetryLaunch: (terminalId: string) => void retryLaunch(terminalId),
  });
  const activeAgentSummary = activeId ? summaries.find((s) => s.sessionId === activeId) ?? null : null;
  const activeAgentMode = activeAgentSummary
    ? sessionMode({ target: "plan", status: activeAgentSummary.status, held: activeAgentSummary.held, revising: waiting, revisions: activeAgentSummary.revisions, runState: activeAgentSummary.runState })
    : null;
  const activeAgentPlanState = useStableValue(activeAgentSummary ? {
    label: activeAgentMode?.label ?? "Plan",
    kind: activeAgentMode?.kind ?? "plan",
    held: activeAgentSummary.held,
    toReview: threadComments.filter((c) => c.status === "resolved").length,
  } : null);
  const activeAgentModel = useStableValue(session?.model ? { model: session.model, effort: session.effort ?? null } : null);
  // ── The plan's chrome: the bundles the Plan pane (components/plan) reads
  // — the footer's verbs, classic's notices, the ⋯ menu, the version pill
  // and the contents toggle. The terminal they point at is the session's
  // agent terminal.
  const planChromeTerminalId = activeId ? sessionTerminals.get(activeId) ?? null : null;
  const planChromeAuthor = agentLabelFor(session?.backend ?? null);
  const planViewing =
    isViewingHistorical && viewedRevision && latest
      ? {
          viewing: viewedRevision.versionNumber,
          latest: latest.versionNumber,
          receivedAt: viewedRevision.receivedAt,
          onGoToLatest: () => setViewedVersionNumber(null),
        }
      : null;
  const planContents = { open: tocOpen, onToggle: tocEligible ? () => setTocOpen(!tocOpen) : null };
  // A restore running or failed shows ITS terminal (the resumed CLI), else
  // the session's; the notices offer it from both the running and the
  // failed notice, as classic's banner did.
  const restoreTerminalId = attemptHere?.terminalId ?? restoreFailure?.terminalId ?? null;
  const planShowTerminal = planChromeTerminalId || restoreTerminalId
    ? () => { void showRawTerminal(restoreTerminalId ?? planChromeTerminalId); }
    : null;
  const planFooter = {
    author: planChromeAuthor,
    canSubmit,
    canApprove,
    waiting,
    waitingAsk,
    onSubmit: submitReview,
    onApprove: approvePlan,
    onApproveLater: () => void approvePlanLater(),
    approval:
      session?.status === "approved"
        ? {
            version: session.revisions[session.revisions.length - 1]?.versionNumber ?? 1,
            runState: activeRunState,
            // The plan's own agent at work in its terminal after
            // Approve & build.
            building: activeRunState === null && !!planChromeTerminalId && terminalKinds.get(planChromeTerminalId) === "working",
          }
        : null,
    buildTargets,
    onBuild: (id: string) => void buildApproved(id),
    onReopen: () => void reopenApproved(),
    planState: session ? { status: session.status, runState: activeRunState, held: activeHeld } : undefined,
    onSetPlanState: session ? (state: ManualPlanState) => { void setPlanState(session.sessionId, state); } : undefined,
    onMoveProject: session ? () => { void openMovePlan(session.sessionId); } : undefined,
    terminals: planChromeTerminalId ? 1 : 0,
    onShowTerminal: planShowTerminal ?? undefined,
  };
  // Classic's plan-pane notices, every one (components/plan/PlanNotices).
  const planNotices = {
    askModeViolation,
    onDismissAskMode: () => setAskModeViolation(false),
    warning,
    onDismissWarning: () => setWarning(null),
    detached: detached
      ? {
          restoring,
          status: restoreStatus,
          failure: restoreFailure?.error ?? null,
          // The automatic resume's own state (lib/autoResume), and the way
          // to stop it: Dismiss and Copy resume command both mean "I'll
          // take it from here".
          auto: autoNoticeHere,
          onStopAuto: () => { if (activeId) autoResume.cancel(activeId); },
          copy: detachedCopy,
          stillRunning: activeId ? agentStillRunning(activeId) : null,
          decision: restoreDecision,
          onHarness: (h: RestoreHarness) => activeId && setHarnessChoices((prev) => ({ ...prev, [activeId]: h })),
          blockers: restoreBlockers,
          onFix: applyReadinessFix,
          onRestore: restorePlanSession,
          onCopyResume: copyRestoreCommand,
          onDismiss: () => setDetachDismissed(true),
        }
      : null,
    onViewPrior: setViewedVersionNumber,
  };
  // The top bar's "what is open · where" (D26): a plan by its name and its
  // project, a joined room by its title, Home as Home, a launch by its
  // project while its first plan is on the way.
  const topBarTitle: { title: string; project: string | null } = (() => {
    if (joinedActive && joinedInfo) return { title: joinedInfo.title || "Live session", project: null };
    if (activeSummary) return { title: activeSummary.titleOverride || activeSummary.planTitle || activeSummary.projectName || "Plan", project: activeSummary.projectName || null };
    if (wbLaunchId) {
      const launch = flowLaunches.find((l) => l.launchId === wbLaunchId);
      const project = launch?.projectPath?.split("/").filter(Boolean).pop() ?? null;
      return { title: "New plan", project };
    }
    return { title: "Home", project: null };
  })();
  // The status bar's two chips that came down from the top bar (D26).
  const footerMemory = { onOpenMemory: () => selectSurface("memory"), onOpenInspector: () => setMemoryInspectorOpen(true) };
  const footerLive = {
    canInvite: sessionReady && !!latest,
    collabActive: !!collabShare || !!joinedRoom,
    onInvite: () => setInviteOpen(true),
    onJoinSession: () => setJoinOpen(true),
    // The room on screen — what the strip under the header used to list.
    presence:
      joinedActive && joinedPresence && joinedRoom && !joinedRoom.revoked
        ? { handle: joinedPresence, role: "collaborator" as const, onEnd: leaveJoined }
        : !joinedActive && sharePresence && collabShare && activeId === collabShare.sessionId
          ? { handle: sharePresence, role: "owner" as const, onEnd: stopShare, onRevokePeer: (inviteHash: string) => revokeByHash(inviteHash) }
          : null,
  };
  // Classic's Download and Live Session menus, as the plan's ⋯.
  const planMenu = {
    onExport: exportRevision,
    onExportDocx: exportRevisionDocx,
    onSaveObsidian: saveRevisionToObsidian,
    onShare: () => setShareOpen(true),
    onInvite: surfaceEnabled(effectiveWorkspace, "collab") ? () => setInviteOpen(true) : null,
    onMove: openMovePlan,
  };
  // ── The centre's panes (W6: `workbench/panes/*`) ──────────────────────────
  // The plan body: mounted once, in `planHost`, and the drafter's spring
  // fades it where the door was.
  const planBody = (
    <PlanBody
      docScrollerRef={docScrollerRef}
      documentRef={documentRef}
      tocDocked={tocDocked}
      tocRailW={tocRailW}
      tocDragging={tocDragging}
      docSurfaceActive={docSurfaceActive}
      docWide={docWide}
      docMeasure={docMeasure}
      joinedRoom={joinedRoom}
      collaboratorCollab={collaboratorCollab}
      collabComments={collabComments}
      yjsBackend={yjsBackend}
      joinedActive={joinedActive}
      leaveJoined={leaveJoined}
      shellReady={shellReady}
      plateMoving={bootAnimating}
      activeId={activeId}
      sessionReady={sessionReady}
      isViewingHistorical={isViewingHistorical}
      viewedRevision={viewedRevision}
      historicalDiff={historicalDiff}
      latest={latest}
      focusedCommentId={focusedCommentId}
      focusNonce={focusNonce}
      handleHighlightClick={handleHighlightClick}
      setViewedVersionNumber={setViewedVersionNumber}
      sections={sections}
      latestComments={latestComments}
      threadRevisions={threadRevisions}
      addEditorComment={addEditorComment}
      updateComment={updateComment}
      deleteComment={deleteComment}
      planActionsRef={planActionsRef}
      lockedEditToast={lockedEditToast}
      ownerCollab={ownerCollab}
    />
  );
  // A door tab converting into review, Localhost or Memory springs out of
  // the island's box (the drafter has its own spring, the browser none: a
  // native webview ignores transforms).
  const spring = (pane: AnyPane, body: ReactNode): ReactNode =>
    swapFrom && convertedPaneRef.current === pane.id && pane.kind !== "drafter" && pane.kind !== "browser"
      ? <SpringSwap from={swapFrom} onArrived={() => { convertedPaneRef.current = null; setSwapFrom(null); }}>{body}</SpringSwap>
      : body;
  const openReviewTerminal = (cwd: string | null, command?: string) => {
    suppressTerminalRevealFocus();
    void openTerminal(cwd).then(async id => {
      if (!id) { setToast("Couldn't open a terminal", 6000); return; }
      if (command) {
        const result = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: command }]);
        if (!result.ok) setToast(`Couldn't prepare the command: ${result.reason}`, 6000);
      }
    }).catch(error => setToast(`Couldn't open a terminal: ${String(error)}`, 6000));
  };
  // What the Agent pane of the open session's own terminal is told.
  const agentFacts = {
    activeId,
    backend: session?.backend ?? null,
    projectPath: session?.projectPath ?? null,
    summary: activeAgentSummary,
    pendingMarks: pendingComments.length,
    planMarkdown: latest?.rawPlanMarkdown ?? null,
    planState: activeAgentPlanState,
    fallbackModel: activeAgentModel,
  };
  const renderPane = (pane: AnyPane, ctx: PaneContext): ReactNode => {
    switch (pane.kind) {
      case "door":
        // At rest (a split's other pane) the door shows its box and its
        // recents; a press there focuses it and the island lands.
        return <DoorPane ctx={ctx} draftKey={pane.data.draftKey} recents={doorRecentItems} onWake={() => wb.dispatch({ type: "focusPane", paneId: pane.id })} onOpenRecent={openDoorRecent} />;
      case "plan":
        return (
          <PlanPaneView
            pane={pane}
            ctx={ctx}
            host={planHost}
            holder={singletonHolder(wb.getState(), "plan", planHolder)}
            bring={setPlanHolder}
            chrome={{ sessionId: activeId, session, latestVersion: latest?.versionNumber ?? null, comments: threadComments, viewing: planViewing, contents: planContents, footer: planFooter, notices: planNotices, planMenu, onShowTerminal: planShowTerminal }}
          />
        );
      case "file":
        return <FilePane data={pane.data} preview={!!pane.preview} onPin={() => wb.dispatch({ type: "pinPane", paneId: pane.id })} onClose={handleCloseFile} onSaved={toastSaved} />;
      case "browser":
        return <BrowserPaneView host={browserHost} pane={pane} ctx={ctx} holder={browserHeld} bring={setBrowserHolder} />;
      case "chat": {
        if (pane.data.source === "companion") return <CompanionPane host={chatHost} ctx={ctx} />;
        const kind = terminalKinds.get(pane.data.terminalId);
        // The wall's own derivation when it has one (a dead agent reads
        // exited there, never its last hook's needs-you); a PTY gone from the
        // live list exited; else the hooks.
        const derived = termStatuses.get(pane.data.terminalId)?.state ?? null;
        const agentTerm = pane.data.terminalId;
        // A launch stopped before its plan reads exited too: its Agent pane
        // shows the stopped strip with Retry.
        const ptyGone = (!!liveTermIds && !liveTermIds.includes(agentTerm)) || flowLaunches.some((l) => l.terminalId === agentTerm && l.stopped);
        return (
          <AgentPaneView
            data={pane.data}
            ctx={ctx}
            facts={agentFacts}
            launches={flowLaunches}
            liveTermIds={liveTermIds}
            termState={ptyGone ? "exited" : derived ?? (kind === "needs-you" ? "needs-you" : kind === "working" ? "working" : null)}
            planOpen={view.visibleKinds.includes("plan")}
            talking={voiceDocked}
            onCliView={setCliView}
            handlers={agentPaneHandlers}
          />
        );
      }
      case "terminals":
        return <TerminalsPane paneId={pane.id} ctx={ctx} />;
      case "drafter":
        return (
          <DrafterPane
            drafterSessionCache={drafterSessionCache}
            drafterLoaded={drafterLoaded}
            setDrafterLoaded={setDrafterLoaded}
            drafterDraftId={drafterDraftId}
            setDrafterDraftId={setDrafterDraftId}
            drafterOpenIds={drafterOpenIds}
            closeDrafterDoc={closeDrafterDoc}
            drafterShelfOpen={drafterShelfOpen}
            setDrafterShelfOpen={setDrafterShelfOpen}
            agentShelfOpen={agentShelfOpen}
            setAgentShelfOpen={setAgentShelfOpen}
            drafterProject={drafterProject}
            drafterProjectPath={drafterProjectPath}
            setDrafterProjectPath={setDrafterProjectPath}
            getDrafterLiveMarkdown={getDrafterLiveMarkdown}
            shelfRunLive={shelfRunLive}
            setToast={setToast}
            drafterRecovery={drafterRecovery}
            setDrafterRecovery={setDrafterRecovery}
            drafterOpening={drafterOpening}
            swapFrom={swapFrom}
            setSwapFrom={setSwapFrom}
            quietOpen={quietOpen}
            leaving={planBody}
            drafterDiscussionSlot={drafterDiscussionSlot}
            discussionShown={!paneCollapsed && railTab === "discussion" && railKind === "drafter"}
            showDrafterDiscussion={showDrafterDiscussion}
            drafterPersist={drafterPersist}
            projectOptions={projectOptions}
            launchFromDrafter={launchFromDrafter}
            readiness={readiness}
            applyReadinessFix={applyReadinessFix}
            pendingLaunch={pendingLaunch}
            setPendingLaunch={setPendingLaunch}
            drafterSources={drafterSources}
            attachDrafterFiles={attachDrafterFiles}
            removeDrafterSource={removeDrafterSource}
            drafterTemplates={drafterTemplates}
            useDrafterTemplate={useDrafterTemplate}
            onExit={() => closeSurfacePane("drafter")}
            drafterSaveState={drafterSaveState}
            consumeLandingSeed={consumeLandingSeed}
            registerDrafterLiveMarkdown={registerDrafterLiveMarkdown}
          />
        );
      case "review":
        return spring(pane, <ReviewPane review={codeReview} projectOptions={projectOptions} onOpenTerminal={openReviewTerminal} onClose={() => closeSurfacePane("review")} focusPath={reviewFocus} />);
      case "servers":
        return spring(pane, <ServersPane scan={devServers.scan} error={devServers.error} onRefresh={devServers.refresh} onStop={devServers.stopServer} onPlanStop={devServers.planStop} projectOptions={projectOptions} onRun={runDevServer} onOpenUrl={openUrlInBrowser} />);
      case "memory":
        return spring(pane, <MemoryPane activeSessionId={session?.sessionId ?? null} activeSessionName={session?.projectName ?? null} tabRequest={stageSurface === "memory" ? tabRequest : null} />);
    }
  };
  return (
    <MenuOverlayProvider value={adjustMenuOverlay}>
    <MonochatContext.Provider value={monochatRouting}>
    <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden">
      <FlashOverlay seq={flashSeq} color={flashColor} />
      {/* Error containment: each independent region gets its own boundary so
          a render throw stays inside it. The terminal dock is deliberately a
          SIBLING of every wrapped region — a crash elsewhere must never
          unmount a TerminalView (its cleanup kills the PTY session). */}
      <ErrorBoundary
        region="session header"
        fallback={(_err, reset) => (
          <div
            className="flex items-center justify-center gap-2 px-4 py-2"
            style={{
              borderBottom: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            <span>The header hit a rendering error.</span>
            <button
              type="button"
              onClick={reset}
              style={{ textDecoration: "underline", cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        )}
      >
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
        // The top bar (D26, RLTopBar): what is open and where, the two
        // toggles, the command field, the sessions waiting on you, the gear.
        title={topBarTitle.title}
        project={topBarTitle.project}
        // The harness chip's successor: the harness's name in the project's
        // place, its exit the palette's "Exit …" (none for a boot entry: a
        // flavored build IS its harness, so its name is where you are).
        harnessName={activeHarness ? activeHarness.manifest.name : null}
        sidebarOpen={!sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        railOpen={!paneCollapsed}
        onToggleRail={togglePane}
        onOpenPalette={() => setPaletteOpen(true)}
        needsYou={termNeedYou}
        onJumpToNeedsYou={jumpToNeedsYou}
        onOpenIntegrationHooks={hookConflicts.openDialog}
        theme={theme}
        onThemeChange={onThemeChange}
        font={font}
        onFontChange={onFontChange}
        lint={lint}
        onLintChange={onLintChange}
        mode={mode}
        onModeChange={changeMode}
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
        // In harness mode the panel is a lens on the HARNESS's arrangement
        // (updateWorkspace already routes writes there) — the stock manifest
        // stays untouched until exit.
        surfacesPanel={
          <SurfacesPanel
            workspace={effectiveWorkspace}
            onUpdate={updateWorkspace}
            harnessName={activeHarness ? activeHarness.manifest.name : null}
          />
        }
      />
      <HookConflictWarning health={hookConflicts} />
      {decisionWindow && (
        <Suspense fallback={null}>
          <DecisionWindowBanner
            event={decisionWindow}
            onOpen={openDecisionForReview}
            onApprove={approveFromDecision}
            onExpire={dismissDecisionWindow}
            raised={frontDoorOpen}
          />
        </Suspense>
      )}
      </ErrorBoundary>
      {/* The columns run to the window's edges (D38): no hull ring, no
          inset cards. Fullscreen takeovers (terminal, discussion) are
          absolute inset-0 against this element. */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col">
        <ErrorBoundary
          region="content area"
          fallback={(err, reset) => (
            <div className="flex-1 overflow-hidden flex items-center justify-center">
              <BoundaryFallback
                region="content area"
                error={err}
                reset={reset}
              />
            </div>
          )}
        >
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex">
        {!sidebarCollapsed && (
        // Clip wrapper for the drawer reveal. In curtain state (the doc is at
        // its floor) it reserves only the flow width and lets the full-width
        // aside spill right OVER the doc, painted above it.
        <div
          ref={sidebarClipRef}
          className="shrink-0 rl-sidebar-clip rl-plate"
          data-rl-pane
          // No `width` here on purpose: `applyLiveLayout` owns it, so a drag
          // frame never has to go through React and React never clobbers a
          // live value. Same for the aside and the dock below.
          style={{
            display: "flex",
            justifyContent: "flex-start",
            transition: sidebarSettling ? "width 160ms ease" : undefined,
          }}
        >
        <aside
          ref={sidebarAsideRef}
          data-tour="sessions"
          className="flex flex-col shrink-0 rl-sidebar-aside"
        >
          {/* One sidebar: the folder tabs went with W4 — a folder's tree is
              the rail's Files tab now. */}
          {(
            // Chunk warmed by the boot effect; null while it lands — the house
            // rule is a quietly blank plate, never a spinner.
            <Suspense fallback={null}>
            <SessionSidebar
              {...sidebarHandlers}
              {...flowSidebarHandlers}
              {...flowSidebarData}
              sessions={summaries}
              activeId={activeId}
              pendingCounts={pendingPerSession}
              joined={joinedInfo}
              onLeaveJoined={leaveJoined}
              onNewPlan={openFrontDoor}
              viewedVersionNumber={viewedVersionNumber}
              unseenIds={unseenPlanIds}
              arrivalGlow={arrivalGlow}
              place={sidebarPlace}
              localhostPorts={sidebarPorts}
              servers={devServers.scan?.running}
              terminals={sidebarTerminals}
              homeTerminals={sidebarTerminals[""]}
            />
            </Suspense>
          )}
        </aside>
        {/* In curtain state the flow boundary sits under the spilled aside, so
            the divider rides the curtain's visible right edge instead. */}
        {liveFlags.curtainL && (
          <div
            ref={sidebarCurtainDivRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              zIndex: 26,
              display: "flex",
            }}
          >
            <PaneDivider
              side="leading"
              label="sidebar"
              collapsed={sidebarCollapsed}
              dragging={sidebarDragging}
              onPointerDown={startSidebarDrag}
            />
          </div>
        )}
        </div>
        )}
        {/* The folded sidebar: its icon pose (D18), reserved in flow by
            `computePaneLayout`'s sidebar edge. */}
        {sidebarCollapsed && (
          <Suspense fallback={<div className="shrink-0" style={{ width: `${SIDEBAR_EDGE_W}px` }} />}>
            <SidebarEdge
              place={sidebarPlace}
              sessions={sidebarEdgeSessions}
              onPlace={sidebarHandlers.onSelectPlace}
              onSession={sidebarHandlers.onSelect}
            />
          </Suspense>
        )}
        {/* The seam (D38): always in flow, one 1px rule that is also the
            drag handle. When the sidebar curtains it is painted over, and the
            absolute copy above carries the drag at the curtain's visible
            edge. No collapse pill: folding is ◧ in the top bar, ⌘B, the
            palette, or a drag past the sidebar's minimum. */}
        <PaneDivider
          side="leading"
          label="sidebar"
          collapsed={sidebarCollapsed}
          dragging={sidebarDragging}
          onPointerDown={startSidebarDrag}
        />
        <div
          ref={docColumnRef}
          className={`min-h-0 min-w-0 flex-1 overflow-hidden flex relative rl-doc-column${browserOpen ? "" : " rl-plate"}`}
          style={{ background: "var(--color-paper)" }}
        >
          {/* The document region: everything the doc column used to hold
              directly. The column itself is now a ROW — content here, the
              voice panel docked beside it — so the panel shrinks the document
              instead of painting over it, exactly as the discussion sidecar
              already shrinks the whole column.

              `relative` matters: the TOC rail, the Contents button, the
              Discuss pill and the zoom control all anchor HERE rather than to
              the outer column, which is what keeps the right-hand zoom control
              from sliding back underneath the voice panel. `min-w-0` lets the
              plan's long code lines actually shrink instead of jamming the
              flex row open.

              Its children are deliberately NOT re-indented — a whole-block
              shift would bury this change in ~530 lines of whitespace diff. */}
          {/* `--rl-doc-zoom` lives HERE, on the common ancestor of every
              surface body — not on the plan's <article>, where it used to sit.
              `.rl-prose { font-size: calc(15px * var(--rl-doc-zoom, 1)) }` was
              therefore inert in the Drafter, whose body is a SIBLING of that
              article: ⌘+/⌘−/⌘0 have been global bindings all along and simply
              did nothing on this surface. One level up and they work.

              The sheet grows with the type, as Word does — a page that stays
              816px while the words get bigger just gives you fewer words per
              line, which is the opposite of what zoom is for. */}
          <div
            className="rl-surface-pane flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative"
            data-main-surface={stageSurface}
            // The docked Contents rail's width, for what sits beside it
            // outside the plan's scroller: the Plan pane's notices.
            style={{ "--rl-doc-zoom": docZoom, "--rl-toc-docked": tocDocked ? `${tocRailW}px` : "0px" } as React.CSSProperties}
          >
          {/* The Contents rail docks beside a Plan pane on screen (its button
              when closed); another tab has no document to index. */}
          <PlanContentsRail
            shown={tocEligible && view.visibleKinds.includes("plan")}
            tocOpen={tocOpen}
            setTocOpen={setTocOpen}
            tocWide={tocWide}
            setTocWide={setTocWide}
            tocRailW={tocRailW}
            tocDragging={tocDragging}
            setTocDragging={setTocDragging}
            tocRailRef={tocRailRef}
            tocBtnRef={tocBtnRef}
            docScrollerRef={docScrollerRef}
            displaySections={displaySections}
          />
          {/* The workbench: the active set's tabs, each pane its body from
              `workbench/panes/*` in a kind-named boundary (WorkbenchStage).
              Singleton bodies (the plan, the browser, the companion chat)
              mount once, in their portals below; a pane shows only a slot. */}
          <Suspense fallback={null}>
            <WorkbenchStage
              store={wb}
              renderPane={renderPane}
              describePane={describePane}
              onNewTab={openDoorTab}
              onCloseTab={closeTabRequest}
              onSplit={splitFocusedWithDoor}
              onClosePane={closePaneRequest}
              room={stageRoom}
              onNoRoom={noRoomHint}
              right={stageActions}
            />
          </Suspense>
          {/* Floating document zoom + line-width control over a document on
              screen — the Plan pane or the drafter, never over an Agent tab
              or a browser (workbench/panes/docControls). */}
          {(stageSurface === "document" ? docSurfaceActive : drafterOpen) &&
            plateMode !== "file" &&
            (view.visibleKinds.includes("plan") || view.visibleKinds.includes("drafter")) && (
            <DocZoomControl
              zoomCtrlRef={zoomCtrlRef}
              zoomColumn={zoomColumn}
              docZoom={docZoom}
              zoomIn={zoomIn}
              zoomOut={zoomOut}
              zoomReset={zoomReset}
              docWide={docWide}
              docMeasure={docMeasure}
              documentRef={documentRef}
              setDocWide={setDocWide}
              setDocMeasure={setDocMeasure}
            />
          )}
          </div>
        </div>

        {!paneFullscreen && (
          // The seam (D38): one 1px rule in flow that is also the drag
          // handle; when the rail curtains it is painted over and the copy
          // inside the pane wrapper carries the drag at the curtain's edge.
          // Folded, the edge strip keeps it as its rule; dragging it pulls
          // the rail back open.
          <PaneDivider
            collapsed={paneCollapsed}
            dragging={isDragging}
            onPointerDown={startDrag}
          />
        )}

        {!paneCollapsed && (
        // Clip wrapper for the drawer reveal. In fullscreen it's display:contents
        // (no box) so the absolute overlay aside is unaffected; otherwise it's a
        // flex clip whose width tracks the live pane width while the aside inside
        // stays pinned at min and is revealed from the right.
        <div
          ref={paneClipRef}
          className={paneFullscreen ? undefined : "rl-pane-clip rl-plate"}
          data-rl-pane={paneFullscreen ? undefined : ""}
          style={
            paneFullscreen
              ? { display: "contents" }
              : {
                  display: "flex",
                  justifyContent: "flex-end",
                  flexShrink: 0,
                  transition: paneSettling ? "width 160ms ease" : undefined,
                }
          }
        >
        {/* Curtain state: the divider copy rides the curtain's visible left
            edge (the in-flow divider is painted over). */}
        {!paneFullscreen && liveFlags.curtainR && (
          <div
            ref={paneCurtainDivRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              zIndex: 26,
              display: "flex",
            }}
          >
            <PaneDivider
              collapsed={paneCollapsed}
              dragging={isDragging}
              onPointerDown={startDrag}
            />
          </div>
        )}
        <aside
          ref={(el) => {
            (sidebarRef as React.MutableRefObject<HTMLElement | null>).current =
              el;
            paneAsideRef.current = el;
          }}
          data-context={discussionContext}
          className={
            paneFullscreen
              ? "absolute inset-0 z-30 overflow-hidden rl-discussion"
              : "overflow-hidden shrink-0 rl-discussion rl-pane-aside"
          }
          style={
            {
              // No border of its own: docked, the pane-clip's plate chrome owns
              // the edge; curtained, the CSS curtain rules dress this aside as
              // the plate (an inline borderColor here would override them).
              background: "var(--color-paper)",
              // Curtain state (read as painted above the doc) is a CSS rule on
              // `.rl-pane-clip[data-rl-curtain] .rl-pane-aside` — see
              // styles.css. Width is owned by `applyLiveLayout`; fullscreen
              // clears it so the aside fills its absolute box.
              // One place to drive every discussion's text size — descendants
              // read `--rl-discussion-zoom` via CSS, so the A−/A+ controls never
              // re-render the comment list. (Safe as a custom property: it is
              // set on the aside, not the root, and only when the user zooms.)
              "--rl-discussion-zoom": discussionZoom,
            } as React.CSSProperties
          }
        >
          {/* The rail (W4): its tab strip over the one tab shown. Only that
              tab's body is mounted, so a tab off screen polls nothing. The
              strip's ⤢ is the old pane's fullscreen; ◨ folds it to the edge
              strip. Quiet while the chunk lands, like every lazy plate. */}
          <Suspense fallback={<div style={{ height: "34px", background: "var(--color-canvas)" }} />}>
          <RightRail
            tabs={railTabs}
            active={railTab}
            onSelect={selectRailTab}
            counts={railCounts}
            attention={railAttention}
            talkKey={dockContext?.key ?? null}
            fullscreen={paneFullscreen}
            onToggleFullscreen={() => setPaneFullscreen(!paneFullscreen)}
          >
          {railTab !== "discussion" ? railOtherBody : railKind === "drafter" ? (
            // The draft's threads: PromptDrafter portals its sidecar in.
            <div ref={setDrafterDiscussionSlot} className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden" data-rail-drafter-discussion />
          ) : discussionContext === "plan" && (railKind === "plan" || railKind === "review") && session && planDiscussable ? (
            // "Refinement": the plan's threads in four piles — Waiting on you,
            // Your marks, With Claude, Resolved — each the classic comment
            // card with App's own handlers, under the composer, the revising
            // notice and the action-item chips.
            <DiscussionZoomContext.Provider value={adjustDiscussionZoom}>
            <Suspense fallback={null}>
            <FeedbackPanel
              session={session}
              viewingVersion={railShownVersion}
              onJumpToAnchor={(_anchorId, commentId) => {
                if (commentId) focusComment(commentId);
              }}
              onOpenVersion={(v) => setViewedVersionNumber(v === latest?.versionNumber ? null : v)}
              focusedCommentId={focusedCommentId}
              composer={null}
              lead={
                <>
                {commentComposer}
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
                      onClick={revealTerm}
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
            {/* Pin "Action items" (Claude's resolutions awaiting accept/
                    reopen) at the top of the pane so the affordance is visible
                    even when the "Claude is revising" banner sits above the
                    regular cards. Clicking a pill focuses + scrolls to the card
                    with the buttons. */}
                {(() => {
                  // The action chips: each answer waiting on you as an amber
                  // pill (a click brings its card up, on the version it was
                  // made on), and the marks riding the next Send.
                  const actionItems = threadComments.filter(
                    (c) => c.status === "resolved",
                  );
                  if (actionItems.length === 0 && !canSubmit) return null;
                  return (
                    <div className="rl-fb-chips" aria-label="Action items">
                      {actionItems.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="rl-fb-chip"
                          data-tone="waiting"
                          onClick={() => {
                            // Clean slate: the card may live on an earlier
                            // version — navigate there before focusing it.
                            const v = commentVersionById.get(c.id);
                            if (v !== undefined) {
                              setViewedVersionNumber(
                                v === latest?.versionNumber ? null : v,
                              );
                            }
                            focusComment(c.id);
                          }}
                          title={`Jump to ${c.id} — Accept or Reopen the resolution`}
                        >
                          {c.type === "question" ? "Answer" : "Accept"} {c.id}
                        </button>
                      ))}
                      {canSubmit && (
                        <button type="button" className="rl-fb-chip" onClick={() => void submitReview()} disabled={busy} title="Send your marks to the agent">
                          Send {pendingComments.length} {pendingComments.length === 1 ? "mark" : "marks"}
                        </button>
                      )}
                    </div>
                  );
                })()}
                </>
              }
              empty={composing ? null : (() => {
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
              renderCard={(p) => (
              <CommentCard
                key={`${session?.sessionId ?? ""}-${p.comment.id}`}
                sessionId={session?.sessionId ?? ""}
                backend={session?.backend ?? null}
                comment={p.comment}
                focused={focusedCommentId === p.comment.id}
                autoOpen={autoOpenCommentId === p.comment.id}
                onAutoOpenConsumed={clearAutoOpen}
                autoDiscuss={autoDiscussCommentId === p.comment.id}
                onAutoDiscussConsumed={clearAutoDiscuss}
                onViewResearch={viewResearch}
                onSelect={p.version === railShownVersion ? commentCallbacks.onSelect : (id: string) => {
                  // A thread from an earlier round is read where it was
                  // written: that version first, then the comment on it.
                  setViewedVersionNumber(p.version === latest?.versionNumber ? null : p.version);
                  focusComment(id);
                }}
                onDelete={commentCallbacks.onDelete}
                onUpdate={commentCallbacks.onUpdate}
                onAccept={commentCallbacks.onAccept}
                onAcceptSuggestion={commentCallbacks.onAcceptSuggestion}
                onReopen={commentCallbacks.onReopen}
                onPromote={commentCallbacks.onPromote}
                submitInFlight={busy}
              />
              )}
            />
            </Suspense>
            </DiscussionZoomContext.Provider>
          ) : (
          <div className="rl-rail-scroll rl-thin-scroll-y">
          {(discussionContext === "review" || (reviewOpen && planDiscussionAvailable)) && (
          <div
            className="rl-chrome-label sticky top-0 z-10 px-4 py-2 border-b flex items-center justify-between gap-2"
            style={{
              borderColor: "var(--color-rule)",
              background: "var(--color-paper)",
            }}
          >
            <span className="flex items-center gap-2">
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
            </span>
          </div>
          )}
          <div className="p-4 flex flex-col gap-3">
            {discussionContext === "review" ? (
              <Suspense fallback={null}>
                <ReviewDiscussionPane review={codeReview} />
              </Suspense>
            ) : (
              <div className="italic" style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
                A plan's discussion shows here once the plan arrives.
              </div>
            )}
          </div>
          </div>
          )}
          </RightRail>
          </Suspense>
        </aside>
        </div>
        )}
        {/* The folded rail: its tabs as icons down a 40px strip (the mic
            among them), reserved in flow by `computePaneLayout`'s edge. */}
        {paneCollapsed && (
          <Suspense fallback={<div className="shrink-0" style={{ width: `${RAIL_EDGE_W}px` }} />}>
            <RailEdge tabs={railTabs} counts={railCounts} attention={railAttention} talkKey={dockContext?.key ?? null} onOpen={openRailTab} />
          </Suspense>
        )}
        </div>
        </ErrorBoundary>

        {/* The terminal layer, inside <main> once and for good: absolutely
            positioned against it, it pins itself over the terminals pane or
            the Agent pane's CLI view on screen (workbench/TerminalLayer). */}
        <div className="contents">
          {/* Mounted once and never unmounted: the terminals' PTYs and their
              scrollback die with it, so a tab or surface change must never
              take it away. */}
          {shellReady && (
            <Suspense fallback={null}>
              <AttentionAlerts
                store={wb}
                summaries={summaries}
                termStatuses={termStatuses}
                terminalAttention={terminalAttention}
                liveTermIds={liveTermIds}
                sessionTerminals={sessionTerminals}
                sessionLabels={sessionLabels}
                chats={chats}
                onReveal={revealAlert}
              />
            </Suspense>
          )}
          {terminalMounted && (
          <Suspense fallback={null}>
          <TerminalLayer
            ref={attachTerminals}
            store={wb}
            theme={theme}
            onTabsChange={setTermTabCount}
            onTabIdsChange={setLiveTermIds}
            onAdopted={handleAdopted}
            onNeedsYouChange={setTermNeedYou}
            onStatesChange={setTermStatuses}
            cli={cliView}
            sessionLabels={sessionLabels}
            agentSessions={agentSessions}
            onSessionAction={terminalSessionAction}
            onActiveTabChange={setActiveTermId}
            onFocusedCwd={handleFocusedCwd}
            watchIds={waitingLaunchIds}
            onProcs={noteLaunchProcs}
            heldTerminalIds={heldTermIds}
            heldPlanTitles={heldPlanTitles}
            projectOptions={projectOptions}
          />
          </Suspense>
          )}
        </div>
      </main>
      <ErrorBoundary
        region="status bar"
        fallback={(_err, reset) => (
          <div
            className="flex items-center justify-center gap-2 px-4 py-1"
            style={{
              borderTop: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            <span>The status bar hit a rendering error.</span>
            <button
              type="button"
              onClick={reset}
              style={{ textDecoration: "underline", cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        )}
      >
      {/* The status bar (W6, D27): Memory, a waiting review, the live
          session and the bridge; no status text and no pill. Its 28px are
          held while its chunk lands. */}
      <Suspense fallback={<div className="rl-app-footer rl-statusbar" aria-hidden />}>
      <Footer
        memory={surfaceEnabled(effectiveWorkspace, "memory") ? footerMemory : null}
        live={surfaceEnabled(effectiveWorkspace, "collab") ? footerLive : null}
        reviewNews={reviewNews === "review" ? "Review ready" : null}
        onOpenReviewNews={() => selectSurface("review")}
        bridge={daemonState}
      />
      </Suspense>
      </ErrorBoundary>
      {/* The trailing modal/overlay cluster: a crash in any dialog collapses
          to a quiet toast instead of taking down the app tree. */}
      <ErrorBoundary
        region="toast"
        fallback={(_err, reset) => (
          <div
            className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded shadow-lg"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink)",
              fontSize: "12px",
            }}
          >
            <span>A dialog hit a rendering error and was closed.</span>
            <button
              type="button"
              onClick={reset}
              style={{ textDecoration: "underline", cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        )}
      >
      {selection && !composing && !planSearch && !isViewingHistorical && (
        <SelectionMenu
          rect={selection.rect}
          onPick={beginCompose}
          onCrossOut={beginCrossOut}
          onSearch={beginPlanSearch}
        />
      )}
      {planSearch && (
        <PlanSearchBar
          rect={planSearch.selection.rect}
          selectedText={planSearch.selection.text}
          onSubmit={runPlanSearch}
          onCancel={() => setPlanSearch(null)}
        />
      )}
      {movePlan && <Suspense fallback={null}><MoveToRepoDialog markdown={movePlan.revisions[movePlan.revisions.length - 1]?.rawPlanMarkdown ?? ""}
        currentProject={movePlan.projectPath} options={projectOptions}
        onCancel={() => setMovePlan(null)} onConfirm={path => moveSessionProject(movePlan.sessionId, path)}/></Suspense>}
      {sendConfirm && (
        <Suspense fallback={null}>
        <SendToRedlineDialog
          markdown={sendConfirm.markdown}
          options={projectOptions}
          initialProject={sendConfirm.initialProject}
          onConfirm={confirmSendToRedline}
          pending={sendPending}
          error={sendError}
          onCancel={() => { if (!sendPendingRef.current) setSendConfirm(null); }}
          destination={sendConfirm.destination ?? sendConfirm.missionHandoff?.destination ?? "plan"}
          onDestinationChange={sendConfirm.source ? destination => setSendConfirm(s => s && ({ ...s, destination })) : undefined}
          onMarkdownChange={sendConfirm.missionHandoff ? undefined : markdown => setSendConfirm(s => s && ({ ...s, markdown }))}
          onReturnToSource={sendConfirm.source ? () => {
            const source = sendConfirm.source!; setSendConfirm(null);
            if (source.conversationKind === "companion") openChat(source.conversationId);
            else if (source.conversationKind === "drafter") { setDrafterDraftId(source.conversationId); setDrafterShelfOpen(false); selectSurface("drafter"); }
            else { selectSurface("browser"); window.dispatchEvent(new CustomEvent("redline-open-conversation", { detail: source })); }
          } : undefined}
          modelControls={<PlanningModelMenu choice={frontDoorBackend} onChange={setFrontDoorBackend} modelCatalogs={modelCatalogs} modelError={modelErrors[frontDoorBackend.backend]} modelStatus={modelStatus[frontDoorBackend.backend]} onRefresh={() => requestModels(frontDoorBackend.backend, selectedModelIdentity, true)} providerInfo={frontDoorBackend.backend === "claude-code" ? preflight?.claude : frontDoorBackend.backend === "codex" ? preflight?.codex ?? undefined : preflight?.providers?.[frontDoorBackend.backend]} onLocate={() => { void applyReadinessFix({ id: "provider-missing", state: "blocked", label: "Locate planning CLI", detail: "Choose the executable used for planning.", fix: { label: "Change CLI…", kind: frontDoorBackend.backend === "codex" ? "locate-codex" : frontDoorBackend.backend === "claude-code" ? "locate-claude" : "locate-provider", backend: frontDoorBackend.backend } }); }} onOpen={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)} compact={false} />}
        />
        </Suspense>
      )}
      {toast && <RedlineToast key={toast.id} toast={toast} onDismiss={dismissToast} />}
      {inviteOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {joinOpen && (
        <Suspense fallback={null}>
          <JoinDialog
            defaultDisplayName={relayDefaults.displayName}
            onJoin={joinRoom}
            onClose={() => setJoinOpen(false)}
          />
        </Suspense>
      )}
      {shareOpen && session && latest && (
        <Suspense fallback={null}>
          <ShareSnapshotDialog
            sessionId={session.sessionId}
            version={latest.versionNumber}
            ownerName={relayDefaults.displayName}
            currentSections={latest.sections}
            currentMarkdown={latest.rawPlanMarkdown}
            addComment={addEditorComment}
            onNavigateToReturn={(ret) => {
              // Land where the comments actually live: the revision that was
              // current at import time (viewed as latest when they coincide),
              // with the first imported comment scrolled + flashed.
              setShareOpen(false);
              setViewedVersionNumber(
                ret.landedVersion === latest.versionNumber
                  ? null
                  : ret.landedVersion,
              );
              if (ret.commentIds[0]) focusComment(ret.commentIds[0]);
            }}
            onClose={() => setShareOpen(false)}
          />
        </Suspense>
      )}
      {memoryInspectorOpen && (
        <Suspense fallback={null}>
          <MemoryInspector
            onClose={() => setMemoryInspectorOpen(false)}
            activeSessionId={session?.sessionId ?? null}
            activeSessionName={session?.projectName ?? null}
          />
        </Suspense>
      )}
      {showReadme && (
        <Suspense fallback={null}>
          <ReadmeModal onClose={() => setShowReadme(false)} />
        </Suspense>
      )}
      {showFeedback && (
        <Suspense fallback={null}>
          <FeedbackModal onClose={() => setShowFeedback(false)} />
        </Suspense>
      )}
      <MonochatIsland
        clearanceKey={`${bootAnimating}`}
        // The door rests on the focused door pane, wherever it sits in the
        // tab's tree and whatever else the tab shows (`doorLands`).
        landing={doorLands(view) && shellReady && !joinedActive}
        surfaceKey={doorNavKey}
        plateKey={wbLayoutKey}
        onVisibilityChange={setDoorVisible}
        open={frontDoorOpen}
        onOpenChange={setFrontDoorOpen}
        handoff={doorHandoff}
        context={surfaceContextLabel(activeSurface, browserIslandPage?.title) ?? "Front door"}
        announce={doorNews}
      >
        {renderMonochatComposer("door")}
      </MonochatIsland>
      {chatId && createPortal(
            <CompanionRoom
              composer={{ draftKey: FRONT_DOOR_TEXT_KEY, attachments: frontDoorAttachments, onAttachmentsConsumed: () => setFrontDoorAttachments([]), project: frontDoorProject, render: (actions, workbench) => renderMonochatComposer("chat", actions, workbench) }}
              harness={frontDoorBackend}
              modelCatalogs={modelCatalogs}
              onHarnessChange={setFrontDoorBackend}
              onNeedModels={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)}
              onRun={request => { void continueChatAsRun(request); }}
              onReviewChanges={projectPath => { setFrontDoorOpen(false); codeReview.setSource("uncommitted"); void codeReview.openReview(projectPath, "uncommitted"); selectSurface("review"); }}
              target={activeSurface}
              modelControls={<PlanningModelMenu choice={frontDoorBackend} onChange={setFrontDoorBackend} modelCatalogs={modelCatalogs} modelError={modelErrors[frontDoorBackend.backend]} modelStatus={modelStatus[frontDoorBackend.backend]} onRefresh={() => requestModels(frontDoorBackend.backend, selectedModelIdentity, true)} onLocate={() => { void applyReadinessFix({ id: "provider-missing", state: "blocked", label: "Locate conversation harness", detail: "Choose the executable used for conversation.", fix: { label: "Change CLI…", kind: frontDoorBackend.backend === "codex" ? "locate-codex" : "locate-claude", backend: frontDoorBackend.backend } }); }} onOpen={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)} compact={false} allowedBackends={["claude-code", "codex"]}/>}
              // Keyed by the thread: the room's mode and harness
              // are stored per chat and `usePersistedState` reads
              // its key once, so switching conversations is a
              // REMOUNT by design rather than one chat's settings
              // carried into another.
              key={chatId}
              companionId={chatId}
              projectOptions={projectOptions}
              lastLaunchProject={lastLaunchProject}
              onPlan={request => { void continueChatAsPlan(request); }}
              receipt={chatReceipts[chatId] ?? null}
              onQueuePlan={queuedChatPlans.arm}
              queuedInstruction={queuedChatPlans.queued[chatId]?.instruction ?? null}
              onCancelQueuedPlan={() => { queuedChatPlans.cancel(chatId); }}
              onShowTerminal={id => { setFrontDoorOpen(false); void showRawTerminal(id); }}
              onOpenPlan={id => { tripDoor(); selectSessions(); setActiveId(id); selectSurface("document"); setViewedVersionNumber(null); void loadSession(id); }}
              onFix={applyReadinessFix}
                            onSelectChat={openChat}
              onEmpty={() => { setChatId(null); setChatSeed(null); refreshChats(); }}
              // The agent's read-only file tools are scoped to
              // whatever folder the user is browsing; HOME when
              // there is none.
              cwd={chatCwd}
              // The room reads at plate scale; the dock's column at its own.
              expanded={!!chatPane}
              onDraft={markdown => { void sendBrowserToDrafter(markdown); }}
              // Its own toolbar shows in the dock alone (the room wears the
              // door's heading): Close puts the column away, chat and all.
              onClose={closeDock}
              seed={
                chatSeed?.companionId === chatId
                  ? chatSeed.text
                  : null
              }
              seedId={chatSeed?.id}
              seedAutoSend={chatSeed?.autoSend}
              seedTarget={chatSeed?.target}
              seedContext={chatSeed?.companionId === chatId ? chatSeed.context : null}
              onSeedConsumed={() => setChatSeed(null)}
              // The card's pressed chips, read per send. Out of band: the
              // prompt carries them, the bubble only what was typed.
              contextFor={async () => chatAttachment(chatId, await gatherContext("chat"))}
              onContextLost={(why) => forgetSent(chatContextSent.current, chatId, why)}
            />
, chatHost)}
      {activeId && createPortal(
        planSwap ? <SpringSwap key={planSwap.launchId} from={planSwap.from} onArrived={() => setPlanSwap(null)}>{planBody}</SpringSwap> : planBody,
        planHost,
      )}
      {browserMounted && createPortal(
                <BrowserBody
                  {...browserHandlers}
                  onPageContext={setBrowserIslandPage}
                  surfaceActive={browserOpen}
                  visible={browserVisible && !hookConflicts.dialogOpen}
                  // A menu over the page: the pane pictures its pages first,
                  // then steps aside behind the picture, never into a blank.
                  menuOver={openMenuCount > 0}
                  projectDir={sidebarTab.kind === "folder" ? sidebarTab.id : null}
                  // "Open" on a Localhost card. A prop, not an event: this pane
                  // mounts only when the browser surface is selected, so an event
                  // emitted at selection time would beat its own listener.
                  openRequest={browserOpenRequest}
                  ownerKey={browserOwner}
                  // Re-sync the native webview whenever a surrounding pane toggles
                  // and reflows the slot without a drag (e.g. closing the comment
                  // pane, which otherwise leaves the webview stranded at its old
                  // size with a gap of blank space).
                  // Terminal state is part of the key: discrete opens (divider
                  // caret, footer button, ⇧↓, programmatic runDevServer/restore)
                  // reflow the slot with no drag, and without a re-sync the
                  // native webview keeps painting at its old taller rect over
                  // the terminal dock. The GRID key (tile count + rows) stands
                  // where tab count used to: a new terminal that lands untiled
                  // changes no geometry, while a tile row changes everything.
                  // The native webview only re-reads its rect when this key
                  // changes.
                  layoutKey={`${wbLayoutKey}|${paneCollapsed}|${sidebarCollapsed}|${liveFlags.curtain}|${voiceDocked}|${dockPill ?? ""}`}
                  // The pane's four panels render into the app's one
                  // conversation column, through a portal — everything they
                  // need (tabs, missions, the linked thread) is the pane's own
                  // state, so the column borrows the DOM node, not the state.
                  dockSlot={dockSlotEl}
                  dockPill={dockPill}
                  onOpenDockPill={openDockPill}
                  onDockState={setBrowserDock}
                  devServerPorts={devServerPorts}
                  onNeedsChange={setBrowserNeeds}
                />
      , browserHost)}
      {hookConflicts.dialogOpen && (
        <Suspense fallback={null}>
          <HookConflictModal health={hookConflicts}/>
        </Suspense>
      )}
      {setupModalActive && !hookConflicts.dialogOpen && (
          <Suspense fallback={null}>
          <IntegrationSetupDialog
            backend={selectedSetupBackend}
            health={preflight}
            busy={installBusy}
            progress={installProgress}
            done={setupPhase === "done"}
            pending={!!setupContinuation.current}
            skillsUpdate={setupReason === "skill-stale" && !!preflight?.skill.installed}
            onInstall={() => { void installIntegration(true, selectedSetupBackend); }}
            onDismiss={dismissSetup}
            onLocate={() => { void applyReadinessFix({ id: "codex-missing", state: "blocked", label: "Locate Codex", detail: "Choose the Codex executable", fix: { label: "Locate CLI", kind: "locate-codex" } }); }}
            onReviewHooks={() => { void (async () => {
              const binary = preflight?.codex?.path;
              if (!binary) return;
              const id = await openTerminal(setupProject);
              if (!id) { setInstallError("Could not open the setup terminal. Retry, or open /hooks in your Codex terminal."); return; }
              setSetupReviewInTerminal(true); setSetupBackend("codex");
              const quoted = "'" + binary.replace(/'/g, "'\\''") + "'";
              typeIntoTerminal(id, `${quoted}\r`, "Could not start Codex for hook review", null, true);
            })(); }}
            error={installError}
          />
          </Suspense>
        )}
      {setupReviewInTerminal && <div className="rl-setup-return" role="status"><span>Sign in if Codex asks, then open <code>/hooks</code> to review Redline’s hooks. Your work stays here.</span><button type="button" onClick={() => { setSetupReviewInTerminal(false); void installIntegration(true, "codex"); }}>Verify and continue</button><button type="button" onClick={() => { setSetupReviewInTerminal(false); dismissSetup(); }}>Later</button></div>}
      {wallClose && (
        <Suspense fallback={null}>
          <CloseWallDialog
            running={wallClose.running}
            total={wallClose.tiles.length}
            onKeep={(afterQuit) => {
              // Kept, and whether past a quit too: the helper reads it at
              // quit (`KillWhere`), so it is written now.
              for (const id of wallClose.tiles) void invoke("pty_set_meta", { id, persist: afterQuit }).catch(() => {});
              finishWallClose(wallClose, true);
              setWallClose(null);
            }}
            onTerminate={() => { finishWallClose(wallClose, false); setWallClose(null); }}
            onCancel={() => setWallClose(null)}
          />
        </Suspense>
      )}
      {/* ⌘K palette. Registers with the menu-overlay contract while open, so
          the native browser webview hides beneath it. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      {/* ⌘P: go to a file under the rail's root (W4). */}
      {quickOpenRoot && (
        <Suspense fallback={null}>
          <QuickOpen root={quickOpenRoot} onOpen={handleOpenFile} onClose={() => setQuickOpenRoot(null)} />
        </Suspense>
      )}
      {/* Onboarding tour: replay from the menu always, or auto-run once on first
          launch — but only after the hook/skill setup modal is out of the way,
          so the two never overlap. */}
      {(() => {
        const setupActive = setupModalActive;
        const show =
          tourOpen || (!onboardingDone && !setupActive && !bootAnimating);
        if (!show) return null;
        return (
          <Suspense fallback={null}>
            <OnboardingTour
              onAnchorChange={handleTourAnchor}
              onClose={() => {
                setTourOpen(false);
                setOnboardingDone(true);
              }}
            />
          </Suspense>
        );
      })()}
      {/* The one quiet workspace suggestion (nudge.ts) — accept edits the
          manifest, dismiss retires it; either way it never fires again.
          Suppressed inside a harness: the suggestion is about the STOCK
          landing, and accepting it there would edit the wrong manifest. */}
      {nudgeSuggestion && !loading && !activeHarness && (
        <NudgeCard
          message={nudgeSuggestion.message}
          onAccept={() => {
            updateWorkspace((ws) => setLanding(ws, nudgeSuggestion.surface));
            saveNudgeState(
              dismissSuggestion(nudgeState, nudgeSuggestion.id),
            );
          }}
          onDismiss={() =>
            saveNudgeState(dismissSuggestion(nudgeState, nudgeSuggestion.id))
          }
        />
      )}
      </ErrorBoundary>
    </div>
    </MonochatContext.Provider>
    </MenuOverlayProvider>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
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

export default App;
