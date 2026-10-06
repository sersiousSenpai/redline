// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseReview } from "../../hooks/useReview";
import type { UsePush } from "../../hooks/usePush";
import type { UseAiReview } from "../../hooks/useAiReview";
import { useNarration } from "../../hooks/useNarration";
import { useSync } from "../../hooks/useSync";
import { useWorkspaces } from "../../hooks/useWorkspaces";
import { gitStory } from "../../lib/gitStory";
import { changeRisks } from "../../lib/changeRisks";
import type { GitAction } from "../../lib/gitWords";
import { nextAnnotationId, nextQuestionId } from "../../lib/reviewSelection";
import { setGuidedContext, getGuidedContext } from "../../lib/guidedContext";
import { OnboardingTour, type TourStep } from "../OnboardingTour";
import { ReviewThread } from "../ReviewThread";
import { useMenuOverlay } from "../menuOverlay";
import { WhereYouAre } from "./WhereYouAre";
import { GuidedChangeCard } from "./GuidedChangeCard";
import { SaveSheet } from "./SaveSheet";
import { ShareSheet } from "./ShareSheet";
import { UpdatesCard } from "./UpdatesCard";
import { ConflictCard } from "./ConflictCard";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { Timeline } from "./Timeline";
import { WhatRedlineDid } from "./WhatRedlineDid";
import { Term } from "./Term";
import type { ActionResult } from "./types";
import "./guided.css";
const actionCache = new Map<string, ActionResult>();
const TOUR: TourStep[] = [
  {
    id: "guided-where",
    anchor: "guided-where",
    title: "Where you are",
    lead: "Your project tells a story.",
    body: "This card explains what's saved, what your team shared, and the next useful action.",
  },
  {
    id: "guided-changes",
    anchor: "guided-changes",
    title: "What changed",
    lead: "Read the changes in plain language.",
    body: "Mark a group as reviewed, ask a question, or open the code. Hover underlined words to learn their Git names.",
  },
  {
    id: "guided-save",
    anchor: "guided-save",
    title: "Save and share",
    lead: "Save versions on your computer, then share a workspace.",
    body: "Your team's main version stays protected. Every completed action explains the commands Redline ran.",
  },
];
interface Props {
  review: UseReview;
  push: UsePush;
  ai: UseAiReview;
  onCode: (file: string) => void;
  onUndo: (file: string) => Promise<ActionResult | void>;
  onOpenTerminal?: (cwd: string, command?: string) => void;
}
export default function GuidedReview({
  review,
  push,
  ai,
  onCode,
  onUndo,
  onOpenTerminal,
}: Props) {
  const {
    repo,
    activeReviewId,
    diff,
    source,
    holdActive,
    annotations,
    viewed,
  } = review;
  const narration = useNarration(activeReviewId, diff),
    sync = useSync(repo),
    workspaces = useWorkspaces(repo);
  const [sheet, setSheet] = useState<"save" | "share" | "workspace" | null>(
      null,
    ),
    [title, setTitle] = useState(""),
    [oldVersion, setOldVersion] = useState<string | undefined>(),
    [timeline, setTimeline] = useState(false),
    [action, setActionState] = useState<ActionResult | null>(
      () => actionCache.get(repo ?? "") ?? null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [askId, setAskId] = useState<string | null>(null);
  const [tour, setTour] = useState(() => {
    try {
      return localStorage.getItem("redline.guidedTourDone") !== "true";
    } catch {
      return false;
    }
  });
  useMenuOverlay(sheet === "workspace");
  const setAction = (result: ActionResult) => {
    actionCache.set(repo ?? "", result);
    if (actionCache.size > 30)
      actionCache.delete(actionCache.keys().next().value!);
    setActionState(result);
  };
  useEffect(() => {
    setActionState(actionCache.get(repo ?? "") ?? null);
    setAskId(null);
    setError(null);
  }, [repo]);
  const risks = useMemo(() => changeRisks(diff ?? []), [diff]);
  const story = gitStory(
    push.status,
    {
      files: source === "uncommitted" ? (diff?.length ?? 0) : 0,
      overlaps: sync.check?.overlaps.length,
    },
    holdActive,
  );
  const currentWorkspace = workspaces.items.find(
    (w) => w.workspace.path === repo,
  )?.workspace;
  useEffect(() => {
    if (activeReviewId)
      setGuidedContext(activeReviewId, push.status, narration.story, action);
  }, [activeReviewId, push.status, narration.story, action]);
  useEffect(() => {
    if (sync.check?.action && !actionCache.has(repo ?? ""))
      setAction(sync.check.action);
  }, [sync.check]);
  const openWorkspace = async (path: string) => {
    review.setSource("uncommitted");
    return review.openReview(path, "uncommitted");
  };
  const refresh = async () => {
    await Promise.all([
      review.refreshDiff(),
      push.refreshStatus(),
      workspaces.refresh(),
    ]);
  };
  const complete = (result: ActionResult) => {
    if (result.repo) actionCache.set(result.repo, result);
    setAction(result);
    setSheet(null);
    void refresh();
  };
  const perform = async (operation: () => Promise<ActionResult>) => {
    setBusy(true);
    setError(null);
    try {
      complete(await operation());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    if (!activeReviewId) return;
    const id = nextQuestionId(review.questions);
    await review.addQuestion({
      id,
      reviewId: activeReviewId,
      filePath: "",
      side: "new",
      startLine: 0,
      endLine: 0,
      quotedText: getGuidedContext(activeReviewId),
      createdAt: Date.now(),
    });
    setAskId(id);
  };
  const checkUpdates = async () => {
    const result = await sync.refresh();
    if (result) setAction(result.action);
    await push.refreshStatus();
  };
  const act = (name: GitAction) => {
    if (name === "save") {
      if (source !== "uncommitted") {
        review.setSource("uncommitted");
        return;
      }
      setSheet("save");
    }
    if (name === "share") setSheet("share");
    if (name === "timeline") setTimeline(true);
    if (name === "workspace") {
      setOldVersion(undefined);
      setTitle("");
      setSheet("workspace");
    }
    if (name === "check") void checkUpdates();
    if (name === "updates") void perform(sync.bringIn);
    if (
      name === "recover" &&
      window.confirm(
        "Cancel the unfinished combine and return to how the project was before it started?",
      )
    )
      void perform(() => invoke<ActionResult>("sync_cancel", { repo }));
    if (name === "connect")
      document
        .getElementById("guided-connect")
        ?.scrollIntoView({ behavior: "smooth" });
    if (name === "notes") void review.submitReview(false);
  };
  if (!repo || !activeReviewId)
    return (
      <div className="guided-review">
        <p>Choose a project to review its changes.</p>
      </div>
    );
  const selectedHistory = source === "commitSha" || source === "lastCommit";
  return (
    <div className="guided-review">
      <WhereYouAre
        story={story}
        name={repo.split("/").filter(Boolean).pop() ?? "project"}
        busy={busy || sync.busy}
        onAction={act}
      >
        <WorkspaceSwitcher
          repo={repo}
          items={workspaces.items}
          busy={busy}
          onOpen={(path) => {
            void openWorkspace(path);
          }}
          onLaunch={(path) => onOpenTerminal?.(path)}
          onBringIn={(id) => {
            if (
              window.confirm(
                "Bring this workspace's saved versions into the original project? The original project must have no unsaved changes.",
              )
            )
              void perform(() =>
                invoke<ActionResult>("workspace_bring_in", { id }),
              );
          }}
          onArchive={(id) => {
            if (
              window.confirm(
                "Archive this workspace folder? Saved versions are kept, and unsaved or unshared work will prevent archiving.",
              )
            )
              void perform(async () => {
                const result = await invoke<ActionResult>("workspace_archive", {
                  id,
                });
                if (currentWorkspace)
                  await openWorkspace(currentWorkspace.repo);
                return result;
              });
          }}
        />
      </WhereYouAre>
      {(error || sync.error || workspaces.error) && (
        <p className="guided-error" role="alert">
          {error ?? sync.error ?? workspaces.error}
        </p>
      )}
      {review.stale && (
        <p className="guided-error">
          The files changed since this review opened.{" "}
          <button
            className="rl-review-btn"
            onClick={() => void review.refreshDiff()}
          >
            Refresh changes
          </button>
        </p>
      )}
      <WhatRedlineDid action={action} />
      {action?.undoId && (
        <button
          type="button"
          className="rl-review-btn"
          disabled={busy}
          onClick={() =>
            void perform(() =>
              invoke<ActionResult>("review_restore_undo", {
                repo,
                id: action.undoId,
              }),
            )
          }
        >
          Restore the change I just undid
        </button>
      )}
      {action?.conflict && (
        <ConflictCard
          conflict={action.conflict}
          busy={busy}
          onHelp={(brief) => {
            void perform(async () => {
              const created = await workspaces.create("Combine team updates");
              await openWorkspace(created.workspace.path);
              onOpenTerminal?.(
                created.workspace.path,
                `claude ${"'" + brief.replace(/'/g, "'\\''") + "'"}`,
              );
              return created.action;
            });
          }}
        />
      )}
      <UpdatesCard
        repo={repo}
        check={sync.check}
        busy={busy || sync.busy}
        onBringIn={() => void perform(sync.bringIn)}
        onCheck={() => void checkUpdates()}
      />
      {push.status && (!push.status.ghAvailable || !push.status.ghAuthed) && (
        <section className="guided-card" id="guided-connect">
          <h3>Connect GitHub</h3>
          <p>
            {push.status.ghAvailable
              ? "Sign in to GitHub, then check again to request reviews from your team."
              : "Install GitHub's command line app, then sign in. You can keep reviewing and saving here."}
          </p>
          <ol>
            {!push.status.ghAvailable && (
              <li>
                Install GitHub CLI from{" "}
                <a
                  href="https://cli.github.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  cli.github.com
                </a>
                .
              </li>
            )}
            <li>Open a terminal, sign in, and follow the GitHub prompts.</li>
            <li>Return here and check your connection.</li>
          </ol>
          <div className="guided-actions">
            <button
              type="button"
              className="rl-review-btn"
              disabled={!onOpenTerminal}
              onClick={() => onOpenTerminal?.(repo, "gh auth login")}
            >
              Open sign-in terminal
            </button>
            <button
              type="button"
              className="rl-review-btn"
              onClick={() => void push.refreshStatus()}
            >
              Check again
            </button>
          </div>
        </section>
      )}
      <section data-tour="guided-changes">
        <div className="guided-section-head">
          <h2>
            <Term term="diff" />
          </h2>
          <button
            type="button"
            className="rl-review-btn"
            disabled={ai.running || !diff?.length}
            onClick={() => void ai.start()}
          >
            {ai.running
              ? "Claude is checking…"
              : "Have Claude double-check this"}
          </button>
          <button
            type="button"
            className="rl-review-btn"
            onClick={() => void ask()}
          >
            Ask about this
          </button>
          <button
            type="button"
            className="rl-review-btn"
            onClick={() => setTimeline(!timeline)}
          >
            Timeline
          </button>
        </div>
        {selectedHistory && (
          <p>
            You are reading a saved version.{" "}
            <button
              className="rl-review-btn"
              onClick={() => review.setSource("uncommitted")}
            >
              Back to current changes
            </button>
          </p>
        )}
        {ai.error && <p role="alert">{ai.error}</p>}
        {narration.loading && (
          <p className="guided-help">Preparing a plain-language summary…</p>
        )}
        {!!diff?.length && <p>{narration.story?.summary}</p>}
        {!diff?.length && <p>No changes to review in this view.</p>}
        {risks
          .filter((r) => !r.file)
          .map((r) => (
            <p key={r.kind} className="guided-risks">
              {r.message}
            </p>
          ))}
        {narration.story?.groups.map((group) => (
          <GuidedChangeCard
            key={group.files.join("|")}
            group={group}
            viewed={viewed}
            busy={busy}
            risks={risks.filter((r) => group.files.includes(r.file))}
            findings={annotations.filter(
              (a) =>
                a.source === "ai" &&
                a.status !== "orphaned" &&
                group.files.includes(a.filePath),
            )}
            canUndo={source === "uncommitted" && !review.stale}
            onGood={(files) => {
              files
                .filter((file) => !viewed.has(file))
                .forEach((file) => void review.toggleViewed(file));
            }}
            onNote={async (filePath, body, label) => {
              await review.addAnnotation({
                id: nextAnnotationId(annotations),
                reviewId: activeReviewId,
                round: review.review?.round ?? 1,
                filePath,
                side: "new",
                startLine: 0,
                endLine: 0,
                kind: "comment",
                body,
                quotedText: "",
                status: "draft",
                createdAt: Date.now(),
                scope: filePath ? "file" : "general",
                label,
                source: "user",
              });
            }}
            onUndo={(file) => {
              if (
                window.confirm(
                  `Undo the unsaved change to ${file}? Review the result before saving a new version.`,
                )
              )
                void perform(async () => {
                  const result = await onUndo(file);
                  return (
                    result ?? {
                      commands: [],
                      conflict: null,
                      message: `Undid the unsaved change to ${file}.`,
                    }
                  );
                });
            }}
            onCode={onCode}
          />
        ))}
      </section>
      {askId && (
        <section className="guided-card">
          <h3>Ask about this</h3>
          <ReviewThread
            reviewId={activeReviewId}
            annotationId={askId}
            kind="question"
          />
        </section>
      )}
      {timeline && (
        <Timeline
          repo={repo}
          busy={busy}
          onOpen={(sha) => {
            review.setSha(sha);
            review.setSource("commitSha");
          }}
          onRestore={(sha, mode, path) => {
            if (
              window.confirm(
                mode === "project"
                  ? "Restore this saved project's contents as unsaved changes? Your history will stay intact."
                  : "Prepare this undo or restore as unsaved changes? Your history will stay intact.",
              )
            )
              void perform(async () => {
                const result = await invoke<ActionResult>("history_restore", {
                  repo,
                  sha,
                  mode,
                  path: path ?? null,
                });
                review.setSource("uncommitted");
                return result;
              });
          }}
          onTry={(sha) => {
            setOldVersion(sha);
            setTitle("Explore an older version");
            setSheet("workspace");
          }}
        />
      )}
      {sheet === "save" && (
        <SaveSheet
          reviewId={activeReviewId}
          fingerprint={review.getFingerprint()}
          push={push}
          onDone={complete}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "share" && (
        <ShareSheet
          repo={repo}
          inWorkspace={!!currentWorkspace}
          story={narration.story}
          onDone={complete}
          onClose={() => setSheet(null)}
          onWorkspace={(path) => {
            void openWorkspace(path);
          }}
        />
      )}
      {sheet === "workspace" && (
        <div className="guided-backdrop">
          <form
            className="guided-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Create a workspace"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const created = await workspaces.create(title, oldVersion);
                await openWorkspace(created.workspace.path);
                return created.action;
              });
            }}
          >
            <h2>Create a workspace</h2>
            <p>
              Your original folder stays as it is. The workspace starts from{" "}
              {oldVersion
                ? "the selected saved version"
                : "your latest saved version"}
              ; unsaved changes stay in the original folder.
            </p>
            <label>
              Name this idea
              <input
                autoFocus
                className="rl-review-card-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="guided-actions">
              <button
                className="rl-review-btn rl-review-btn-primary"
                type="submit"
                disabled={busy || !title.trim()}
              >
                Create workspace
              </button>
              <button
                className="rl-review-btn"
                type="button"
                disabled={busy}
                onClick={() => setSheet(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {tour && (
        <OnboardingTour
          steps={TOUR}
          onClose={() => {
            setTour(false);
            try {
              localStorage.setItem("redline.guidedTourDone", "true");
            } catch {
              /* best effort */
            }
          }}
        />
      )}
    </div>
  );
}
