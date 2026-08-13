// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { X } from "lucide-react";
import { CopyChip } from "./CopyChip";
import type { ReadinessItem } from "../lib/readiness";

// The front door's honesty strip. `deriveReadiness` yields ONLY faults, so a
// well machine hands this an empty list and it renders nothing at all —
// there is no green checklist to dismiss and no chrome to stop seeing.
// Each row is one thing that would break the door's promise, and (where one
// exists) the button that fixes it in place.

export function ReadinessStrip({
  items,
  onFix,
}: {
  items: ReadinessItem[];
  /** Runs the item's fix. Resolves true when the fault is cleared. */
  onFix: (item: ReadinessItem) => Promise<boolean>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rl-fd-strip">
      {items.map((item) => (
        <ReadinessRow key={item.id} item={item} onFix={onFix} />
      ))}
    </div>
  );
}

/** One item, rendered INSIDE the island when ⏎ was refused — the fix belongs
 *  where the user's attention already is, not only in a strip they may have
 *  stopped seeing. */
export function ReadinessBlock({
  item,
  onFix,
  onDismiss,
}: {
  item: ReadinessItem;
  onFix: (item: ReadinessItem) => Promise<boolean>;
  onDismiss: () => void;
}) {
  return (
    <div className="rl-fd-block is-blocking">
      <div className="flex items-start gap-2.5">
        <Dot state={item.state} />
        <div className="flex-1">
          <div className="rl-fd-label">{item.label}</div>
          <div className="rl-fd-detail">{item.detail}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          className="rl-fd-x"
        >
          <X size={12} />
        </button>
      </div>
      <div className="rl-fd-row">
        <FixControl item={item} onFix={onFix} prominent />
      </div>
    </div>
  );
}

function ReadinessRow({
  item,
  onFix,
}: {
  item: ReadinessItem;
  onFix: (item: ReadinessItem) => Promise<boolean>;
}) {
  return (
    <div className="rl-fd-item">
      <Dot state={item.state} />
      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="rl-fd-label">{item.label}</span>
          <FixControl item={item} onFix={onFix} />
        </div>
        <div className="rl-fd-detail">{item.detail}</div>
      </div>
    </div>
  );
}

// The palette carries no red (blue/yellow/green — see theme/themes.ts), so
// severity reads as amber-vs-grey: a blocker is the theme's warning colour
// with a soft halo, a warning is a quiet mark that doesn't compete with it.
function Dot({ state }: { state: ReadinessItem["state"] }) {
  return (
    <span
      aria-hidden
      className={`rl-fd-dot${state === "blocked" ? " is-blocked" : ""}`}
    />
  );
}

/** The fix, in whatever shape it takes: a `/hooks` chip the user copies into
 *  Claude Code (nothing here can approve it for them — it is Claude Code's
 *  own security check), or a button over a handler App already owns. */
function FixControl({
  item,
  onFix,
  prominent,
}: {
  item: ReadinessItem;
  onFix: (item: ReadinessItem) => Promise<boolean>;
  prominent?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const fix = item.fix;
  if (!fix) return null;
  if (fix.kind === "copy-hooks") {
    return (
      <CopyChip
        text={fix.copyText ?? fix.label}
        title={`Copy ${fix.copyText ?? fix.label}`}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onFix(item).finally(() => setBusy(false));
      }}
      className={`rl-fd-fix${prominent ? " is-primary" : ""}`}
    >
      {busy ? "Working…" : fix.label}
    </button>
  );
}
