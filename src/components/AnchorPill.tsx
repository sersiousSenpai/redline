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
  if (label && isFlowShell()) {
    return (
      <span
        className="inline-block rounded-sm px-1.5 py-0.5 text-[11px] select-none"
        style={{
          background: "var(--color-anchor-bg)",
          color: "var(--color-anchor-text)",
        }}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className="font-mono inline-block rounded-sm px-1.5 py-0.5 text-[10px] tracking-wide select-none"
      style={{
        background: "var(--color-anchor-bg)",
        color: "var(--color-anchor-text)",
      }}
    >
      §{anchorId}
    </span>
  );
}
