// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
interface AnchorPillProps {
  anchorId: string;
}

export function AnchorPill({ anchorId }: AnchorPillProps) {
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
