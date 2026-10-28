// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The plan pane (W6): the plan's body, mounted once in the plan host and
// shown through a plan pane's slot (decision D3: the plan body is a
// per-session singleton), the pane itself under its chrome
// (`components/plan/PlanPane`: header, notices, footer verbs), the read-only
// view of an earlier revision, and the Contents rail that docks beside the
// plan. App keeps the session, its comments and every handler; this module
// is how they are drawn. The editor (Tiptap) and the chrome are lazy chunks,
// as they were in App.

import { lazy, Suspense, type MutableRefObject, type RefObject } from "react";

import { EmptyState } from "../../components/EmptyState";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import type { PlanEditorActions, PlanEditorCollab, PlanEditorProps } from "../../components/PlanEditor";
import type { PlanPaneProps } from "../../components/plan/PlanPane";
import { Button } from "../../components/ui/Button";
import { collabRevisionKey, type CollabConfig } from "../../collab/collabConfig";
import type { createYjsCommentBackend } from "../../collab/yjsCommentBackend";
import type { ParagraphDiff } from "../../diff";
import { docArticleWidth } from "../../lib/docControl";
import { rafCoalesce } from "../../lib/raf";
import { beginResizeSession, endResizeSession } from "../../lib/resizeSession";
import { TOC_RAIL_W, TOC_RAIL_W_WIDE, clampTocDrag, snapTocWide } from "../../lib/tocRail";
import type { Comment, Revision, Section } from "../../types";
import type { AnyPane } from "../model";
import { Singleton } from "../singleton";
import type { PaneContext } from "../WorkbenchStage";
import { surfaceFallback } from "./fallback";

/** Tiptap/ProseMirror is heavy: the editor is its own chunk, warmed by the
 *  boot prefetch when a held plan is what boot lands on. */
export const loadPlanEditor = () => import("../../components/PlanEditor");
const PlanEditor = lazy(() => loadPlanEditor().then((m) => ({ default: m.PlanEditor })));
/** The Plan tab's chrome (header, notices, footer) around the one plan body,
 *  warmed as the app boots. */
export const loadPlanPane = () => import("../../components/plan/PlanPane");
const PlanPaneChrome = lazy(loadPlanPane);
// The table-of-contents rail renders only once opened (about 6 kB, W1).
const PlanToc = lazy(() => import("../../components/PlanToc").then((m) => ({ default: m.PlanToc })));

type CommentBackend = ReturnType<typeof createYjsCommentBackend>;

export interface PlanBodyProps {
  docScrollerRef: RefObject<HTMLDivElement | null>;
  documentRef: RefObject<HTMLElement | null>;
  tocDocked: boolean;
  tocRailW: number;
  tocDragging: boolean;
  /** A document is on the plate (a ready session, or a joined room). */
  docSurfaceActive: boolean;
  docWide: boolean;
  docMeasure: number;
  /** The collab room joined as a collaborator: its editor stays MOUNTED
   *  (hidden) while another session is selected. */
  joinedRoom: { config: CollabConfig; revoked?: boolean } | null;
  collaboratorCollab: PlanEditorCollab | undefined;
  collabComments: Comment[];
  yjsBackend: CommentBackend | null;
  joinedActive: boolean;
  leaveJoined: () => void;
  shellReady: boolean;
  /** The boot doors are still parting: a "Loading…" flash would read as a
   *  glitch inside them. */
  plateMoving: boolean;
  activeId: string | null;
  sessionReady: boolean;
  isViewingHistorical: boolean;
  viewedRevision: Revision | null | undefined;
  historicalDiff: ParagraphDiff | undefined;
  latest: Revision | undefined;
  focusedCommentId: string | null;
  focusNonce: number;
  handleHighlightClick: (commentId: string) => void;
  setViewedVersionNumber: (version: number | null) => void;
  sections: Section[];
  latestComments: Comment[];
  threadRevisions: ReadonlyArray<{ versionNumber: number }>;
  addEditorComment: NonNullable<PlanEditorProps["onAddComment"]>;
  updateComment: NonNullable<PlanEditorProps["onUpdateComment"]>;
  deleteComment: NonNullable<PlanEditorProps["onDeleteComment"]>;
  planActionsRef: MutableRefObject<PlanEditorActions | null>;
  lockedEditToast: (blockId: string) => void;
  ownerCollab: PlanEditorCollab | undefined;
}

/** The plan's scroller and article: the joined room's editor, the revoked
 *  notice, the loading beat, an earlier revision read-only, or the latest
 *  revision live. Mounted once, in the plan host. */
export function PlanBody(props: PlanBodyProps) {
  const {
    docScrollerRef,
    documentRef,
    tocDocked,
    tocRailW,
    tocDragging,
    docSurfaceActive,
    docWide,
    docMeasure,
    joinedRoom,
    collaboratorCollab,
    collabComments,
    yjsBackend,
    joinedActive,
    leaveJoined,
    shellReady,
    plateMoving: bootAnimating,
    activeId,
    sessionReady,
    isViewingHistorical,
    viewedRevision,
    historicalDiff,
    latest,
    focusedCommentId,
    focusNonce,
    handleHighlightClick,
    setViewedVersionNumber,
    sections,
    latestComments,
    threadRevisions,
    addEditorComment,
    updateComment,
    deleteComment,
    planActionsRef,
    lockedEditToast,
    ownerCollab,
  } = props;
  return (
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
          ...(docSurfaceActive ? docArticleWidth(docWide, docMeasure) : { maxWidth: "none", paddingRight: "24px" }),
          paddingLeft: docSurfaceActive ? undefined : "24px",
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
      ) : joinedActive ? null : !shellReady || (activeId && !sessionReady) ? (
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
            // The Plan pane's header says it once, as the version pill.
            banner={false}
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
}

/** A plan pane: the holder (`singletonHolder`) shows the plan body under
 *  its chrome — the header (Contents, version, marks, ⋯), the notices, the
 *  footer's verbs; another visible plan pane shows where the body went. The
 *  slot alone while the chrome's chunk arrives. */
export function PlanPaneView({ pane, ctx, host, holder, bring, chrome }: {
  pane: AnyPane;
  ctx: PaneContext;
  host: HTMLElement;
  holder: string | undefined;
  bring: (paneId: string) => void;
  /** Everything the chrome reads but the body it wraps. */
  chrome: Omit<PlanPaneProps, "children">;
}) {
  const body = <Singleton host={host} pane={pane} ctx={ctx} holder={holder} bring={bring} />;
  if (ctx.visible && holder !== pane.id) return body;
  return (
    <Suspense fallback={body}>
      <PlanPaneChrome {...chrome}>{body}</PlanPaneChrome>
    </Suspense>
  );
}

export interface PlanContentsRailProps {
  /** A plan with headings is on screen (`tocEligible` and a Plan pane in
   *  the active tab); else neither the rail nor its button exists. */
  shown: boolean;
  tocOpen: boolean;
  setTocOpen: (open: boolean) => void;
  tocWide: boolean;
  setTocWide: (wide: boolean) => void;
  tocRailW: number;
  tocDragging: boolean;
  setTocDragging: (dragging: boolean) => void;
  tocRailRef: RefObject<HTMLDivElement | null>;
  tocBtnRef: RefObject<HTMLButtonElement | null>;
  docScrollerRef: RefObject<HTMLDivElement | null>;
  displaySections: Section[];
}

/** Table-of-contents rail (Phase 2). Docked to the left of the document
 *  column: the scroller reserves `TOC_RAIL_W` of left padding while this is
 *  open (`tocDocked`), so the rail sits BESIDE the plan rather than floating
 *  over it — responsive when the sidebar narrows the column. Closed, it is
 *  the "☰ Contents" button. */
export function PlanContentsRail(props: PlanContentsRailProps) {
  const { shown, tocOpen, setTocOpen, tocWide, setTocWide, tocRailW, tocDragging, setTocDragging, tocRailRef, tocBtnRef, docScrollerRef, displaySections } = props;
  if (!shown) return null;
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
export function HistoricalRevisionView({
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
