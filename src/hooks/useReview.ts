// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePersistedState } from "../theme/usePersistedState";
import type {
  CodeReviewSession,
  DiffFile,
  DiffSource,
  ReviewAnnotation,
  ReviewCommit,
  ReviewQuestion,
} from "../types";

/** Owns the Code Review surface: which repo/source is being reviewed, the
 *  parsed diff, the line-anchored annotations, and per-file viewed state.
 *  The active review id is persisted
 *  so the pane restores on reload; the diff itself is always re-resolved live
 *  (it's the working tree — never cache it). */
export function useReview() {
  const [activeReviewId, setActiveReviewId] = usePersistedState<string | null>(
    "redline.review.activeReviewId",
    null,
  );
  const [repo, setRepo] = usePersistedState<string | null>(
    "redline.review.repo",
    null,
  );
  const [source, setSource] = usePersistedState<DiffSource>(
    "redline.review.source",
    "uncommitted",
  );
  // vsBase / commitSha params (not persisted — they're per-look choices).
  const [base, setBase] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);

  const [review, setReview] = useState<CodeReviewSession | null>(null);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [commits, setCommits] = useState<ReviewCommit[]>([]);
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A `/redline-code-review` curl is held open on this review — Submit/Approve/
  // Dismiss will answer the agent directly.
  const [holdActive, setHoldActive] = useState(false);
  // Bumped by review-requested so the diff re-resolves even when repo+source
  // are unchanged (a re-run is a new round of the same diff coordinates).
  const [refreshNonce, setRefreshNonce] = useState(0);

  const activeReviewIdRef = useRef(activeReviewId);
  activeReviewIdRef.current = activeReviewId;

  // --- diff ------------------------------------------------------------------

  // Staleness: the fingerprint of the diff we're SHOWING vs. the live one.
  // Poll-based (a cheap `--no-optional-locks` fingerprint compare)
  // rather than auto-refreshing — yanking the rows out from under an
  // in-progress annotation would be worse than a banner.
  const [stale, setStale] = useState(false);
  const fingerprintRef = useRef<string | null>(null);
  /** The fingerprint of the diff the pane is SHOWING — revert passes it so
   *  the backend can refuse to apply against a drifted diff. */
  const getFingerprint = useCallback(() => fingerprintRef.current, []);

  /** Re-resolve the diff for the current repo/source. vsBase needs `base`;
   *  commitSha needs `sha` — with the param missing we show nothing rather
   *  than erroring mid-typing. */
  const refreshDiff = useCallback(async () => {
    if (!repo || (source === "vsBase" && !base) || (source === "commitSha" && !sha)) {
      setDiff(null);
      return;
    }
    setLoading(true);
    try {
      const files = await invoke<DiffFile[]>("review_diff", {
        repo,
        source,
        base,
        sha,
      });
      setDiff(files);
      setError(null);
      setStale(false);
      fingerprintRef.current = await invoke<string>("review_fingerprint", {
        repo,
        source,
        base,
        sha,
      }).catch(() => null);
    } catch (err) {
      setDiff(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repo, source, base, sha]);

  // The staleness poll runs only while a diff is showing and not yet stale.
  useEffect(() => {
    if (!repo || !diff || stale) return;
    const id = window.setInterval(() => {
      void invoke<string>("review_fingerprint", { repo, source, base, sha })
        .then((fp) => {
          if (fingerprintRef.current && fp !== fingerprintRef.current) {
            setStale(true);
          }
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [repo, source, base, sha, diff, stale]);

  useEffect(() => {
    void refreshDiff();
  }, [refreshDiff, refreshNonce]);

  // Commit picker rows — refreshed with the repo (cheap, bounded at 20).
  useEffect(() => {
    if (!repo) {
      setCommits([]);
      return;
    }
    let alive = true;
    void invoke<ReviewCommit[]>("review_commits", { repo, n: 20 })
      .then((rows) => {
        if (alive) setCommits(rows);
      })
      .catch(() => {
        if (alive) setCommits([]);
      });
    return () => {
      alive = false;
    };
  }, [repo]);

  // --- review session --------------------------------------------------------

  /** Open (or continue) the repo's review session — annotations and viewed
   *  state key on its id. Called when the user picks a repo in the pane. */
  const openReview = useCallback(
    async (repoPath: string, src?: DiffSource) => {
      const wanted = src ?? source;
      try {
        const session = await invoke<CodeReviewSession>("review_open", {
          repo: repoPath,
          source: wanted,
          base,
          sha,
        });
        setRepo(session.repoPath);
        setReview(session);
        setActiveReviewId(session.reviewId);
        setError(null);
        return session;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [source, base, sha, setRepo, setActiveReviewId],
  );

  // --- annotations + viewed --------------------------------------------------

  const refreshAnnotations = useCallback(async (reviewId: string | null) => {
    if (!reviewId) {
      setAnnotations([]);
      setViewed(new Set());
      return;
    }
    try {
      const [anns, seen] = await Promise.all([
        invoke<ReviewAnnotation[]>("review_annotation_list", { reviewId }),
        invoke<string[]>("review_list_viewed", { reviewId }),
      ]);
      setAnnotations(anns);
      setViewed(new Set(seen));
    } catch {
      /* ignore — empty sets are a fine fallback */
    }
  }, []);

  useEffect(() => {
    void refreshAnnotations(activeReviewId);
  }, [activeReviewId, refreshAnnotations]);

  // Any writer (this pane, the daemon's carry-forward pass) bumps the set.
  useEffect(() => {
    let alive = true;
    const p = listen<string>("review-annotations-changed", (e) => {
      if (!alive || e.payload !== activeReviewIdRef.current) return;
      void refreshAnnotations(e.payload);
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
  }, [refreshAnnotations]);

  // A held `/redline-code-review` curl requested this review: adopt its repo/
  // source/round and enter hold mode. `review-released` ends the hold
  // (answered, dismissed, capped, or the curl died).
  useEffect(() => {
    let alive = true;
    const reqP = listen<{
      reviewId: string;
      repoPath: string;
      source: DiffSource;
      round: number;
    }>("review-requested", (e) => {
      if (!alive) return;
      const { reviewId, repoPath, source: src, round } = e.payload;
      setRepo(repoPath);
      setSource(src);
      setActiveReviewId(reviewId);
      setReview({
        reviewId,
        repoPath,
        source: src,
        round,
        createdAt: Date.now(),
      });
      setHoldActive(true);
      setRefreshNonce((n) => n + 1);
    });
    const relP = listen<{ reviewId: string }>("review-released", (e) => {
      if (!alive || e.payload.reviewId !== activeReviewIdRef.current) return;
      setHoldActive(false);
    });
    return () => {
      alive = false;
      void reqP.then((un) => un());
      void relP.then((un) => un());
    };
  }, [setRepo, setSource, setActiveReviewId]);

  // Reload survival: if the pane restores while a curl is still held (the
  // hold lives in the daemon, not the webview), re-enter hold mode.
  useEffect(() => {
    if (!activeReviewId) return;
    let alive = true;
    void invoke<boolean>("review_hold_active", { reviewId: activeReviewId })
      .then((held) => {
        if (alive && held) setHoldActive(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeReviewId]);

  /** Answer the held curl with the current annotation set (or approval). */
  const submitReview = useCallback(
    async (approve: boolean, approveMessage?: string | null) => {
      const reviewId = activeReviewIdRef.current;
      if (!reviewId) return;
      try {
        await invoke("submit_review_feedback", {
          reviewId,
          approve,
          approveMessage: approveMessage ?? null,
        });
        setHoldActive(false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  /** Unblock a held review the reviewer is walking away from. */
  const dismissReview = useCallback(async () => {
    const reviewId = activeReviewIdRef.current;
    if (!reviewId) return;
    try {
      await invoke("dismiss_review", { reviewId });
      setHoldActive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Annotation writers. Optimistic list edit for instant UI; the backend's
  // `review-annotations-changed` event then re-syncs the authoritative rows
  // (and on failure the refetch restores truth).
  const addAnnotation = useCallback(
    async (annotation: ReviewAnnotation) => {
      setAnnotations((l) => [...l, annotation]);
      try {
        await invoke("review_annotation_add", { annotation });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refreshAnnotations(activeReviewIdRef.current);
      }
    },
    [refreshAnnotations],
  );

  const updateAnnotation = useCallback(
    async (annotation: ReviewAnnotation) => {
      setAnnotations((l) => l.map((a) => (a.id === annotation.id ? annotation : a)));
      try {
        await invoke("review_annotation_update", { annotation });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refreshAnnotations(activeReviewIdRef.current);
      }
    },
    [refreshAnnotations],
  );

  const deleteAnnotation = useCallback(
    async (id: string) => {
      const reviewId = activeReviewIdRef.current;
      if (!reviewId) return;
      setAnnotations((l) => l.filter((a) => a.id !== id));
      try {
        await invoke("review_annotation_delete", { reviewId, id });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refreshAnnotations(reviewId);
      }
    },
    [refreshAnnotations],
  );

  // --- Ask-AI questions -------------------------------------------------------
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const refreshQuestions = useCallback(async (reviewId: string | null) => {
    if (!reviewId) {
      setQuestions([]);
      return;
    }
    try {
      setQuestions(
        await invoke<ReviewQuestion[]>("review_question_list", { reviewId }),
      );
    } catch {
      /* empty list is a fine fallback */
    }
  }, []);
  useEffect(() => {
    void refreshQuestions(activeReviewId);
  }, [activeReviewId, refreshQuestions]);
  useEffect(() => {
    let alive = true;
    const p = listen<string>("review-questions-changed", (e) => {
      if (!alive || e.payload !== activeReviewIdRef.current) return;
      void refreshQuestions(e.payload);
    });
    return () => {
      alive = false;
      void p.then((un) => un());
    };
  }, [refreshQuestions]);

  const addQuestion = useCallback(
    async (question: ReviewQuestion) => {
      setQuestions((l) => [...l, question]);
      try {
        await invoke("review_question_add", { question });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refreshQuestions(activeReviewIdRef.current);
      }
    },
    [refreshQuestions],
  );

  const deleteQuestion = useCallback(
    async (id: string) => {
      const reviewId = activeReviewIdRef.current;
      if (!reviewId) return;
      setQuestions((l) => l.filter((q) => q.id !== id));
      try {
        await invoke("review_question_delete", { reviewId, id });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void refreshQuestions(reviewId);
      }
    },
    [refreshQuestions],
  );

  const toggleViewed = useCallback(
    async (filePath: string) => {
      const reviewId = activeReviewIdRef.current;
      if (!reviewId) return;
      const next = !viewed.has(filePath);
      // Optimistic — the row collapse should feel instant.
      setViewed((v) => {
        const out = new Set(v);
        if (next) out.add(filePath);
        else out.delete(filePath);
        return out;
      });
      try {
        await invoke("review_mark_viewed", { reviewId, filePath, viewed: next });
      } catch {
        setViewed((v) => {
          const out = new Set(v);
          if (next) out.delete(filePath);
          else out.add(filePath);
          return out;
        });
      }
    },
    [viewed],
  );

  return {
    activeReviewId,
    review,
    repo,
    source,
    base,
    sha,
    diff,
    commits,
    annotations,
    viewed,
    loading,
    error,
    stale,
    getFingerprint,
    holdActive,
    submitReview,
    dismissReview,
    setSource,
    setBase,
    setSha,
    openReview,
    refreshDiff,
    toggleViewed,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    questions,
    addQuestion,
    deleteQuestion,
  };
}

export type UseReview = ReturnType<typeof useReview>;
