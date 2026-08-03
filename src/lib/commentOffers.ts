// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Offered plan items — the `＋ Add as item` chips under a voice reply.
//
// An offer is staged by the agent mid-turn and carries no plan change until the
// user taps it. It binds to the reply it came from by `messageId`, which the
// backend fills in only once that reply is persisted — so "not yet bound" is a
// normal, transient state, not an error. Grouping therefore has to keep those
// loose offers rather than dropping them.

/** One staged offer, as `comment_offers_pending` / the `comment-offer` event
 *  deliver it (mirrors the Rust `CommentOffer`). */
export interface CommentOffer {
  id: string;
  sessionId: string;
  /** The transcript line this offer belongs under; `null` until bound. */
  messageId: string | null;
  blockId: string;
  /** What the feedback comment would say. */
  body: string;
  /** A short chip line; falls back to a truncated `body`. */
  label: string | null;
  agentId: string;
  /** `pending | added | dismissed`. */
  status: string;
  createdAt: number;
  /** The plan moved on and this offer's block is gone — render disabled. */
  stale?: boolean;
}

/** A transcript line as far as grouping is concerned. */
interface KeyedLine {
  id?: string;
}

export interface GroupedOffers {
  /** Offers keyed by the transcript line they render under. */
  byMessage: Map<string, CommentOffer[]>;
  /** Offers not yet bound to a line — rendered under the streaming reply, or
   *  at the tail when nothing is streaming. */
  loose: CommentOffer[];
}

/** Split offers into "under this reply" and "not yet attached".
 *
 *  An offer whose `messageId` names a line that isn't in this transcript is
 *  treated as loose rather than dropped: the panel may be showing a trimmed or
 *  still-hydrating view, and an offer that renders nowhere is an offer the user
 *  can never act on. */
export function groupOffers(
  transcript: readonly KeyedLine[],
  offers: readonly CommentOffer[],
): GroupedOffers {
  const known = new Set<string>();
  for (const line of transcript) {
    if (line.id) known.add(line.id);
  }
  const byMessage = new Map<string, CommentOffer[]>();
  const loose: CommentOffer[] = [];
  for (const o of offers) {
    if (o.messageId && known.has(o.messageId)) {
      const list = byMessage.get(o.messageId);
      if (list) list.push(o);
      else byMessage.set(o.messageId, [o]);
    } else {
      loose.push(o);
    }
  }
  return { byMessage, loose };
}

/** The chip's line: the agent's own short label, else a truncated body. */
export function offerChipLabel(o: CommentOffer, max = 48): string {
  const label = o.label?.trim();
  if (label) return label;
  const body = o.body.trim();
  return body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
}
