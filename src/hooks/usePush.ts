// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

  const refreshStatus = useCallback(async () => {
    const r = repoRef.current;
    if (!r) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await invoke<GitStatus>("push_status", { repo: r }));
    } catch {
      setStatus(null);
    }
  }, []);

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

  // Status follows the repo; a modest poll keeps the strip honest while the
  // agent (or the user's terminal) works underneath it.
  useEffect(() => {
    setStatus(null);
    if (!repo) return;
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 10_000);
    return () => window.clearInterval(id);
  }, [repo, refreshStatus]);

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
