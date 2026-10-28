import { useQueuedChatPlans } from "./hooks/useQueuedChatPlans";
import type { ChatPlanReceipt, ChatPlanRequest, ChatWorkbenchComposer } from "./components/ChatRoom";
import { CONTINUE_EVENT, continuationKey, continuationOrigin, prepareCompanionContinuation, type ContinuationMessage, type ContinueRequest, type ContinueDestination } from "./lib/conversationContinuation";
import { createPortal } from "react-dom";
import { createBoundedPortalHost, PersistentPortalSlot } from "./components/PersistentPortalSlot";
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
import type { ReactNode, RefObject } from "react";
import { ZoomButton } from "./components/ZoomButton";
import { DocWidthToggle } from "./components/DocWidthToggle";
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
// Tiptap/ProseMirror is heavy; lazy-load so it's off the initial paint path.
/** How long a direct run's flight pill stays up: through the launch, not the
 *  run — after this the tile is the status. */
const RUN_FLIGHT_MS = 12_000;

const loadPlanEditor = () => import("./components/PlanEditor");
const PlanEditor = lazy(() =>
  loadPlanEditor().then((m) => ({ default: m.PlanEditor })),
);
import type { PlanEditorActions } from "./components/PlanEditor";
import type { PlanEditorCollab } from "./components/PlanEditor";
import { EmptyState } from "./components/EmptyState";
import { FrontDoor, BackendMenu as PlanningModelMenu } from "./components/FrontDoor";
import { ReadinessStrip } from "./components/ReadinessStrip";
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
import { isLiveRunState } from "./lib/orchestration";
const Footer = lazy(() => import("./components/Footer").then(m => ({ default: m.Footer })));
import { Header } from "./components/Header";
// The flow shell's top bar and its store ride their own chunks: about
// 16.7 kB of boot JS the classic shell never painted (the workbench's
// headroom, W1). Flow fetches both at mount; until W2 deletes the shell its
// top bar lands a beat after the first frame.
const loadFlowTopBar = () => import("./shell/FlowTopBar");
const FlowTopBar = lazy(() => loadFlowTopBar().then((m) => ({ default: m.FlowTopBar })));
const togglePlanPanel = (sessionId: string) => void loadFlowTopBar().then((m) => m.togglePlanPanel(sessionId)).catch(() => {});
import { flowStateNow, loadFlowState, useFlowLazy as useFlow, withFlowState } from "./shell/flowStateLazy";
const toggleStage = () => withFlowState((m) => m.toggleStage());
const setPlanPose = (sessionId: string, pose: PlanPose) => withFlowState((m) => m.setPlanPose(sessionId, pose));
const setStage = (view: StageView) => withFlowState((m) => m.setStage(view));
const setFlowSidebar = (open: boolean) => withFlowState((m) => m.setSidebar(open));
const getFlowState = flowStateNow;
import { launchTitle, needsYou, sessionMode, sessionTitle, type ModeTarget } from "./lib/sessionMode";
import { isNewSessionKey, isPlanPanelKey, isSidebarKey, isStageKey, toolKeyOf } from "./lib/keymap";
import { TOOL_DESCRIPTORS, toolForKey, toolSurfaces, type ToolId } from "./config/workspace";
import { Button } from "./components/ui/Button";
// Carries the markdown→PM parser + block serializer (the heavy editor chain);
// only mounts when the share dialog opens.
const ShareSnapshotDialog = lazy(() =>
  import("./components/ShareSnapshotDialog").then((m) => ({
    default: m.ShareSnapshotDialog,
  })),
);
import { importSharedPlanFromUrl } from "./collab/importSharedLink";
import { deriveActiveSurface } from "./lib/activeSurface";
import { documentPlateMode, type DocumentPlateMode } from "./lib/documentPlate";
import {
  BROWSER_DOCK_KINDS,
  NO_BROWSER_DOCK,
  CONVERSATION_PIN_KEY,
  activeConversation,
  conversationContexts,
  dockScope, withDockOpen, onScopeChange, type DockScope, type DockOpenBy,
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
const PresenceBar = lazy(() => import("./components/PresenceBar").then((m) => ({ default: m.PresenceBar })));
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
// Shown once, ever — the cleanest lazy win on the boot path (A0).
const OnboardingTour = lazy(() =>
  import("./components/OnboardingTour").then((m) => ({
    default: m.OnboardingTour,
  })),
);
import { AskModeViolationBanner } from "./components/AskModeViolationBanner";
import { ResolutionWarningBanner } from "./components/ResolutionWarningBanner";
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
  orchestrateHandoff,
  PROMPT_TIMEOUT_MS,
  SHELL_PROMPT,
  type HandoffStep,
  type OrchestrateDeps,
} from "./lib/terminalHandoff";
import { TEAM_BUILD_ITEMS, teamScaleOf, type Scale } from "./lib/teamBuildItems";
import type { ScaleConfig, ScaledLaunch } from "./lib/scaledBuild";
const SidebarTabStrip = lazy(() => import("./components/SidebarTabStrip").then((module) => ({ default: module.SidebarTabStrip })));
// The table-of-contents rail renders only once opened (about 6 kB, W1).
const PlanToc = lazy(() => import("./components/PlanToc").then((m) => ({ default: m.PlanToc })));
// Classic's folder tab only, so its own chunk.
const FileTree = lazy(() => import("./components/FileTree").then((m) => ({ default: m.FileTree })));
// Lazy: the read-only viewer only mounts once a folder tab opens a file.
const FileViewer = lazy(() =>
  import("./components/FileViewer").then((m) => ({ default: m.FileViewer })),
);
// The largest unclaimed lever on the boot path (109 KB source). The pane
// mounts only when the browser surface is selected, and `browserVisible` is
// already false during the boot choreography — the chunk fetch hides in the
// same gate.
const loadBrowserPane = () => import("./components/BrowserPane");
const BrowserPane = lazy(() =>
  loadBrowserPane().then((m) => ({ default: m.BrowserPane })),
);
import { MenuOverlayProvider } from "./components/menuOverlay";
import { SplitPane } from "./components/SplitPane";
// Same Tiptap/ProseMirror stack as PlanEditor — lazy for the same reason. The
// landing's type-to-start seed keeps buffering in App's window listener until
// the chunk mounts and consumeSeed runs, so the handoff stays lossless.
/** The Drafter's chunk, as a promise we can also trigger early.
 *
 *  `lazy()` alone means the FIRST open pays for the fetch+parse while the
 *  spring is already running: the animation measures and flies a Suspense
 *  fallback, then the real editor swaps in mid-flight. That is exactly why the
 *  first trip from the Front Door was janky and every one after it was smooth.
 *  Warmed at idle once the shell has settled (see `warmDrafterChunk` below), so
 *  by the time anyone presses ⏎ the first open is the same as the tenth. */
const loadPromptDrafter = () => import("./components/PromptDrafter");
const PromptDrafter = lazy(() =>
  loadPromptDrafter().then((m) => ({ default: m.PromptDrafter })),
);
import type { DrafterSaveState } from "./components/PromptDrafter";
// Lazy: a settings pane. Its module also feeds MemorySurface (class tree +
// portability sections), so the chunk is shared with that surface's family.
const MemoryInspector = lazy(() =>
  import("./components/MemoryInspector").then((m) => ({
    default: m.MemoryInspector,
  })),
);
// Off the boot path. `MemorySurface` is 85KB and structurally identical to the
// surfaces already lazy here (the drafter, the voice panel) — it was static
// only by omission, and boot JS sits at the budget ceiling.
const loadMemorySurface = () => import("./components/MemorySurface");
const MemorySurface = lazy(() =>
  loadMemorySurface().then((m) => ({ default: m.MemorySurface })),
);
// Off the boot path like the drafter: the Runs surface only matters once an
// orchestrated run exists, so its chunk loads on first open.
// The run report — the container an orchestrated run's review pane sits in.
// Behind the run chip, never on the way to the front door, and (like the
// preflight modal above) pure surface that a user who has never orchestrated
// should not carry at boot.
const RunReport = lazy(() =>
  import("./components/RunReport").then((m) => ({ default: m.RunReport })),
);

// Build Redline's one piece outside Runs: the readiness indicator, the restart
// confirmation, and the cover that goes up while Redline is saving its work or
// checking a version it just installed. Lazy, and it stays unfetched on a
// machine that never prepares a release — the boot path has single-digit KB of
// headroom and this has no business on it.
const ActivationBar = lazy(() =>
  import("./components/ActivationBar").then((m) => ({ default: m.ActivationBar })),
);

// The Orchestrate preflight modal. Lazy because it is behind a click that
// already awaits three invokes (push_status, the workflows probe, the allow
// candidates), so a chunk fetch is free there — and because it is pure prose
// and controls that nobody who never orchestrates should pay for at boot. The
// door is on the boot path with single-digit KB of headroom; this is exactly
// the kind of weight that has no business sitting on it.
const loadOrchestrationSurface = () => import("./components/OrchestrationSurface");
const OrchestrationSurface = lazy(() =>
  loadOrchestrationSurface().then((m) => ({
    default: m.OrchestrationSurface,
  })),
);
// Off the boot path for the same reason as MemorySurface: the Localhost
// surface is a pure function of one scan, opened on demand, and static only
// by omission while boot JS sits at its ceiling.
const loadServersPane = () => import("./components/ServersPane");
const ServersPane = lazy(() =>
  loadServersPane().then((m) => ({ default: m.ServersPane })),
);
// Off the boot path, and this one is not optional: boot JS sits at ~99% of the
// size budget, so a chat room in the boot chunk would fail `size-budget.json`
// outright. It loads when the door's third destination is taken.
const loadChatRoom = () => import("./components/ChatRoom");
// Scaled builds (Track O): the Custom dialog and the pre-flight/pause cards.
const ScaledBuildDialog = lazy(() => import("./components/ScaledBuild").then((m) => ({ default: m.ScaledBuildDialog })));
const ScaledBuildCards = lazy(() => import("./components/ScaledBuild").then((m) => ({ default: m.ScaledBuildCards })));
const ChatRoom = lazy(() => loadChatRoom().then((m) => ({ default: m.ChatRoom })));
// Every lazy surface body's chunk, keyed by the surface that mounts it. The
// boot effect prefetches the LANDING surface's entry the moment
// `initialSurface` resolves — the doors' choreography covers the fetch, so a
// lazy landing never blanks behind the parting plates (boot.test.ts pins
// this). Review and servers are static; document warms the editor a held
// session would mount.
const SURFACE_CHUNK_LOADERS: Partial<
  Record<string, () => Promise<unknown>>
> = {
  document: loadPlanEditor,
  drafter: loadPromptDrafter,
  browser: loadBrowserPane,
  memory: loadMemorySurface,
  runs: loadOrchestrationSurface,
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
import { computeParagraphDiff, type ParagraphDiff } from "./diff";
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
import { useEdgeReveal } from "./hooks/useEdgeReveal";
import { ChromeSlot } from "./components/HullRail";
import { PaneDivider } from "./components/PaneDivider";
import { BoundaryFallback, ErrorBoundary } from "./components/ErrorBoundary";
import { DiscussPill } from "./components/DiscussPill";
import { useFrontDoorConversation } from "./hooks/useFrontDoorConversation";
import { hasChildOverlay, MonochatIsland } from "./components/MonochatIsland";
import { isFlowShell } from "./lib/shellFlag";
import { anyApproved, continueLinks, NEW_SESSION_EVENT } from "./lib/flowStart";
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
// The dock's body is fetched with its mount, not with the shell — see
// `terminalMounted` below. `import type` is erased, so the handle's type
// costs nothing.
const TerminalTabs = lazy(() =>
  import("./components/TerminalTabs").then((m) => ({
    default: m.TerminalTabs,
  })),
);
import type { TerminalTabsHandle } from "./components/TerminalTabs";
// The flow shell's session stage: what it shows (lib/flowSessions), the plan
// panel's pose rules (lib/flowPose) and its body, a lazy chunk the classic
// shell never fetches.
import type { PlanPose, StageView } from "./shell/flowState";
import { useStageDock } from "./lib/stageDock";
import type { ConversationLayout } from "./shell/FlowStage";
import { attentionKinds, deriveStageTarget, reduceLaunches, sidebarActivity, sidebarLaunches, useSessionTerminals, type FlowLaunch, type LaunchEvent } from "./lib/flowSessions";
import { FLOW_ARTICLE } from "./lib/flowPose";
// The comment composer opens on a gesture — a selection's menu — so it rides
// its own chunk (about 9.5 kB off the boot path, which pays for the flow
// stage's wiring), warmed the moment a selection shows that menu.
const loadCommentComposer = () => import("./components/CommentComposer");
const CommentComposer = lazy(() => loadCommentComposer().then((m) => ({ default: m.CommentComposer })));
const loadFlowStage = () => import("./shell/FlowStage");
const loadSessionConversation = () => import("./components/agent/SessionConversation");
// The Agent pane: the session's conversation as a centre tab (W2), with
// its header and the Chat | CLI toggle. Rides the conversation's chunk.
const AgentPane = lazy(() => import("./components/agent/AgentPane"));
const FlowStage = lazy(loadFlowStage);
const SessionConversation = lazy(loadSessionConversation);
import { FlashOverlay } from "./components/FlashOverlay";
// ⌘K's palette paints nothing until it opens, so it rides its own chunk,
// loaded on the first ⌘K (the flow shell's way back paid for its bytes).
const CommandPalette = lazy(() => import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
import { playInterceptBeep, DEFAULT_SOUND } from "./audio/beep";
import { buildResumeBuildCommand, buildResumeCommand, handoffPrompt } from "./lib/resumeCommand";
import { buildCommands } from "./lib/commands";
import { isCloseKey, isCloseWindowKey, isDockKey, isNeedsYouKey, isNewPlanKey, isNewTabKey, isPaletteKey, isReopenTabKey, isSnapBackKey, tabCycleKeyOf, tabIndexKeyOf } from "./lib/keymap";
import { loadDictation } from "./lib/dictationComposer";
import type { TalkContext } from "./audio/dictationHost";
import { isKnownTab, type NavTarget, type TabRequest } from "./lib/navTarget";
import {
  TOC_RAIL_W,
  TOC_RAIL_W_WIDE,
  clampTocDrag,
  snapTocWide,
} from "./lib/tocRail";
import {
  type MainSurface,
  bootOnFrontDoor,
  migrateMainSurfaceOnce,
} from "./lib/mainSurface";
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
import {
  effectiveShape,
  isImmersive,
  maskPanels,
  panelMask,
  platePaneMask,
  flowStageShape,
  panelsMasked,
} from "./lib/immersive";
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
  SHELL_EDGE,
  SHELL_GUTTER,
  VOICE_PANE_MIN,
  VOICE_PANE_W,
  canonicalLayout,
  clampDockHeight,
  computePaneLayout,
  isLayoutAtRest,
  paneCollapseOnMask,
  voicePaneMaxW,
  type PaneLayout,
} from "./lib/paneLayout";
import { dockHeightForTiles } from "./lib/tileGrid";
import { SNAPBACK_SETTLE_MS } from "./lib/boot";
import { markOnce } from "./lib/bootMarks";
import { beginMeasure, endMeasure } from "./workbench/perf";
// The workbench (W1): the centre as per-session tab sets of typed panes.
// `store` is the one boot-path piece beyond perf; the adapter reads App's
// old vocabulary off it while the two models coexist (deleted in W6).
import { createWorkbenchStore, useWorkbench } from "./workbench/store";
import { bootToHome, migrateToWorkbenchOnce, persistWorkbench, readWorkbench } from "./workbench/persist";
import { kindForSurface, legacyView, type LegacyView } from "./workbench/legacy";
import { HOME_KEY, activeTabOf, isDocumentKind, isSplit, launchIdOf, launchKey, paneIdsOf, planKey, sessionIdOf, singletonHolder, type AnyPane, type PaneInit, type PaneKind, type SessionKey, type WorkbenchState } from "./workbench/model";
import type { CliView } from "./components/agent/AgentPane";
import { doorDraftKey } from "./workbench/model";
import type { WorkbenchAction } from "./workbench/reducer";
import type { PaneContext } from "./workbench/WorkbenchStage";
// The stage and the reducer ride their own chunk, fetched as the app boots:
// the first frame needs the store and the stored state, not the actions
// that move it nor the strip that shows it (the doors cover the fetch).
const loadWorkbenchStage = () => import("./workbench/WorkbenchStage");
const WorkbenchStage = lazy(() => loadWorkbenchStage().then((m) => ({ default: m.WorkbenchStage })));
const SingletonSlot = lazy(() => loadWorkbenchStage().then((m) => ({ default: m.SingletonSlot })));
const Singleton = lazy(() => loadWorkbenchStage().then((m) => ({ default: m.Singleton })));
import { Columns2 } from "lucide-react";
import { latestDisplayVersion } from "./lib/revisionVersions";
import { perfProbeOn, setPerfProbe } from "./lib/perfProbeSwitch";
import type { BootstrapState, DaemonState } from "./types";
import {
  integrationHealth,
  type HealthQuery,
  type IntegrationHealth,
} from "./lib/integrationHealth";
import { integrationNeedsRepair, repairIntegration } from "./lib/integrationSetup";
import {
  clearDrafterShadow,
  drafterModeKey,
  readDrafterShadow,
  resolveDraftOpen,
  resolveDrafterMountDoc,
  writeDrafterFlush,
  type DrafterSessionEntry,
  type DrafterShadow,
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
  docArticleWidth,
  DOC_MEASURE_MIN,
} from "./lib/docControl";
import {
  beginResizeSession,
  endResizeSession,
  installWindowResizeSession,
  isResizing,
  onResizeSession,
} from "./lib/resizeSession";
import {
  buildPlanLaunchCommand,
  buildRunLaunchCommand,
  buildScaledLaunchCommand,
  buildScaledPrompt,
  runSupported,
} from "./lib/planLaunchCommand";
import type { CodeReviewSession, WorkflowAvailability } from "./types";
import type { RunGraph } from "./lib/runner/schema";
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
/** The code-review surface's whole body, including DiffView and the push
 *  dialog. Reached by opening a review, never on boot. */
const ReviewPanel = lazy(() => import("./components/ReviewPanel"));
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

const BookshelfView = lazy(() =>
  import("./components/BookshelfView").then((m) => ({
    default: m.BookshelfView,
  })),
);
// Lazy: the agent shelf (harness A3) is the Bookshelf's sibling sheet.
const AgentShelf = lazy(() =>
  import("./components/AgentShelf").then((m) => ({
    default: m.AgentShelf,
  })),
);
// The drafter's documents menu: rendered only in the drafter's body, which
// is itself lazy, so it rides its own chunk (about 9 kB of boot JS, W1).
const DocumentsMenu = lazy(() => import("./components/DocumentsMenu").then((m) => ({ default: m.DocumentsMenu })));
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
  Revision,
  ReviewSession,
  Section,
  SessionSummary,
  CombineBrief,
  CombinePreview,
  CombineSource,
} from "./types";

// Upgrade pre-quick-switch persisted pane state (four booleans → one surface
// value + a doc pin) exactly once, before the first usePersistedState read.
migrateMainSurfaceOnce(localStorage);
// …and the chat room's fold into the conversation dock (A3): a persisted
// `mainSurface === "chat"` names a surface this build no longer renders.
migrateChatSurfaceOnce(localStorage);
// …and every launch opens on the Front Door: frame one must not paint the
// surface the last run ended on (see bootOnFrontDoor).
bootOnFrontDoor(localStorage);
// …and the workbench: its one-time migration from those keys, a synchronous
// read (the paint-cache rule), and — in the classic shell, which it drives —
// boot on Home's door, with every change written back on a debounce.
migrateToWorkbenchOnce(localStorage);
const classicWb = !isFlowShell();
const wb = createWorkbenchStore(classicWb ? bootToHome(readWorkbench(localStorage)) : readWorkbench(localStorage), () => import("./workbench/reducer").then((m) => m.reduce));
if (classicWb) {
  persistWorkbench(wb, localStorage);
  void loadWorkbenchStage().catch(() => {});
}
// `legacyView` builds a fresh object; the selector hands the same one back
// for an unchanged state, or useSyncExternalStore would re-render App on
// every notification.
let legacyCacheState: WorkbenchState | null = null;
let legacyCacheView: LegacyView | null = null;
const selectLegacy = (state: WorkbenchState): LegacyView => {
  if (state !== legacyCacheState) {
    legacyCacheState = state;
    legacyCacheView = legacyView(state);
  }
  return legacyCacheView!;
};
/** The active set's active tab and its panes, in reading order. */
function activePanes(state: WorkbenchState): { key: SessionKey; set: NonNullable<WorkbenchState["sets"][SessionKey]> | null; tab: ReturnType<typeof activeTabOf>; panes: AnyPane[] } {
  const set = state.sets[state.activeKey] ?? null;
  const tab = set ? activeTabOf(set) : null;
  const panes = tab && set ? paneIdsOf(tab.root).map((id) => set.panes[id]).filter((p): p is AnyPane => Boolean(p)) : [];
  return { key: state.activeKey, set, tab, panes };
}
/** The first pane of `kind` in the set, active tab first, with its tab. */
function findPane(state: WorkbenchState, kind: PaneKind): { tabId: string; pane: AnyPane } | null {
  const set = state.sets[state.activeKey];
  if (!set) return null;
  const order = set.activeTabId ? [set.activeTabId, ...set.order.filter((id) => id !== set.activeTabId)] : set.order;
  for (const tabId of order) {
    const tab = set.tabs[tabId];
    if (!tab) continue;
    for (const id of paneIdsOf(tab.root)) {
      const pane = set.panes[id];
      if (pane && pane.kind === kind) return { tabId, pane };
    }
  }
  return null;
}
/** The geometry the browser's native webview re-reads its rect on. */
const selectWbLayoutKey = (state: WorkbenchState): string => {
  const { key, tab } = activePanes(state);
  return tab ? `${key}|${tab.id}|${JSON.stringify(tab.root)}` : key;
};
let doorCounter = 0;
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

/** An actionable toast. Plain strings stay the common case; this is for the
 *  toasts that report a switch the app chose NOT to make for you, which have to
 *  offer the switch itself. */
/** The standard per-surface crash-containment fallback (T2.1).
 *
 *  14 of the 21 recorded runtime failures were WKWebView render errors and 12
 *  took the whole app down, because the only boundaries in the tree were the
 *  header, the content area and the root — so a cold or stale lazy chunk in
 *  ONE surface blanked every surface. A boundary sitting directly above each
 *  lazily-loaded surface settles that failure at surface granularity instead,
 *  and names the surface in the `render_crash` friction row it writes
 *  (`ErrorBoundary.componentDidCatch` -> `record_render_crash`).
 *
 *  Deliberately a fallback factory rather than a wrapper component: the
 *  literal `<ErrorBoundary region="…">` stays at each call site, which is what
 *  `src/lib/surfaceBoundaries.test.ts` reads. */
const surfaceFallback =
  (region: string) => (err: Error, reset: () => void) => (
    <div className="flex-1 overflow-hidden flex items-center justify-center">
      <BoundaryFallback region={region} error={err} reset={reset} />
    </div>
  );

// The Front Door's sentence, read and written WITHOUT subscribing to it: the
// composer owns it, and App touches it only when something is sent, cleared
// or handed back.
// Under the workbench each door pane has a draft of its own; App keeps the
// focused door's key here (set each render) so a launch reads and clears
// the sentence of the door it came from. Home's first door and the footer
// pill's card share the Front Door's key.
let doorSentenceKey = FRONT_DOOR_TEXT_KEY;
const getFrontDoorText = () => readSharedDraft(doorSentenceKey);
const setFrontDoorText = (text: string) => writeSharedDraft(doorSentenceKey, text);
const selectFocusedDoorDestination = (state: WorkbenchState): LaunchDestination | null => {
  const { set, tab } = activePanes(state);
  const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
  const d = focused?.kind === "door" ? focused.data.destination : undefined;
  return d === "plan" || d === "run" || d === "chat" || d === "drafter" || d === "browser" ? d : null;
};
const selectFocusedDoorDraftKey = (state: WorkbenchState): string => {
  const { set, tab } = activePanes(state);
  const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
  return focused?.kind === "door" ? focused.data.draftKey : FRONT_DOOR_TEXT_KEY;
};

function App() {
  // The Front Door. Every launch starts with it SHUT: on the document's empty
  // plate it rests there instead — headline, composer and recents in the
  // plate's free area — without taking the caret (typing with nothing focused
  // flows into it), and anywhere else there is only the footer pill. Opening
  // it is always a gesture: the pill, Shift+Enter, ⌘J, ⌘⇧N, a press or a
  // keystroke in the resting composer. The chat-surface seed is still
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
    if (!classicWb || !launchId) return;
    const { key, set, tab } = activePanes(wb.getState());
    const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
    if (focused?.kind === "door" && tab) doorLaunchTabRef.current = { launchId, key, tabId: tab.id };
  }, []);
  const retireDoorLaunchTab = useCallback((launchId: string | null | undefined) => {
    const noted = doorLaunchTabRef.current;
    if (!classicWb || !noted || !launchId || noted.launchId !== launchId) return;
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
  // The pill's compact card, sprung out by a hover. Never open at launch and
  // never re-opened by coming back to a surface.
  const [doorCompact, setDoorCompact] = useState(false);
  // A place the user asked for on the surface they already stand on — a plan
  // from the palette, a recent, a chat's receipt, a notice's Open — is
  // navigation all the same. It is part of the door's navigation key
  // (`doorNavKey`), so whatever is open closes behind them and the caret
  // lands in the main area. A plan merely arriving never counts.
  const [doorTrip, setDoorTrip] = useState(0);
  const tripDoor = useCallback(() => setDoorTrip((n) => n + 1), []);
  // The door is up: open, or resting on the empty plate.
  const [doorVisible, setDoorVisible] = useState(false);
  // Only opening a chat puts the chat in the door; any other summons is the
  // door's home, its own composer.
  const [chatInRoom, setChatInRoom] = useState(false);
  // The island's polite status line: a launch handed off, a plan arrived. The
  // same words twice are nudged apart so a screen reader reads them again.
  const [doorNews, setDoorNews] = useState("");
  const announceDoor = useCallback((text: string) => setDoorNews(news => news === text ? `${text}\u00a0` : text), []);
  // One launch through the card at a time: a context read can make the
  // hand-off take a beat, and a second ⏎ inside it must not launch twice.
  const [frontDoorLaunching, setFrontDoorLaunching] = useState(false);
  const frontDoorLaunchingRef = useRef(false);
  // The browser tab the card would quote, as the pane reports it.
  const [browserIslandPage, setBrowserIslandPage] = useState<BrowserIslandPage | null>(null);
  // The context chips the user flipped, for the surface they flipped them on.
  const [chipPresses, setChipPresses] = useState<ChipPresses>({ surfaceKey: "", on: {} });
  const [monochatBusy, setMonochatBusy] = useState(false);
  const [monochatForks, setMonochatForks] = useState<Set<string>>(() => new Set());
  const reportMonochatActivity = useCallback((key: string, active: boolean) => setMonochatForks(previous => {
    if (previous.has(key) === active) return previous;
    const next = new Set(previous); if (active) next.add(key); else next.delete(key); return next;
  }), []);
  useEffect(() => {
    const subscriptions = ["fork-delta", "fork-done", "fork-error", "fork-cancelled"].map(event => listen<{sessionId: string; commentId: string}>(event, message => reportMonochatActivity(`${message.payload.sessionId}:${message.payload.commentId}`, event === "fork-delta")));
    return () => { subscriptions.forEach(subscription => { void subscription.then(stop => stop()); }); };
  }, [reportMonochatActivity]);
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  // The selected session. In the classic shell it is the workbench's active
  // set (`legacyView.activeId`), plus the collab joined key — a room with no
  // session key of its own — kept beside it; the flow shell keeps its own
  // state until W2 deletes it.
  const wbView = useWorkbench(wb, selectLegacy);
  const [legacyActiveId, setLegacyActiveId] = useState<string | null>(null);
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const activeId: string | null = classicWb ? (joinedId ?? wbView.activeId) : legacyActiveId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // The one writer, in both forms (`leaveJoined` passes an updater). A
  // re-selection of the open session is not a switch: the load effect
  // below keys on `activeId`, and dispatching nothing keeps it from
  // loading twice.
  const setActiveId = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    if (!classicWb) {
      setLegacyActiveId(next);
      return;
    }
    const value = typeof next === "function" ? next(activeIdRef.current) : next;
    if (value === activeIdRef.current) return;
    if (value && isJoinedSessionId(value)) {
      // `joined:<sid>:<threadStart>`: the room shows in the plan set of the
      // session it mirrors, its Plan tab in front.
      setJoinedId(value);
      const sid = value.split(":")[1];
      if (sid) wb.dispatch({ type: "selectSession", key: planKey(sid) });
      return;
    }
    setJoinedId(null);
    // The session's agent terminal, when known, so its set opens with an
    // Agent tab beside the plan (the reducer's defaults).
    wb.dispatch({ type: "selectSession", key: value ? planKey(value) : HOME_KEY, defaults: value ? { agentTerminalId: sessionTerminalsRef.current.get(value) ?? null } : undefined });
  }, []);
  const sessionTerminalsRef = useRef<ReadonlyMap<string, string>>(new Map());
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
  const requestSetup = useCallback((backend: Backend, projectPath: string | null = null): Promise<boolean> => {
    if (setupContinuation.current || installBusyRef.current) return Promise.resolve(false);
    setSetupPhase("setup"); setInstallError(null); setSetupBackend(backend);
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
  const [tocOpen, setTocOpen] = usePersistedState(isFlowShell() ? "redline.flow.tocOpen" : "redline.tocOpen", !isFlowShell());
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
  // The four size keys below (plus BrowserPane's chat ratio) are written by
  // drag paths. Without a debounce every commit ran a synchronous
  // JSON.stringify + localStorage.setItem on the main thread mid-drag.
  const [sidebarWidthPref, setSidebarWidth] = usePersistedState(
    "redline.sidebar.width",
    240,
    { debounceMs: 250 },
  );
  // The six shape flags below are the PERSISTED preference — what the user
  // last chose. On an immersive surface they are masked by `effectiveShape`
  // into the derived names (`sidebarCollapsed`, …) further down, which is what
  // every read site uses. Nothing masks the storage: immersive never writes,
  // so leaving the surface simply lifts the overlay. See lib/immersive.ts.
  const [sidebarCollapsedPref, setSidebarCollapsed] = usePersistedState(
    "redline.sidebar.collapsed",
    false,
  );
  const [paneWidth, setPaneWidth] = usePersistedState(
    "redline.commentPane.width",
    320,
    { debounceMs: 250 },
  );
  const [paneCollapsedPref, setPaneCollapsed] = usePersistedState(
    "redline.commentPane.collapsed",
    false,
  );
  const [paneFullscreenPref, setPaneFullscreen] = usePersistedState(
    "redline.commentPane.fullscreen",
    false,
  );
  // The voice panel ("Talk to the plan") is a docked column INSIDE the document
  // column, not one of the app-row panes — so it has a width but no collapsed
  // flag: its own ✕, the Discuss pill and ⌘J are the open/close affordances.
  const [voiceWidth, setVoiceWidth] = usePersistedState(
    "redline.voicePane.width",
    VOICE_PANE_W,
    { debounceMs: 250 },
  );
  // Which artifact the Discussion sidecar pertains to (plan comments vs the
  // code review's annotations/questions). Only consulted in a true split —
  // see `effectiveDiscussionContext`.
  const [discussionPinned, setDiscussionPinned] =
    usePersistedState<DiscussionContext>("redline.discussion.context", "plan");
  // The center pane shows exactly ONE surface at a time (document / browser /
  // drafter / review) — the header buttons are a radio group, so switching is
  // always a full quick-switch. Tiling is a separate explicit choice: while
  // `docPinned` is on, the document stays alongside whichever non-document
  // surface is selected, sharing the pane as a foldable split (see SplitPane);
  // `splitVertical` flips between side-by-side (default) and stacked, and
  // `splitRatio` is the document's share. `splitDragging` hides the native
  // webview during a split-divider drag so it doesn't swallow the pointer.
  const [legacyMainSurface, setMainSurface] = usePersistedState<MainSurface>(
    "redline.mainSurface",
    "document",
  );
  // Classic reads the active tab's surface off the workbench (it does NOT
  // follow focus: clicking the plan half of a plan + browser tab must not
  // hide the webview); flow keeps the persisted value.
  const mainSurface: MainSurface = classicWb ? wbView.mainSurface : legacyMainSurface;
  // What the workbench does for `selectSurface(next)`, bound below once the
  // state it reads (the doc pin, the drafter's document, the review) exists.
  const openInWorkbenchRef = useRef<(next: MainSurface) => void>(() => {});
  const [docPinnedPref, setDocPinned] = usePersistedState(
    "redline.doc.pinned",
    false,
  );
  // Derived views of the single surface value — they keep the many read sites
  // below near-diff-free, and make disagreeing pane booleans unrepresentable.
  const browserOpen = mainSurface === "browser";
  // The chat is ONE mounted room in two places: the door's slot while the
  // door holds it, the conversation dock's once it was carried out. The host
  // moves between them; the conversation in it never remounts.
  const [chatHost] = useState(() => createBoundedPortalHost("conversation"));
  const [chatRegularSlot, setChatRegularSlot] = useState<HTMLDivElement | null>(null);
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
  const drafterOpen = mainSurface === "drafter";
  const reviewOpen = mainSurface === "review";
  const serversOpen = mainSurface === "servers";
  const memoryOpen = mainSurface === "memory";
  const runsOpen = mainSurface === "runs";
  const chatOpen = mainSurface === "chat";
  // The user has explicitly reopened something on this visit to an immersive
  // surface, so the mask is off until they leave. Declared here — above
  // selectSurface — because entering a surface re-arms it. Never persisted:
  // "was immersive" is exactly the stale bit this design refuses to store.
  const [immersiveBroken, setImmersiveBroken] = useState(false);
  const [panelBreaks, setPanelBreaks] = useState({ sidebar: false, pane: false });
  // Its orientation stays persisted for the tile the pin preference makes;
  // the button that flipped it left the header with the workbench (W1).
  const [splitVertical] = usePersistedState(
    "redline.split.vertical",
    false,
  );
  const [splitRatio, setSplitRatio] = usePersistedState(
    "redline.split.ratio",
    0.5,
    { debounceMs: 250 },
  );
  const [splitDragging, setSplitDragging] = useState(false);
  // The one way any surface comes forward — header radio clicks and every
  // programmatic open funnel through here. Resets the split so a previously
  // folded pane can't come back invisible, and hands the Discussion sidecar
  // to the review on enter / back to the plan on leave.
  const selectSurface = useCallback(
    (next: MainSurface) => {
      setSplitRatio(0.5);
      // The entry edge for immersion. Every header click and every
      // programmatic open funnels through here, so one line re-arms the mask
      // on each entry — "re-entering always hides again". Transition-driven,
      // not state-driven, exactly like useAutoExitFullscreen: the rule fires
      // on the move and never fights the user afterwards.
      setImmersiveBroken(false);
      setPanelBreaks({ sidebar: false, pane: false });
      // Leaving the plate the conversation had taken. It does NOT close — it
      // collapses into the dock and comes with you, which is the whole point
      // of there being one column: you walk out of the room still talking.
      if (next === "review" && mainSurface !== "review") {
        setDiscussionPinned("review");
      } else if (next !== "review" && mainSurface === "review") {
        setDiscussionPinned("plan");
      }
      if (classicWb) openInWorkbenchRef.current(next);
      else setMainSurface(next);
    },
    [mainSurface, setSplitRatio, setDiscussionPinned, setMainSurface],
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
  // immersive opt-out) deliberately keep reading the STOCK manifest — they
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
    from: MainSurface;
    startedAt: number;
    done: boolean;
  } | null>(null);
  useEffect(() => {
    const watch = launchWatchRef.current;
    if (!watch || watch.done) return;
    if (mainSurface === watch.from) return;
    watch.done = true;
    if (Date.now() - watch.startedAt <= NUDGE_WINDOW_MS) {
      saveNudgeState(recordLaunch(nudgeStateRef.current, mainSurface));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainSurface]);
  const nudgeSuggestion = useMemo(
    () => suggestLanding(nudgeState, workspace),
    [nudgeState, workspace],
  );
  const voiceEnabled = surfaceEnabled(effectiveWorkspace, "voice");
  const chatEnabled = surfaceEnabled(effectiveWorkspace, "chat");
  // Fresh view of mainSurface for the boot-time landing decision.
  const mainSurfaceRef = useRef(mainSurface);
  mainSurfaceRef.current = mainSurface;
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
        returnSurface: mainSurfaceRef.current,
      };
      const delta = readHarnessArrangement(localStorage, manifest.id);
      storeActiveHarness(localStorage, active);
      setActiveHarness(active);
      setHarnessDelta(delta);
      const target = initialSurface(
        harnessWorkspace(manifest, delta),
        mainSurfaceRef.current,
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
        ? (back as MainSurface)
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
      mainSurface !== "document" &&
      !surfaceEnabled(effectiveWorkspace, mainSurface as ToggleableSurface)
    ) {
      selectSurfaceRef.current("document");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveWorkspace]);
  // The Prompt Drafter — a Word-style authoring surface selected into the
  // center pane. Its draft (Tiptap JSON) and the project it launches into
  // persist across reloads.
  // The conversation dock — ONE AI column beside whichever surface is
  // selected. It began as the plan's voice drawer and then grew a second copy
  // for the drafter; the two open bits could disagree, so crossing between the
  // surfaces closed a conversation the user had deliberately left up. There is
  // one bit now, and `conversationContext.ts` decides WHICH conversation the
  // column is holding — the same shape `mainSurface` gave the center plate.
  const [dockOpenBy, setDockOpenBy] = useState<DockOpenBy>({});
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
  const [drafterRecovery, setDrafterRecovery] = useState<{
    forId: string;
    shadow: DrafterShadow;
    /** What the database has. Chosen by "Discard". */
    stored: JSONContent | null;
    projectPath: string | null;
  } | null>(null);
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
  // The open door is holding the chat rather than its own composer.
  const roomChat = frontDoorOpen && chatInRoom && !!chatId;
  const chatTarget = roomChat ? chatRegularSlot : chatDockSlot;
  // A move lays the host out afresh, and a scroller laid out afresh starts at
  // its top: carried between the room and the dock, the thread would open on
  // its first message. It keeps its place — the end if it was there.
  const chatScroll = useRef<{ thread: HTMLElement; top: number; end: boolean } | null>(null);
  useLayoutEffect(() => {
    const target = chatTarget;
    if (!target) { chatHost.remove(); return; }
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
  // Belt and braces for the surface that moved into the dock: nothing in this
  // build selects `"chat"` any more and the boot migration rewrites the
  // persisted value, but a workspace manifest can still NAME a surface (its
  // `landing`), and landing on one with no body would show an empty plate.
  useEffect(() => {
    // Under the workbench "chat" is a companion chat pane: nothing to bounce.
    if (classicWb || mainSurface !== "chat") return;
    // The document's empty plate is where the door rests.
    selectSurfaceRef.current("document");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainSurface]);

  // ONE pending launch, keyed by the door it came through. Not one per
  // surface: `deriveReadiness` takes a single `pendingSince`, so two states
  // would force App to fold them, and the 90s `hook-unapproved` nudge would
  // sometimes describe a launch nobody is watching. Never persisted — a stale
  // "Planning…" card must not outlive a restart.
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);
  const pendingLaunchRef = useRef(pendingLaunch);
  pendingLaunchRef.current = pendingLaunch;
  // A direct run's flight pill. Its OWN slot, deliberately not `pendingLaunch`:
  // that slot claims plan-decision windows and drives the `/hooks` nudge, and
  // a run sends no plan to claim. It lives only through the launch itself —
  // the tile is the status after that — so it retires on its own.
  const [runFlight, setRunFlight] = useState<
    { prompt: string; startedAt: number; terminalId: string; restore: LaunchRestore; kind: "run" } | null
  >(null);
  const launchedPlansRef = useRef(new Map<string, PendingLaunch>());
  const [chatReceipts, setChatReceipts] = useState<Record<string, ChatPlanReceipt>>({});
  const chatHandoffSeeds = useRef(new Map<string, { text: string; id: string }>());
  const [planSwap, setPlanSwap] = useState<{ launchId: string; from: SwapRect } | null>(null);
  // Focus + seed handoff from the type-to-start listener (see lib/landing.ts).
  const [frontDoorFocus, setFrontDoorFocus] = useState(0);
  // ── The door tab (W1) ─────────────────────────────────────────────────
  // ⌘T, the footer pill's click and "Plan a build" open a door tab in the
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
    // The door's own draft leaves with it; the shared sentence stays the pill's.
    if (door.data.draftKey !== FRONT_DOOR_TEXT_KEY) writeSharedDraft(door.data.draftKey, "");
    return true;
  }, []);
  doorSentenceKey = classicWb ? doorDraftKeyNow : FRONT_DOOR_TEXT_KEY;
  const wbActiveKey = useWorkbench(wb, (st) => st.activeKey);
  const wbActiveTabId = useWorkbench(wb, (st) => st.sets[st.activeKey]?.activeTabId ?? null);
  const untouchedDoors = useRef(new Set<string>());
  // ⌘T's door, for the mount-once key listener below.
  const openDoorTabRef = useRef<() => void>(() => {});
  const openDoorTab = useCallback(() => {
    // The flow shell has no tabs: ⌘T is its door.
    if (!classicWb) {
      openFrontDoorRef.current();
      return;
    }
    beginMeasure("wb:new-tab-caret");
    setDoorCompact(false);
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
    setDoorCompact(false);
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
  // takes its draft with it; the shared sentence stays the pill's. Watched
  // on the store, so every way a door goes — the strip's ×, ⌘W, Esc, the
  // launch's handoff — forgets its key.
  useEffect(() => {
    if (!classicWb) return;
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
    if (!classicWb) return;
    const prev = previousTabRef.current;
    previousTabRef.current = { key: wbActiveKey, tabId: wbActiveTabId };
    if (!prev || (prev.key === wbActiveKey && prev.tabId === wbActiveTabId)) return;
    closeUntouchedDoor(prev.key, prev.tabId);
  }, [wbActiveKey, wbActiveTabId, closeUntouchedDoor]);
  useEffect(() => {
    if (!classicWb) return;
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
    if (mainSurfaceRef.current !== "drafter") setQuietOpen(false);
  }, [mainSurface]);

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
      void done.then((un) => un());
      void err.then((un) => un());
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
    missionHandoff?: { missionId: string; handoffId: string; destination: "plan" | "auto" | "run" };
  } | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const sendPendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Memory is plumbing: no per-surface toolbar panes anymore. One ephemeral,
  // read-mostly inspector (Lake / Catalog / Settings) behind the quiet pill.
  const [memoryInspectorOpen, setMemoryInspectorOpen] = useState(false);
  // ⌘J toggles the front door; surface discussion controls stay local. An
  // open compact card grows into the door, draft and all.
  const toggleDoor = useCallback(() => {
    setDoorCompact(false);
    setFrontDoorOpen(value => !value);
  }, []);
  useEffect(() => {
    // The flow shell's ⌘J is the stage's Conversation | Terminal instead
    // (the flow keys below), the browser's forwarded ⌘J included.
    if (isFlowShell()) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isDockKey(e)) return;
      e.preventDefault();
      toggleDoor();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("redline:toggle-monochat", toggleDoor);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("redline:toggle-monochat", toggleDoor); };
  }, [toggleDoor]);
  // Visibility from the active tab's panes (a review beside a browser is on
  // screen though it is not the tab's "surface"), the old value in flow.
  const codeReview = useReview(classicWb ? wbView.visibleKinds.includes("review") : reviewOpen);
  // The Localhost dashboard. Gated on the surface being selected: the scan
  // forks three subprocesses per tick, so it must not run behind another pane.
  const devServers = useDevServers(classicWb ? wbView.visibleKinds.includes("servers") : serversOpen);
  // What `selectSurface(next)` means in the workbench. "document" is the
  // way back: beside a surface it closes the surface half (the tile the doc
  // pin made); alone it brings the set's plan — or Home's door — forward.
  // A surface opens in a tab of its own, or beside the document while the
  // doc pin preference is on; the drafter and the review are one pane per
  // set (App keeps which document / repo they show). "chat" is a companion
  // chat pane and never opens from here (the room's own routes do).
  const paneInitFor = (kind: Exclude<MainSurface, "document" | "chat">): PaneInit => {
    switch (kind) {
      case "browser": return { kind, data: { workspace: "regular" } };
      case "drafter": return { kind, data: { draftId: drafterDraftId ?? "" } };
      case "review": return { kind, data: { repo: codeReview.repo ?? "", source: codeReview.source } };
      default: return { kind, data: {} };
    }
  };
  openInWorkbenchRef.current = (next: MainSurface) => {
    const state = wb.getState();
    const { key, set, tab, panes } = activePanes(state);
    if (next === "chat") return;
    if (next === "document") {
      // Never closes a pane (a surface's own ✕ does that): the set's Plan
      // tab comes forward — the plan half of a tile keeps its neighbour —
      // or Home's door. Reads the set selected NOW, so a caller that also
      // switches session switches first.
      if (kindForSurface("document", key) === "plan") {
        wb.dispatch({ type: "openSurface", kind: "plan" });
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
    const doc = panes.find((p) => isDocumentKind(p.kind));
    if (docPinnedPref && doc && tab && set && panes.length <= 2) {
      const other = panes.find((p) => p.id !== doc.id);
      if (other?.kind === next) {
        wb.dispatch({ type: "focusPane", paneId: other.id });
        return;
      }
      if (other) wb.dispatch({ type: "closePane", paneId: other.id });
      wb.dispatch({ type: "splitPane", paneId: doc.id, direction: splitVertical ? "column" : "row", pane: paneInitFor(next) });
      return;
    }
    const init = paneInitFor(next);
    wb.dispatch({ type: "openSurface", kind: next, data: init.data });
  };
  // The browser host's holder joins the key: moving the host between two
  // panes is a pure reparent, which no ResizeObserver sees, so the key is
  // the only thing that moves the native webview.
  const browserHeld = useWorkbench(wb, (s) => singletonHolder(s, "browser", browserHolder));
  const wbLayoutKey = `${useWorkbench(wb, selectWbLayoutKey)}|${browserHeld}`;
  // An agent asking for a code review (a `/redline-code-review` curl holding
  // for feedback), or a run filing its exit report, is news — never a move.
  // The review surface waits for you: a notice says so once, a footer chip
  // holds the way in until you go there (or the agent stops waiting), and
  // from another app the Dock bounces and a notification says it. The agent
  // waits either way; the hook itself adopts the repo/source/round.
  const [reviewNews, setReviewNews] = useState<"review" | "report" | null>(null);
  const reviewNewsRef = useRef(reviewNews);
  reviewNewsRef.current = reviewNews;
  const tellReview = useCallback((kind: "review" | "report") => {
    const message = kind === "report" ? "Run report ready" : "Review ready";
    const there = mainSurfaceRef.current === "review";
    // A report's own review request follows it in: one piece of news.
    if (!there && reviewNewsRef.current) return;
    // Already on the review surface, it is on screen: only the OS is told.
    if (!there) {
      reviewNewsRef.current = kind;
      setReviewNews(kind);
      setToast({
        message,
        tone: "info",
        action: { label: "Open", onAction: () => selectSurfaceRef.current("review") },
        ...(mainSurfaceRef.current === "browser" ? { placement: "top" as const } : {}),
      });
    }
    void import("./lib/osNotice")
      .then(({ noticeWhenAway }) => noticeWhenAway(message, kind === "report" ? "A run filed its report. Open Redline to review it." : "An agent is waiting for your code review in Redline."))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const p = listen("review-requested", () => {
      if (alive) tellReview("review");
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
  }, [tellReview]);
  // Over once you go to the review surface, or once the agent stops
  // waiting on a review nobody opened. A report waits for you.
  useEffect(() => {
    if (mainSurface === "review") setReviewNews(null);
  }, [mainSurface]);
  useEffect(() => {
    if (!codeReview.holdActive) setReviewNews((news) => (news === "review" ? null : news));
  }, [codeReview.holdActive]);
  // Orchestrated runs: which plan session's RunReport container wraps the
  // review surface (null = the plain review pane). Opened by the exit-report
  // event or by clicking a run chip in the sessions pane.
  const [runReportFor, setRunReportFor] = useState<string | null>(null);
  // A verified Orchestrate handoff that failed — the persistent error banner
  // with Retry / Copy launch command / Open terminal manually. The state was
  // already rolled back (reset_run) by the time this is set.
  const [handoffFailure, setHandoffFailure] = useState<{
    sessionId: string;
    stage: string;
    reason: string;
    launchCmd: string;
    prompt: string;
    projectPath: string | null;
    /** A team build's failed launch: Retry relaunches the team, not a graph. */
    retryScaled?: ScaleConfig;
  } | null>(null);
  // Sessions whose approval was rescinded (unapprove_plan) this app session —
  // their restore prompt carries the "your stand-down is void" sentence so a
  // resumed claude doesn't obey a stale ORCHESTRATE_STAND_DOWN in its context.
  const [rescindedIds, setRescindedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    let alive = true;
    // The orchestrator filed its exit report → the review surface opens on
    // the RunReport container (the review-requested event that follows
    // lands inside it), whenever the user goes there.
    const rep = listen<{ sessionId: string }>("orchestration-report", (e) => {
      if (!alive) return;
      setRunReportFor(e.payload.sessionId);
      tellReview("report");
    });
    return () => {
      alive = false;
      void rep.then((un) => un());
    };
  }, [tellReview]);
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
    return () => window.removeEventListener("keydown", onKey);
  }, [setDocZoom]);

  // ⌘W (File ▸ Close, a native menu item so it reaches the app while a
  // browser page has focus) closes from the inside out: a browser pane's
  // page first (BrowserPane closes it on the window event; its last page
  // closes the pane through `onClose`), else the focused pane of a split,
  // else the tab. Never the window: ⌘⇧W is the window, and the reducer
  // refills a set whose last tab closed, so Home always keeps a door.
  const closeFromInside = useCallback(() => {
    // The flow shell (until W2) has pages but no tabs: a browser page, or
    // nothing — never the window.
    if (!classicWb) {
      if (mainSurfaceRef.current === "browser") window.dispatchEvent(new CustomEvent("redline:browser-close-page"));
      return;
    }
    const { set, tab } = activePanes(wb.getState());
    if (!set || !tab) return;
    const focused = set.panes[tab.focusedPaneId];
    if (focused?.kind === "browser") {
      window.dispatchEvent(new CustomEvent("redline:browser-close-page"));
      return;
    }
    if (isSplit(tab.root)) wb.dispatch({ type: "closePane", paneId: tab.focusedPaneId });
    else wb.dispatch({ type: "closeTab", tabId: tab.id });
  }, []);
  /** Close the active tab's pane of `kind` (a surface's own ✕ or Exit). */
  const closeSurfacePane = useCallback((kind: PaneKind) => {
    const { tab, panes } = activePanes(wb.getState());
    const pane = panes.find((p) => p.kind === kind);
    if (!tab || !pane) return;
    if (isSplit(tab.root)) wb.dispatch({ type: "closePane", paneId: pane.id });
    else wb.dispatch({ type: "closeTab", tabId: tab.id });
  }, []);
  // Every event the native menu emits for the workbench has exactly one
  // listener, here, in both shells (flow keeps them until W2; its tab
  // actions are no-ops there): File ▸ New Tab, Reopen Closed Tab, Close,
  // Close Window, and the Tabs submenu. BrowserPane keeps only menu-print;
  // browser_signals.js forwards the rest from a page.
  useEffect(() => {
    const tabs = (action: WorkbenchAction) => {
      if (classicWb) wb.dispatch(action);
    };
    const subs = [
      listen("menu-new-tab", () => openDoorTabRef.current()),
      listen("menu-close-tab", closeFromInside),
      listen("menu-close-window", () => void getCurrentWindow().close()),
      listen("menu-reopen-tab", () => tabs({ type: "reopenClosed" })),
      listen<number>("menu-tab-index", (e) => tabs({ type: "selectTabIndex", index: e.payload })),
      listen<number>("menu-tab-cycle", (e) => {
        beginMeasure("wb:tab-switch");
        tabs({ type: "cycleTab", delta: e.payload < 0 ? -1 : 1 });
      }),
    ];
    // A page's ⌘⌥← / ⌘⌥→, forwarded by BrowserPane.
    const fromPage = (e: Event) => tabs({ type: "cycleTab", delta: (e as CustomEvent<number>).detail < 0 ? -1 : 1 });
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
    window.addEventListener("keydown", onKey, true);
    if (classicWb) void invoke("set_workbench_menu", { enabled: true }).catch(() => {});
    return () => {
      for (const p of subs) void p.then((un) => un());
      window.removeEventListener("redline:workbench-tab-cycle", fromPage);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [closeFromInside]);


  // A browser download or page save landed (or failed): Safari's notice, with
  // Open / Show in Finder. Native, so it fires for background tabs too; the
  // toast builder loads on the first download, never at boot.
  useEffect(() => {
    const p = listen<BrowserDownloadEvent>("browser-download", (e) => {
      void import("./lib/browserOutput").then((m) => setToast(m.downloadToast(e.payload)));
    });
    return () => {
      void p.then((un) => un());
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
  const [termHeight, setTermHeight] = usePersistedState(
    "redline.terminalPane.height",
    260,
    { debounceMs: 250 },
  );
  const [termCollapsedPref, setTermCollapsed] = usePersistedState(
    "redline.terminalPane.collapsed",
    false,
  );
  const [termFullscreenPref, setTermFullscreen] = usePersistedState(
    "redline.terminalPane.fullscreen",
    false,
  );
  // Flow's wall (Tools ▸ Terminals) is a place you visit, never where the
  // app opens.
  useLayoutEffect(() => {
    if (isFlowShell()) setTermFullscreen(false);
  }, [setTermFullscreen]);

  // Project-folder explorer: open folders (sidebar tabs), the active tab, the
  // file shown in the center pane, and the linked-nav toggle.
  const {
    openFolders,
    sidebarTab,
    linkNav,
    activeFile: folderActiveFile,
    openFolder,
    closeFolder,
    selectSessions,
    selectFolder,
    setActiveFile,
    setLinkNav,
  } = useFolderWorkspaces();
  // The document plate wears three faces — the Front Door, a plan, and the
  // folder explorer's file viewer — and every site below used to re-derive
  // which one from `sidebarTab.kind === "folder" && activeFile`. Naming it
  // once is what lets the conversation dock tell a plan (which has a
  // discussion) from a file (which has none).
  // Under the workbench a file is a pane: the focused file pane's path, and
  // the plate's face follows the focused pane (a door tab in a session is
  // the door; a plan beside a browser is the plan).
  const activeFile = classicWb ? wbView.activeFile : folderActiveFile;
  const wbPlateMode: DocumentPlateMode = wbView.focusedKind === "file" ? "file" : wbView.focusedKind === "door" ? "door" : activeId ? "plan" : "door";
  const plateMode = classicWb ? wbPlateMode : documentPlateMode(sidebarTab, activeId, activeFile);
  const plateModeRef = useRef(plateMode);
  plateModeRef.current = plateMode;
  useLayoutEffect(() => {
    setPanelBreaks(state => state.pane ? { ...state, pane: false } : state);
  }, [plateMode]);
  const currentDockScope = dockScope(mainSurface, plateMode);
  dockScopeRef.current = currentDockScope;
  const dockOpen = currentDockScope !== null && !!dockOpenBy[currentDockScope];
  const previousDockScope = useRef(currentDockScope);
  useEffect(() => {
    const previous = previousDockScope.current;
    previousDockScope.current = currentDockScope;
    setDockOpenBy(state => onScopeChange(state, previous, currentDockScope));
  }, [currentDockScope]);
  useEffect(() => {
    if (!(dockOpen && mainSurface === "drafter" && drafterDraftId)) return;
    let alive = true;
    void invoke<Section[]>("parse_markdown_sections", {
      markdown: drafterMarkdown,
    })
      .then((s) => alive && setDrafterSections(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dockOpen, mainSurface, drafterDraftId, drafterMarkdown]);
  // ── The flow shell's session stage ────────────────────────────────────────
  //
  // In flow a session exists from the moment it launches (BRIEF, "Session
  // identity in flow"): the stage shows a launch until its plan arrives and
  // then that plan, keyed by the terminal its CLI runs in, so the handoff
  // never changes which conversation is on screen. `launchPlan` records the
  // launches; the terminal map is fed by the hooks (`term-attention`), the
  // engine (`convo-bound`), held plans and arrivals. On the classic shell the
  // hook stays inert, the list empty and the target is never read.
  const flowShell = isFlowShell();
  // An Agent pane showing its PTY (its CLI view): the terminal dock is
  // pinned over that pane's box and shows that one terminal alone — the
  // same attachment the dock already holds, never a second one.
  const [cliView, setCliView] = useState<CliView | null>(null);
  const cliBoxRef = useMemo<RefObject<HTMLElement | null>>(() => ({ current: cliView?.el ?? null }), [cliView]);
  // The stage's two chunks are what a session opens onto: warmed once the
  // shell is up, so the first plan or launch doesn't wait on a fetch.
  useEffect(() => {
    if (!flowShell) return;
    // The store first: the top bar, the sidebar and the stage read it.
    void loadFlowState().catch(() => {});
    void loadFlowTopBar().catch(() => {});
    const warm = () => {
      void loadFlowStage().catch(() => {});
      void loadSessionConversation().catch(() => {});
    };
    const idle = window.requestIdleCallback?.(warm, { timeout: 2000 });
    if (idle === undefined) {
      const t = setTimeout(warm, 500);
      return () => clearTimeout(t);
    }
    return () => window.cancelIdleCallback?.(idle);
  }, [flowShell]);
  const [flowLaunches, setFlowLaunches] = useState<readonly FlowLaunch[]>([]);
  const flowLaunchesRef = useRef(flowLaunches);
  flowLaunchesRef.current = flowLaunches;
  const noteFlowLaunch = useCallback(
    (event: LaunchEvent) => setFlowLaunches((prev) => reduceLaunches(prev, event)),
    [],
  );
  // The launch the stage is showing, by terminal. A launch puts the stage on
  // it (and takes the selection off whatever plan was open); selecting any
  // session takes the stage off it.
  const [focusedLaunch, setFocusedLaunch] = useState<string | null>(null);
  const focusedLaunchRef = useRef(focusedLaunch);
  focusedLaunchRef.current = focusedLaunch;
  useEffect(() => {
    if (activeId) setFocusedLaunch(null);
  }, [activeId]);
  const {
    terminals: sessionTerminals,
    attention: terminalAttention,
    titles: terminalTitles,
    bind: bindSessionTerminals,
  } = useSessionTerminals(true);
  sessionTerminalsRef.current = sessionTerminals;
  const terminalKinds = useMemo(() => attentionKinds(terminalAttention), [terminalAttention]);
  // A held plan names the terminal its CLI is waiting in.
  useEffect(() => {
    bindSessionTerminals(
      summaries.flatMap((s) =>
        s.heldTerminalId ? [{ sessionId: s.sessionId, terminalId: s.heldTerminalId }] : [],
      ),
    );
  }, [summaries, bindSessionTerminals]);
  // The handoff: a launch's plan arriving binds its session to the launch's
  // terminal and, when the stage is on that launch, flips it to the plan —
  // the same conversation, now with a plan. The general arrival rule (the
  // `plan-received` listener below) still decides everything else.
  useEffect(() => {
    const unlisten = listen<PlanReceivedEvent>("plan-received", (e) => {
      const { launchId, sessionId } = e.payload;
      const launch = launchId
        ? flowLaunchesRef.current.find((l) => l.launchId === launchId)
        : undefined;
      if (!launch) return;
      bindSessionTerminals([{ sessionId, terminalId: launch.terminalId }]);
      noteFlowLaunch({ type: "arrived", launchId: launch.launchId });
      // Both shells keep the launch registry (the sidebar's pending rows);
      // only flow's stage follows a launch onto its plan.
      if (!flowShell || focusedLaunchRef.current !== launch.terminalId) return;
      selectSessions();
      setActiveId(sessionId);
      setViewedVersionNumber(null);
      void loadSession(sessionId);
    });
    return () => {
      void unlisten.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowShell, bindSessionTerminals, noteFlowLaunch, selectSessions]);
  const stageTarget = deriveStageTarget({
    activeId,
    focusedLaunch,
    launches: flowLaunches,
    pendingLaunch,
    runFlight,
    terminals: sessionTerminals,
  });
  // The sidebar's launch rows (its flow layout): `launches`, with
  // `activeLaunchId` and `selectFlowLaunch`.
  const flowSidebarLaunches = useMemo(
    () => sidebarLaunches(flowLaunches, terminalKinds, terminalTitles),
    [flowLaunches, terminalKinds, terminalTitles],
  );
  // Its spinners and "Needs you" reasons, from the CLIs' own hooks.
  const { working: flowWorking, needs: flowNeeds } = useMemo(
    () => sidebarActivity(sessionTerminals, terminalAttention, flowLaunches),
    [sessionTerminals, terminalAttention, flowLaunches],
  );
  // The launch on screen: under the workbench the active `launch:` set's
  // terminal (its Agent tab), in flow the stage's.
  const wbLaunchId = classicWb ? launchIdOf(wbActiveKey) : null;
  const activeLaunchId = classicWb
    ? (wbLaunchId ? flowLaunches.find((l) => l.launchId === wbLaunchId)?.terminalId ?? null : null)
    : stageTarget.kind === "launch" ? stageTarget.terminalId : null;
  // What the tab strip says about a pane beyond its kind: a plan's own
  // title and version, and its status in the shared vocabulary (the
  // session's terminal needs you / is working, from `sidebarActivity`).
  const describePane = useCallback((pane: AnyPane) => {
    // An Agent tab wears its terminal's state, from the CLI's own hooks.
    if (pane.kind === "chat" && pane.data.source === "agent") {
      const kind = terminalKinds.get(pane.data.terminalId);
      return { status: kind === "needs-you" || kind === "your-turn" ? ("needs" as const) : kind === "working" ? ("working" as const) : undefined };
    }
    if (pane.kind !== "plan") return {};
    const summary = summaries.find((x) => x.sessionId === pane.data.sessionId);
    const key = `plan:${pane.data.sessionId}`;
    const version = summary?.revisions.length ? latestDisplayVersion(summary.revisions, summary.latestVersion) : null;
    return {
      // A title the user gave the tab wins (`paneTitle` reads it).
      title: pane.titleOverride ? undefined : summary ? `${summary.titleOverride || summary.planTitle || summary.projectName || "Plan"}${version ? ` v${version}` : ""}` : undefined,
      status: flowNeeds[key] ? ("needs" as const) : flowWorking.has(key) ? ("working" as const) : summary?.attachState === "detached" ? ("exited" as const) : undefined,
    };
  }, [summaries, flowNeeds, flowWorking, terminalKinds]);
  // The strip's right-hand cluster: the doc pin as a contextual entry —
  // tile the session's plan beside the surface in this tab, or untile it.
  const stageTile = (() => {
    const { panes } = activePanes(wb.getState());
    const doc = panes.find((p) => isDocumentKind(p.kind));
    const surface = panes.find((p) => !isDocumentKind(p.kind) && p.kind !== "terminals" && p.kind !== "chat");
    if (doc && surface) return { tiled: true as const, docId: doc.id };
    if (!doc && surface && activeId) return { tiled: false as const, surfaceId: surface.id };
    return null;
  })();
  const stageActions = stageTile ? (
    <button
      type="button"
      className="rl-wb-right-btn"
      title={stageTile.tiled ? "Untile the plan" : "Tile the plan alongside"}
      aria-label={stageTile.tiled ? "Untile the plan" : "Tile the plan alongside"}
      aria-pressed={stageTile.tiled}
      onClick={() => {
        setSplitRatio(0.5);
        setImmersiveBroken(true);
        if (stageTile.tiled) {
          setDocPinned(false);
          wb.dispatch({ type: "closePane", paneId: stageTile.docId });
        } else if (activeId) {
          setDocPinned(true);
          wb.dispatch({ type: "splitPane", paneId: stageTile.surfaceId, direction: splitVertical ? "column" : "row", pane: { kind: "plan", data: { sessionId: activeId, version: null } }, before: true });
        }
      }}
    >
      <Columns2 size={16} aria-hidden />
    </button>
  ) : null;
  // Set where the stage's way back is defined (`flowRowToStage`), below.
  const flowRowToStageRef = useRef<() => void>(() => {});
  const flowShowTerminalRef = useRef<(terminalId: string, view: StageView) => void>(() => {});
  const flowJumpRef = useRef<() => void>(() => {});
  const selectFlowLaunch = useCallback((terminalId: string) => {
    flowRowToStageRef.current();
    setFocusedLaunch(terminalId);
    setActiveId(null);
  }, []);
  // The stage owns the plate: a launch or a plan on the session surface —
  // not the New-session screen and not the folder's file viewer.
  const flowStageOwns =
    flowShell && mainSurface === "document" && stageTarget.kind !== "start" && plateMode !== "file";
  // ⌘J's Conversation | Terminal, and the pose the stage last painted (its
  // narrow rule needs its own width, so it reports the result up).
  const flowView = useFlow((s) => s.stage);
  const [flowPainted, setFlowPainted] = useState<{ pose: PlanPose; layout: ConversationLayout }>(
    { pose: "closed", layout: "stage" },
  );
  const onFlowPose = useCallback(
    (pose: PlanPose, layout: ConversationLayout) =>
      setFlowPainted((prev) => (prev.pose === pose && prev.layout === layout ? prev : { pose, layout })),
    [],
  );
  // 4c: the split pose takes the sidebar's width for the plan when the
  // window has none to spare (the sidebar, the 440px column and a readable
  // plan need about 1300px), and gives it back on the way out — unless ⌘B
  // moved it in between, which is the user's say. On a wider window the
  // sidebar stays: it is how you get anywhere else.
  const splitFoldedSidebar = useRef(false);
  const flowSplit = flowStageOwns && flowPainted.pose === "split";
  const [roomForSidebar, setRoomForSidebar] = useState(() => window.innerWidth >= 1300);
  useEffect(() => {
    if (!flowShell) return;
    const query = window.matchMedia("(min-width: 1300px)");
    const update = () => setRoomForSidebar(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [flowShell]);
  useEffect(() => {
    if (!flowShell) return;
    if (flowSplit && !roomForSidebar) {
      if (getFlowState().sidebar) {
        splitFoldedSidebar.current = true;
        setFlowSidebar(false);
      }
    } else if (splitFoldedSidebar.current) {
      splitFoldedSidebar.current = false;
      if (!getFlowState().sidebar) setFlowSidebar(true);
    }
  }, [flowShell, flowSplit, roomForSidebar]);
  // The conversation is ONE mounted component in three places — the stage,
  // the split column, the full pose's Chat tab — like the chat room's host
  // below: the stage moves this node between them and the conversation in it
  // never remounts, so its subscription and its place survive every pose.
  const [flowConvoHost] = useState(() => (flowShell ? createBoundedPortalHost("session-conversation") : null));
  // The session's terminal at full stage (deviation 6): the dock, positioned
  // over the stage and showing that one PTY. Off the stage the dock is the
  // wall when fullscreen and hidden otherwise — flow never docks a terminal
  // under the conversation.
  const stageTerminalId = stageTarget.kind === "start" ? null : stageTarget.terminalId;
  const flowTermStage = flowStageOwns && flowView === "terminal" && stageTerminalId !== null;
  // Whether the conversation can be seen: on the stage, not under ⌘J's
  // terminal, and not behind the companion column's Feedback tab.
  const flowPanelTab = useFlow((s) => s.panelTab);
  const flowConvoOnScreen =
    flowStageOwns && flowView === "conversation" && !(flowPainted.pose !== "closed" && flowPanelTab === "feedback");
  // On every surface, Tools included: flow never docks a terminal under
  // anything. The wall (⌘J's big sibling, Tools ▸ Terminals) is the one way
  // the dock shows off the stage.
  // …and the same off the stage: an Agent pane's CLI view takes the dock
  // (W3 moves terminals into the centre for good).
  const paneCli = cliView && !termFullscreenPref ? cliView : null;
  const flowDockHidden = (flowShell && !termFullscreenPref && !flowTermStage) || !!paneCli;
  // The Front Door is the plate at REST — no document, no draft, nothing of
  // its own to cover — and that is where the door rests instead of the pill.
  const plateAtRest = mainSurface === "document" && plateMode === "door";
  // In the flow shell that same empty plate is the start screen — the
  // New-session screen, the door at rest on the stage — but only while the
  // stage's target is: a launch whose plan hasn't arrived leaves the plate
  // empty too, and the stage is showing its conversation.
  const flowStartOnStage = isFlowShell() && plateAtRest && stageTarget.kind === "start";


  // ---- Immersive surfaces ---------------------------------------------------
  //
  // Surface masks are derived from the current visit rather than a saved
  // layout snapshot. The discussion preference also closes on entry, so
  // leaving a masked surface does not reopen it. The names
  // below are the ORIGINAL flag names, so every read site downstream
  // (layoutFlagsRef, computePaneLayout, the JSX guards, browserVisible, the
  // useResizablePane wiring) reads the effective value with no diff at all.
  // A read that sits ABOVE this block is a TypeScript error, never a silently
  // wrong value.
  const immersive = isImmersive({
    surface: mainSurface,
    broken: immersiveBroken,
    enabled: workspaceImmersive(workspace),
  });
  // Flow keeps its own sidebar switch (⌘B, shell/flowState), so the layout
  // reads that instead of the classic shell's persisted collapse.
  const flowSidebarOpen = useFlow((s) => s.sidebar);
  const baseShape = flowStageShape(
    effectiveShape(
      {
        sidebarCollapsed: isFlowShell() ? !flowSidebarOpen : sidebarCollapsedPref,
        paneCollapsed: paneCollapsedPref,
        paneFullscreen: paneFullscreenPref,
        termCollapsed: termCollapsedPref,
        termFullscreen: termFullscreenPref,
        // Structural under the workbench: a document face shares the tab
        // with a surface. The preference still says what the NEXT surface
        // does (tile beside the document, or take a tab of its own).
        docPinned: classicWb ? wbView.docPinned : docPinnedPref,
      },
      immersive,
    ),
    flowDockHidden,
  );
  // The second, NARROWER overlay: just the two side panels, leaving the header,
  // the footer and the terminal dock exactly where they are. The sessions list
  // is a document index and the discussion pane is a plan's margin, so on a
  // surface with no document neither is about anything on screen. The overlay
  // hides immediately; its rising edge also closes the discussion preference.
  // `docPinned` is read from the UNMASKED shape (this never touches it), so
  // there is no cycle.
  const surfaceMask = panelMask({
    surface: mainSurface,
    broken: panelBreaks,
    enabled: workspaceImmersive(workspace),
    docPinned: baseShape.docPinned,
  });
  // Flow's sidebar is the app's navigation, not a document index: it stays
  // on every surface, so a Tool is somewhere you visit with the way back in
  // view.
  const pMask = flowShell ? { ...surfaceMask, sidebar: false } : surfaceMask;
  // A plate with no plan on it hides the pane too — and in flow, the plate
  // never has one beside it: the stage's plan panel is the plan's margin.
  const noPlanPane = platePaneMask({
    surface: mainSurface,
    plateMode,
    brokenPane: panelBreaks.pane,
    flowPaneOpen: flowShell ? false : undefined,
  });
  const combinedPaneMask = pMask.pane || noPlanPane;
  const previousPaneMask = useRef(false);
  useLayoutEffect(() => {
    if (paneCollapseOnMask(previousPaneMask.current, combinedPaneMask)) {
      setPaneCollapsed(true);
    }
    previousPaneMask.current = combinedPaneMask;
  }, [combinedPaneMask, setPaneCollapsed]);
  // Only surface masking defers intercepts to a toast. A new plan arriving
  // on the Front Door can select its plan in one batch; it never opens the pane.
  const paneMaskedRef = useRef(pMask.pane);
  paneMaskedRef.current = pMask.pane;
  const {
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
    termCollapsed,
    termFullscreen,
    docPinned,
  } = maskPanels(baseShape, { ...pMask, pane: combinedPaneMask });
  const panelsAreMasked = panelsMasked(pMask);
  const docVisible = mainSurface === "document" || docPinned;

  // Breaking out. While immersive a persisted flag is masked, so a bare
  // `setPaneCollapsed(false)` changes nothing on screen — every gesture that
  // OPENS something clears the mask first. The rule: immersive hides, the user
  // unhides, and the user wins for the rest of that visit. Nothing here writes
  // a "was immersive" bit; the next selectSurface re-arms.
  const revealSidebar = useCallback(() => {
    setPanelBreaks(state => ({ ...state, sidebar: true }));
    if (isFlowShell()) setFlowSidebar(true);
    else setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);
  const revealPane = useCallback(() => {
    setPanelBreaks(state => ({ ...state, pane: true }));
    setPaneCollapsed(false);
  }, [setPaneCollapsed]);
  const revealTerm = useCallback(() => {
    setImmersiveBroken(true);
    // Opening the dock IS the intent to use it — mount now rather than at the
    // next idle callback.
    setTerminalMounted(true);
    setTermCollapsed(false);
  }, [setTermCollapsed]);
  // The user-driven toggles read the EFFECTIVE value to pick their direction:
  // masked, the pane reads as closed, so the gesture means "open" — which is
  // what the user pressing ⇧← at a hidden sidebar is asking for.
  const toggleSidebar = useCallback(() => {
    setPanelBreaks(state => ({ ...state, sidebar: true }));
    if (isFlowShell()) setFlowSidebar(sidebarCollapsed);
    else setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);
  const togglePane = useCallback(() => {
    setPanelBreaks(state => ({ ...state, pane: true }));
    setPaneCollapsed(!paneCollapsed);
  }, [paneCollapsed, setPaneCollapsed]);
  const toggleTerm = useCallback(() => {
    setImmersiveBroken(true);
    setTerminalMounted(true);
    setTermCollapsed(!termCollapsed);
  }, [termCollapsed, setTermCollapsed]);
  // Entering dock fullscreen. Extracted from the inline handler that used to
  // sit on TerminalTabs' `onFullscreenChange` (the per-tile `⤢`, now retired)
  // so the terminal divider's centre pill can drive it. Going fullscreen is an
  // open gesture and must still break the immersive mask; leaving it never
  // needs to, which is why the two exit paths below just set the flag.
  const enterTermFullscreen = useCallback(() => {
    setImmersiveBroken(true);
    setTerminalMounted(true);
    setTermFullscreen(true);
  }, [setTermFullscreen]);

  // The chrome's hover reveal. The header can't simply vanish — it is the
  // window-drag region and the traffic lights float over it — so immersive
  // swaps it for a slim hull rail, and pointing at the rail slides the real
  // bar back (see components/HullRail.tsx). One state for both bars: the
  // chrome returns as a unit. `openMenuCount` is already tracked for
  // `browserVisible`; here it stops a header dropdown from being torn out
  // from under the pointer.
  const chrome = useEdgeReveal({
    enabled: immersive,
    menusOpen: openMenuCount,
  });
  const chromeRevealed = chrome.revealed;

  // First masked entry ever: say where the panels went. A mode with no visible
  // exit reads as a trap. Gated on the PANEL mask, not `immersive` — the panel
  // mask is the one that actually fires, and it is the one that takes something
  // off the screen without being asked.
  const [immersiveHintSeen, setImmersiveHintSeen] = usePersistedState(
    "redline.immersiveHintSeen",
    false,
  );
  // Read through a ref so the flag is NOT a dependency. It was, and the effect
  // set it — so React ran this effect's cleanup (`clearTimeout`) before the
  // re-run, cancelling the hint's own dismissal every single time. The banner
  // then sat there forever. An 8-second notice that never leaves is not a
  // notice, it is furniture.
  const immersiveHintSeenRef = useRef(immersiveHintSeen);
  immersiveHintSeenRef.current = immersiveHintSeen;
  useEffect(() => {
    if (!panelsAreMasked || immersiveHintSeenRef.current) return;
    setImmersiveHintSeen(true);
    setToast({
      // `info`, not the default `success`: nothing succeeded. It rendered as a
      // green success banner for an explanatory line about where the panels
      // went, which is the wrong colour for the wrong kind of message.
      tone: "info",
      message:
        "Panels hidden for this surface — ⇧← or ⇧→ brings one back, ⌘⇧0 snaps everything back.",
    }, 8000);
  }, [panelsAreMasked, setImmersiveHintSeen, setToast]);
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
    // Snap-back is the immersive escape hatch, so it drops the mask on the way
    // through (the canonical branch also lands on the document, which re-arms
    // it). Everything below reads the *Pref flags, not the masked ones: the
    // at-rest cycle has to describe the user's real layout, or ⌘⇧0 from an
    // immersive surface would read "already closed" and do the wrong half of
    // the cycle.
    setImmersiveBroken(true);
    setPanelBreaks({ sidebar: true, pane: true });
    if (
      isLayoutAtRest(
        {
          sidebarCollapsed: sidebarCollapsedPref,
          paneCollapsed: paneCollapsedPref,
          paneFullscreen: paneFullscreenPref,
          termCollapsed: termCollapsedPref,
          termFullscreen: termFullscreenPref,
          docPinned: docPinnedPref,
          surface: mainSurface,
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
      setTermCollapsed(true);
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
    setTermHeight(target.termHeight);
    setTermCollapsed(target.termCollapsed);
    setTermFullscreen(false);
    setDocPinned(false);
    selectSurface(target.surface);
  }, [
    workspace,
    selectSurface,
    setSidebarWidth,
    setSidebarCollapsed,
    setPaneWidth,
    setPaneCollapsed,
    setPaneFullscreen,
    setTermHeight,
    setTermCollapsed,
    setTermFullscreen,
    setDocPinned,
    // The at-rest check reads the live persisted flags; snapBackRef exists
    // precisely so the mount-once ⌘⇧0 listener sees this fresh closure.
    sidebarCollapsedPref,
    paneCollapsedPref,
    paneFullscreenPref,
    termCollapsedPref,
    termFullscreenPref,
    docPinnedPref,
    mainSurface,
  ]);
  // Flow's layout has nothing to snap: ⌘⇧0 is "back to the session".
  snapBackRef.current = isFlowShell() ? () => flowRowToStageRef.current() : snapBack;
  const [termTabCount, setTermTabCount] = useState(1);
  // The dock's GRID, distinct from the tab count — 9 tabs / 2 tiles is
  // normal. Drives dock growth and the browser-pane resync key.
  const [termTiles, setTermTiles] = useState({ count: 1, rows: 1 });
  // Live terminal ids. Null until the dock first reports — an absent report
  // must never read as "the terminal is gone".
  const [liveTermIds, setLiveTermIds] = useState<string[] | null>(null);
  // A session's terminal, learnt: its set (when it has one) gets an Agent
  // tab for it — quietly, beside the plan — and loses one for a terminal
  // that is gone and no longer the session's (a restore into a fresh PTY).
  useEffect(() => {
    if (!classicWb) return;
    const state = wb.getState();
    for (const [sessionId, terminalId] of sessionTerminals) {
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
    const id = (await ensureTerminalReady())?.openSessionTerminal(projectPath, { background: true }) ?? null;
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
  // Baseline for tile-driven dock growth (see the effect below).
  const prevTileCountRef = useRef(1);
  const tilesReportedRef = useRef(false);
  const handleTileCountChange = useCallback(
    (count: number, rows: number) => {
      if (!tilesReportedRef.current) {
        tilesReportedRef.current = true;
        prevTileCountRef.current = count;
      }
      setTermTiles((prev) =>
        prev.count === count && prev.rows === rows ? prev : { count, rows },
      );
    },
    [],
  );
  // How many dock terminals need you (TerminalTabs owns which): the footer
  // chip, and whether ⌘⇧J has anywhere to go.
  const [termNeedYou, setTermNeedYou] = useState(0);
  const termNeedYouRef = useRef(termNeedYou);
  termNeedYouRef.current = termNeedYou;
  // The flow top bar's share: only terminals in needs-you proper (an agent
  // blocked on a question or a permission), by id so the bar can leave out
  // the session on screen.
  const [flowNeedsYouTerms, setFlowNeedsYouTerms] = useState<string[]>([]);
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
          // The spotlight needs its target on screen, so a tour step pointing
          // at a pane breaks the immersive mask like any other reveal.
          if (termCollapsed) revealTerm();
          if (termHeight !== partial) setTermHeight(partial);
          tourRevealRestore.current = () => {
            setTermCollapsed(prevCollapsed);
            setTermFullscreen(prevFullscreen);
            setTermHeight(prevHeight);
          };
        }
      } else if (anchor === "sessions" && sidebarCollapsed) {
        revealSidebar();
        tourRevealRestore.current = () => setSidebarCollapsed(true);
      } else if (anchor === "discussion" && paneCollapsed) {
        revealPane();
        tourRevealRestore.current = () => setPaneCollapsed(true);
      } else if (anchor === "landing" && !doorVisible) {
        // The composer is only measurable while the door is up — resting on
        // the empty plate, or open anywhere else.
        setFrontDoorOpen(true);
        tourRevealRestore.current = () => setFrontDoorOpen(false);
      }
    },
    [
      doorVisible,
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
      revealSidebar,
      revealPane,
      revealTerm,
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
    // Flow has no dock: the top bar's own jump, which goes to the session.
    if (isFlowShell()) return flowJumpRef.current();
    if (termNeedYouRef.current === 0) return;
    setFrontDoorOpen(false);
    setDoorCompact(false);
    revealTerm();
    void ensureTerminalReady().then((dock) => dock?.jumpToNeedsYou());
  }, [revealTerm, ensureTerminalReady]);
  // Capture phase, like the Shift+arrow pane keys below: xterm's handler sits
  // on its helper textarea, so this runs first and the shell never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNeedsYouKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      jumpToNeedsYou();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

  // Folder-tab click: activate the folder and, with linked nav on, bring its
  // terminal forward — the mirror image of focusing a terminal to switch
  // folders. No-op on the terminal side if no terminal lives in that folder.
  const selectFolderTab = useCallback(
    (path: string) => {
      setFrontDoorProject({ path });
      activateFolder(path);
      if (!linkNavRef.current) return;
      const termId = folderTermRef.current.get(path);
      if (termId) terminalsRef.current?.selectTab(termId);
    },
    [activateFolder, setFrontDoorProject],
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
    // Classic's panels; flow has none of them (⌘B is its sidebar).
    if (isFlowShell()) return;
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
          toggleSidebar();
          break;
        case "ArrowRight":
          togglePane();
          break;
        case "ArrowDown":
          toggleTerm();
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
    // The toggles close over the EFFECTIVE flags to pick their direction, so
    // the listener re-subscribes when one flips — the same cadence it already
    // has for the sidebar tabs below.
    toggleSidebar,
    togglePane,
    toggleTerm,
    openFolders,
    sidebarTab,
    selectSessions,
    selectFolderTab,
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
      if (linkNavRef.current && !isFlowShell()) {
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
    (path: string) => {
      setActiveFile(path);
      // Under the workbench a file opens as a pane in the current set (the
      // one already open with that path comes forward).
      if (classicWb) wb.dispatch({ type: "openSurface", kind: "file", data: { path } });
      // If a non-document surface fills the center pane, the opened file would
      // load hidden behind it — switch to the document, unless the user has
      // pinned it (the file is already visible in the tile).
      else if (mainSurface !== "document" && !docPinned) {
        selectSurface("document");
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
    [setActiveFile, sidebarTab, activeTermId, mainSurface, docPinned, selectSurface],
  );
  const handleCloseFile = useCallback(() => {
    setActiveFile(null);
    if (classicWb) closeSurfacePane("file");
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
  const sidebarRef = useRef<HTMLElement | null>(null);
  // When both side panes are dragged so wide that the document column is
  // squeezed to a sliver, the two dividers' chevrons collide. We replace them
  // with a single vertical "latch" (‹ above, › below) centered over the
  // vanished document; clicking either arrow snaps it back open.
  const docColumnRef = useRef<HTMLDivElement | null>(null);
  // The two elements the contents-rail drag resizes directly.
  const tocRailRef = useRef<HTMLDivElement | null>(null);
  const docScrollerRef = useRef<HTMLDivElement | null>(null);
  // The collapsed rail's "☰ Contents" button, which drops to a bare burger
  // when the text column reaches it.
  const tocBtnRef = useRef<HTMLButtonElement | null>(null);
  const [latchPos, setLatchPos] = useState({ left: 0, top: 0 });

  // Track the viewport width so each side pane's max can be "up to the other
  // pane" — letting EITHER pane be dragged until the document clamps fully
  // shut, symmetrically. (A fixed 320px reserve made this lopsided: one pane
  // could clamp the doc shut and the other couldn't.)
  const [winWidth, setWinWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  // The flow sidebar is the boards' fixed column, not a dragged width: 232px
  // of content plus 10px padding each side and its 1px rule at 1280, growing
  // to 260px of content at 1600 (FlowSidebar.css). Classic keeps the drag.
  const sidebarWidth = isFlowShell()
    ? Math.min(281, Math.max(253, Math.round(winWidth * 0.1625) + 21))
    : sidebarWidthPref;

  // The row's space model: the doc column floors at DOC_MIN and any pane
  // width past that becomes curtain overlay instead of flow. Stateless — it
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
      }),
    [
      winWidth,
      sidebarWidth,
      sidebarCollapsed,
      paneWidth,
      paneCollapsed,
      paneFullscreen,
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
  // Three things genuinely need a render because they add or remove DOM rather
  // than resize it — the curtain's extra divider copy, the latch, and hiding
  // the native browser webview. Those are tracked as booleans and committed
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
  const termDockRef = useRef<HTMLDivElement | null>(null);
  // The dock over the Agent pane's CLI box while one shows its PTY.
  useStageDock(termDockRef, cliBoxRef, !!paneCli);
  // Flow's wall (Tools ▸ Terminals) covers the plate, not the sidebar.
  useStageDock(termDockRef, docColumnRef, flowShell && termFullscreen);
  // The voice dock is not part of `applyLiveLayout` — it lives one level down,
  // inside the document column — but it follows the same rule: its width is
  // written straight to the element, never rendered from JSX.
  const voiceDockRef = useRef<HTMLDivElement | null>(null);
  // Live px the voice panel takes out of the document column (0 when closed).
  // Kept in a ref, not state, so a drag frame stays render-free — `recomputeLatch`
  // reads it the same way it reads the live app-row geometry.
  const voiceFlowRef = useRef(0);
  const liveSizeRef = useRef({ sidebarWidth, paneWidth, termHeight, winWidth });
  const layoutFlagsRef = useRef({
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
    termCollapsed,
    termFullscreen,
  });
  layoutFlagsRef.current = {
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
    termCollapsed,
    termFullscreen,
  };
  // The freshest layout, live during a drag. Consumers that must compute real
  // geometry mid-drag (the latch's position) read this instead of the
  // render-time `layout`, which is frozen for the duration.
  const liveLayoutRef = useRef<PaneLayout>(layout);
  const [liveFlags, setLiveFlags] = useState({
    curtain: layout.curtainActive,
    curtainL: layout.sidebarOverlayPx > 0,
    curtainR: layout.paneOverlayPx > 0,
    docObscured: layout.docVisibleW < 56,
  });

  const applyLiveLayout = useCallback(
    (over?: Partial<{
      sidebarWidth: number;
      paneWidth: number;
      termHeight: number;
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
      });
      liveLayoutRef.current = l;

      // Drawer-reveal geometry: the clip (outer) tracks the live width while
      // the content (inner aside) stays pinned at min so it is revealed rather
      // than reflowed.
      setGeom(sidebarClipRef.current, "width", `${l.sidebarFlowW}px`);
      setGeom(
        sidebarAsideRef.current,
        "width",
        `${Math.max(sizes.sidebarWidth, 180)}px`,
      );
      setGeom(
        sidebarCurtainDivRef.current,
        "right",
        `${-(l.sidebarOverlayPx + SHELL_GUTTER)}px`,
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
        f.paneFullscreen ? "" : `${Math.max(sizes.paneWidth, 240)}px`,
      );
      setGeom(
        paneCurtainDivRef.current,
        "left",
        `${-(l.paneOverlayPx + SHELL_GUTTER)}px`,
      );
      setGeom(
        termDockRef.current,
        "height",
        f.termFullscreen
          ? ""
          : `${f.termCollapsed ? 0 : clampDockHeight(sizes.termHeight, window.innerHeight)}px`,
      );
      // Discrete curtain styling (overflow / stacking / the drop shadow that
      // reads as "painted over the doc") is a CSS rule keyed on this attribute,
      // so crossing the threshold re-styles without a render. Set on the clips
      // themselves, not the root, so the selector match stays local — and only
      // on a real flip, since an attribute write invalidates either way.
      setCurtain(sidebarClipRef.current, l.sidebarOverlayPx > 0);
      setCurtain(paneClipRef.current, !f.paneFullscreen && l.paneOverlayPx > 0);
      // The three things a variable cannot express: an extra divider node at
      // the curtain's visible edge, the latch, and hiding the native browser
      // webview. Committed only when one actually flips.
      const next = {
        curtain: l.curtainActive,
        curtainL: l.sidebarOverlayPx > 0,
        curtainR: l.paneOverlayPx > 0,
        docObscured: l.docVisibleW < 56,
      };
      setLiveFlags((prev) =>
        prev.curtain === next.curtain &&
        prev.curtainL === next.curtainL &&
        prev.curtainR === next.curtainR &&
        prev.docObscured === next.docObscured
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
      liveSizeRef.current = { sidebarWidth, paneWidth, termHeight, winWidth };
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
    mainSurface,
    docPinned,
    docPadR,
    docWide,
    docMeasure,
  ]);

  // Position the latch over the visible remnant of the document. The doc
  // column's flow box floors at DOC_MIN now, so "squeezed shut" means the
  // curtains cover it — center the latch on the strip they leave uncovered.
  // Position is relative to the positioned <main> ancestor (the document
  // column's offsetParent).
  // Reads the LIVE layout, not the render-time one, so a recompute triggered
  // mid-drag (the latch appearing) lands in the right place instead of using
  // the geometry from before the drag started.
  const recomputeLatch = useCallback(() => {
    const el = docColumnRef.current;
    if (!el) return;
    const l = liveLayoutRef.current;
    // Keep the latch on-screen when the visible strip clamps against a
    // window edge (one pane collapsed).
    const parent = el.offsetParent as HTMLElement | null;
    const maxLeft = (parent?.clientWidth ?? window.innerWidth) - 12;
    // A docked voice panel eats the right end of the doc column, so the strip
    // the curtains leave uncovered is not all document. `computePaneLayout`
    // deliberately doesn't know about it (it models the app row, and the voice
    // panel splits one cell of that row) — so discount it here, where "where is
    // the document" is the actual question being asked.
    const docStrip = Math.max(0, l.docVisibleW - voiceFlowRef.current);
    const rawLeft = el.offsetLeft + l.sidebarOverlayPx + docStrip / 2;
    const next = {
      left: Math.min(maxLeft, Math.max(12, rawLeft)),
      top: el.offsetTop + el.offsetHeight / 2,
    };
    // Guarded: an unchanged position must not allocate a fresh object, which
    // would re-render this component and (via the deps below) rebuild the
    // observer — the loop that made every drag frame cost two full renders.
    setLatchPos((prev) =>
      prev.left === next.left && prev.top === next.top ? prev : next,
    );
  }, []);

  useEffect(() => {
    const el = docColumnRef.current;
    if (!el) return;
    recomputeLatch();
    // `sidebarWidth`/`paneWidth` are deliberately NOT deps: with them, a drag
    // tore down and rebuilt this ResizeObserver every single frame, and
    // `recompute` then ran twice per frame (direct call + observer fire), each
    // doing five forced-layout reads. The observer already fires on every
    // geometry change; the drag itself is handled by the session hook below.
    const onGeometry = () => {
      if (isResizing()) return;
      recomputeLatch();
    };
    const ro = new ResizeObserver(onGeometry);
    ro.observe(el);
    const off = onResizeSession((active) => {
      if (!active) recomputeLatch();
    });
    return () => {
      ro.disconnect();
      off();
    };
  }, [
    recomputeLatch,
    sidebarCollapsed,
    paneCollapsed,
    paneFullscreen,
    // The latch mounting/unmounting changes what the position is for; recompute
    // against the live layout at that moment.
    liveFlags.docObscured,
  ]);

  // The latch appears whenever the document's uncovered strip has shrunk to a
  // sliver — the curtains (or a collapsed pane's edge) have swallowed it. Each
  // arrow reopens the document by shrinking whichever pane is actually open on
  // that side (falling back to the other side when one pane is collapsed).
  const latchActive = liveFlags.docObscured && !paneFullscreen;
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
    onLiveSize: (w) => applyLiveLayout({ sidebarWidth: w }),
    side: "leading",
    min: 180,
    max: sidebarMaxW,
    // Drag the document over the sidebar past its hard stop → snap it shut.
    onCollapse: () => setSidebarCollapsed(true),
    // Drag the divider of a collapsed sidebar to re-open it as a drawer —
    // including a sidebar that is only collapsed because immersive says so.
    collapsed: sidebarCollapsed,
    onExpand: revealSidebar,
  });

  const {
    isDragging,
    startDrag,
    settling: paneSettling,
  } = useResizablePane({
    width: paneWidth,
    onWidthChange: setPaneWidth,
    onLiveSize: (w) => applyLiveLayout({ paneWidth: w }),
    max: paneMaxW,
    // Same for the comment pane on the right edge. Its drag-from-edge expand
    // is the escape hatch that keeps Code Review workable while immersive.
    onCollapse: () => setPaneCollapsed(true),
    collapsed: paneCollapsed,
    onExpand: revealPane,
  });

  // The voice panel splits the *document column*, so its ceiling is what the
  // two app-row panes leave behind (their two dividers, plus the voice
  // panel's own). Unlike them it never curtains — `voicePaneMaxW` just stops
  // it growing, so the plan always keeps a readable strip.
  const docColW = Math.max(
    0,
    winWidth -
      (sidebarCollapsed ? 0 : sidebarWidth) -
      (paneCollapsed || paneFullscreen ? 0 : paneWidth) -
      12 -
      DIVIDER_W,
  );
  const voiceMaxW = voicePaneMaxW(docColW);
  const voiceRestW = Math.min(
    Math.max(voiceWidth, VOICE_PANE_MIN),
    voiceMaxW,
  );

  const { isDragging: voiceDragging, startDrag: startVoiceDrag } =
    useResizablePane({
      width: voiceWidth,
      onWidthChange: setVoiceWidth,
      // One element write per frame, no React render — the voice panel
      // re-renders on every streamed `voice-delta`, and a commit landing
      // mid-drag would otherwise fight the pointer for the width.
      onLiveSize: (w) => {
        const el = voiceDockRef.current;
        if (el) el.style.width = `${w}px`;
        voiceFlowRef.current = w + DIVIDER_W;
      },
      min: VOICE_PANE_MIN,
      max: voiceMaxW,
    });

  // Adopt the resting width after every render — but never mid-drag, where the
  // live value on the element is the truth (same contract as the app-row
  // layout effect above). No dep array: any render can be the one that changes
  // the ceiling (window resize, a sidecar drag) or mounts the dock.
  useLayoutEffect(() => {
    const el = voiceDockRef.current;
    if (!el) {
      voiceFlowRef.current = 0;
      return;
    }
    if (isResizing()) return;
    el.style.width = `${voiceRestW}px`;
    voiceFlowRef.current = voiceRestW + DIVIDER_W;
  });

  // The Discussion sidecar's context. Plan comments need the doc pane on a
  // sessions tab; the review context needs the Code Review pane open. In a
  // true split the header toggle (discussionPinned) decides.
  const planDiscussionAvailable =
    docVisible && sidebarTab.kind === "sessions";
  const discussionContext = effectiveDiscussionContext(
    reviewOpen,
    planDiscussionAvailable,
    discussionPinned,
  );

  const { isDragging: termDragging, startDrag: startTermDrag } =
    useResizablePane({
      // Start the drag from the height actually painted, not a saved one the
      // window can no longer fit — or the first pixel of drag jumps.
      width: clampDockHeight(termHeight, window.innerHeight),
      onWidthChange: setTermHeight,
      onLiveSize: (h) => applyLiveLayout({ termHeight: h }),
      axis: "y",
      min: 120,
    });

  // Tile-driven dock growth: ADDING a tile grows the dock to that tile
  // count's floor (dockHeightForTiles only ever grows — a dock dragged
  // taller keeps its height, and removing a tile never yanks it shorter;
  // shrinking is the user's job via the divider or the collapse caret) and
  // uncollapses it. It never touches termFullscreen. The divider's own max is
  // looser than this cap, so growth can never exceed what a manual drag
  // allows.
  //
  // The dock's FIRST report is its restored workspace, not tiles being added:
  // relaunching with seven saved tiles must not reopen a dock the user left
  // collapsed, nor grow it over the document.
  // `handleTileCountChange` seeds the baseline from that first report.
  useEffect(() => {
    const prev = prevTileCountRef.current;
    prevTileCountRef.current = termTiles.count;
    if (termTiles.count <= prev) return;
    const next = dockHeightForTiles(
      termTiles.count,
      { width: winWidth, height: window.innerHeight },
      termHeight,
    );
    if (next !== termHeight) setTermHeight(next);
    if (termCollapsed) revealTerm();
    // Growth fires on the tile-count edge only — height/collapse are read
    // fresh but must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termTiles.count]);

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
      if (classicWb) {
        const state = wb.getState();
        const live = list.map((s) => s.sessionId);
        const joined = activeIdRef.current && isJoinedSessionId(activeIdRef.current) ? activeIdRef.current.split(":")[1] : null;
        if (joined) live.push(joined);
        for (const key of Object.keys(state.sets) as SessionKey[]) {
          const sid = sessionIdOf(key);
          if (sid && (key === state.activeKey || !setsBefore.has(key))) live.push(sid);
        }
        wb.dispatch({ type: "prune", liveSessions: live, livePtys: Object.keys(state.owners) });
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
      if (archived && id === activeId) { setActiveId(null); setSession(null); }
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
      const held = boot?.heldSessionId ?? null;
      setActiveId(held);
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
            mainSurfaceRef.current,
          )
        : initialSurface(
            ws,
            mainSurfaceRef.current,
            list[0]?.projectPath ?? null,
          );
      // Warm what boot is about to show while the doors are still parting:
      // the landing surface's chunk, and the sessions sidebar (the aside's
      // resting tab). Dynamic imports — the size budget never sees them.
      prefetchSurfaceChunk(target);
      void loadSessionSidebar().catch(() => {});
      if (target !== mainSurfaceRef.current) {
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
    // Getting Started: the tour, or in the flow shell the start screen,
    // which carries the four steps and the first-run checklist itself.
    const tutorialUnlisten = listen("menu-open-tutorial", () =>
      isFlowShell() ? window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT, { detail: { via: "pointer" } })) : setTourOpen(true),
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
          ...(mainSurfaceRef.current === "browser" ? { placement: "top" as const } : {}),
        });
        // A door that sent this very launch is never "writing", caret in its
        // box or not: its ⏎ asked for this plan, so it arrives on screen —
        // from a door tab it springs out of the box and the door retires.
        // Only while the user is STILL on that door tab: someone who ⌘T'd
        // another door and is typing in it is busy — the launch door retires
        // quietly, the plan's set gets its Plan tab without being selected
        // (D1's "elsewhere"), and the row's pulse carries the news.
        const launchDoor = classicWb && !!payload.launchId && doorLaunchTabRef.current?.launchId === payload.launchId ? doorLaunchTabRef.current : null;
        const wbNow = wb.getState();
        // The launch's own set (its Agent tab, and the door it came through):
        // it becomes the plan's set, the door its Plan tab (D1: selected
        // when the user is on it, inserted quietly when not).
        const launchSetKey = classicWb && payload.launchId ? launchKey(payload.launchId) : null;
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
          mainSurface: mainSurfaceRef.current,
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
          if (classicWb && payload.launchId && doorLaunchTabRef.current?.launchId === payload.launchId) {
            const from = boxOf(".rl-frontdoor-focus .rl-fd-island");
            if (from) setPlanSwap({ launchId: payload.launchId, from });
            retireDoorLaunchTab(payload.launchId);
          } else if (ownDoorTab) {
            const from = boxOf(".rl-frontdoor-focus .rl-fd-island");
            if (from) setPlanSwap({ launchId: payload.launchId!, from });
          }
          focusIntercepted();
          // Someone elsewhere comes to the plan itself, not the Agent tab
          // the set was showing (D1 selects the Plan tab only for the user
          // already on the set).
          if (classicWb && !ownLaunch) wb.dispatch({ type: "openSurface", kind: "plan", key: planKey(payload.sessionId) });
          announceDoor(arrivalMessage(title, revision));
          return;
        }
        if (focus === "focus") {
          // A masked surface (browser, memory, runs): the plan becomes what
          // you come back to, but the surface you chose is not yanked away.
          selectSessions();
          setActiveId(payload.sessionId);
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
      void planUnlisten.then((u) => u());
      void detachedUnlisten.then((u) => u());
      void bindFailedUnlisten.then((u) => u());
      void commentsUnlisten.then((u) => u());
      void statusUnlisten.then((u) => u());
      void runStateUnlisten.then((u) => u());
      void passedThroughUnlisten.then((u) => u());
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
    runsOpen,
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
    sidebarTab.kind === "sessions" &&
    !joinedActive &&
    sessionReady &&
    mainSurface === "document" &&
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
    deps: [tocDocked, tocEligible, mainSurface, activeId, activeFile, docWide, docMeasure],
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
  const dockContexts = useMemo(
    () =>
      conversationContexts({
        voiceEnabled,
        chatEnabled,
        surface: mainSurface,
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
      }),
    [
      voiceEnabled,
      chatEnabled,
      mainSurface,
      plateMode,
      planDiscussable,
      activeId,
      activeSummary?.planTitle,
      drafterDraftId,
      browserDock,
      chatId,
      chatTitle,
    ],
  );
  const dockContext = activeConversation(dockContexts, conversationPin);
  // Two poses, one thread. The plate is "at rest" only on the Front Door —
  // nothing of its own to cover — which is exactly what makes the door a way
  // IN to a conversation rather than a place you navigate away from.
  // The room's occupant must be the conversation the room was opened for. If
  // the user switches contexts from inside it — to one that cannot be a room,
  // or simply to another — the room folds back into the column rather than
  // quietly showing something else at plate scale.
  // One source of truth for the JSX and for the surrounding layout, so the
  // dock, the divider and the pill can never disagree about whether the
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
  const closeDock = useCallback(() => {
    setDockOpenBy(state => withDockOpen(state, dockScopeRef.current, false));
    setConversationPin(pin => (pin === "companion" ? null : pin));
  }, [setConversationPin]);
  const openDock = useCallback(() => setDockOpenBy(state => withDockOpen(state, dockScopeRef.current, true)), []);
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
      setDockOpenBy(state => withDockOpen(state, "browser", true));
    },
    [setConversationPin],
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
      selectSurfaceRef.current(t.surface as MainSurface);
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
  // Every dock terminal currently holding a plan: the backend pins each held
  // POST to the terminal whose claude sent it, so the "plan intercepted" strip
  // renders inside exactly those tabs — never in a sibling tab, and never for
  // plans intercepted from external terminals. A *set*, not a boolean about the
  // focused tab: in a split dock each pane answers for itself, and approving
  // one pane's plan must leave the other pane's strip standing.
  const heldTermIds = useStableValue(useMemo(() => heldTerminalIds(summaries), [summaries]));
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
      setRestoreAttempt(settled);
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
  const activeRunState =
    summaries.find((s) => s.sessionId === session?.sessionId)?.runState ?? null;

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
  // (their non-plan flags are unverified). Multi-agent builds are Track O.
  const planHarness: Backend = restoreDecision.harness;
  const buildTargets = useMemo(() => {
    if (session?.status !== "approved") return [];
    const targets: { id: string; label: string; detail?: string }[] = [];
    if (runSupported(planHarness))
      targets.push({ id: "same", label: `with ${agentLabelFor(planHarness)}`, detail: "resumes the session that wrote the plan" });
    for (const b of ["claude-code", "codex"] as const) {
      if (b !== planHarness) targets.push({ id: b, label: `with ${agentLabelFor(b)}`, detail: "a fresh session reads the approved plan" });
    }
    targets.push(...TEAM_BUILD_ITEMS);
    return targets;
  }, [session?.status, planHarness]);

  const buildApproved = async (targetId: string) => {
    const scale = teamScaleOf(targetId);
    if (scale) {
      void startTeamBuild(scale);
      return;
    }
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
        setTermFullscreen(false);
        // Flow has no dock: the build is this session's conversation from
        // now on, bound before the resumed CLI starts (as a restore is).
        if (!flowShell) revealTerm();
        const id = (await ensureTerminalReady())?.openSessionTerminal(projectPath, flowShell ? { background: true } : undefined) ?? null;
        if (!id) {
          setToast("Couldn't open a terminal to build in", 6000);
          return;
        }
        // The build is this session's conversation from now on, in either
        // shell: bound before the resumed CLI starts (as a restore is), so
        // the workbench's Agent tab finds its terminal the moment it exists.
        bindSessionTerminals([{ sessionId, terminalId: id }]);
        void import("./components/agent/convo/api").then((api) => api.convoPrebind(id, sessionId)).catch(() => {});
        const delivery = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: cmd }]);
        if (!delivery.ok) {
          setToast(`Couldn't start the build (${delivery.stage}): ${delivery.reason}`, 6000);
          return;
        }
        await invoke("mark_plan_build", { sessionId, harness: planHarness, mode: "same" });
        setToast(flowShell ? `Building with ${agentLabelFor(planHarness)}. Follow it here, or in its terminal (⌘J).` : `Building with ${agentLabelFor(planHarness)} in the terminal below ↓`);
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

  // SCALED BUILDS (Track O): build with a team. Auto launches at the
  // defaults; Custom opens the dialog first. Either way the lead is a typed
  // `ultracode:` launch through the verified handoff, with the run's own
  // pre-flight and budget hooks in its `--settings`.
  const [scaleDialogFor, setScaleDialogFor] = useState<{ sessionId: string; defaults: ScaleConfig } | null>(null);
  const startTeamBuild = async (scale: Scale) => {
    if (!session || busy) return;
    const defaults = await invoke<ScaleConfig>("scaled_defaults").catch(() => null);
    if (!defaults) {
      setToast("Couldn't read the team build defaults", 6000);
      return;
    }
    if (scale === "custom") setScaleDialogFor({ sessionId: session.sessionId, defaults });
    else void launchScaledBuild(session.sessionId, defaults);
  };
  const launchScaledBuild = async (sessionId: string, config: ScaleConfig) => {
    if (busy) return;
    const projectPath = (session?.sessionId === sessionId ? session.projectPath : summaries.find((s) => s.sessionId === sessionId)?.projectPath) || null;
    // Refuse before approving anything: without workflows the team can't run.
    const availability = await invoke<WorkflowAvailability>("workflow_availability", { projectPath }).catch(() => null);
    if (availability?.disabledInSettings || availability?.disabledInEnv) {
      setToast(`Dynamic workflows are turned off${availability.settingsSource ? ` in ${availability.settingsSource}` : ""}; a team build needs them.`, 8000);
      return;
    }
    setBusy(true);
    let launch: ScaledLaunch;
    try {
      launch = await invoke<ScaledLaunch>("scaled_build_start", { sessionId, config });
    } catch (err) {
      if (isDetachError(err)) {
        setDetachDismissed(false);
        void refreshSummaries();
      } else setToast(`Couldn't start the team build: ${err}`, 8000);
      return;
    } finally {
      setBusy(false);
    }
    void refreshSummaries();
    const launchCmd = buildScaledLaunchCommand(launch.projectPath, launch.settingsPath, launch.leadModel, launch.effort);
    const prompt = buildScaledPrompt(sessionId, launch.runId);
    suppressTerminalRevealFocus();
    setTermFullscreen(false);
    revealTerm();
    const id = (await ensureTerminalReady())?.openSessionTerminal(launch.projectPath) ?? null;
    // Arm the lineage guards BEFORE the prompt can reach the hook: the ingest
    // claim links the lead under the plan and starts the Runs watcher.
    const rearm = () =>
      invoke("record_orchestration_launch", { prompt, planSessionId: sessionId, terminalId: id }).then(() => undefined);
    await rearm().catch((err) => console.error("record_orchestration_launch failed", err));
    const fail = async (stage: string, reason: string) => {
      await invoke("scaled_stop", { runId: launch.runId }).catch(() => {});
      await invoke("reset_run", { sessionId }).catch(() => {});
      setHandoffFailure({ sessionId, stage, reason, launchCmd, prompt, projectPath: launch.projectPath, retryScaled: config });
      void refreshSummaries();
    };
    if (!id) {
      await fail("spawn", "no terminal tab could be opened");
      return;
    }
    const deps: OrchestrateDeps = {
      ...tauriHandoffDeps,
      journal: (stage, detail) => {
        void invoke("record_handoff_event", { sessionId, stage, detail: detail ?? null }).catch(() => {});
      },
      getRunState: (sid) => invoke<string | null>("get_run_state", { sessionId: sid }),
      rearm,
    };
    const result = await orchestrateHandoff(deps, id, sessionId, launchCmd, prompt);
    if (result.ok) {
      setHandoffFailure((cur) => (cur?.sessionId === sessionId ? null : cur));
      setToast(flowShell ? "Team build started. Redline shows you its workflow (Tools ▸ Runs) before any agent starts." : "Team build started below ↓ Redline shows you its workflow before any agent starts.");
    } else await fail(result.stage, result.reason);
  };
  // A pre-flight or a pause is waiting on the user: mount the cards (lazy).
  const [scaledAttention, setScaledAttention] = useState(0);
  useEffect(() => {
    const bump = () => setScaledAttention((n) => n + 1);
    const subs = [listen("scaled-preflight", bump), listen("scaled-paused", bump)];
    void invoke<unknown[]>("scaled_pending")
      .then((rows) => { if (rows?.length) bump(); })
      .catch(() => {});
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  // Reopen for review: rescind the approval, then restore the session so the
  // plan comes back held, in review, with its comments — the stand-down it
  // was given is declared void in the restore trigger.
  const reopenApproved = async () => {
    if (!session) return;
    if (await unapproveSession(session.sessionId)) await restorePlanSessionWith({ rescinded: true });
  };

  // A native graph is reviewed in Runs before any task gets write access.
  const [nativeRunId, setNativeRunId] = useState<string | null>(null);
  const [runPlanAnchor, setRunPlanAnchor] = useState<{ sessionId: string; blockId: string } | null>(null);
  useEffect(() => {
    if (!runPlanAnchor || session?.sessionId !== runPlanAnchor.sessionId || (classicWb ? !wbView.visibleKinds.includes("plan") : mainSurface !== "document")) return;
    const frame = requestAnimationFrame(() => {
      const block = document.querySelector(`.doc-article [data-block-id="${cssEscape(runPlanAnchor.blockId)}"]`);
      if (block instanceof HTMLElement) { block.scrollIntoView({ block: "center", behavior: "smooth" }); setRunPlanAnchor(null); }
    });
    return () => cancelAnimationFrame(frame);
  }, [runPlanAnchor, session, mainSurface]);
  const showNativeRun = (run: RunGraph) => {
    setNativeRunId(run.runId);
    selectSurface("runs");
    void refreshSummaries();
  };
  const relaunchOrchestrator = async (sessionId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const runs = await invoke<RunGraph[]>("runner_list");
      const existing = runs.find((run) => run.planSessionId === sessionId && !["done", "abandoned"].includes(run.status));
      showNativeRun(existing ?? await invoke<RunGraph>("runner_decompose", { planSessionId: sessionId }));
      setHandoffFailure((cur) => cur?.sessionId === sessionId ? null : cur);
    } catch (err) { setToast(`Could not open the run: ${err}`); }
    finally { setBusy(false); }
  };
  const openRunReview = async (reviewId: string) => {
    const reviews = await invoke<CodeReviewSession[]>("review_sessions_list");
    const review = reviews.find((row) => row.reviewId === reviewId);
    if (!review) throw new Error("The run review no longer exists.");
    if (review) { codeReview.setSource("uncommitted"); await codeReview.openReview(review.repoPath, "uncommitted"); selectSurface("review"); }
  };

  // B1: clear a wedged run without touching the approval.
  const resetRunFor = async (sessionId: string) => {
    try {
      await invoke("reset_run", { sessionId });
      setHandoffFailure((cur) => (cur?.sessionId === sessionId ? null : cur));
      void refreshSummaries();
    } catch (err) {
      setToast(`Reset failed: ${err}`, 6000);
    }
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
      setHandoffFailure((cur) => (cur?.sessionId === sessionId ? null : cur));
      setRunReportFor((cur) => (cur === sessionId ? null : cur));
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

  // B4: abort a live run. Never kills the orchestrator process — names (and
  // offers to show) the terminal tab to close instead.
  const standDownRun = async (sessionId: string) => {
    try {
      const native = (await invoke<RunGraph[]>("runner_list")).find((run) => run.planSessionId === sessionId && !["done", "abandoned"].includes(run.status));
      if (native) {
        showNativeRun(await invoke<RunGraph>("runner_intervene", { runId: native.runId, nodeId: null, action: "stop", message: null, baseRev: native.rev }));
        setToast("Run stopped. Its graph, messages, and file changes are saved.");
        return;
      }
      const terminal = await invoke<string | null>("stand_down_run", {
        sessionId,
      });
      setHandoffFailure((cur) => (cur?.sessionId === sessionId ? null : cur));
      void refreshSummaries();
      if (terminal) {
        setToast({
          message:
            "Run stood down — close its terminal tab to stop the orchestrator.",
          tone: "info",
          action: {
            label: "Show tab",
            onAction: () => {
              setToast(null);
              revealTerm();
              void ensureTerminalReady().then((dock) =>
                dock?.selectTab(terminal),
              );
            },
          },
        });
      } else {
        setToast(
          "Run stood down — the orchestrator (if it is running) keeps going until its terminal is closed.",
          10000,
        );
      }
    } catch (err) {
      setToast(`Stand down failed: ${err}`, 6000);
    }
  };

  // A5: the single-step verified handoff shared by every "open a terminal
  // and type a command" path — spawn-verified, write-checked, loud on
  // failure. Replaces the identical blind setTimeout(pty_write, 900) pattern
  // that let a failed delivery render as success. The failure toast is
  // persistent (Dismiss, never a timer): a spawn timeout surfaces at +15s,
  // after the user has already looked away — an 8s auto-dismiss is how these
  // failures kept escaping diagnosis. With a sessionId the handoff also
  // journals its breadcrumbs (handoff_spawned/…/handoff_failed), same trail
  // as Orchestrate.
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
  const checkRestoreHealth = async (): Promise<PreflightStatus | null> => {
    try {
      const health = await integrationHealth.refresh({ backend: restoreDecision.harness, extension: false });
      setRestoreHealth({ backend: restoreDecision.harness, preflight: health.preflight, codexHook: health.codexHook?.installed ?? false });
      const [first] = providerRestoreBlockers(restoreDecision.harness, health.preflight, health.codexHook?.installed);
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
    if (isFlowShell()) {
      if (terminalId) flowShowTerminalRef.current(terminalId, "terminal");
      return;
    }
    setTermFullscreen(false);
    revealTerm();
    if (!terminalId) return;
    const dock = await ensureTerminalReady();
    dock?.selectTab(terminalId);
    dock?.hailTerminal(terminalId);
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
  const restorePlanSession = () => restorePlanSessionWith({});
  const restorePlanSessionWith = async (opts: { rescinded?: boolean }) => {
    if (!session) return;
    // One at a time. See `RestoreAttempt`. A failed attempt is not in flight —
    // its Retry comes back through here.
    if (!canStartRestore(restoreAttempt)) return;
    // Nothing spent until the round trip can actually complete: a Codex restore
    // missing its binary, sign-in, plan profile or Stop hook opens a terminal
    // that runs, looks healthy, and never gives the plan back. The blocker's
    // own fix is already on screen.
    const restoreProbe = await checkRestoreHealth();
    if (!restoreProbe) return;
    const sessionId = session.sessionId;
    const projectPath = session.projectPath || null;
    onRestore({ type: "start", sessionId, at: Date.now() });
    // The banner is the status surface now, so it must NOT be dismissed — the
    // old path hid it and left the reviewer with a terminal and no narrator.
    setDetachDismissed(false);
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
      restoreDecision.harness,
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
        backend: restoreDecision.harness,
        claudeBin: restoreProbe.claude.path,
        codexBin: restoreProbe.codex?.path ?? null,
        cursorBin: restoreProbe.providers?.cursor?.path ?? null,
        antigravityBin: restoreProbe.providers?.antigravity?.path ?? null,
        model: session.model,
        effort: session.effort,
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
      return;
    }

    // The terminal opens in the PLAN's directory — the one the reviewer thinks
    // in — and the command's own `cd` takes it wherever the transcript lives.
    const id =
      (await ensureTerminalReady())?.openSessionTerminal(projectPath, {
        background: true,
      }) ?? null;
    if (!id) {
      fail("Couldn't open a terminal to resume in.");
      return;
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
  };

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
      if (await requestSetup(choice.backend, req.projectPath)) return launchPlan({ ...req, choice });
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
    // In flow the launch lands on the stage, as its conversation; the dock
    // stays out of sight (⌘J shows the PTY).
    if (!req.background && !flowShell) {
      suppressTerminalRevealFocus();
      setTermFullscreen(false);
      revealTerm();
    }
    const terminalId =
      (await ensureTerminalReady())?.openSessionTerminal(req.projectPath, { background: req.background }) ??
      null;
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
    // Flow: the session exists from here, before any plan row does. A launch
    // the user asked to see puts the stage on it.
    // The launch registry feeds the sidebar's pending rows in both shells;
    // flow's stage also goes to the launch.
    noteFlowLaunch({
      type: "launched",
      launch: { launchId, terminalId, prompt: trimmed, startedAt, projectPath: req.projectPath, mode: run ? "run" : "plan", harness: choice.backend === "codex" ? "codex" : "claude" },
    });
    if (flowShell && !req.background) selectFlowLaunch(terminalId);
    // The workbench: the launch is a session from here — a `launch:` set
    // holding its Agent tab, rekeyed to the plan when it arrives. Asked
    // for in the foreground it is selected, and the door tab it came
    // through follows it (it becomes the Plan tab on arrival); a
    // background launch gets its set without moving anyone.
    if (classicWb) {
      const key = launchKey(launchId);
      if (req.background) wb.dispatch({ type: "ensureDefaults", key, defaults: { agentTerminalId: terminalId } });
      else {
        const { key: fromKey, set, tab } = activePanes(wb.getState());
        const door = tab && set && set.panes[tab.focusedPaneId]?.kind === "door" ? { key: fromKey, tabId: tab.id } : null;
        wb.dispatch({ type: "selectSession", key, defaults: { agentTerminalId: terminalId } });
        if (door) {
          wb.dispatch({ type: "moveTab", from: door.key, to: key, tabId: door.tabId, at: 0, activate: false });
          doorLaunchTabRef.current = { launchId, key, tabId: door.tabId };
        }
      }
    }
    if (run) {
      // Its own pill, never the pending plan card.
      setRunFlight({ prompt: trimmed, startedAt, terminalId, restore: req.restore, kind: "run" });
      setLastLaunchProject(req.projectPath!);
      if (req.background || !flowShell) setToast(req.background ? { message: "Run started in a background terminal", placement: "top" } : "Running in the terminal below ↓");
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
    if (req.background || !flowShell) setToast(req.background ? { message: "Plan started in a background terminal", placement: "top" } : "Launching plan in the terminal below ↓");
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
    setTermFullscreen(false);
    revealTerm();
    const id =
      (await ensureTerminalReady())?.openSessionTerminal(projectPath) ?? null;
    if (id) {
      typeIntoTerminal(id, `${cmd}\r`, "Couldn't start the dev server");
    }
    setToast(flowShell ? "Starting the dev server (Tools ▸ Terminals)" : "Starting the dev server in the terminal below ↓");
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
    setBrowserOpenRequest({ url, nonce: Date.now() });
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
    // A plan to launch, so the door's composer — not a chat it was holding.
    setFrontDoorDest("plan");
    setChatInRoom(false);
    setDoorCompact(false);
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
  const runContinuation = async ({ markdown, source, destination, project, missionHandoff, harness }: { markdown: string; source?: ContinueRequest["source"]; destination: ContinueDestination; project: string | null; harness?: BackendChoice; missionHandoff?: { missionId: string; handoffId: string; destination: "plan" | "auto" | "run" } }) => {
    if (sendPendingRef.current || !markdown.trim()) throw new Error("Another continuation is starting; try again in a moment.");
    let handoff = missionHandoff;
    if ((destination === "auto" || destination === "run") && !project) throw new Error("Choose a project to build in.");
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
              if (destination === "auto") {
                const graph = await invoke<RunGraph>("runner_get", { runId: claim.handoff.destinationId });
                setSendConfirm(null); showNativeRun(graph);
              } else {
                const live = await invoke<boolean>("pty_is_live", { id: claim.handoff.destinationId });
                if (!live) throw new Error("The original plan terminal is no longer available.");
                await showRawTerminal(claim.handoff.destinationId); setSendConfirm(null);
              }
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
      if (handoff?.destination === "auto" && claimToken) {
        const graph = await invoke<RunGraph>("mission_prepare_auto", { missionId: handoff.missionId, handoffId: handoff.handoffId, claimToken, projectPath: project });
        claimSettled = true; setSendConfirm(null); showNativeRun(graph);
        setToast("Execution brief prepared. Review the graph and use Run to start the auto session.");
        return;
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
      void p.then((un) => un());
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
    setSetupDismissed(true); setSetupPhase("setup"); setSetupBackend(null); setInstallError(null);
    const continuation = setupContinuation.current; setupContinuation.current = null; continuation?.(false);
  };
  // First-run auto-start waits for the doors to finish — the tour's spotlight
  // is measured against plate geometry, and a coachmark pinned to a plate
  // that is still travelling points at nothing. This is the one legitimate
  // reason to read the choreography: it is about where things ARE, not about
  // when the user may act.
  // The flow shell has no tour: its start screen is the introduction.
  const tourActive = !isFlowShell() &&
    (tourOpen || (!onboardingDone && !setupModalActive && !bootAnimating));
  // The open door hides the page. The compact card does not: it is cut out
  // of the webview (useNativeOverlayRegion), never laid over it.
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
  // draggable over the browser, exactly as they are over the document.
  // A curtained side pane paints over the doc column in React DOM — which the
  // native webview would ignore (it always paints above). Hide the browser
  // while any curtain is up, exactly like under modals and drags.
  // And hidden while the boot doors are mid-flight: the native webview
  // ignores DOM transforms and would paint over the moving plates.
  // Terminal fullscreen covers the whole work area in DOM (absolute inset-0)
  // without changing the browser slot's rect, so the only fix is hiding the
  // native webview — it would otherwise paint above the fullscreen terminal.
  const browserVisible =
    browserOpen &&
    !bootAnimating &&
    !browserOverlayActive &&
    !sidebarDragging &&
    !isDragging &&
    !termDragging &&
    !splitDragging &&
    // The conversation dock reflows the browser as it is dragged; the native
    // webview paints above React DOM and would otherwise smear across the
    // frames it is being resized through.
    !voiceDragging &&
    !termFullscreen &&
    !liveFlags.curtain &&
    openMenuCount === 0;

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
  // A direct run's pill obeys the same law, tracked beside it in this one
  // effect so the pay-back keeps exactly one call site.
  const runConfirmedRef = useRef<{ startedAt: number; confirmed: boolean } | null>(null);
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
    if (died(pendingLaunch, launchConfirmedRef)) {
      setPendingLaunch(null);
      dead.push(pendingLaunch!);
    }
    if (died(runFlight, runConfirmedRef)) {
      setRunFlight(null);
      dead.push({ ...runFlight!, launchId: "", origin: "front-door-run", draftId: null });
    }
    // Give the sentence back, for the door that took one — the ONE place the
    // pay-back fires. This is the involuntary case: the launch did not survive
    // and nobody chose that, so the composer is refilled ready to re-send. The
    // Drafter's document never left the screen, so its restore is `none`.
    for (const p of dead) repayPending(p, "Launch cancelled — that terminal was closed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTermIds, pendingLaunch, runFlight]);
  // Flow's launches obey the same law: one whose terminal closed is gone
  // from the stage and the sidebar, since no plan can come from a dead PTY.
  useEffect(() => {
    noteFlowLaunch({ type: "terminals", live: liveTermIds });
  }, [liveTermIds, noteFlowLaunch]);

  // The run's pill retires itself once the run is under way: no plan arrives
  // to clear it, and a run's tile is its own status from then on. Keyed on
  // `startedAt` so one run's timer can never retire the next run's pill.
  useEffect(() => {
    if (!runFlight) return;
    const startedAt = runFlight.startedAt;
    const t = setTimeout(() => setRunFlight((f) => (f?.startedAt === startedAt ? null : f)), RUN_FLIGHT_MS);
    return () => clearTimeout(t);
  }, [runFlight]);

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
  const islandSurfaceKey = `${mainSurface}:${activeId ?? ""}:${mainSurface === "drafter" ? drafterDraftId ?? "" : ""}`;
  const doorNavKey = `${mainSurface}:${mainSurface === "drafter" ? drafterDraftId ?? "" : ""}:${doorTrip}`;
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

  const launchFromFrontDoor = async (projectOverride?: string, mode: "plan" | "run" = "plan") => {
    // Plans pilled → this is a combination, and the composer's text is context
    // on top of them rather than the thing being launched. The plans are its
    // context, so the chips sit this one out.
    if (mode === "plan" && frontDoorCombine.length > 0) {
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
    const browser = mainSurface === "browser";
    const project = projectOverride ?? resolveFrontDoorProject(text);
    frontDoorLaunchingRef.current = true;
    setFrontDoorLaunching(true);
    try {
      const r = await launchPlan({
        mode,
        origin: browser ? "browser-island" : mode === "run" ? "front-door-run" : "front-door",
        background: browser,
        prompt: withContext(prompt, await gatherContext(mode)),
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
        const message = `Couldn't ${mode === "run" ? "start the run" : "launch the plan"} — ${r.reason}`;
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
      if (mode === "plan" && frontDoorOpenRef.current) doorLaunchRef.current = r.launchId;
      if (mode === "plan") noteDoorLaunchTab(r.launchId);
      // In the flow shell the launch IS the next stage — its conversation,
      // before any plan exists — so the zoomed door steps aside for it at
      // once instead of holding the window until the plan lands.
      if (isFlowShell()) { doorLaunchRef.current = null; setFrontDoorOpen(false); }
      // Handed off: the compact card shrinks back into the pill, which shows
      // the work. The open door shows it in place.
      setDoorCompact(false);
      announceDoor(mode === "run" ? "Run started in the terminal." : "Plan launched. Redline is planning it in the terminal.");
    } finally {
      frontDoorLaunchingRef.current = false;
      setFrontDoorLaunching(false);
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
    doorVisible && !roomChat && frontDoorDest === "chat" && frontDoorBackend.backend === "claude-code"
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
    setPanelBreaks({ sidebar: false, pane: false });
    // The door GROWS into the chat in place — the composer you were typing in
    // is the bottom of the thread you are now inside — and `selectSurface` is
    // deliberately not called, because nothing is being navigated away from.
    // A plan launched from it earlier then lands as any other would.
    doorLaunchRef.current = null;
    setFrontDoorOpen(true);
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
      setChatInRoom(true);
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
  const openChat = (id: string) => {
    doorLaunchRef.current = null;
    setFrontDoorDest("chat");
    setChatId(id);
    setChatSeed(null);
    setSwapFrom(null);
    setChatInRoom(true);
    setDoorCompact(false);
    setFrontDoorOpen(true);
    setPanelBreaks({ sidebar: false, pane: false });
  };
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
  const landingTypeEligible =
    mainSurface === "document" &&
    !loading &&
    !activeId &&
    sidebarTab.kind === "sessions" &&
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
    // "New plan" means the composer, even when the door was holding a chat.
    setChatInRoom(false);
    // Under the workbench "Plan a build" is a door tab in the active set.
    if (classicWb) {
      openDoorTab();
      return;
    }
    setDoorCompact(false);
    setFrontDoorOpen(true);
    setFrontDoorFocus(n => n + 1);
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
        shell: isFlowShell() ? "flow" : "classic",
        // The flow shell hints each Tool's ⌘ number beside its entry.
        surfaces: isFlowShell()
          ? headerSurfaceList.map((s) => {
              const key = TOOL_DESCRIPTORS.find((t) => t.id === s.id)?.key;
              return key ? { ...s, keys: ["⌘", String(key)] } : s;
            })
          : headerSurfaceList,
        currentSurface: mainSurface,
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
          toggleDock: toggleDoor,
          openConversation: (kind) => {
            const hit = dockContexts.find((c) => c.kind === kind);
            if (!hit) return;
            if (kindPill(hit.kind)) setConversationPin(hit.kind);
            setDockOpenBy(state => withDockOpen(state, dockScopeRef.current, true));
          },
          openChat,
          snapBack,
          toggleSidebar,
          toggleDiscussion: togglePane,
          toggleTerminal: toggleTerm,
          // The palette's word for "give me the panels back on this surface"
          // (and, pressed again on the same visit, hide them again). It flips
          // the break-out bit only — the persisted layout is never touched.
          toggleImmersive: () => { setImmersiveBroken(b => !b); setPanelBreaks(state => ({ sidebar: !state.sidebar, pane: !state.pane })); },
          setTheme: (name) => {
            if (isThemeName(name)) onThemeChange(name);
          },
          setFont: (name) => {
            if (isFontName(name)) onFontChange(name);
          },
          zoomReset: () => setDocZoom(1),
          replayTour: () => (isFlowShell() ? openStartScreen("pointer") : setTourOpen(true)),
          togglePerfProbe: () => {
            void setPerfProbe(!perfProbe);
            setPerfProbeShown(!perfProbe);
          },
          enterHarness: (id) => {
            const manifest = harnessList.find((h) => h.id === id);
            if (manifest) enterHarness(manifest);
          },
          exitHarness,
          // Flow: ⌘J is the stage's Conversation | Terminal, ⌘B its sidebar
          // and ⌘⌥B the active plan's panel.
          ...(isFlowShell()
            ? {
                // The palette is a keyboard: the start screen arrives zoomed.
                draftNewPlan: () => openStartScreen("key"),
                toggleDock: toggleStage,
                // The effective toggle: on a Tool too (flowKeysRef, below).
                toggleSidebar: () => flowKeysRef.current.toggleSidebar(),
                togglePlanPanel: activeId ? () => togglePlanPanel(activeId) : undefined,
              }
            : {}),
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      headerSurfaceList,
      mainSurface,
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
      toggleTerm,
      setDocZoom,
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
          <EmptyState title="Chat" body="Starting a conversation…" />
        ) : !chatId ? (
          <EmptyState
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
          />
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

  const monochatRouting = useMemo(() => ({ harness: frontDoorBackend, conversationId: chatId, reportActivity: reportMonochatActivity }), [frontDoorBackend, chatId, reportMonochatActivity]);

  // The door's one flight pill: its own plan launch or its own run, whichever
  // started last. Built once per launch, not per render: the composer reads a
  // new object as a new launch.
  const frontDoorFlight = useMemo(() => {
    const plan = pendingLaunch?.origin === "front-door" || pendingLaunch?.origin === "browser-island" ? { ...pendingLaunch, kind: "plan" as const } : null;
    return plan && runFlight ? (runFlight.startedAt > plan.startedAt ? runFlight : plan) : (runFlight ?? plan);
  }, [pendingLaunch, runFlight]);
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
  // The flow shell's New session (⌘N, "+ New session", Getting Started): the
  // start screen as the stage. Navigation the user asked for, so whatever
  // the door had open closes behind it, and the plate goes back to rest — no
  // plan selected, the sidebar on its sessions. A keyboard summons arrives
  // with the caret in the box, which is the focus zoom; a pointer arrives
  // quiet, the caret left where it was (never stolen between tasks).
  const openStartScreen = useCallback((via: "key" | "pointer" = "pointer") => {
    tripDoor();
    setFrontDoorOpen(false);
    setDoorCompact(false);
    selectSessions();
    setActiveId(null);
    // Off any launch the stage was showing: New session is the start screen.
    setFocusedLaunch(null);
    selectSurface("document");
    // Once the resting door has landed on the stage it engages like any
    // keyboard summons.
    if (via === "key") requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("redline:open-front-door"))));
  }, [tripDoor, selectSessions, setActiveId, selectSurface]);
  useEffect(() => {
    if (!isFlowShell()) return;
    const onNew = (event: Event) => openStartScreen((event as CustomEvent<{ via?: "key" | "pointer" }>).detail?.via === "key" ? "key" : "pointer");
    window.addEventListener(NEW_SESSION_EVENT, onNew);
    return () => window.removeEventListener(NEW_SESSION_EVENT, onNew);
  }, [openStartScreen]);
  // The four-step strip retires for good at the first approval: remembered,
  // so deleting that session never brings it back.
  const [flowStripRetired, setFlowStripRetired] = usePersistedState("redline.flow.stripRetired", false);
  const approvedOnce = anyApproved(summaries);
  useEffect(() => {
    if (approvedOnce && !flowStripRetired) setFlowStripRetired(true);
  }, [approvedOnce, flowStripRetired, setFlowStripRetired]);
  // How many harnesses this machine has: past one, the start screen's model
  // chip says which will do the work.
  const harnessCount = (preflight?.claude.found ? 1 : 0) + (preflight?.codex?.found ? 1 : 0)
    + Object.entries(preflight?.providers ?? {}).filter(([id, probe]) => id !== "claude-code" && id !== "codex" && probe?.found).length;
  const openDoorRecent = (r: DoorRecent) => {
    if (r.kind === "chat") return openChat(r.id);
    tripDoor();
    setFrontDoorOpen(false);
    if (r.kind === "plan") {
      selectSessions();
      setActiveId(r.id);
      selectSurface("document");
      return;
    }
    // By thread. A plan's explicit research link reopens with its answer (the
    // same as "View result"); any other tab comes back quietly, chat closed.
    setBrowserOpenRequest({ url: r.url ?? "", nonce: Date.now(), focusBrowseId: r.id, quiet: !r.research });
    selectSurface("browser");
  };
  // Leaving the room carries its chat into the conversation dock, still
  // open — however the room was left: the door shut on it, or kept but handed
  // back to its own composer (⌘⇧N, a plan sent to the door). Not over a dock
  // already holding the surface's own conversation: that would end a voice
  // discussion mid-thought, and the dock's strip has the chat a click away.
  // The door, shut, goes back to being its own composer for the next summons.
  // A chat minted for a door shut while it was being made lands in the room
  // late: it is carried too. The room's New lets go of the chat instead (it
  // stays in History), so there is nothing to carry.
  const roomHeldChat = useRef(false);
  useEffect(() => {
    const left = chatInRoom ? !frontDoorOpen : roomHeldChat.current;
    roomHeldChat.current = chatInRoom && frontDoorOpen;
    if (!left) return;
    if (chatInRoom) setChatInRoom(false);
    // A surface with no dock has nowhere to show it: no pin is left behind.
    if (!chatId || dockOpen || !dockScopeRef.current) return;
    setConversationPin("companion");
    openDock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontDoorOpen, chatInRoom]);
  // On screen in the dock's column — the same room, at column scale.
  const chatDocked = !roomChat && !!chatId && voiceDocked && dockContext?.kind === "companion";
  // The compact card launches only in place — Plan or Run. Elsewhere than the
  // browser its menu also offers the Drafter and Chat, and picking either
  // grows the card into the door, which takes that destination.
  const cardDestination: LaunchDestination = frontDoorDest === "run" ? "run" : "plan";
  const growCardTo = (next: LaunchDestination) => {
    setFrontDoorDest(next);
    if (next !== "drafter" && next !== "chat") return;
    setDoorCompact(false);
    setFrontDoorOpen(true);
  };
  // One composer in three places — the door's own (resting or open), the
  // compact card's, a chat's — and one sentence: each is a FrontDoor on the
  // same shared draft, so what you typed in one is there in the next.
  // A door tab's Open target: the browser takes the sentence as an address
  // or a search; the others open at once with the sentence kept.
  const openDoorTarget = (id: string, text: string) => {
    if (id === "browser") {
      const url = browserTarget(text);
      if (!convertDoorPane({ kind: "browser", data: { workspace: "regular" } })) selectSurface("browser");
      setBrowserOpenRequest({ url, nonce: Date.now() });
      return;
    }
    if (doorOpenTargets.some((t) => t.id === id)) selectSurface(id as MainSurface);
  };
  const setDoorDestination = (next: LaunchDestination) => {
    setFrontDoorDest(next);
    const { set, tab } = activePanes(wb.getState());
    const focused = tab && set ? set.panes[tab.focusedPaneId] : null;
    if (focused?.kind === "door") wb.dispatch({ type: "replacePane", paneId: focused.id, pane: { kind: "door", data: { ...focused.data, destination: next } } });
  };
  const renderMonochatComposer = (where: "door" | "card" | "chat", accessories?: React.ReactNode, workbench?: ChatWorkbenchComposer) => {
    const card = where === "card";
    const shown = where === "door" ? doorVisible : card ? doorCompact : roomChat || chatDocked;
    const destination = where === "chat" ? "chat" : card ? cardDestination : frontDoorDest;
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
                // A hover never takes the caret: the card's composer waits
                // for a click. The door's is the island's to focus — a pointer
                // on the pill opens it quiet, anything else with the caret in
                // it. A chat the room holds takes it on every summons.
                autoFocusOnShow={where === "chat" && roomChat}
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
                onRun={(project) => void launchFromFrontDoor(project, "run")}
                // A refusal from App's own backstop gate, so the fix lands in
                // the island rather than only in a corner toast.
                refusal={frontDoorRefusal}
                onDrafter={drafterFromFrontDoor}
                onChat={() => void chatFromFrontDoor()}
                chatEnabled={surfaceEnabled(effectiveWorkspace, "chat")}
                // The browser's card is Plan and Run alone: a page has no
                // Drafter or Chat of its own to grow into.
                allowedDestinations={card && mainSurface === "browser" ? ["plan", "run"] : undefined}
                // A door tab's Open targets, and the destination the pane
                // remembers (a door opened from a browser pane starts on
                // Browser); the global default follows every pick.
                openTargets={where === "door" && classicWb ? doorOpenTargets : undefined}
                onOpenTarget={where === "door" && classicWb ? openDoorTarget : undefined}
                destination={card ? cardDestination : where === "door" && classicWb ? (doorPaneDestination ?? frontDoorDest) : frontDoorDest}
                onDestinationChange={card ? growCardTo : where === "door" && classicWb ? setDoorDestination : setFrontDoorDest}
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
                onCancelPending={() => (frontDoorFlight?.kind === "run" ? setRunFlight(null) : setPendingLaunch(null))}
                // The pill's other half: go watch it. Reveal the dock, focus
                // the tile the plan is running in, and glow it once so the
                // eye lands on the right one of fourteen.
                onRevealPending={() => {
                  const p = frontDoorFlight;
                  if (!p) return;
                  setFrontDoorOpen(false);
                  setDoorCompact(false);
                  revealTerm();
                  terminalsRef.current?.selectTab(p.terminalId);
                  terminalsRef.current?.hailTerminal(p.terminalId);
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
                // in the door alone: never in the compact card. Bounded: this
                // is a way in, not an index; the room's own `Chats ▾` holds the
                // full list.
                chats={where === "door" ? chats
                  .slice(0, 4)
                  .map((c) => ({ id: c.companionId, title: c.title })) : undefined}
                onOpenChat={where === "door" ? openChat : undefined}
                // The flow shell's start screen is this door, and only it.
                flow={where === "door" && isFlowShell() ? {
                  manyHarnesses: harnessCount > 1,
                  strip: !flowStripRetired && !approvedOnce,
                  continues: continueLinks(summaries),
                  onContinue: (id) => openDoorRecent({ kind: "plan", id, label: "", detail: "" }),
                } : undefined}
              />
    );
  };

  // The flow sidebar's own rows: chats beside the plans, a project's "+",
  // and the launch in flight until its plan arrives. The classic sidebar
  // ignores all of these.
  const flowSidebarHandlers = useStableHandlers({
    // A click is a pointer summons: the start screen arrives quiet, the
    // caret left where it was.
    onNewSession: () => openStartScreen("pointer"),
    onNewSessionIn: (path: string) => {
      setFrontDoorProject({ path });
      openStartScreen("pointer");
    },
    onSelectChat: (id: string) => {
      flowRowToStage();
      openChat(id);
    },
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
  // What the sidebar reads beyond the sessions: both shells now (W1).
  // Launches are the stage's registry (lib/flowSessions): every launch until
  // its plan arrives or its terminal closes, the one on the stage active.
  const flowSidebarData = useMemo(
    () => ({
      launches: flowSidebarLaunches,
      activeLaunchId,
      working: flowWorking,
      needs: flowNeeds,
      // Chats are rows in both shells (the frame's "○ Billing chat"): the
      // open one reads selected while the door's room holds it.
      chats,
      activeChatId: roomChat ? chatId : null,
      ...(isFlowShell() ? { startActive: flowStartOnStage && !roomChat } : {}),
    }),
    [flowStartOnStage, roomChat, chats, chatId, flowSidebarLaunches, activeLaunchId, flowWorking, flowNeeds],
  );
  // The workbench sidebar's own data (W1): which Place reads selected, the
  // live runs and Localhost ports beside them, and each session's terminals
  // in the shared status vocabulary — its agent's terminal from
  // `useSessionTerminals`, its state from the CLI's own hooks.
  const sidebarPlace = !classicWb ? null : wbView.focusedKind === "runs" ? "runs" as const : wbView.focusedKind === "servers" ? "servers" as const : wbActiveKey === HOME_KEY ? "home" as const : null;
  const sidebarRunsLive = useMemo(() => summaries.filter((s) => isLiveRunState(s.runState)).length, [summaries]);
  // Read off the Localhost scan, which runs only while that pane is on
  // screen; a ports chip of its own comes with W7's discovery.
  const sidebarPorts = useMemo(() => (devServers.scan?.running ?? []).map((r) => `:${r.port}`), [devServers.scan]);
  const sidebarTerminals = useMemo(() => {
    const out: Record<string, { id: string; title: string; status: "needs" | "working" | "idle" | "exited" }[]> = {};
    for (const [sessionId, terminalId] of sessionTerminals) {
      const attention = terminalAttention.get(terminalId);
      const status = liveTermIds && !liveTermIds.includes(terminalId)
        ? "exited" as const
        : attention?.kind === "needs-you" || attention?.kind === "your-turn" ? "needs" as const
        : attention?.kind === "working" ? "working" as const
        : "idle" as const;
      (out[sessionId] ??= []).push({ id: terminalId, title: terminalTitles.get(terminalId) || "claude", status });
    }
    return out;
  }, [sessionTerminals, terminalAttention, terminalTitles, liveTermIds]);

  // The memoized sidebar and browser pane get identity-stable handlers (see
  // `commentCallbacks`), so they render when their data changes and not on
  // every shell render.
  const sidebarHandlers = useStableHandlers({
    // Flow: a row puts its session on the stage, so the start screen gives
    // way (as a door recent does) and a Tool steps back.
    onSelect: (id: string) => {
      if (isFlowShell()) {
        setFrontDoorOpen(false);
        flowRowToStage();
      }
      // `wb:session-switch`: the click to the stage showing the session
      // (ended once `sessionReady` flips, below). A re-click of the open
      // session is not a switch.
      if (id !== activeId) beginMeasure("wb:session-switch");
      setActiveId(id);
    },
    onSelectJoined: () => joinedInfo && setActiveId(joinedInfo.key),
    // The Places (W1): Home is the workbench's Home set (its door lands),
    // Runs and Localhost open in the current set.
    onSelectPlace: (place: "home" | "runs" | "servers") => {
      if (place === "home") {
        tripDoor();
        setActiveId(null);
        return;
      }
      selectSurface(place);
    },
    // A session's terminal row: the dock's tile, hailed. (Terminal panes in
    // the centre are W3's.)
    onSelectTerminal: (sessionId: string, terminalId: string) => {
      if (isFlowShell()) {
        flowShowTerminalRef.current(terminalId, "terminal");
        return;
      }
      // The session's agent terminal is its Agent tab: one pane per
      // terminal, opened again it comes forward.
      if (sessionTerminals.get(sessionId) === terminalId) {
        setActiveId(sessionId);
        wb.dispatch({ type: "openSurface", kind: "chat", key: planKey(sessionId), data: { source: "agent", terminalId, sessionId } });
        return;
      }
      revealTerm();
      terminalsRef.current?.selectTab(terminalId);
      terminalsRef.current?.hailTerminal(terminalId);
    },
    // A pending launch's row: its own set (the Agent tab) under the
    // workbench, the stage in flow.
    onSelectLaunch: (terminalId: string) => {
      if (isFlowShell()) {
        selectFlowLaunch(terminalId);
        return;
      }
      const launch = flowLaunches.find((l) => l.terminalId === terminalId);
      if (launch) {
        wb.dispatch({ type: "selectSession", key: launchKey(launch.launchId), defaults: { agentTerminalId: terminalId } });
        return;
      }
      revealTerm();
      terminalsRef.current?.selectTab(terminalId);
      terminalsRef.current?.hailTerminal(terminalId);
    },
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
      if (isFlowShell()) flowRowToStage();
      if (sessionId !== activeId) {
        beginMeasure("wb:session-switch");
        setActiveId(sessionId);
      }
      setViewedVersionNumber(versionNumber);
    },
    onOpenRunReport: (sessionId: string) => {
      // The run chip is the Runs monitor's one entry point: a live run opens
      // the live monitor (selecting the session so the monitor lands on ITS
      // run); a finished run reopens the report, as before.
      const chipRunState =
        summaries.find((s) => s.sessionId === sessionId)?.runState ?? null;
      if (isLiveRunState(chipRunState)) {
        if (sessionId !== activeId) setActiveId(sessionId);
        selectSurface("runs");
      } else {
        setRunReportFor(sessionId);
        selectSurface("review");
      }
    },
  });
  const browserHandlers = useStableHandlers({
    onOpenDraft: (draftId: string) => { setDrafterDraftId(draftId); setDrafterShelfOpen(false); selectSurface("drafter"); },
    onMissionContinue: (missionId: string, destination: "plan" | "auto", body: string, handoffId: string) => {
      const folder = sidebarTab.kind === "folder" ? sidebarTab.id : null;
      selectSurface("document");
      setSendError(null);
      setSendConfirm({ markdown: body, initialProject: guessProjectForPlan(body, projectOptions) ?? folder ?? lastLaunchProject, missionHandoff: { missionId, handoffId, destination } });
    },
    onClose: () => (classicWb ? closeSurfacePane("browser") : selectSurface("document")),
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
    onCloseDock: () => setDockOpenBy((state) => withDockOpen(state, "browser", false)),
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

  // ── The flow stage's props ───────────────────────────────────────────────
  const stageHarness: "claude" | "codex" =
    stageTarget.kind === "launch"
      ? (flowLaunches.find((l) => l.terminalId === stageTarget.terminalId)?.harness ?? "claude")
      : session?.backend === "codex"
        ? "codex"
        : "claude";
  // A live room's plan is on the plate too: its document is the mesh's.
  const stageHasPlan = stageTarget.kind === "plan" && (joinedActive || (sessionReady && !!latest));
  // The Feedback tab's verbs: the comment cards' own handlers.
  const feedbackActions = useMemo(
    () => ({
      accept: commentCallbacks.onAccept,
      reopen: commentCallbacks.onReopen,
      promote: commentCallbacks.onPromote,
      remove: commentCallbacks.onDelete,
      update: commentCallbacks.onUpdate,
      acceptSuggestion: commentCallbacks.onAcceptSuggestion,
    }),
    [commentCallbacks],
  );
  const stagePlanTitle = stageHasPlan
    ? (summaries.find((s) => s.sessionId === activeId)?.planTitle ?? null)
    : null;
  // The conversation's Talk: the dock's conversation beside the stage — the
  // plan's voice panel once there is a plan. A launch with no plan yet has no
  // voice of its own, so Talk says when it will.
  const flowTalk = () => {
    if (voiceDocked) closeDock();
    else if (dockReachable) openDiscussion();
    else setToast({ message: "Talk opens on the plan as soon as it arrives.", tone: "info" });
  };
  const renderFlowStage = (planBody: ReactNode) => {
    if (stageTarget.kind === "start" || !flowConvoHost) return planBody;
    const author = agentLabelFor(session?.backend ?? null);
    return (
      <Suspense fallback={null}>
        <ErrorBoundary region="session stage" fallback={surfaceFallback("session stage")}>
          <FlowStage
            target={stageTarget}
            harness={stageHarness}
            conversationHost={flowConvoHost}
            onPose={onFlowPose}
            hasPlan={stageHasPlan}
            planBody={planBody}
            latestVersion={latest?.versionNumber ?? null}
            comments={threadComments}
            viewing={
              isViewingHistorical && viewedRevision && latest
                ? {
                    viewing: viewedRevision.versionNumber,
                    latest: latest.versionNumber,
                    receivedAt: viewedRevision.receivedAt,
                    onGoToLatest: () => setViewedVersionNumber(null),
                  }
                : null
            }
            contents={{ open: tocOpen, onToggle: tocEligible ? () => setTocOpen(!tocOpen) : null }}
            width={{ wide: docWide, measure: docMeasure }}
            footer={{
              author,
              canSubmit,
              canApprove,
              waiting,
              waitingAsk,
              onSubmit: submitReview,
              onApprove: approvePlan,
              onApproveLater: () => void approvePlanLater(),
              onBuildTeam: (scale) => void startTeamBuild(scale),
              approval:
                session?.status === "approved"
                  ? {
                      version: session.revisions[session.revisions.length - 1]?.versionNumber ?? 1,
                      runState: activeRunState,
                      runLive: isLiveRunState(activeRunState),
                      // A live run, or the plan's own agent at work in its
                      // terminal after Approve & build.
                      building:
                        isLiveRunState(activeRunState) ||
                        (activeRunState === null && !!stageTerminalId && terminalKinds.get(stageTerminalId) === "working"),
                    }
                  : null,
              buildTargets,
              onBuild: (id) => void buildApproved(id),
              onReopen: () => void reopenApproved(),
              planState: session ? { status: session.status, runState: activeRunState, held: activeHeld } : undefined,
              onSetPlanState: session ? (state) => { void setPlanState(session.sessionId, state); } : undefined,
              onMoveProject: session ? () => { void openMovePlan(session.sessionId); } : undefined,
              progress: null,
              terminals: stageTerminalId ? 1 : 0,
              onShowTerminal: stageTerminalId ? () => setStage("terminal") : undefined,
            }}
            // Classic's plan-pane notices, every one (components/plan/PlanNotices).
            notices={{
              askModeViolation,
              onDismissAskMode: () => setAskModeViolation(false),
              warning,
              onDismissWarning: () => setWarning(null),
              detached: detached
                ? {
                    restoring,
                    status: restoreStatus,
                    failure: restoreFailure?.error ?? null,
                    copy: detachedCopy,
                    decision: restoreDecision,
                    onHarness: (h) => activeId && setHarnessChoices((prev) => ({ ...prev, [activeId]: h })),
                    blockers: restoreBlockers,
                    onFix: applyReadinessFix,
                    onRestore: restorePlanSession,
                    onCopyResume: copyRestoreCommand,
                    onDismiss: () => setDetachDismissed(true),
                  }
                : null,
              onViewPrior: setViewedVersionNumber,
            }}
            // Classic's Download and Live Session menus, as the plan's ⋯.
            planMenu={{
              onExport: exportRevision,
              onExportDocx: exportRevisionDocx,
              onSaveObsidian: saveRevisionToObsidian,
              onShare: () => setShareOpen(true),
              onInvite: surfaceEnabled(effectiveWorkspace, "collab") ? () => setInviteOpen(true) : null,
              onMove: openMovePlan,
            }}
            feedback={
              session
                ? {
                    session,
                    viewingVersion: isViewingHistorical && viewedRevision ? viewedRevision.versionNumber : (latest?.versionNumber ?? 1),
                    // A thread's anchor takes you to its comment (scrolled to,
                    // flashed, the block when it has no highlight).
                    onJumpToAnchor: (anchorId, commentId) => {
                      if (commentId) focusComment(commentId);
                      else documentRef.current?.querySelector(`[data-anchor-id="${cssEscape(anchorId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                    },
                    focusedCommentId,
                    submitInFlight: busy,
                    actions: feedbackActions,
                    onViewResearch: viewResearch,
                    composer: {
                      // A historical view's anchors point into another revision.
                      selection: isViewingHistorical ? null : selection,
                      onClearSelection: clearSelection,
                      onSubmit: (req) => submitComment(req),
                    },
                    onOpenVersion: (version) => setViewedVersionNumber(version === latest?.versionNumber ? null : version),
                    autoDiscussId: autoDiscussCommentId,
                    onAutoDiscussConsumed: clearAutoDiscuss,
                    autoOpenId: autoOpenCommentId,
                    onAutoOpenConsumed: clearAutoOpen,
                  }
                : null
            }
            composer={commentComposer}
            discussionZoom={{ value: discussionZoom, adjust: adjustDiscussionZoom }}
            terminalView={flowView === "terminal"}
            terminalDock={termDockRef}
          />
        </ErrorBoundary>
      </Suspense>
    );
  };

  // ── The flow shell's top bar and keys (C1) ──────────────────────────────
  // What the bar names: the session on the stage (its StageTarget), its mode,
  // its plan and its terminal — or the chat the door is holding, or the
  // start screen while the door is open.
  const flowSummary = stageTarget.kind === "plan" ? summaries.find((s) => s.sessionId === stageTarget.sessionId) ?? null : null;
  const flowChat = frontDoorOpen && chatInRoom && chatId ? chats.find((c) => c.companionId === chatId) ?? null : null;
  const flowTarget: ModeTarget = flowChat ? "chat" : frontDoorOpen ? "start" : stageTarget.kind;
  const flowPlanId = flowTarget === "plan" && stageTarget.kind === "plan" ? stageTarget.sessionId : null;
  const flowTerminalId = flowTarget === "launch" || flowTarget === "plan" ? stageTerminalId : null;
  // The CLI's own name for the session (`convo-title`) stands in until the
  // plan brings a title of its own.
  const flowCliTitle = stageTerminalId ? terminalTitles.get(stageTerminalId) ?? null : null;
  const flowTitle =
    flowTarget === "chat" ? flowChat?.title || "Chat"
      : flowTarget === "plan" && flowSummary ? (flowSummary.titleOverride || flowSummary.planTitle ? sessionTitle(flowSummary) : flowCliTitle ?? sessionTitle(flowSummary))
        : flowTarget === "launch" && stageTarget.kind === "launch" ? flowCliTitle ?? launchTitle(stageTarget.prompt)
          : null;
  const flowMode = sessionMode({
    target: flowTarget,
    status: flowSummary?.status,
    held: flowSummary?.held,
    revising: waiting,
    revisions: flowSummary?.revisions,
    runState: flowSummary?.runState,
  });
  const flowTools = useMemo(() => toolSurfaces(effectiveWorkspace), [effectiveWorkspace]);
  // The Tool on screen instead of the stage: the wall counts, so the top bar
  // offers the way back from it like any other.
  const flowToolSurface: ToolId | null = termFullscreen ? "terminals" : flowTools.find((t) => t.id === mainSurface)?.id ?? null;
  // "● N needs you" (lib/sessionMode `needsYou`): what waits on you anywhere
  // but the session on screen.
  const flowWaiting = needsYou({
    summaries,
    needsYouTerminals: flowNeedsYouTerms,
    // A review an agent asked for, or a run's report: classic's footer chip.
    reviewHold: codeReview.holdActive || !!reviewNews,
    // The session on screen is left out; on a Tool, nothing is on screen.
    activeSessionId: flowStageOwns ? flowPlanId : null,
    activeTerminalId: flowStageOwns ? flowTerminalId : null,
  });
  // Flow has no dock, so a terminal is shown as its session's stage (or its
  // launch's), in the view asked for; one no session owns, on the wall.
  const flowShowTerminal = (terminalId: string, view: StageView) => {
    const sessionId = [...sessionTerminals].find(([, t]) => t === terminalId)?.[0] ?? null;
    const launch = flowLaunches.some((l) => l.terminalId === terminalId);
    if (sessionId || launch) {
      setFrontDoorOpen(false);
      flowRowToStage();
      if (sessionId) setActiveId(sessionId);
      else selectFlowLaunch(terminalId);
      setStage(view);
      return;
    }
    enterTermFullscreen();
    void ensureTerminalReady().then((dock) => {
      dock?.selectTab(terminalId);
      dock?.hailTerminal(terminalId);
    });
  };
  flowShowTerminalRef.current = flowShowTerminal;
  flowJumpRef.current = () => flowJumpToNeedsYou();
  // A gesture, so a trip like any other: the door steps aside for it.
  const flowJumpToNeedsYou = () => {
    const plan = flowWaiting.plans[0];
    if (plan) {
      tripDoor();
      selectSessions();
      setActiveId(plan);
      selectSurface("document");
      setPlanPose(plan, "split");
    } else if (flowWaiting.terminals.length > 0) {
      // Its question or permission card is in the conversation.
      flowShowTerminal(flowWaiting.terminals[0], "conversation");
    } else if (flowWaiting.review) {
      tripDoor();
      selectSurface("review");
    }
  };
  // The Tool on screen, picked again (its row or its ⌘ key), is the way
  // back, like a tab you click a second time.
  const openFlowTool = (id: ToolId) => {
    if (id === flowToolSurface) return showFlowStage();
    tripDoor();
    if (id === "terminals") return enterTermFullscreen();
    setTermFullscreen(false);
    selectSurface(id);
  };
  const showFlowStage = () => {
    setTermFullscreen(false);
    if (mainSurface === "document") return;
    tripDoor();
    selectSurface("document");
  };
  // A sidebar row is the way back from anywhere: its session takes the stage,
  // and the sidebar is about sessions again (the terminal's folder follow
  // can have left it on a folder, which flow never shows).
  const flowRowToStage = () => {
    showFlowStage();
    selectSessions();
  };
  flowRowToStageRef.current = flowRowToStage;
  // Mount-once listeners read the latest of these.
  // ⌘N, File ▸ New Session and the ⌘⇧N alias are all keyboard summons of
  // the start screen (the start lane's openStartScreen): it arrives with the
  // caret in the box.
  const flowNewSession = () => openStartScreen("key");
  const flowKeys = { openTool: openFlowTool, newSession: flowNewSession, showStage: showFlowStage, planId: flowPlanId, workspace: effectiveWorkspace, surface: mainSurface, tool: flowToolSurface, toggleSidebar };
  const flowKeysRef = useRef(flowKeys);
  flowKeysRef.current = flowKeys;
  useEffect(() => {
    if (!isFlowShell()) return;
    const keys = () => flowKeysRef.current;
    // From a Tool, ⌘J and ⌘⌥B first bring the session back; ⌘J then stops
    // there rather than also flipping to the terminal.
    const stage = () => {
      if (keys().tool) keys().showStage();
      else toggleStage();
    };
    const planPanel = () => {
      const id = keys().planId;
      if (!id) return;
      keys().showStage();
      togglePlanPanel(id);
    };
    const tool = (n: number) => {
      const id = toolForKey(keys().workspace, n);
      if (id) keys().openTool(id);
      return !!id;
    };
    // Capture phase, ahead of xterm's helper textarea (like ⌘⇧J): the shell
    // never sees these. ⌘N and ⌘1–4 normally never get here — the native
    // menu takes them first, browser page focused or not — but a page with
    // no native menu still has them.
    const onKey = (e: KeyboardEvent) => {
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (isStageKey(e)) {
        claim();
        stage();
      } else if (isPlanPanelKey(e)) {
        claim();
        planPanel();
      } else if (isSidebarKey(e)) {
        // ⌘B is bold in a text editor, and the file tree on Code review.
        if ((e.target as HTMLElement | null)?.isContentEditable || keys().surface === "review") return;
        claim();
        keys().toggleSidebar();
      } else if (isNewSessionKey(e) || (e.metaKey && isNewPlanKey(e))) {
        // ⌘⇧N too, the old chord, for one release — taken here, ahead of
        // the classic listener, so it lands on the start screen rather than
        // the door. (⌘ only: Ctrl+⇧N stays the terminal's.)
        claim();
        keys().newSession();
      } else {
        const n = toolKeyOf(e);
        if (n && toolForKey(keys().workspace, n)) {
          claim();
          tool(n);
        }
      }
    };
    // Esc leaves a Tool for the session, when nothing nearer claimed it: a
    // field, the terminal, a menu, the browser's own tile restore.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !keys().tool) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], .xterm, [role=menu], [role=dialog]")) return;
      e.preventDefault();
      keys().showStage();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onEscape);
    // The same chords from inside a browser page (browser_signals.js →
    // BrowserPane), where none of our listeners can hear the keyboard.
    const fromPage: [string, () => void][] = [
      ["redline:toggle-monochat", stage],
      ["redline:toggle-sidebar", () => keys().toggleSidebar()],
      ["redline:toggle-plan-panel", planPanel],
    ];
    for (const [name, run] of fromPage) window.addEventListener(name, run);
    // The native menu's accelerators (workbench_menu.rs's flow set), installed now and
    // taken out again by the Settings switch before it reloads to classic.
    const onNew = listen("menu-new-session", () => keys().newSession());
    const onSurface = listen<number>("menu-surface", (e) => void tool(e.payload));
    void invoke("set_flow_menu", { enabled: true }).catch(() => {});
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keydown", onEscape);
      for (const [name, run] of fromPage) window.removeEventListener(name, run);
      void onNew.then((un) => un());
      void onSurface.then((un) => un());
    };
  }, []);

  // The plan body, built inside the centre's render below and mounted once
  // in `planHost` after it (siblings render in order).
  let planBodyNow: ReactNode = null;
  return (
    <MenuOverlayProvider value={adjustMenuOverlay}>
    <MonochatContext.Provider value={monochatRouting}>
    <div className={`h-full min-h-0 min-w-0 flex flex-col overflow-hidden${flowShell ? " rl-ambient" : ""}`}>
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
      {/* Immersive: the header becomes a hull rail until the pointer asks for
          it back. Reveal REFLOWS the plate down rather than floating over it —
          a native webview composites above all React DOM, so an overlaid
          header on the browser surface would simply be invisible. */}
      <ChromeSlot immersive={immersive} edge="top" reveal={chrome}>
      {isFlowShell() ? (
        <Suspense fallback={<div className="rl-app-header" style={{ height: 38 }} />}>
        <FlowTopBar
          title={flowTitle}
          mode={flowMode}
          planSessionId={flowPlanId}
          terminalId={flowTerminalId}
          toolSurface={flowToolSurface}
          sidebarOpen={!sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onShowStage={showFlowStage}
          needsYou={flowWaiting.count}
          onJumpToNeedsYou={flowJumpToNeedsYou}
          tools={flowTools}
          liveRuns={summaries.filter((s) => isLiveRunState(s.runState)).length}
          onOpenTool={openFlowTool}
          // What classic's header carried and no other flow control does.
          toolExtras={[
            { id: "palette", label: "Command palette", hint: "⌘K", onPick: () => setPaletteOpen(true) },
            ...(surfaceEnabled(effectiveWorkspace, "collab") ? [{ id: "join", label: "Join a live session…", onPick: () => setJoinOpen(true) }] : []),
            ...(surfaceEnabled(effectiveWorkspace, "memory") ? [{ id: "inspector", label: "Memory inspector", onPick: () => setMemoryInspectorOpen(true) }] : []),
            ...(activeHarness && activeHarness.entry !== "boot" ? [{ id: "harness", label: `Exit ${activeHarness.manifest.name}`, onPick: exitHarness }] : []),
          ]}
          settings={{
            onOpenIntegrationHooks: hookConflicts.openDialog,
            theme,
            onThemeChange,
            font,
            onFontChange,
            lint,
            onLintChange,
            mode,
            onModeChange: changeMode,
            flashEnabled,
            onFlashEnabledChange: setFlashEnabled,
            flashColor,
            onFlashColorChange: setFlashColor,
            flashSound,
            onFlashSoundChange: setFlashSound,
            flashSoundConfig,
            onFlashSoundConfigChange: setFlashSoundConfig,
            onFlashSoundPreview: (cfg) => playInterceptBeep(cfg),
            onFlashTest: () => {
              setFlashSeq((n) => n + 1);
              if (flashSound) playInterceptBeep(flashSoundConfig);
            },
            surfacesPanel: (
              <SurfacesPanel
                workspace={effectiveWorkspace}
                onUpdate={updateWorkspace}
                harnessName={activeHarness ? activeHarness.manifest.name : null}
              />
            ),
          }}
        />
        </Suspense>
      ) : (
      <Header
        onOpenIntegrationHooks={hookConflicts.openDialog}
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
        collabEnabled={surfaceEnabled(effectiveWorkspace, "collab")}
        memoryEnabled={surfaceEnabled(effectiveWorkspace, "memory")}
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
        // The harness chip — the one piece of header branding A5 swaps: the
        // harness's name where stock Redline shows none, doubling as the
        // exit. Hidden for a boot entry (a flavored build IS its harness;
        // there is no Redline underneath to exit to).
        harnessName={activeHarness ? activeHarness.manifest.name : null}
        onExitHarness={
          activeHarness && activeHarness.entry !== "boot" ? exitHarness : null
        }
        onOpenMemory={() => selectSurface("memory")}
        onOpenMemoryInspector={() => setMemoryInspectorOpen(true)}
        collabActive={!!collabShare || !!joinedRoom}
        canInvite={sessionReady && !!latest}
        onInvite={() => setInviteOpen(true)}
        onJoinSession={() => setJoinOpen(true)}
        canShare={sessionReady && !!latest}
        onShareSnapshot={() => setShareOpen(true)}
        onSnapBack={snapBack}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      )}
      </ChromeSlot>
      <HookConflictWarning health={hookConflicts} />
      {decisionWindow && (
        <Suspense fallback={null}>
          <DecisionWindowBanner
            event={decisionWindow}
            onOpen={openDecisionForReview}
            onApprove={approveFromDecision}
            onExpire={dismissDecisionWindow}
            raised={frontDoorOpen || doorCompact}
          />
        </Suspense>
      )}
      {joinedActive && joinedPresence && joinedRoom && !joinedRoom.revoked ? (
        <Suspense fallback={null}>
        <PresenceBar
          handle={joinedPresence}
          role="collaborator"
          onEnd={leaveJoined}
        />
        </Suspense>
      ) : !joinedActive &&
        sharePresence &&
        collabShare &&
        activeId === collabShare.sessionId ? (
        <Suspense fallback={null}>
        <PresenceBar
          handle={sharePresence}
          role="owner"
          onInvite={() => setInviteOpen(true)}
          onEnd={stopShare}
          onRevokePeer={(inviteHash) => revokeByHash(inviteHash)}
        />
        </Suspense>
      ) : null}
      </ErrorBoundary>
      {/* The window-edge hull ring: constant padding, never part of drag math
          (`computePaneLayout` subtracts it from the row's available width).
          Fullscreen takeovers (terminal, discussion) are absolute inset-0
          against this element, so they cover the ring — plates only. */}
      <main
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col"
        style={{ padding: `${flowShell ? 0 : SHELL_EDGE}px` }}
      >
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
          // Flow's sidebar sits flush on the window with its own rule; the
          // plate is classic's.
          className={`shrink-0 rl-sidebar-clip${isFlowShell() ? "" : " rl-plate"}`}
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
          {/* Flow's sidebar is sessions only; folders open from the composer. */}
          {!isFlowShell() && openFolders.length > 0 && <Suspense fallback={null}><SidebarTabStrip
            openFolders={openFolders}
            sidebarTab={sidebarTab}
            linkNav={linkNav}
            onSelectSessions={selectSessions}
            onSelectFolder={selectFolderTab}
            onCloseFolder={closeFolder}
            onToggleLink={() => setLinkNav((v) => !v)}
          /></Suspense>}
          {isFlowShell() || sidebarTab.kind === "sessions" ? (
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
              runsLive={sidebarRunsLive}
              localhostPorts={sidebarPorts}
              terminals={sidebarTerminals}
            />
            </Suspense>
          ) : (
            <div className="flex-1 overflow-y-auto" style={{ background: "var(--color-paper)" }}>
              <Suspense fallback={null}>
              <FileTree
                root={sidebarTab.id}
                onPlanHere={(path) => { setFrontDoorProject({ path }); openFrontDoor(); }}
                activeFile={activeFile}
                onOpenFile={handleOpenFile}
              />
              </Suspense>
            </div>
          )}
        </aside>
        {/* In curtain state the flow boundary sits under the spilled aside, so
            the divider rides the curtain's visible right edge instead. */}
        {liveFlags.curtainL && !isFlowShell() && (
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
              orientation="vertical"
              side="leading"
              label="sidebar"
              collapsed={sidebarCollapsed}
              dragging={sidebarDragging}
              onToggle={toggleSidebar}
              onPointerDown={startSidebarDrag}
              hideChevron={latchActive}
            />
          </div>
        )}
        </div>
        )}
        {/* Always in flow (its 6px is part of the space model); when the
            sidebar curtains it is painted over, and the absolute copy above
            carries the affordance at the curtain's visible edge. The flow
            shell has none: its sidebar is a fixed column with its own rule,
            shown and hidden with ⌘B, and "+ New session" is its way in. */}
        {!isFlowShell() && <PaneDivider
          orientation="vertical"
          side="leading"
          label="sidebar"
          collapsed={sidebarCollapsed}
          dragging={sidebarDragging}
          onToggle={toggleSidebar}
          onPointerDown={startSidebarDrag}
          hideChevron={latchActive || liveFlags.curtainL}
          // The front door's affordance, on the one piece of the sidebar that
          // never goes away. Its only other visible entry is a row INSIDE the
          // sessions list, and that list is now closed on every non-document
          // surface (and collapsible on the document) — so without this the
          // app's resting state would be reachable only through ⌘K.
          action={{
            glyph: "＋",
            label: "Plan a build (⌘⇧N)",
            onClick: openFrontDoor,
          }}
        />}
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
            data-main-surface={mainSurface}
            style={{ "--rl-doc-zoom": docZoom } as React.CSSProperties}
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
                ref={tocRailRef}
                className="rl-toc-rail"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: `${tocRailW}px`,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--color-bg-elevated)",
                  borderRight: "1px solid var(--color-rule)",
                  boxShadow: "4px 0 16px rgba(0,0,0,0.12)",
                  transition: tocDragging
                    ? "none"
                    : "width 160ms cubic-bezier(0.4,0,0.2,1)",
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
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "8px" }}
                  >
                    <button
                      type="button"
                      onClick={() => setTocWide(!tocWide)}
                      title={tocWide ? "Narrow the rail" : "Widen the rail"}
                      aria-label={
                        tocWide ? "Narrow the contents rail" : "Widen the contents rail"
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--color-ink-muted)",
                        cursor: "pointer",
                        fontSize: "12px",
                        lineHeight: 1,
                      }}
                    >
                      {tocWide ? "⤡" : "⤢"}
                    </button>
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
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  <Suspense fallback={null}>
                  <PlanToc
                    sections={displaySections}
                    scopeSelector=".doc-article"
                  />
                  </Suspense>
                </div>
                {/* Drag-to-snap handle on the rail's right edge: transient
                    width while dragging, release snaps to 230/340 (the width
                    transition above animates the settle). */}
                <div
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const rail = tocRailRef.current;
                    const scroller = docScrollerRef.current;
                    if (!rail) return;
                    (e.currentTarget as HTMLElement).setPointerCapture(
                      e.pointerId,
                    );
                    const left = rail.getBoundingClientRect().left;
                    setTocDragging(true);
                    beginResizeSession();
                    // Written straight onto the two elements that use it. A
                    // custom property on the doc column would have been tidier
                    // to read, but it would invalidate style for the entire
                    // plan document on every frame — which is exactly the cost
                    // this handle is trying to avoid.
                    let pending = tocRailW;
                    const apply = rafCoalesce((px: number) => {
                      rail.style.width = `${px}px`;
                      if (scroller) scroller.style.paddingLeft = `${px}px`;
                    });
                    const move = (ev: PointerEvent) => {
                      pending = clampTocDrag(ev.clientX - left);
                      apply(pending);
                    };
                    const up = () => {
                      apply.cancel();
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                      const wide = snapTocWide(pending);
                      setTocDragging(false);
                      setTocWide(wide);
                      // The snap often lands back on the width React already
                      // rendered (drag 230 → 250 → snap 230), in which case its
                      // style diff writes nothing and the last drag frame would
                      // stick. Set the resting width explicitly — next frame,
                      // so the just-restored transition animates the settle.
                      const rest = wide ? TOC_RAIL_W_WIDE : TOC_RAIL_W;
                      requestAnimationFrame(() => {
                        rail.style.width = `${rest}px`;
                        if (scroller) {
                          scroller.style.paddingLeft = `${rest}px`;
                        }
                      });
                      endResizeSession();
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }}
                  title="Drag to resize the contents rail"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: "-3px",
                    bottom: 0,
                    width: "6px",
                    cursor: "col-resize",
                    zIndex: 21,
                    touchAction: "none",
                  }}
                />
              </div>
            ) : (
              // Sheds "Contents" and stands down to the bare ☰ once the text
              // column grows out to meet it — see useTextClearance below. The
              // aria-label is the full name in both forms, so the burger never
              // becomes an unlabelled glyph to a screen reader. `gap` lives in
              // .rl-toc-btn rather than here so it can animate closed with the
              // label; an inline value would outrank the collapsed rule.
              <button
                ref={tocBtnRef}
                type="button"
                onClick={() => setTocOpen(true)}
                title="Show contents"
                aria-label="Show table of contents"
                className="rl-toc-btn font-sans"
                style={{
                  position: "absolute",
                  top: "10px",
                  left: "10px",
                  zIndex: 20,
                  display: "flex",
                  alignItems: "center",
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
                <span aria-hidden>☰</span>
                <span className="rl-toc-btn-label">Contents</span>
              </button>
            );
          })()}
          {(() => {
            const drafterMount = resolveDrafterMountDoc(
              drafterSessionCache.current,
              drafterLoaded,
              drafterDraftId,
            );
            // The shelf is a SHEET over the document, not a replacement for
            // it. Swapping the whole surface meant opening the shelf hid the
            // document you were writing — you lost your place to look
            // something up. Same glass recipe as the launch bar; Esc closes.
            const drafterShelf = drafterShelfOpen ? (
              <div
                className="rl-dl-shelf"
                data-no-drag="true"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDrafterShelfOpen(false);
                }}
              >
                <Suspense fallback={null}>
                  <BookshelfView
                    openDraftId={drafterDraftId}
                    openIds={drafterOpenIds}
                    defaultProject={drafterProjectPath}
                    onOpen={(id) => {
                      setDrafterDraftId(id);
                      setDrafterShelfOpen(false);
                    }}
                    onCloseDoc={closeDrafterDoc}
                    onClose={() => setDrafterShelfOpen(false)}
                  />
                </Suspense>
              </div>
            ) : null;
            // The agent shelf rides the same sheet recipe: the document stays
            // mounted underneath, Esc closes. A run closes the sheet so the
            // user watches the tracked changes land in their document.
            const agentShelf =
              agentShelfOpen && drafterDraftId ? (
                <div
                  className="rl-dl-shelf"
                  data-no-drag="true"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAgentShelfOpen(false);
                  }}
                >
                  <Suspense fallback={null}>
                    <AgentShelf
                      draftId={drafterDraftId}
                      projectPath={drafterProjectPath}
                      getLiveMarkdown={getDrafterLiveMarkdown}
                      onRunStarted={(name) => {
                        shelfRunLive.current = name;
                        setAgentShelfOpen(false);
                        setToast(
                          `${name} is working — its edits will land as tracked changes.`, 8000,
                        );
                      }}
                      onClose={() => setAgentShelfOpen(false)}
                    />
                  </Suspense>
                </div>
              ) : null;
            const drafterBody = drafterRecovery?.forId === drafterDraftId ? (
              // The crash-recovery choice, as a card rather than a native
              // confirm. Nothing is destroyed until the user picks.
              <EmptyState
                title="Recover unsaved changes?"
                body={
                  "This document has edits that didn't reach the database " +
                  "before Redline last closed. They're still here — pick which " +
                  "copy is the document."
                }
                action={{
                  label: "Recover them",
                  onAction: () => {
                    const r = drafterRecovery;
                    setDrafterRecovery(null);
                    setDrafterLoaded({ forId: r.forId, doc: r.shadow.json });
                    // Land the recovered body now; the shadow clears only once
                    // the DB write is CONFIRMED.
                    void persistDraftDoc(
                      r.forId,
                      r.shadow.markdown,
                      r.shadow.json,
                      r.projectPath,
                    )
                      .then(() => clearDrafterShadow(r.forId))
                      .catch((err) => {
                        setToast(`Couldn't save the recovered copy: ${err}`, 8000);
                      });
                  },
                }}
                secondary={{
                  label: "Discard them",
                  onAction: () => {
                    const r = drafterRecovery;
                    setDrafterRecovery(null);
                    setDrafterLoaded({ forId: r.forId, doc: r.stored });
                    clearDrafterShadow(r.forId);
                  },
                }}
              />
            ) : drafterOpening ||
              drafterMount === null ||
              drafterProject?.forId !== drafterDraftId ? (
              // A body belonging to a DIFFERENT id is the same state as not
              // loaded at all — the gate makes mounting the wrong body
              // unrepresentable during a doc switch. The project pick is gated
              // on the same id for the same reason: it is what the persist
              // writes, and `upsert_draft` writes `project_path`
              // unconditionally, so a null must mean "explicitly Home" and
              // never "I don't know". Waiting here removes "I don't know" from
              // the reachable states rather than guarding against it downstream.
              //
              // The editor is deliberately NOT held back until the spring
              // lands. Mounting inside the growing container is the point —
              // the ribbon and page grow with it, which is what "the island
              // becomes the Drafter" actually looks like. Holding it out meant
              // an empty box grew and the surface appeared afterwards, which
              // is a reveal, not an expansion.
              //
              // That was only ever unsafe because of the `fill: "backwards"`
              // bug in SpringSwap, which snapped the surface back to
              // island-size for a frame at the landing. With the fill correct,
              // a mid-flight mount rides the transform — and WAAPI transforms
              // run on the compositor, so even TipTap's expensive first
              // construction cannot stall the animation.
              //
              // Nothing is rendered meanwhile: the growth IS the loading
              // indicator, and a sentence that appears inside the surface as it
              // opens and is taken away again is worse than an empty one.
              swapFrom || quietOpen ? null : (
                <EmptyState
                  title="Opening the document…"
                  body="Reading it from your Bookshelf."
                />
              )
            ) : (
              // Lazy chunk; fallback matches the doc-loading beat above so a
              // first open never flashes an empty pane.
              //
              // SILENT during a spring. The fallback is a small block of text
              // at the surface's top-left, and a spring scales the surface up
              // from the island's box — so that text visibly flew across the
              // window and grew, then hard-swapped for the editor when the
              // chunk landed. That was the first-run jank, and only the first
              // run, because the chunk is cached after. What springs now is an
              // empty glass surface and the editor fades in behind it.
              <Suspense
                fallback={
                  swapFrom || quietOpen ? null : (
                    <EmptyState
                      title="Opening the document…"
                      body="Reading it from your Bookshelf."
                    />
                  )
                }
              >
                <ErrorBoundary region="drafter" fallback={surfaceFallback("drafter")}>
                  <PromptDrafter
                    // Remount on the open document so TipTap picks up its content:
                    // `content` is captured once, at editor creation.
                    key={drafterDraftId ?? ""}
                    draftId={drafterDraftId ?? ""}
                    doc={drafterMount.doc}
                    onPersist={drafterPersist}
                    projectOptions={projectOptions}
                    selectedProject={drafterProjectPath}
                    onSelectedProjectChange={setDrafterProjectPath}
                    onLaunch={launchFromDrafter}
                    readiness={readiness}
                    onFix={applyReadinessFix}
                    // ONLY this document's launch. One pending state serves every
                    // door, so a card keyed to another document (or to the front
                    // door) would claim a launch that isn't this one's.
                    pending={
                      pendingLaunch?.origin === "drafter" &&
                      pendingLaunch.draftId === drafterDraftId
                        ? pendingLaunch
                        : null
                    }
                    onDismissPending={() => setPendingLaunch(null)}
                    sources={drafterSources}
                    onAttachFiles={attachDrafterFiles}
                    onRemoveSource={removeDrafterSource}
                    templates={drafterTemplates}
                    onUseTemplate={useDrafterTemplate}
                    // The floating Discuss pill inside the drafter pane opens the
                    // draft's voice panel — the one discussion surface (talk or
                    // type). Hidden while the panel is up.
                    onDiscuss={
                      dockReachable && !dockOpen ? openDock : null
                    }
                    onOpenShelf={() => setDrafterShelfOpen(true)}
                    onOpenAgents={() => setAgentShelfOpen(true)}
                    // Only when the drafter is living inside the Front Door's
                    // island; reached by its own route there is nothing to go
                    // back to.
                    // Back to the Front Door, which is the Document surface's
                    // resting state and always has been.
                    onExit={() => (classicWb ? closeSurfacePane("drafter") : selectSurface("document"))}
                    saveState={drafterSaveState}
                    consumeSeed={consumeLandingSeed}
                    registerLiveMarkdown={registerDrafterLiveMarkdown}
                    documentsMenu={
                      <Suspense fallback={null}>
                      <DocumentsMenu
                        openIds={drafterOpenIds}
                        activeId={drafterDraftId}
                        defaultProject={drafterProjectPath}
                        side="above"
                        onActivate={setDrafterDraftId}
                        onCloseDoc={closeDrafterDoc}
                      />
                      </Suspense>
                    }
                  />
                </ErrorBoundary>
              </Suspense>
            );
            // An orchestrated run wraps the review pane in its RunReport
            // container (claims vs ground truth above, resolution bar below);
            // closing the container falls back to the plain review pane.
            const runReportSummary = runReportFor
              ? summaries.find((s) => s.sessionId === runReportFor) ?? null
              : null;
            const reviewBody = runReportFor ? (
              <Suspense fallback={null}>
              <RunReport
                planSessionId={runReportFor}
                planTitle={runReportSummary?.planTitle ?? null}
                repoPath={runReportSummary?.projectPath ?? null}
                review={codeReview}
                projectOptions={projectOptions}
                onClose={() => setRunReportFor(null)}
                onResolved={() => void refreshSummaries()}
                canRelaunch={runReportSummary?.status === "approved"}
                onRelaunch={(sid) => void relaunchOrchestrator(sid)}
                onStandDown={(sid) => void standDownRun(sid)}
              />
              </Suspense>
            ) : (
              <ErrorBoundary region="review pane" fallback={surfaceFallback("review pane")}>
                <Suspense fallback={null}>
                  <ReviewPanel
                    review={codeReview}
                    projectOptions={projectOptions}
                    onOpenTerminal={(cwd, command) => {
                      suppressTerminalRevealFocus(); setTermFullscreen(false); revealTerm();
                      void ensureTerminalReady().then(async terminals => {
                        const id = terminals?.openSessionTerminal(cwd);
                        if (!id) { setToast("Couldn't open a terminal", 6000); return; }
                        if (command) {
                          const result = await deliverToTerminal(tauriHandoffDeps, id, [{ stage: "launch", data: command }]);
                          if (!result.ok) setToast(`Couldn't prepare the command: ${result.reason}`, 6000);
                        }
                      }).catch(error => setToast(`Couldn't open a terminal: ${String(error)}`, 6000));
                    }}
                    onClose={() => (classicWb ? closeSurfacePane("review") : selectSurface("document"))}
                  />
                </Suspense>
              </ErrorBoundary>
            );
            const serversBody = (
              <Suspense fallback={null}>
                <ServersPane
                  scan={devServers.scan}
                  error={devServers.error}
                  onRefresh={devServers.refresh}
                  onStop={devServers.stopServer}
                  onPlanStop={devServers.planStop}
                  projectOptions={projectOptions}
                  onRun={runDevServer}
                  onOpenUrl={openUrlInBrowser}
                />
              </Suspense>
            );
            const memoryBody = (
              // fallback={null}: the surface arrives a beat after its plate,
              // which reads as a settle — a spinner would read as a glitch.
              // (Also the boundary itself: `lazy` with no Suspense above it
              // throws to the content-area ErrorBoundary on a cold chunk.)
              <Suspense fallback={null}>
                <ErrorBoundary region="memory" fallback={surfaceFallback("memory")}>
                  <MemorySurface
                    activeSessionId={session?.sessionId ?? null}
                    activeSessionName={session?.projectName ?? null}
                    tabRequest={mainSurface === "memory" ? tabRequest : null}
                  />
                </ErrorBoundary>
              </Suspense>
            );
            const runsBody = (
              <Suspense fallback={<EmptyState title="Runs" body="Opening the monitor…" />}>
                <ErrorBoundary region="runs" fallback={surfaceFallback("runs")}>
                  <OrchestrationSurface
                    active={runsOpen}
                    nativeRunId={nativeRunId}
                    onOpenPlanBlock={(sessionId, blockId) => { setActiveId(sessionId); setRunPlanAnchor({ sessionId, blockId: blockId.replace(/^rl:/, "") }); selectSurface("document"); }}
                    onReviewSession={(id) => { void openRunReview(id).catch((err) => setToast(`Could not open review: ${err}`)); }}
                    summaries={summaries}
                    activePlanSessionId={activeId}
                    onOpenRunReport={(sid) => {
                      setRunReportFor(sid);
                      selectSurface("review");
                    }}
                    onRetryLaunch={(sid) => void relaunchOrchestrator(sid)}
                    onResetRun={(sid) => void resetRunFor(sid)}
                    onUnapprove={(sid) => void unapproveSession(sid)}
                    onStandDown={(sid) => void standDownRun(sid)}
                    tabRequest={runsOpen ? tabRequest : null}
                    onToast={setToast}
                  />
                </ErrorBoundary>
              </Suspense>
            );
            // Exactly one surface owns the pane; a non-document surface splits
            // against the document only while the doc pin is on, with the exact
            // same SplitPane (orientation toggle, ratio and fold-to-edge
            // divider) the browser has always used.
            const planBody = (
          <div
            ref={docScrollerRef}
            className="rl-thin-scroll-y flex-1 overflow-y-auto"
            style={{
              paddingLeft: tocDocked ? `${tocRailW}px` : undefined,
              transition: tocDragging
                ? "none"
                : "padding-left 160ms cubic-bezier(0.4,0,0.2,1)",
            }}
          >
          <article
            ref={documentRef}
            data-tour="editor"
            className="doc-article mx-auto pl-16 py-10"
            style={
              {
                // Wide view drops the measure entirely and lets the column run
                // to the pane's edges (`mx-auto` then has nothing to centre);
                // normal view keeps the 820px reading measure.
                //
                // With no document on the plate, neither applies: what is left
                // there (a loading or revoked notice) centres on its own, and a
                // wide-view setting left over from a plan must not slide it
                // sideways. Symmetric, slim gutters instead of the reading ones.
                ...(flowStageOwns ? FLOW_ARTICLE : docSurfaceActive ? docArticleWidth(docWide, docMeasure) : { maxWidth: "none", paddingRight: "24px" }),
                ...(flowStageOwns ? null : { paddingLeft: docSurfaceActive ? undefined : "24px" }),
                // `--rl-doc-zoom` moved UP one level, to the ancestor every
                // surface body shares — it was inert in the Drafter from here.
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
                  <ErrorBoundary region="collab plan editor" fallback={surfaceFallback("collab plan editor")}>
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
                  </ErrorBoundary>
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
                    <Button
                      variant="ghost"
                      onClick={leaveJoined}
                      label="Leave the session"
                      style={{
                        display: "inline-flex",
                        textDecoration: "underline",
                      }}
                    />
                  </>
                }
              />
            ) : joinedActive ? null : !classicWb && sidebarTab.kind === "folder" ? (
              <EmptyState
                title="Browsing files"
                body="Select a file from the tree to view it here."
              />
            ) : !shellReady || (activeId && !sessionReady) ? (
              // Mid-choreography the plate stays quietly blank — a "Loading…"
              // flash inside the parting doors reads as a glitch, and the
              // plate's own fade already covers the wait.
              bootAnimating ? null : (
                <EmptyState
                  title="Loading…"
                  body="Fetching the latest review session."
                />
              )
            ) : sessionReady ? (
              isViewingHistorical && viewedRevision ? (
                <HistoricalRevisionView
                  sessionId={activeId ?? ""}
                  revision={viewedRevision}
                  diff={historicalDiff}
                  latestVersionNumber={latest?.versionNumber ?? 0}
                  focusedCommentId={focusedCommentId}
                  focusNonce={focusNonce}
                  onHighlightClick={handleHighlightClick}
                  onBackToLatest={() => setViewedVersionNumber(null)}
                  // Flow says it once, in the plan header's version pill.
                  banner={!flowStageOwns}
                />
              ) : (
                <Suspense fallback={null}>
                  {/* Clean slate: the latest revision renders with no diff
                      highlights and only its own comments — prior rounds live
                      on the previous version (revisions navigator). */}
                  <ErrorBoundary region="plan editor" fallback={surfaceFallback("plan editor")}>
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
                      focusNonce={focusNonce}
                      onHighlightClick={handleHighlightClick}
                      actionsRef={planActionsRef}
                      onLockedEdit={lockedEditToast}
                      collab={ownerCollab}
                      // Flow's split pose has no comment pane: a mark's words
                      // go under its block (board 4c).
                      marginNotesBy={flowStageOwns && flowPainted.pose === "split" ? relayDefaults.displayName : undefined}
                    />
                  </ErrorBoundary>
                </Suspense>
              )
            ) : (
              // The empty plate shows nothing of its own: the Front Door rests
              // over it (MonochatIsland's resting pose).
              null
            )}
          </article>
          </div>
              );
            // The plate's file face (flow and the legacy centre); under the
            // workbench a file is its own pane, below.
            const documentBody =
              plateMode === "file" && activeFile ? (
                <Suspense fallback={null}>
                  <FileViewer path={activeFile} onClose={handleCloseFile} onSaved={toastSaved} />
                </Suspense>
              ) : planBody;
            const browserBody = <PersistentPortalSlot key="browser" name="browser" host={browserHost} />;
            // What the editor mounts with, resolved HERE rather than pushed at
            // it every 400ms. The session cache is strictly fresher than
            // `drafterLoaded` by construction, and reading it at the mount site
            // is what lets the persist stop writing a prop the component
            // contractually ignores after mount.
            // Arriving from the Front Door, the drafter springs out of the
            // box the island occupied, with the door still mounted behind it
            // and fading — one spring, two separate surfaces, App owning the
            // transition between them.
            //
            // `from` is null for the header and command-palette routes: they
            // have no island to spring from, so SpringSwap renders the body
            // untouched.
            const drafterSurface = (
              <SpringSwap
                from={swapFrom}
                onArrived={() => setSwapFrom(null)}
                leaving={swapFrom ? documentBody : null}
              >
                <div className="relative flex h-full min-h-0 flex-col">
                  {drafterBody}
                  {drafterShelf}
                  {agentShelf}
                </div>
              </SpringSwap>
            );
            // The surface dispatch — a lenient record over the bodies this
            // build ships, not a closed ternary: a manifest can name any
            // surface (a harness pack, a future workspace.json), and an id
            // this build can't render resolves to no body — the document —
            // never to a type error. The bodies are the consts built above,
            // so the record costs what the ternary cost.
            const surfaceBodies: Record<string, ReactNode | undefined> = {
              browser: browserBody,
              drafter: drafterSurface,
              review: reviewBody,
              servers: serversBody,
              memory: memoryBody,
              runs: runsBody,
              // No `chat` entry: the room is a conversation, and conversations
              // live in the dock now. `"chat"` stays in the `MainSurface` union
              // for one release (a downgrade must still read its own persisted
              // key) and resolves here to no body — the document — which is
              // exactly what the lenient record is for.
            };
            // The workbench: the active set's tabs over these same bodies,
            // each pane in a kind-named boundary (WorkbenchStage). Singleton
            // bodies (the browser, the companion chat) mount once, in their
            // portals; a pane shows only their slot.
            if (classicWb) {
              planBodyNow = planBody;
              const spring = (pane: AnyPane, body: ReactNode): ReactNode =>
                swapFrom && convertedPaneRef.current === pane.id && pane.kind !== "drafter" && pane.kind !== "browser"
                  ? <SpringSwap from={swapFrom} onArrived={() => { convertedPaneRef.current = null; setSwapFrom(null); }}>{body}</SpringSwap>
                  : body;
              const renderPane = (pane: AnyPane, ctx: PaneContext): ReactNode => {
                switch (pane.kind) {
                  case "door":
                    // The island lands on this plate while the pane is on
                    // screen and focused (MonochatIsland reads the attribute).
                    return <div className="rl-wb-door-plate" data-rl-door-plate={ctx.visible && ctx.focused ? "" : undefined} />;
                  case "plan":
                    return <Singleton host={planHost} pane={pane} ctx={ctx} holder={singletonHolder(wb.getState(), "plan", planHolder)} bring={setPlanHolder} />;
                  case "file":
                    return (
                      <Suspense fallback={null}>
                        <FileViewer path={pane.data.path} onClose={handleCloseFile} onSaved={toastSaved} />
                      </Suspense>
                    );
                  case "browser":
                    return <Singleton host={browserHost} pane={pane} ctx={ctx} holder={browserHeld} bring={setBrowserHolder} />;
                  case "chat": {
                    if (pane.data.source === "companion") return <SingletonSlot host={chatHost} name="conversation" active={ctx.visible} />;
                    // The session's own conversation: the agent in its
                    // terminal, mirrored. Keyed by the terminal, so a launch
                    // becoming its plan keeps the conversation.
                    const agentTerminal = pane.data.terminalId;
                    const agentSession = pane.data.sessionId;
                    const launch = flowLaunches.find((l) => l.terminalId === agentTerminal) ?? null;
                    const own = agentSession !== null && agentSession === activeId;
                    const ownSummary = own ? summaries.find((s) => s.sessionId === agentSession) ?? null : null;
                    const harness: "claude" | "codex" = launch?.harness ?? ((own ? session?.backend : ownSummary?.backend) === "codex" ? "codex" : "claude");
                    const ownMode = ownSummary
                      ? sessionMode({ target: "plan", status: ownSummary.status, held: ownSummary.held, revising: waiting, revisions: ownSummary.revisions, runState: ownSummary.runState })
                      : null;
                    const projectPath = launch?.projectPath ?? (own ? session?.projectPath ?? null : null);
                    return (
                      <Suspense fallback={null}>
                        <AgentPane
                          key={agentTerminal}
                          terminalId={agentTerminal}
                          sessionId={agentSession}
                          harness={harness}
                          visible={ctx.visible}
                          cliAvailable={!liveTermIds || liveTermIds.includes(agentTerminal)}
                          onCliView={setCliView}
                          onFork={harness === "claude" ? (cliSessionId) => void forkCliSession(cliSessionId, projectPath) : null}
                          planTitle={ownSummary?.planTitle ?? null}
                          planMarks={own ? pendingComments.length : 0}
                          // The plan is a tab of this set: open while it is on
                          // screen, and its card opens it.
                          planOpen={wbView.visibleKinds.includes("plan")}
                          onOpenPlan={() => wb.dispatch({ type: "openSurface", kind: "plan" })}
                          projectPath={projectPath}
                          planMarkdown={own ? latest?.rawPlanMarkdown ?? null : null}
                          termState={terminalKinds.get(agentTerminal) === "needs-you" ? "needs-you" : terminalKinds.get(agentTerminal) === "working" ? "working" : null}
                          talking={voiceDocked}
                          onTalk={flowTalk}
                          planState={ownSummary ? {
                            label: ownMode?.label ?? "Plan",
                            kind: ownMode?.kind ?? "plan",
                            held: ownSummary.held,
                            toReview: threadComments.filter((c) => c.status === "resolved").length,
                          } : null}
                          fallbackModel={own && session?.model ? { model: session.model, effort: session.effort ?? null } : null}
                          fallbackMode={ownSummary?.status === "in_review" ? "plan" : null}
                        />
                      </Suspense>
                    );
                  }
                  case "terminals":
                    return <EmptyState title="Terminals" body="Terminal walls move into tabs in a later phase; the dock below still holds them." />;
                  case "drafter":
                    return drafterSurface;
                  case "review":
                    return spring(pane, reviewBody);
                  case "servers":
                    return spring(pane, serversBody);
                  case "memory":
                    return spring(pane, memoryBody);
                  case "runs":
                    return spring(pane, runsBody);
                }
              };
              return (
                <Suspense fallback={null}>
                  <WorkbenchStage
                    store={wb}
                    renderPane={renderPane}
                    describePane={describePane}
                    onSplitDragging={setSplitDragging}
                    onNewTab={openDoorTab}
                    right={stageActions}
                  />
                </Suspense>
              );
            }
            const secondaryBody =
              mainSurface === "document"
                ? null
                : (surfaceBodies[mainSurface] ?? null);
            if (secondaryBody && docPinned)
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
            // Flow: the session stage, holding the plan document in its panel
            // — or, with no session on it, the start screen's plate: empty,
            // the window's colour, and where the resting door lands.
            if (flowStageOwns) return renderFlowStage(documentBody);
            if (flowStartOnStage) return <div data-rl-door-plate className="rl-flow-start-plate" />;
            // No secondary pane open → the document is the default full view.
            return planSwap ? <SpringSwap key={planSwap.launchId} from={planSwap.from} onArrived={() => setPlanSwap(null)}>{documentBody}</SpringSwap> : documentBody;
          })()}
          {/* The Discuss pill — the discussion entry on the document pane.
              Opens the plan's voice panel: the one discussion surface
              (voice-first, typed composer inside). Hidden while the panel
              is up. Stands up out of the article's way when the pane gets too
              narrow to hold both; 64 is the article's pl-16. */}
          {mainSurface === "document" &&
            // Not on the Front Door. The door is one composed gesture — a
            // sentence and three destinations, one of which IS a conversation
            // — and a floating pill offering a fourth way to the same place
            // would be the header-button sprawl this app refuses, one level
            // down. Everywhere else on this surface the pill is the way in.
            plateMode !== "door" &&
            !dockOpen &&
            dockReachable && (
              <DiscussPill
                onClick={openDiscussion}
                // Only a plan has an article to stand clear of; the file
                // viewer has none, and a stale ref would stow the pill against
                // a column that isn't on screen.
                textRef={
                  plateMode === "plan" && planDiscussable
                    ? documentRef
                    : undefined
                }
                textInset={64}
                measureKey={`${docWide}:${docMeasure}`}
                voiceKey={dockContext?.key}
              />
            )}
          {/* Floating document zoom + line-width control — pinned to the pane
              (doesn't scroll with the plan). A document always has it; the only
              thing that goes without is the folder file viewer, which isn't one.

              It stacks into a narrow column whenever the text would otherwise
              reach it — always in wide view, where full-bleed text leaves no
              horizontal gutter to lie in, and on any pane too narrow to seat
              the row. The vertical gutter is free either way, and standing up
              is what keeps the way back OUT of wide view on screen: the toggle
              that undoes the mode lives in here, so this control shrinking is
              always the right answer and disappearing never is.
              `column-reverse` so the order still reads + above − with the mode
              toggle on top. */}
          {(mainSurface === "document" ? docSurfaceActive : drafterOpen) &&
            plateMode !== "file" && (
            <div
              ref={zoomCtrlRef}
              className={`rl-doc-zoom absolute flex items-center gap-1 rounded-full${zoomColumn ? " flex-col-reverse" : ""}`}
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
                  // Stacked, the readout sets the whole column's width — so it
                  // drops the "%" and its reserved room for the three digits it
                  // actually needs. Every px here is a px of gutter the column
                  // needs to clear the text, and on the panes that force the
                  // stack there are few going spare.
                  minWidth: zoomColumn ? "22px" : "34px",
                  color: "var(--color-ink-muted)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {Math.round(docZoom * 100)}
                {zoomColumn ? "" : "%"}
              </button>
              <ZoomButton label="+" title="Zoom in (⌘+)" onClick={zoomIn} />
              <DocWidthToggle
                wide={docWide}
                measure={docMeasure}
                articleRef={documentRef}
                onToggle={() => setDocWide((w) => !w)}
                onCommit={({ wide, measure }) => { setDocWide(wide); setDocMeasure(measure); }}
              />
            </div>
          )}
          </div>
          {/* The conversation dock — the app's one AI column, opened by the
              Discuss pill or ⌘J. A sibling of the whole surface pane rather
              than a drawer painted over the document, so it SHRINKS whatever
              is selected instead of covering it — which is also what keeps it
              honest over the browser, whose native webview would ignore an
              overlay and paint straight through it.

              `dockContext.key` is the identity: switching conversations
              remounts the body rather than mutating a warm session under it,
              and for the voice-capable kinds that same key is what `voice.rs`
              dispatches on. */}
          {voiceDocked && dockContext && (
            <>
              <PaneDivider
                label="voice"
                collapsed={false}
                dragging={voiceDragging}
                // The chevron closes the panel; the pill and ⌘J reopen it (a
                // collapsed voice column has no divider left to drag from).
                onToggle={closeDock}
                onPointerDown={startVoiceDrag}
                hideChevron={latchActive}
                // Runs inside the document plate — no hull to show through.
                hairline
              />
              {/* Width is owned by the resize hook + the adopt effect, never
                  rendered from here. `data-rl-pane` lets the app-wide resizing
                  flag kill its transition mid-drag. */}
              <div
                ref={voiceDockRef}
                data-rl-pane
                className="min-h-0 min-w-0 shrink-0 flex flex-col overflow-hidden"
              >
                {/* Only when the surface offers a genuine choice — see the
                    strip. Selecting sets the PIN, which is a tie-break: it
                    follows you to the next surface that has the same kind and
                    is ignored by every surface that hasn't. */}
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
            </>
          )}
        </div>

        {/* Flow has no classic margin; Code review keeps it for its diff's
            threads, which have no flow home yet. */}
        {!paneFullscreen && !(flowShell && mainSurface !== "review") && (
          // Always in flow (its 6px is part of the space model); when the
          // discussion pane curtains it is painted over, and the absolute
          // copy inside the pane wrapper carries the affordance at the
          // curtain's visible edge. Not beside the flow stage, whose plan
          // panel is the plan's margin (`platePaneMask`).
          <PaneDivider
            collapsed={paneCollapsed}
            dragging={isDragging}
            onToggle={togglePane}
            onPointerDown={startDrag}
            hideChevron={latchActive || liveFlags.curtainR}
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
              onToggle={togglePane}
              onPointerDown={startDrag}
              hideChevron={latchActive}
            />
          </div>
        )}
        <aside
          ref={(el) => {
            (sidebarRef as React.MutableRefObject<HTMLElement | null>).current =
              el;
            paneAsideRef.current = el;
          }}
          data-tour="discussion"
          data-context={discussionContext}
          className={
            paneFullscreen
              ? "absolute inset-0 z-30 overflow-y-auto rl-discussion"
              : "overflow-y-auto shrink-0 rl-discussion rl-pane-aside"
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
                onClick={() => {
                  // Effective-value toggle, same rule as the pane's collapse:
                  // immersive masks fullscreen off, so ⤢ means "go fullscreen".
                  setImmersiveBroken(true);
                  setPanelBreaks(state => ({ ...state, pane: true }));
                  setPaneFullscreen(!paneFullscreen);
                }}
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
              <Suspense fallback={null}>
                <ReviewDiscussionPane review={codeReview} />
              </Suspense>
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
                  {restoring ? (
                    /* The restore's own status, app-native. The terminal
                       running it is deliberately off-screen: a resumed session
                       replays its earlier user turns, so what is on that screen
                       is Redline's own control traffic quoted back — valid
                       history that reads as an accidental double-send. This
                       banner is where the reviewer learns what is happening,
                       and the button below is the way to the machinery. */
                    <>
                      <strong>Reopening this plan…</strong> {restoreStatus}
                      <span
                        className="block"
                        style={{
                          marginTop: "4px",
                          color: "var(--color-ink-muted)",
                          fontSize: "12px",
                        }}
                      >
                        The original {restoreDecision.label} conversation and
                        your Redline comments are kept — this re-presents the
                        plan it was holding, it doesn&rsquo;t revise it.
                      </span>
                      <span
                        className="flex flex-wrap gap-2"
                        style={{ marginTop: "8px" }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            void showRawTerminal(attemptHere?.terminalId ?? null)
                          }
                          disabled={!attemptHere?.terminalId}
                          title="Open the terminal this restore is running in."
                          className="rounded px-2 py-1"
                          style={{
                            background: "transparent",
                            color: "var(--color-ink-muted)",
                            border: "1px solid var(--color-rule)",
                            cursor: attemptHere?.terminalId
                              ? "pointer"
                              : "default",
                            fontSize: "12px",
                            opacity: attemptHere?.terminalId ? 1 : 0.6,
                          }}
                        >
                          Show raw terminal
                        </button>
                      </span>
                    </>
                  ) : restoreFailure ? (
                    /* A restore that died stays on screen and stays
                       actionable. Reverting to the plain detached banner is
                       indistinguishable from never having clicked, which is how
                       one silently-dead restore became three live claudes. */
                    <>
                      <strong>Couldn&rsquo;t reopen this plan.</strong>{" "}
                      {restoreFailure.error}
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
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void showRawTerminal(restoreFailure.terminalId)
                          }
                          disabled={!restoreFailure.terminalId}
                          title="Open the terminal this restore was running in."
                          className="rounded px-2 py-1"
                          style={{
                            background: "transparent",
                            color: "var(--color-ink-muted)",
                            border: "1px solid var(--color-rule)",
                            cursor: restoreFailure.terminalId
                              ? "pointer"
                              : "default",
                            fontSize: "12px",
                            opacity: restoreFailure.terminalId ? 1 : 0.6,
                          }}
                        >
                          Show raw terminal
                        </button>
                        <button
                          type="button"
                          onClick={copyRestoreCommand}
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
                    </>
                  ) : (
                  <>
                  {/* Named for the harness that actually left. A Codex reviewer
                      told "the Claude Code session ended" is being pointed at a
                      process they never started — the sentence stops describing
                      a recoverable state and starts reading as a bug. A legacy
                      row claims neither name; see `detachedBannerCopy`. */}
                  <strong>{detachedCopy.lede}</strong> {detachedCopy.body}
                  <strong>Restore plan session</strong> reopens the same
                  conversation and re-presents the plan for review. It runs in
                  the background — nothing is retyped and nothing is lost.
                  {/* The harness choice, for a row with no stored provenance.
                      Shown ONLY then: asking a known-Codex reviewer which
                      harness wrote their plan is asking them to confirm
                      something Redline already knows, and getting it wrong
                      sends `claude --resume` a thread id — which does not
                      error, it silently starts a FRESH session. */}
                  {restoreDecision.legacy && activeId && (
                    <span
                      className="flex items-center gap-2 flex-wrap"
                      style={{ marginTop: "8px", fontSize: "12px" }}
                    >
                      <span style={{ color: "var(--color-ink-muted)" }}>
                        Written in:
                      </span>
                      {(
                        [
                          ["claude-code", "Claude Code"],
                          ["codex", "Codex"],
                          ["cursor", "Cursor"],
                          ["antigravity", "Antigravity"],
                        ] as [RestoreHarness, string][]
                      ).map(([value, label]) => {
                        const on = restoreDecision.harness === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={on && restoreDecision.chosen}
                            onClick={() =>
                              setHarnessChoices((prev) => ({
                                ...prev,
                                [activeId]: value,
                              }))
                            }
                            className="rounded px-2 py-0.5"
                            style={{
                              background: on
                                ? "var(--color-anchor-bg)"
                                : "transparent",
                              color: on
                                ? "var(--color-anchor-text)"
                                : "var(--color-ink-muted)",
                              border: "1px solid var(--color-rule)",
                              cursor: "pointer",
                              fontSize: "11px",
                              fontWeight: on ? 600 : 400,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </span>
                  )}
                  {/* What would stop the plan coming back, with the same fix
                      the front door offers. Rendered before the click, not
                      after: a restore that cannot complete spends a terminal,
                      dismisses this banner, and leaves nothing to show for it. */}
                  {restoreBlockers.length > 0 && (
                    <span className="block">
                      <ReadinessStrip
                        items={restoreBlockers}
                        onFix={applyReadinessFix}
                      />
                    </span>
                  )}
                  <span
                    className="flex flex-wrap gap-2"
                    style={{ marginTop: "8px" }}
                  >
                    {/* No "Restoring…" state here any more: an in-flight
                        restore replaces this whole branch with its own status,
                        so this button only ever renders when there is nothing
                        running to double-click. */}
                    <button
                      type="button"
                      onClick={restorePlanSession}
                      disabled={restoreBlockers.length > 0}
                      title={
                        restoreBlockers.length > 0
                          ? `${restoreBlockers[0].label} — restore can't bring the plan back until that's fixed.`
                          : undefined
                      }
                      className="rounded px-2 py-1"
                      style={{
                        background: "var(--color-anchor-bg)",
                        color: "var(--color-anchor-text)",
                        border: "1px solid var(--color-rule)",
                        cursor:
                          restoreBlockers.length > 0 ? "default" : "pointer",
                        fontSize: "12px",
                        fontWeight: 600,
                        opacity: restoreBlockers.length > 0 ? 0.6 : 1,
                      }}
                    >
                      Restore plan session
                    </button>
                    <button
                      type="button"
                      onClick={copyRestoreCommand}
                      disabled={restoreBlockers.length > 0}
                      title={`For a ${restoreDecision.label} running in a terminal Redline doesn't own — copy the resume command to paste yourself.`}
                      className="rounded px-2 py-1"
                      style={{
                        background: "transparent",
                        color: "var(--color-ink-muted)",
                        border: "1px solid var(--color-rule)",
                        cursor:
                          restoreBlockers.length > 0 ? "default" : "pointer",
                        fontSize: "12px",
                        opacity: restoreBlockers.length > 0 ? 0.6 : 1,
                      }}
                    >
                      Copy resume command
                    </button>
                  </span>
                  </>
                  )}
                </span>
                {/* No dismiss while a restore is running: the banner IS the
                    progress, and hiding it leaves the reviewer with a
                    background terminal and no narrator. */}
                {!restoring && (
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
                )}
              </div>
            )}
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
                          focusComment(c.id);
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
            {/* One boundary around the LIST, not one per card: a per-card
                Suspense would let the pane pop in a card at a time. Quiet
                fallback — a spinner where comments are about to appear reads
                as a glitch, and the chunk is local. */}
            <Suspense fallback={null}>
            {paneComments.map((c) => (
              <CommentCard
                key={`${session?.sessionId ?? ""}-${c.id}`}
                sessionId={session?.sessionId ?? ""}
                backend={session?.backend ?? null}
                comment={c}
                focused={focusedCommentId === c.id}
                autoOpen={autoOpenCommentId === c.id}
                onAutoOpenConsumed={clearAutoOpen}
                autoDiscuss={autoDiscussCommentId === c.id}
                onAutoDiscussConsumed={clearAutoDiscuss}
                onViewResearch={viewResearch}
                onSelect={commentCallbacks.onSelect}
                onDelete={commentCallbacks.onDelete}
                onUpdate={commentCallbacks.onUpdate}
                onAccept={commentCallbacks.onAccept}
                onAcceptSuggestion={commentCallbacks.onAcceptSuggestion}
                onReopen={commentCallbacks.onReopen}
                onPromote={commentCallbacks.onPromote}
                submitInFlight={busy}
              />
            ))}
            </Suspense>
            </DiscussionZoomContext.Provider>
              </>
            )}
          </div>
        </aside>
        </div>
        )}
        </div>
        </ErrorBoundary>

        {!termFullscreen && !flowDockHidden && !flowTermStage && !paneCli && (
          <PaneDivider
            orientation="horizontal"
            label="terminal"
            collapsed={termCollapsed}
            dragging={termDragging}
            // The top-edge caret IS the dock's fullscreen control now: centre
            // pill ⤢ to fill the window, the same pill ⤡ to come back. A
            // collapsed dock keeps the plain re-open caret, so `onToggle`
            // still means "show me the terminal" in that state.
            toggleMode="fullscreen"
            onToggle={termCollapsed ? revealTerm : enterTermFullscreen}
            onPointerDown={startTermDrag}
            // Collapse loses the centre pill, so it gets its own — the drag
            // has a 120px floor and can never close the dock.
            action={{
              glyph: "⌄",
              label: "Collapse terminal",
              onClick: toggleTerm,
            }}
            actionVisible="expanded"
          />
        )}
        <div
          ref={termDockRef}
          className={
            // Flow's terminal view first: the dock over the stage, showing
            // the session's PTY alone (`solo` below).
            // Flow's wall too, over the plate beside the sidebar: the sidebar
            // and the top bar's crumb are its way back.
            flowTermStage || (flowShell && termFullscreen) || paneCli
              ? "rl-term-dock--stage"
              : termFullscreen
              ? "absolute inset-0 z-30"
              : // Collapsed, the dock folds to height 0 — the plate class must
                // go with it, or its top/bottom hairlines survive the fold as
                // a 2px rounded sliver across the hull.
                `relative shrink-0 overflow-hidden rl-term-dock${termCollapsed ? "" : " rl-plate"}`
          }
          data-rl-pane={termFullscreen || flowTermStage || paneCli ? undefined : ""}
          // Folded, the dock's terminals are not rendered at all (styles.css
          // `.rl-term-dock[data-collapsed]`): their layers and layout would
          // otherwise be kept warm behind a 0px fold.
          data-collapsed={!termFullscreen && !flowTermStage && !paneCli && termCollapsed ? "" : undefined}
          // Height is owned by `applyLiveLayout` (it folds in the collapsed
          // state), so the dock tracks the divider without a render — and
          // without touching style for anything else on the page.
          style={termFullscreen ? { background: "var(--color-paper)" } : undefined}
        >
          {/* In fullscreen, an overlay divider at the top of the terminal
              gives the user the same top-edge caret they use to collapse
              the docked terminal — except here it exits fullscreen. */}
          {termFullscreen && !flowShell && (
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
                // Same pill, mirrored glyph: ⤡ undoes the ⤢ that got here.
                toggleMode="fullscreen"
                onToggle={() => setTermFullscreen(false)}
                onPointerDown={() => {}}
                fullscreen
                onExitFullscreen={() => setTermFullscreen(false)}
              />
            </div>
          )}
          {/* Mounted once and never unmounted: the dock's PTYs and their
              scrollback die with it, so a surface change must never take it
              away. Until then the enclosing div IS the dock — same plate, same
              geometry, owned by `applyLiveLayout` — so nothing moves when the
              tabs arrive. */}
          {terminalMounted && (
          <Suspense fallback={null}>
          <TerminalTabs
            ref={attachTerminals}
            theme={theme}
            onTabsChange={setTermTabCount}
            onTabIdsChange={setLiveTermIds}
            onTileCountChange={handleTileCountChange}
            onNeedsYouChange={setTermNeedYou}
            onNeedsYouIdsChange={isFlowShell() ? setFlowNeedsYouTerms : undefined}
            collapsed={termFullscreen || flowTermStage || paneCli ? false : termCollapsed}
            solo={flowTermStage ? stageTerminalId : paneCli?.terminalId ?? null}
            onActiveTabChange={setActiveTermId}
            onFocusedCwd={handleFocusedCwd}
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
            <span>The footer hit a rendering error.</span>
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
      {/* Same swap at the bottom — no native constraint here, so the footer
          hides outright behind a SHELL_EDGE strip of hull. */}
      {/* Not in flow: build status moved to the plan panel's footer, and
          "needs you" to the top bar (PLAN, "Footer removed"). */}
      {!flowShell && <Suspense fallback={null}><ChromeSlot immersive={immersive} edge="bottom" reveal={chrome}>
      <Footer
        planState={session ? { status:session.status, runState:activeRunState, held:activeHeld } : undefined}
        onSetPlanState={session ? state => { void setPlanState(session.sessionId, state); } : undefined}
        onMoveProject={session ? () => { void openMovePlan(session.sessionId); } : undefined}
        comments={threadComments}
        sessionReady={sessionReady}
        canSubmit={canSubmit}
        canApprove={canApprove}
        waiting={waiting}
        waitingAsk={waitingAsk}
        onSubmit={submitReview}
        onApprove={approvePlan}
        onApproveLater={() => void approvePlanLater()}
        onBuildTeam={(scale) => void startTeamBuild(scale)}
        approval={
          session?.status === "approved"
            ? {
                version: session.revisions[session.revisions.length - 1]?.versionNumber ?? 1,
                runState: activeRunState,
                runLive: isLiveRunState(activeRunState),
              }
            : null
        }
        buildTargets={buildTargets}
        onBuild={(id) => void buildApproved(id)}
        onReopen={() => void reopenApproved()}
        termCollapsed={termCollapsed && !termFullscreen}
        termTabCount={termTabCount}
        termNeedYou={termNeedYou}
        onJumpToNeedsYou={jumpToNeedsYou}
        reviewNews={reviewNews === "report" ? "Run report ready" : reviewNews === "review" ? "Review ready" : null}
        onOpenReviewNews={() => selectSurface("review")}
        onExpandTerminal={revealTerm}
        backend={session?.backend ?? null}
      />
      </ChromeSlot></Suspense>}
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
      {/* Persistent and unobtrusive: it announces a ready release once per
          candidate, and "Later" means indefinitely. It also owns the two short
          windows where the backend is refusing writes, because an editor that
          silently drops what you type is worse than one that says why. */}
      <Suspense fallback={null}>
        <ActivationBar
          onOpenBuildRedline={() => {
            setTabRequest({ tab: "build", nonce: Date.now() });
            selectSurface("runs");
          }}
          onToast={setToast}
        />
      </Suspense>
      {toast && <RedlineToast key={toast.id} toast={toast} onDismiss={dismissToast} />}
      {scaleDialogFor && (
        <Suspense fallback={null}>
          <ScaledBuildDialog
            defaults={scaleDialogFor.defaults}
            onClose={() => setScaleDialogFor(null)}
            onLaunch={(config) => {
              const sid = scaleDialogFor.sessionId;
              setScaleDialogFor(null);
              void launchScaledBuild(sid, config);
            }}
          />
        </Suspense>
      )}
      {scaledAttention > 0 && (
        <Suspense fallback={null}>
          <ScaledBuildCards nonce={scaledAttention} onIdle={() => setScaledAttention(0)} onToast={setToast} />
        </Suspense>
      )}
      {/* A5: a failed Orchestrate handoff is persistent and actionable —
          never a 10-second toast. The run state was already rolled back to
          NULL when this appears; the plan stays approved. */}
      {handoffFailure && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded shadow-lg px-4 py-3"
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-danger, #d33)",
            color: "var(--color-ink)",
            fontSize: "12px",
            maxWidth: "560px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {handoffFailure.retryScaled ? "Team build" : "Orchestrate"} handoff failed at {handoffFailure.stage}
          </div>
          <div
            style={{ color: "var(--color-ink-muted)", marginBottom: 8 }}
          >
            {handoffFailure.reason} — the plan is still approved; the run was
            rolled back.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() =>
                void (handoffFailure.retryScaled
                  ? launchScaledBuild(handoffFailure.sessionId, handoffFailure.retryScaled)
                  : relaunchOrchestrator(handoffFailure.sessionId))
              }
              className="rounded px-2 py-1"
              style={{
                border: "1px solid var(--color-info)",
                color: "var(--color-info)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  `${handoffFailure.launchCmd}\n${handoffFailure.prompt}`,
                );
                setToast("Launch command + prompt copied");
              }}
              className="rounded px-2 py-1"
              style={{
                border: "1px solid var(--color-rule)",
                cursor: "pointer",
              }}
            >
              Copy launch command
            </button>
            <button
              type="button"
              onClick={() => {
                revealTerm();
                void ensureTerminalReady().then((dock) =>
                  dock?.openSessionTerminal(handoffFailure.projectPath),
                );
              }}
              className="rounded px-2 py-1"
              style={{
                border: "1px solid var(--color-rule)",
                cursor: "pointer",
              }}
            >
              Open terminal manually
            </button>
            <button
              type="button"
              onClick={() => setHandoffFailure(null)}
              className="rounded px-2 py-1"
              style={{
                color: "var(--color-ink-muted)",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
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
        clearanceKey={`${immersive}:${chromeRevealed}:${termCollapsed}:${termFullscreen}:${flowStartOnStage}:${bootAnimating}`}
        // In the flow shell the door rests exactly where the start screen is
        // the stage — whatever the sidebar holds: a folder there is where it
        // would launch (A5), not a file viewer covering the plate. Flow has
        // no floating pill: its sidebar, and New session at its head, stay on
        // every surface.
        landing={plateAtRest && shellReady && !joinedActive && (isFlowShell() ? flowStartOnStage : classicWb ? wbView.focusedKind === "door" : sidebarTab.kind !== "folder")}
        onPillClick={classicWb ? openDoorTab : undefined}
        pill={!isFlowShell()}
        surfaceKey={doorNavKey}
        onVisibilityChange={setDoorVisible}
        open={frontDoorOpen}
        onOpenChange={setFrontDoorOpen}
        handoff={doorHandoff}
        compactOpen={doorCompact}
        onCompactChange={setDoorCompact}
        compact={doorCompact && renderMonochatComposer("card")}
        context={roomChat ? chatTitle ?? "Chat" : surfaceContextLabel(activeSurface, browserIslandPage?.title) ?? "Front door"}
        busy={frontDoorLaunching || !!frontDoorFlight || monochatBusy || monochatForks.size > 0}
        announce={doorNews}
        // A chat in the room: its heading's New goes back to a blank
        // composer, the conversation kept in History.
        onNewChat={roomChat ? () => { setChatId(null); setChatSeed(null); setChatInRoom(false); refreshChats(); } : undefined}
      >
        <div ref={setChatRegularSlot} hidden={!roomChat} className="rl-frontdoor-chat-slot relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/>
        {!roomChat && renderMonochatComposer("door")}
      </MonochatIsland>
      {chatId && createPortal(<Suspense fallback={null}><ErrorBoundary region="chat" fallback={surfaceFallback("chat")}>
            <ChatRoom
              composer={{ draftKey: FRONT_DOOR_TEXT_KEY, attachments: frontDoorAttachments, onAttachmentsConsumed: () => setFrontDoorAttachments([]), project: frontDoorProject, render: (actions, workbench) => renderMonochatComposer("chat", actions, workbench) }}
              harness={frontDoorBackend}
              modelCatalogs={modelCatalogs}
              onHarnessChange={setFrontDoorBackend}
              onNeedModels={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)}
              onRun={request => { void continueChatAsRun(request); }}
              onReviewChanges={projectPath => { setFrontDoorOpen(false); codeReview.setSource("uncommitted"); void codeReview.openReview(projectPath, "uncommitted"); selectSurface("review"); }}
              target={activeSurface}
              modelControls={<PlanningModelMenu choice={frontDoorBackend} onChange={setFrontDoorBackend} modelCatalogs={modelCatalogs} modelError={modelErrors[frontDoorBackend.backend]} modelStatus={modelStatus[frontDoorBackend.backend]} onRefresh={() => requestModels(frontDoorBackend.backend, selectedModelIdentity, true)} onLocate={() => { void applyReadinessFix({ id: "provider-missing", state: "blocked", label: "Locate conversation harness", detail: "Choose the executable used for conversation.", fix: { label: "Change CLI…", kind: frontDoorBackend.backend === "codex" ? "locate-codex" : "locate-claude", backend: frontDoorBackend.backend } }); }} onOpen={() => requestModels(frontDoorBackend.backend, selectedModelIdentity)} compact={false} allowedBackends={["claude-code", "codex"]}/>}
              onActivityChange={setMonochatBusy}
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
              expanded={roomChat}
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
</ErrorBoundary></Suspense>, chatHost)}
      {/* The flow stage's conversation, rendered here — at one place in the
          tree for as long as the session is on the stage — and shown wherever
          the stage puts its host. Keyed by the terminal, so a launch becoming
          its plan keeps the conversation, and another session gets its own. */}
      {flowConvoHost && stageTarget.kind !== "start" && createPortal(
        <Suspense fallback={null}>
          <ErrorBoundary region="session conversation" fallback={surfaceFallback("session conversation")}>
            <SessionConversation
              key={stageTerminalId ?? (stageTarget.kind === "plan" ? stageTarget.sessionId : "")}
              terminalId={stageTerminalId}
              sessionId={stageTarget.kind === "plan" ? stageTarget.sessionId : null}
              harness={stageHarness}
              layout={flowStageOwns ? flowPainted.layout : "stage"}
              planTitle={stagePlanTitle}
              planMarks={pendingComments.length}
              planOpen={flowStageOwns && flowPainted.pose !== "closed"}
              onOpenPlan={() => { if (stageTarget.kind === "plan") setPlanPose(stageTarget.sessionId, "split"); }}
              onShowTerminal={() => setStage("terminal")}
              projectPath={stageTarget.kind === "launch" ? stageTarget.projectPath : (session?.projectPath ?? null)}
              planMarkdown={stageHasPlan ? (latest?.rawPlanMarkdown ?? null) : null}
              // Talk is the voice panel, one click away (it IS the
              // discussion surface): open beside the stage, or closed again.
              talking={voiceDocked}
              onTalk={flowTalk}
              // Out of sight, its questions go to the terminal (components/agent/askRelease).
              hidden={!flowConvoOnScreen}
              // The plan card follows the session, not only the transcript.
              planState={stageTarget.kind === "plan" && flowSummary ? {
                label: flowMode?.label ?? "Plan",
                kind: flowMode?.kind ?? "plan",
                held: flowSummary.held,
                toReview: threadComments.filter((c) => c.status === "resolved").length,
              } : null}
              fallbackModel={stageTarget.kind === "plan" && session?.model ? { model: session.model, effort: session.effort ?? null } : null}
              fallbackMode={flowSummary?.status === "in_review" ? "plan" : null}
            />
          </ErrorBoundary>
        </Suspense>,
        flowConvoHost,
      )}
      {classicWb && activeId && createPortal(
        planSwap ? <SpringSwap key={planSwap.launchId} from={planSwap.from} onArrived={() => setPlanSwap(null)}>{planBodyNow}</SpringSwap> : planBodyNow,
        planHost,
      )}
      {browserMounted && createPortal(
<Suspense fallback={null}>
              <ErrorBoundary region="browser" fallback={surfaceFallback("browser")}>
                <BrowserPane
                  {...browserHandlers}
                  onPageContext={setBrowserIslandPage}
                  surfaceActive={browserOpen}
                  visible={browserVisible && !hookConflicts.dialogOpen}
                  projectDir={sidebarTab.kind === "folder" ? sidebarTab.id : null}
                  // "Open" on a Localhost card. A prop, not an event: this pane
                  // mounts only when the browser surface is selected, so an event
                  // emitted at selection time would beat its own listener.
                  openRequest={browserOpenRequest}
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
                  // Immersive entry and every chrome reveal move the slot as
                  // surely as a pane toggle does, and the native webview only
                  // re-reads its rect when this key changes.
                  layoutKey={`${wbLayoutKey}|${paneCollapsed}|${sidebarCollapsed}|${docVisible}|${splitVertical}|${liveFlags.curtain}|${voiceDocked}|${dockPill ?? ""}|${termCollapsed}|${termHeight}|${termFullscreen}|${termTiles.count}x${termTiles.rows}|${immersive}|${chromeRevealed}`}
                  // The pane's four panels render into the app's one
                  // conversation column, through a portal — everything they
                  // need (tabs, missions, the linked thread) is the pane's own
                  // state, so the column borrows the DOM node, not the state.
                  dockSlot={dockSlotEl}
                  dockPill={dockPill}
                  onOpenDockPill={openDockPill}
                  onDockState={setBrowserDock}
                />
              </ErrorBoundary>
              </Suspense>
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
            onInstall={() => { void installIntegration(true, selectedSetupBackend); }}
            onDismiss={dismissSetup}
            onLocate={() => { void applyReadinessFix({ id: "codex-missing", state: "blocked", label: "Locate Codex", detail: "Choose the Codex executable", fix: { label: "Locate CLI", kind: "locate-codex" } }); }}
            onReviewHooks={() => { void (async () => {
              const binary = preflight?.codex?.path;
              if (!binary) return;
              const dock = await ensureTerminalReady();
              const id = dock?.openSessionTerminal(setupProject);
              if (!id) { setInstallError("Could not open the setup terminal. Retry, or open /hooks in your Codex terminal."); return; }
              setSetupReviewInTerminal(true); setSetupBackend("codex"); setTermFullscreen(false); revealTerm();
              const quoted = "'" + binary.replace(/'/g, "'\\''") + "'";
              typeIntoTerminal(id, `${quoted}\r`, "Could not start Codex for hook review", null, true);
            })(); }}
            error={installError}
          />
          </Suspense>
        )}
      {setupReviewInTerminal && <div className="rl-setup-return" role="status"><span>Sign in if Codex asks, then open <code>/hooks</code> to review Redline’s hooks. Your work stays here.</span><button type="button" onClick={() => { setSetupReviewInTerminal(false); void installIntegration(true, "codex"); }}>Verify and continue</button><button type="button" onClick={() => { setSetupReviewInTerminal(false); dismissSetup(); }}>Later</button></div>}
      {/* ⌘K palette. Registers with the menu-overlay contract while open, so
          the native browser webview hides beneath it. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      {/* Onboarding tour: replay from the menu always, or auto-run once on first
          launch — but only after the hook/skill setup modal is out of the way,
          so the two never overlap. Never in the flow shell, whose start
          screen is the introduction (Getting Started opens it). */}
      {!isFlowShell() && (() => {
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
      {nudgeSuggestion && !loading && !activeHarness && !flowShell && (
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
  focusNonce,
  onHighlightClick,
  onBackToLatest,
  banner = true,
}: {
  sessionId: string;
  revision: Revision;
  diff?: ParagraphDiff;
  latestVersionNumber: number;
  focusedCommentId: string | null;
  focusNonce?: number;
  onHighlightClick: (commentId: string) => void;
  onBackToLatest: () => void;
  /** The "Viewing vN · read-only" bar above the text. The flow shell's
   *  plan header carries it as the version pill instead. */
  banner?: boolean;
}) {
  const when = new Date(revision.receivedAt).toLocaleString();
  return (
    <div>
      {banner && <div
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
      </div>}
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
          focusNonce={focusNonce}
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

export default App;
