// FLOW PLACEHOLDER — owned by feedback
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Stand-in for the feedback lane's Feedback tab (BRIEF, "Component seams"),
//! so the stage builds and its fixture renders. The integrator keeps the
//! feedback lane's file. The seam names `Session`; the type in src/types.ts
//! is `ReviewSession`.

import type { ReactNode } from "react";
import type { ReviewSession } from "../types";

export interface FeedbackPanelProps {
  session: ReviewSession;
  viewingVersion: number;
  onJumpToAnchor: (anchorId: string) => void;
  composer?: ReactNode;
}

export default function FeedbackPanel({ session, viewingVersion, onJumpToAnchor, composer }: FeedbackPanelProps) {
  const comments = session.revisions.find((r) => r.versionNumber === viewingVersion)?.comments ?? [];
  return (
    <div className="rl-feedback-placeholder" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ul style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, color: "var(--color-ink-3)" }}>
        {comments.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onJumpToAnchor(c.anchorId)}>{c.body}</button>
          </li>
        ))}
      </ul>
      {composer}
    </div>
  );
}
