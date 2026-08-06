// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo } from "react";

import type { GitStatus, PushRecord } from "../types";

// The review pane's git status strip:
//   ⎇ main → origin/main ↑0 ↓2 · 3 dirty · a1b2c3d "subject"
// plus a last-push chip linking the PR. Read-only — valuable before any push
// exists. The PR link is a plain <a>: lib/externalLinks.ts routes it to the
// system browser instead of hijacking the webview.

interface ReviewGitStripProps {
  status: GitStatus | null;
  lastPush: PushRecord | null;
}

function ReviewGitStrip({ status, lastPush }: ReviewGitStripProps) {
  if (!status) return null;
  const dirty = status.staged + status.unstaged + status.untracked;
  return (
    <div className="rl-review-gitstrip shrink-0" aria-label="Git status">
      <span className="rl-review-gitstrip-branch" title="Current branch (never switched by a push)">
        ⎇ {status.branch ?? "detached HEAD"}
      </span>
      {status.upstream && (
        <span title={`Upstream ${status.upstream}: ${status.ahead} ahead, ${status.behind} behind`}>
          → {status.upstream} ↑{status.ahead} ↓{status.behind}
        </span>
      )}
      <span title={`${status.staged} staged · ${status.unstaged} unstaged · ${status.untracked} untracked`}>
        · {dirty === 0 ? "clean" : `${dirty} dirty`}
      </span>
      {status.headShort && (
        <span
          className="truncate"
          style={{ minWidth: 0, maxWidth: 320 }}
          title={status.headSubject ?? undefined}
        >
          · {status.headShort} {status.headSubject ? `“${status.headSubject}”` : ""}
        </span>
      )}
      {status.inProgress && (
        <span className="rl-review-gitstrip-warn">⚠ {status.inProgress} in progress</span>
      )}
      {lastPush && (
        <span className="rl-review-gitstrip-chip" title="Last push from this review">
          ⇧ {lastPush.commitSha ? `${lastPush.commitSha.slice(0, 7)} → ` : ""}
          {lastPush.remote}/{lastPush.branch}
          {lastPush.prUrl && (
            <>
              {" · "}
              <a href={lastPush.prUrl} title={lastPush.prUrl}>
                PR{lastPush.prNumber != null ? ` #${lastPush.prNumber}` : ""}
              </a>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** Memoized: re-renders only when the polled status or last push changes. */
export default memo(ReviewGitStrip);
