// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The drafter pane (W6): the Prompt Drafter's body — the crash-recovery
// card, the quiet "Opening…" beat, the editor itself, and the two sheets
// over it (the Bookshelf and the agent shelf) — springing out of the door's
// island when a door tab converts into it. App owns the open document, its
// persistence and every handler; this is how they are drawn. The editor
// (Tiptap), the shelves and the documents menu are lazy chunks, as they were
// in App; `loadPromptDrafter` is warmed at idle so the first spring is the
// same as the tenth.

import { lazy, Suspense, type MutableRefObject, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/react";

import { EmptyState } from "../../components/EmptyState";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import type { PromptDrafterProps } from "../../components/PromptDrafter";
import { SpringSwap } from "../../components/SpringSwap";
import type { ToastSpec } from "../../components/RedlineToast";
import { persistDraftDoc } from "../../lib/bookshelf";
import { clearDrafterShadow, resolveDrafterMountDoc, type DrafterSessionEntry, type DrafterShadow } from "../../lib/drafterCache";
import type { DocProjectChoice, PendingLaunch } from "../../lib/launch";
import type { SwapRect } from "../../lib/springSwap";
import { surfaceFallback } from "./fallback";

/** The Drafter's chunk, as a promise App can also trigger early.
 *
 *  `lazy()` alone means the FIRST open pays for the fetch+parse while the
 *  spring is already running: the animation measures and flies a Suspense
 *  fallback, then the real editor swaps in mid-flight. That is exactly why the
 *  first trip from the Front Door was janky and every one after it was smooth.
 *  Warmed at idle once the shell has settled (App's `warmDrafterChunk`), so by
 *  the time anyone presses ⏎ the first open is the same as the tenth. */
export const loadPromptDrafter = () => import("../../components/PromptDrafter");
const PromptDrafter = lazy(() => loadPromptDrafter().then((m) => ({ default: m.PromptDrafter })));
// The shelf is a sheet over the drafter, opened on click.
const BookshelfView = lazy(() => import("../../components/BookshelfView").then((m) => ({ default: m.BookshelfView })));
// The agent shelf (harness A3) is the Bookshelf's sibling sheet.
const AgentShelf = lazy(() => import("../../components/AgentShelf").then((m) => ({ default: m.AgentShelf })));
// The drafter's documents menu: rendered only in the drafter's body, so it
// rides its own chunk (about 9 kB of boot JS, W1).
const DocumentsMenu = lazy(() => import("../../components/DocumentsMenu").then((m) => ({ default: m.DocumentsMenu })));

export interface DrafterRecovery {
  forId: string;
  shadow: DrafterShadow;
  /** What the database has. Chosen by "Discard". */
  stored: JSONContent | null;
  projectPath: string | null;
}

export interface DrafterPaneProps {
  drafterSessionCache: MutableRefObject<Map<string, DrafterSessionEntry>>;
  drafterLoaded: { forId: string; doc: JSONContent | null } | null;
  setDrafterLoaded: (loaded: { forId: string; doc: JSONContent | null }) => void;
  drafterDraftId: string | null;
  setDrafterDraftId: (id: string | null) => void;
  drafterOpenIds: string[];
  closeDrafterDoc: (id: string) => void;
  drafterShelfOpen: boolean;
  setDrafterShelfOpen: (open: boolean) => void;
  agentShelfOpen: boolean;
  setAgentShelfOpen: (open: boolean) => void;
  drafterProject: DocProjectChoice;
  drafterProjectPath: string | null;
  setDrafterProjectPath: (path: string | null) => void;
  getDrafterLiveMarkdown: () => string | undefined;
  /** The shelf-agent run in flight, by name (App claims its closing line). */
  shelfRunLive: MutableRefObject<string | null>;
  setToast: (toast: string | ToastSpec | null, durationMs?: number | null) => void;
  drafterRecovery: DrafterRecovery | null;
  setDrafterRecovery: (recovery: DrafterRecovery | null) => void;
  drafterOpening: boolean;
  /** The island's box the surface springs out of; null once it has landed. */
  swapFrom: SwapRect | null;
  setSwapFrom: (rect: SwapRect | null) => void;
  /** Arriving from the Front Door: quiet until the editor is up. */
  quietOpen: boolean;
  /** What fades where the door was while the drafter springs. */
  leaving: ReactNode;
  drafterDiscussionSlot: HTMLElement | null;
  /** The rail shows this draft's Discussion. */
  discussionShown: boolean;
  showDrafterDiscussion: () => void;
  drafterPersist: PromptDrafterProps["onPersist"];
  projectOptions: PromptDrafterProps["projectOptions"];
  launchFromDrafter: PromptDrafterProps["onLaunch"];
  readiness: NonNullable<PromptDrafterProps["readiness"]>;
  applyReadinessFix: NonNullable<PromptDrafterProps["onFix"]>;
  pendingLaunch: PendingLaunch | null;
  setPendingLaunch: (launch: PendingLaunch | null) => void;
  drafterSources: NonNullable<PromptDrafterProps["sources"]>;
  attachDrafterFiles: (paths: string[]) => void;
  removeDrafterSource: (id: string) => void;
  drafterTemplates: NonNullable<PromptDrafterProps["templates"]>;
  useDrafterTemplate: (draftId: string) => void;
  /** The drafter's ✕: its pane closes. */
  onExit: () => void;
  drafterSaveState: PromptDrafterProps["saveState"];
  consumeLandingSeed: () => string;
  registerDrafterLiveMarkdown: (get: (() => string) | null) => void;
}

/** The drafter's body and its sheets, unsprung. */
function DrafterBody(props: DrafterPaneProps) {
  const {
    drafterSessionCache,
    drafterLoaded,
    setDrafterLoaded,
    drafterDraftId,
    setDrafterDraftId,
    drafterOpenIds,
    closeDrafterDoc,
    drafterShelfOpen,
    setDrafterShelfOpen,
    agentShelfOpen,
    setAgentShelfOpen,
    drafterProject,
    drafterProjectPath,
    setDrafterProjectPath,
    getDrafterLiveMarkdown,
    shelfRunLive,
    setToast,
    drafterRecovery,
    setDrafterRecovery,
    drafterOpening,
    swapFrom,
    quietOpen,
    drafterDiscussionSlot,
    discussionShown,
    showDrafterDiscussion,
    drafterPersist,
    projectOptions,
    launchFromDrafter,
    readiness,
    applyReadinessFix,
    pendingLaunch,
    setPendingLaunch,
    drafterSources,
    attachDrafterFiles,
    removeDrafterSource,
    drafterTemplates,
    useDrafterTemplate,
    onExit,
    drafterSaveState,
    consumeLandingSeed,
    registerDrafterLiveMarkdown,
  } = props;
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
          // Its comment threads live in the rail's Discussion (W4).
          discussionSlot={drafterDiscussionSlot}
          discussionShown={discussionShown}
          onShowDiscussion={showDrafterDiscussion}
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
          onOpenShelf={() => setDrafterShelfOpen(true)}
          onOpenAgents={() => setAgentShelfOpen(true)}
          // Only when the drafter is living inside the Front Door's
          // island; reached by its own route there is nothing to go
          // back to.
          // Back to the Front Door, which is the Document surface's
          // resting state and always has been.
          onExit={onExit}
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
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {drafterBody}
      {drafterShelf}
      {agentShelf}
    </div>
  );
}

/** The drafter pane. Arriving from the Front Door, it springs out of the
 *  box the island occupied, with the door still mounted behind it and fading
 *  — one spring, two separate surfaces, App owning the transition. `from` is
 *  null for the palette and programmatic routes: nothing to spring from, so
 *  SpringSwap renders the body untouched. */
export function DrafterPane(props: DrafterPaneProps) {
  const { swapFrom, setSwapFrom, leaving } = props;
  return (
    <SpringSwap
      from={swapFrom}
      onArrived={() => setSwapFrom(null)}
      leaving={swapFrom ? leaving : null}
    >
      <DrafterBody {...props} />
    </SpringSwap>
  );
}
