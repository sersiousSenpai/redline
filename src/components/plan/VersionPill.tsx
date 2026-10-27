// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! "Viewing v1 · read-only · Go to v4": the one amber pill that says you are
//! reading an older version (board 5a). It replaces classic's banner across
//! the top of the historical revision — the received-at time and the
//! separate "Back to latest" button fold into it — and sits in the plan
//! panel's header, so the plan text starts where it always does.
//!
//! Amber because an old version is a redlining state (read, mark, compare);
//! the inner button is the pill's one action and the only filled thing in it.

import { useId } from "react";

export interface VersionPillProps {
  viewing: number;
  latest: number;
  /** When the viewed version arrived — the classic banner's "received …",
   *  kept as the pill's tooltip. */
  receivedAt?: number | null;
  onGoToLatest: () => void;
}

export function VersionPill({ viewing, latest, receivedAt, onGoToLatest }: VersionPillProps) {
  const labelId = useId();
  const when = receivedAt ? new Date(receivedAt).toLocaleString() : null;
  return (
    <span
      className="rl-version-pill"
      data-version-pill
      role="group"
      aria-labelledby={labelId}
      title={when ? `v${viewing} · received ${when}` : undefined}
    >
      <span id={labelId}>Viewing v{viewing} · read-only</span>
      <button type="button" className="rl-version-pill-go" onClick={onGoToLatest}>
        Go to v{latest}
      </button>
    </span>
  );
}

export default VersionPill;
