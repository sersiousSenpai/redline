// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { isFlowShell } from "../lib/shellFlag";

interface AnchorPillProps {
  anchorId: string;
  /** The human label for the anchor (lib/anchorDisplay: "§4 · step 4"). The
   *  flow shell shows it in place of the positional id; the classic shell
   *  keeps the id it has always shown. Display only — the id the payload
   *  carries never changes. */
  label?: string;
}

export function AnchorPill({ anchorId, label }: AnchorPillProps) {
  const human = !!label && isFlowShell();
  return (
    <span
      className={`${human ? "text-[11px]" : "font-mono text-[10px] tracking-wide"} inline-block rounded-sm px-1.5 py-0.5 select-none`}
      style={{
        background: "var(--color-anchor-bg)",
        color: "var(--color-anchor-text)",
      }}
    >
      {human ? label : `§${anchorId}`}
    </span>
  );
}
