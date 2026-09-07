// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  awayCardLine,
  markAwaySeen,
  summarizeAway,
  takeAwayWatermark,
  visibleAway,
  type AwayCard,
} from "../lib/awayFeed";

// "While you were away", above the Companion conversation.
//
// A STRIP, not a surface: it says what happened, it offers one way to go look
// at it properly, and it goes away. The Runs surface is where the work graph is
// actually read — this only exists so the news finds the user instead of
// waiting to be discovered.
//
// It renders nothing at all when nothing happened, which is most of the time.
// A panel that is usually an empty state teaches people to stop looking at it.
export function AwayFeed({
  /** Whether the Companion is the conversation on screen — the fetch is gated
   *  on it, so an unopened dock costs nothing. */
  active,
  /** Go read the work graph properly. */
  onOpenWork,
}: {
  active: boolean;
  onOpenWork: () => void;
}) {
  const [cards, setCards] = useState<AwayCard[]>([]);

  useEffect(() => {
    if (!active) return;
    const since = takeAwayWatermark(localStorage, Date.now());
    // No watermark yet — this is the first look, and a first look is not a
    // "while you were away".
    if (since == null) return;
    let alive = true;
    void invoke<AwayCard[]>("work_since", { sinceMs: since })
      .then((c) => alive && setCards(c))
      .catch(() => {
        /* the feed is an affordance, not a dependency */
      });
    return () => {
      alive = false;
    };
  }, [active]);

  if (!active || cards.length === 0) return null;
  const summary = summarizeAway(cards);
  const { shown, more } = visibleAway(cards);
  const dismiss = () => {
    markAwaySeen(localStorage, Date.now());
    setCards([]);
  };

  return (
    <div
      className="shrink-0"
      style={{
        borderBottom: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        padding: "8px 10px",
      }}
    >
      <div
        className="font-sans flex items-baseline gap-2"
        style={{ marginBottom: "6px" }}
      >
        <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-ink)" }}>
          While you were away
        </span>
        <span
          style={{ flex: 1, fontSize: "11px", color: "var(--color-ink-muted)" }}
        >
          {summary.headline}
        </span>
        <button
          type="button"
          onClick={dismiss}
          title="Mark these as seen"
          className="font-sans"
          style={{
            fontSize: "11px",
            border: "none",
            background: "transparent",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          Dismiss
        </button>
      </div>
      <ul style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {shown.map((c) => (
          <li key={`${c.kind}:${c.itemId}:${c.at}`}>
            <button
              type="button"
              onClick={onOpenWork}
              title="Open the work graph"
              className="font-sans w-full text-left"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "2px 0",
              }}
            >
              <span
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "var(--color-ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.title}
              </span>
              <span style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
                {awayCardLine(c)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={onOpenWork}
          className="font-sans"
          style={{
            marginTop: "4px",
            fontSize: "11px",
            border: "none",
            background: "transparent",
            color: "var(--color-info)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          and {more} more →
        </button>
      )}
    </div>
  );
}
