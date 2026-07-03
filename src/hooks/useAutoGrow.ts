// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef } from "react";

// Auto-grow a <textarea> to fit its content — no inner scrollbar, no manual
// resize handle. Mirror of the document sidecar composer (CommentThread): the
// box expands as the reviewer types and snaps back when the value is cleared
// on send. Pass the current text as `value` so it recomputes on every edit and
// whenever the parent resets the draft.
//
// Pair with `resize: none; overflow: hidden;` on the textarea so the measured
// scrollHeight reflects the content, not a scrolled viewport.
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}
