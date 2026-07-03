// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AiReviewDoneEvent,
  AiReviewErrorEvent,
  AiReviewLogEvent,
} from "../types";

/** Keep the live log bounded — the reviewer reads the tail, not a transcript. */
const LOG_CAP = 60_000;
/** Batch delta appends so a chatty stream doesn't re-render per token. */
const FLUSH_MS = 150;

/** Owns one review's AI pre-review job: start/cancel, the live log, and the
 *  outcome. Findings themselves arrive through the normal
 *  `review-annotations-changed` path — they're just draft annotations. */
export function useAiReview(reviewId: string | null) {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [summary, setSummary] = useState<AiReviewDoneEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idRef = useRef(reviewId);
  idRef.current = reviewId;
  const pendingRef = useRef("");
  const timerRef = useRef<number | null>(null);

  // Reset per review; re-adopt a still-running job after reload.
  useEffect(() => {
    setLog("");
    setSummary(null);
    setError(null);
    pendingRef.current = "";
    if (!reviewId) {
      setRunning(false);
      return;
    }
    let alive = true;
    void invoke<boolean>("ai_review_active", { reviewId })
      .then((active) => {
        if (alive) setRunning(active);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reviewId]);

  useEffect(() => {
    let alive = true;
    const flush = () => {
      timerRef.current = null;
      const chunk = pendingRef.current;
      pendingRef.current = "";
      if (!chunk) return;
      setLog((l) => {
        const next = l + chunk;
        return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
      });
    };
    const logP = listen<AiReviewLogEvent>("review-ai-log", (e) => {
      if (!alive || e.payload.reviewId !== idRef.current) return;
      pendingRef.current += e.payload.text;
      if (timerRef.current == null) {
        timerRef.current = window.setTimeout(flush, FLUSH_MS);
      }
    });
    const doneP = listen<AiReviewDoneEvent>("review-ai-done", (e) => {
      if (!alive || e.payload.reviewId !== idRef.current) return;
      setRunning(false);
      setSummary(e.payload);
    });
    const errP = listen<AiReviewErrorEvent>("review-ai-error", (e) => {
      if (!alive || e.payload.reviewId !== idRef.current) return;
      setRunning(false);
      setError(e.payload.cancelled ? null : e.payload.error);
    });
    return () => {
      alive = false;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      void logP.then((un) => un());
      void doneP.then((un) => un());
      void errP.then((un) => un());
    };
  }, []);

  const start = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    setLog("");
    setSummary(null);
    setError(null);
    setRunning(true);
    try {
      await invoke("ai_review_start", { reviewId: id });
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cancel = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    void invoke("ai_review_cancel", { reviewId: id }).catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    setSummary(null);
    setError(null);
    setLog("");
  }, []);

  return { running, log, summary, error, start, cancel, dismiss };
}

export type UseAiReview = ReturnType<typeof useAiReview>;
