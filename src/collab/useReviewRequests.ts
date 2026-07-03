// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Per-session Review Request registry, persisted through the Rust side
 * (`get/set_collab_requests` — an opaque JSON blob in app_settings) so
 * requests, invite tokens, and revocations survive restarts. The frontend
 * is writer-of-record; Rust only stores.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  parseRequests,
  serializeRequests,
  type ReviewRequest,
} from "./reviewRequest";

export interface ReviewRequestsApi {
  requests: ReviewRequest[];
  /** Loaded flag — mutations before the initial load are refused so a slow
   *  read can't be clobbered by an empty write. */
  ready: boolean;
  add: (request: ReviewRequest) => void;
  update: (id: string, patch: Partial<ReviewRequest>) => void;
  remove: (id: string) => void;
}

export function useReviewRequests(sessionId: string | null): ReviewRequestsApi {
  const [requests, setRequests] = useState<ReviewRequest[]>([]);
  const [ready, setReady] = useState(false);
  // The session the current `requests` state belongs to — guards both the
  // async load race on session switch and writes landing under the wrong key.
  const boundRef = useRef<string | null>(null);

  useEffect(() => {
    setRequests([]);
    setReady(false);
    boundRef.current = null;
    if (!sessionId) return;
    let cancelled = false;
    void invoke<string>("get_collab_requests", { sessionId })
      .then((json) => {
        if (cancelled) return;
        boundRef.current = sessionId;
        setRequests(parseRequests(json));
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        boundRef.current = sessionId;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const mutate = useCallback(
    (updater: (prev: ReviewRequest[]) => ReviewRequest[]) => {
      const bound = boundRef.current;
      if (!bound) return;
      setRequests((prev) => {
        const next = updater(prev);
        void invoke("set_collab_requests", {
          sessionId: bound,
          json: serializeRequests(next),
        }).catch(() => undefined);
        return next;
      });
    },
    [],
  );

  const add = useCallback(
    (request: ReviewRequest) => mutate((prev) => [...prev, request]),
    [mutate],
  );
  const update = useCallback(
    (id: string, patch: Partial<ReviewRequest>) =>
      mutate((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      ),
    [mutate],
  );
  const remove = useCallback(
    (id: string) => mutate((prev) => prev.filter((r) => r.id !== id)),
    [mutate],
  );

  return { requests, ready, add, update, remove };
}
