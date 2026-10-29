// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A chat composer's notices: the plan's one-line strip (NoticeStrip, D41)
//! riding above the card (`.rl-composer-notices`, ComposerLook.css), never a
//! paragraph inside it. One strip per fault: the amber mark, the sentence,
//! its fix as a compact text action, a × that sets it aside for this
//! composer. The explanation is the tooltip. Lazy: FrontDoor is on the boot
//! path, and a well machine never loads this.

import { useState } from "react";

import type { ReadinessItem } from "../../lib/readiness";
import { CopyChip } from "../CopyChip";
import { NoticeStrip } from "./NoticeStrip";

/** The strip's one sentence: the fault, without the article a paragraph
 *  wanted ("The Redline skills are out of date" → "Redline skills are out
 *  of date"). */
export const noticeTitle = (label: string) => label.replace(/^The (\S)/, (_, c: string) => c.toUpperCase());
/** The fix as a text action: one verb where the long label was a phrase. */
export const noticeAction = (label: string) => label === "Install integration" ? "Install" : label;

export function ComposerNotices({ items, refused, onFix }: {
  items: ReadinessItem[];
  /** A refused ⏎ with no panel of its own. */
  refused?: string | null;
  onFix: (item: ReadinessItem) => Promise<boolean>;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const shown = items.filter((item) => !dismissed.has(item.id));
  if (!shown.length && !refused) return null;
  const dismiss = (id: string) => setDismissed((set) => new Set(set).add(id));
  return (
    <div className="rl-composer-notices" data-composer-notices>
      {refused && <NoticeStrip title={refused} label={refused} />}
      {shown.map((item) => (
        <NoticeStrip
          key={item.id}
          title={noticeTitle(item.label)}
          tip={item.detail || undefined}
          mark={busy === item.id ? "working" : "needs"}
          attrs={{ "data-notice": item.id }}
          onDismiss={() => dismiss(item.id)}
        >
          {item.fix && (item.fix.kind === "copy-hooks"
            ? <CopyChip text={item.fix.copyText ?? item.fix.label} title={`Copy ${item.fix.copyText ?? item.fix.label}`} />
            : <button
                type="button"
                className="rl-plan-notice-btn"
                data-primary
                disabled={busy === item.id}
                title={`${item.fix.label}. ${item.detail}`}
                onClick={() => {
                  setBusy(item.id);
                  void onFix(item).finally(() => setBusy(null));
                }}
              >
                {busy === item.id ? "Working…" : noticeAction(item.fix.label)}
              </button>)}
        </NoticeStrip>
      ))}
    </div>
  );
}
