// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";

/** What a call site asks for. `durationMs` defaults by shape (see
 *  `toastDuration`); `null` keeps it up until it is dismissed — for the rare
 *  notice that reports something still broken. */
export interface ToastSpec {
  message: string;
  /** Picks the leading icon — never a coloured pill. "success" is the
   *  default; "info" marks something that happened *to* you; "warning"
   *  something you should look at. */
  tone?: "success" | "info" | "warning";
  /** One quiet action. Pressing it also dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** A second, rarer action beside the first (a download's Show in Finder). */
  secondaryAction?: { label: string; onAction: () => void };
  /** "top" lifts the card to the window's top edge, which is always HTML.
   *  For a notice raised while a native browser page (which paints over all
   *  HTML) fills the lower window, as a download's does. */
  placement?: "top";
  durationMs?: number | null;
}

/** A toast in the slot. The `id` is what makes the slot safe to share: every
 *  timer and every dismissal names the toast it belongs to, so a stale one can
 *  never clear a newer toast. */
export interface ActiveToast extends ToastSpec {
  id: number;
}

/** 4 s for a notice; 8 s when there is something to press, because reading
 *  and then aiming takes longer than reading. */
export function toastDuration(spec: ToastSpec): number | null {
  if (spec.durationMs !== undefined) return spec.durationMs;
  return spec.action ? 8000 : 4000;
}

/** Normalise any call-site shape into a slot entry with a fresh id. */
export function makeToast(
  t: string | ToastSpec,
  id: number,
  durationMs?: number | null,
): ActiveToast {
  const spec = typeof t === "string" ? { message: t } : t;
  return { ...spec, ...(durationMs !== undefined ? { durationMs } : {}), id };
}

/** How long the leave fade runs before the slot is cleared. */
export const TOAST_LEAVE_MS = 140;

/** Redline's one toast: a quiet paper card, bottom-right, that leaves on its
 *  own. It OWNS its timer, keyed by the toast's id — call sites no longer
 *  schedule their own `setToast(null)`, which is how a stale timer used to
 *  wipe a newer toast and how two toasts never cleared at all. Hover pauses
 *  the clock; ✕ closes; an action closes after it runs.
 *
 *  Render it with `key={toast.id}`: each toast is its own instance, so its
 *  clock and its leave state can never carry over to the next one. */
export function RedlineToast({
  toast,
  onDismiss,
}: {
  toast: ActiveToast;
  /** Clear THIS toast — the owner compares ids, so a late call is a no-op. */
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Time left on the clock, carried across hover pauses.
  const remaining = useRef<number | null>(toastDuration(toast));
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const id = toast.id;

  const leave = useRef(() => {});
  leave.current = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => dismiss.current(id), TOAST_LEAVE_MS);
  };

  useEffect(() => {
    const left = remaining.current;
    if (hovered || leaving || left === null) return;
    const started = Date.now();
    const t = window.setTimeout(() => leave.current(), Math.max(0, left));
    return () => {
      window.clearTimeout(t);
      remaining.current = Math.max(0, left - (Date.now() - started));
    };
  }, [hovered, leaving]);

  const tone = toast.tone ?? "success";
  const Icon = tone === "warning" ? AlertTriangle : tone === "info" ? Info : Check;
  return (
    <div
      className={`rl-toast is-${tone}${toast.placement === "top" ? " is-top" : ""}${leaving ? " is-leaving" : ""}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Icon size={14} className="rl-toast-icon" aria-hidden />
      <span className="rl-toast-msg">{toast.message}</span>
      {[toast.action, toast.secondaryAction].map((action) => action && (
        <button
          key={action.label}
          type="button"
          className="rl-toast-action"
          onClick={() => {
            action.onAction();
            leave.current();
          }}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        className="rl-toast-x"
        aria-label="Dismiss"
        onClick={() => leave.current()}
      >
        <X size={12} />
      </button>
    </div>
  );
}
