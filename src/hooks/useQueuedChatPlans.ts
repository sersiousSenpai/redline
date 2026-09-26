// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatPlanRequest } from "../components/ChatRoom";
import type { ContinuationMessage } from "../lib/conversationContinuation";

/** A queued plan belongs to the app, so leaving Home cannot lose the instruction. */
export function useQueuedChatPlans(onReady: (request: ChatPlanRequest) => void, onError: (request: ChatPlanRequest, error: string) => void) {
  const [queued, setQueued] = useState<Record<string, ChatPlanRequest>>({});
  const requests = useRef(queued);
  const ready = useRef(onReady); ready.current = onReady;
  const failed = useRef(onError); failed.current = onError;
  const arm = useCallback((request: ChatPlanRequest) => {
    requests.current = { ...requests.current, [request.companionId]: request };
    setQueued(requests.current);
  }, []);
  const cancel = useCallback((id: string) => {
    const request = requests.current[id];
    const next = { ...requests.current }; delete next[id];
    requests.current = next; setQueued(next);
    return request?.instruction ?? null;
  }, []);
  const active = Object.keys(queued).length > 0;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      for (const request of Object.values(requests.current)) {
        try {
          const status = await invoke<{ streaming: boolean; queued: unknown[] }>("companion_turn_status", { companionId: request.companionId });
          if (!alive || status.streaming || status.queued.length > 0) continue;
          const messages = await invoke<ContinuationMessage[]>("companion_get_thread", { companionId: request.companionId });
          if (!alive || requests.current[request.companionId] !== request) continue;
          cancel(request.companionId);
          if (messages[messages.length - 1]?.status === "error") failed.current(request, "The chat reply failed. Retry planning when you are ready.");
          else ready.current({ ...request, messages });
        } catch (error) {
          if (alive && requests.current[request.companionId] === request) {
            cancel(request.companionId);
            failed.current(request, `Could not check the pending reply: ${String(error)}`);
          }
        }
      }
      if (alive && Object.keys(requests.current).length > 0) timer = setTimeout(() => void poll(), 700);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, cancel]);
  return { queued, arm, cancel };
}
