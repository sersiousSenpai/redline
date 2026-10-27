// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePoll } from "./usePoll";
import { useGitWatch } from "./useFsWatch";

import type {
  CommitDraft,
  GitStatus,
  PushLogEvent,
  PushOutcome,
  PushRecord,
  PushRequest,
} from "../types";

/** Owns the review pane's push surface: the git status behind the strip, the
 *  push call with its live log, the last-push memory, and the AI draft. */
export function usePush(repo: string | null, reviewId: string | null) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [lastPush, setLastPush] = useState<PushRecord | null>(null);
  const [pushing, setPushing] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<PushOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const repoRef = useRef(repo);
  repoRef.current = repo;
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;

  // Status follows the repo: git's own moves arrive through the .git watch,
  // a window focus re-reads for working-tree edits made elsewhere, and a
  // once-a-minute poll is the backstop (a worktree's .git is a file the
  // watch can't follow). Every status read, those and the ones a push asks
  // for, goes through the poll, so a status that didn't change keeps its
  // object and costs the pane no render.
  const refreshStatus = usePoll(
    () => {
      const r = repoRef.current;
      return r
        ? invoke<GitStatus>("push_status", { repo: r }).catch(() => null)
        : null;
    },
    repo ? 60_000 : null,
    { pauseWhenHidden: true, skipIfUnchanged: true, onResult: setStatus },
    [repo],
  );
  useGitWatch(repo, refreshStatus);
  useEffect(() => {
    const onFocus = () => refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatus]);
  useEffect(() => setStatus(null), [repo]);

  const refreshLastPush = useCallback(async () => {
    const id = reviewIdRef.current;
    if (!id) {
      setLastPush(null);
      return;
    }
    try {
      setLastPush(await invoke<PushRecord | null>("review_last_push", { reviewId: id }));
    } catch {
      setLastPush(null);
    }
  }, []);

  useEffect(() => {
    setLastPush(null);
    setOutcome(null);
    setError(null);
    setLog([]);
    if (reviewId) void refreshLastPush();
  }, [reviewId, refreshLastPush]);

  // Live step lines while a push runs; done → re-read status + last push.
  useEffect(() => {
    let alive = true;
    const logP = listen<PushLogEvent>("review-push-log", (e) => {
      if (!alive || e.payload.reviewId !== reviewIdRef.current) return;
      setLog((l) => [...l, e.payload.line]);
    });
    const doneP = listen<string>("review-push-done", (e) => {
      if (!alive) return;
      if (e.payload && e.payload !== reviewIdRef.current) return;
      void refreshStatus();
      void refreshLastPush();
    });
    return () => {
      alive = false;
      void logP.then((un) => un());
      void doneP.then((un) => un());
    };
  }, [refreshStatus, refreshLastPush]);

  const push = useCallback(
    async (req: PushRequest): Promise<PushOutcome | null> => {
      setPushing(true);
      setLog([]);
      setOutcome(null);
      setError(null);
      try {
        const out = await invoke<PushOutcome>("review_push", { req });
        setOutcome(out);
        return out;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setPushing(false);
        void refreshStatus();
        void refreshLastPush();
      }
    },
    [refreshStatus, refreshLastPush],
  );

  /** One awaited AI drafting pass; the caller folds the draft into the form. */
  const draft = useCallback(async (): Promise<CommitDraft | null> => {
    const id = reviewIdRef.current;
    if (!id) return null;
    setDrafting(true);
    setError(null);
    try {
      return await invoke<CommitDraft>("ai_commit_draft", { reviewId: id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setDrafting(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setOutcome(null);
    setError(null);
    setLog([]);
  }, []);

  return {
    status,
    lastPush,
    pushing,
    log,
    outcome,
    error,
    drafting,
    refreshStatus,
    push,
    draft,
    clearResult,
  };
}

export type UsePush = ReturnType<typeof usePush>;
