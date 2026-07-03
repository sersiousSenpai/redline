// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The Review Request — the unifying object behind both ways plan feedback
 * reaches an owner (§A.4 of the collab program plan):
 *
 *  - **live**: a per-invite join code into the running room. The invite
 *    token doubles as the revocation handle (transport-side: the signaling
 *    server enforces its hash) and as key material for secret-rotation
 *    envelopes.
 *  - **async**: an encrypted snapshot link opened in the browser viewer by
 *    someone who never installs Redline; their annotations come back as an
 *    HMAC-signed return blob that re-anchors onto the CURRENT revision.
 *
 * Both funnel into the same comment model and the Collaboration Center.
 * This module is pure (no Tauri imports) so the browser viewer can share
 * the types; persistence lives in `useReviewRequests`.
 */

import type { Comment } from "../types";
import type { ReturnComment } from "./returnBlob";

export type ReviewRequestMode = "live" | "async";

/** pending → (live: connected is DERIVED from presence, not stored) →
 *  returned (async only) → resolved; revoked is terminal for live invites. */
export type ReviewRequestStatus = "pending" | "returned" | "resolved" | "revoked";

export interface ReviewRequest {
  /** Request id — also the HMAC-signing-key derivation handle for async
   *  returns, so verification never needs per-request key storage. */
  id: string;
  /** Who this request is for — "Review from John Doe". */
  reviewerName: string;
  mode: ReviewRequestMode;
  status: ReviewRequestStatus;
  createdAt: number;
  /** Revision the request was minted against. Live joiners roll forward with
   *  the room; async returns re-anchor onto the CURRENT revision at import. */
  baseVersion: number;
  /** Live: the per-invite bearer token embedded in the join code. Kept
   *  owner-side because rotation seals the new room secret to it. */
  invite?: string;
  /** Live: SHA-256 hex of `invite` — the identity the signaling server
   *  enforces and awareness advertises (never the raw token). */
  inviteHash?: string;
  /** Async: link expiry (epoch millis). The viewer refuses past-expiry
   *  snapshots and the owner rejects past-expiry returns. */
  expiresAt?: number;
  /** Optional note shown to the reviewer in the viewer/invite. */
  note?: string;
  returnedAt?: number;
  /** Comment ids created by importing this request's return. */
  importedCommentIds?: string[];
  /** Returned comments whose blockId no longer exists in the current
   *  revision — surfaced in the Collaboration Center, never silently
   *  dropped. */
  orphans?: ReturnComment[];
  /** Version the return was re-anchored ONTO (the current revision at
   *  import time) — drives the "anchored to v3, current is v5" line. */
  importedIntoVersion?: number;
}

/** Reviewer names a request's imported comments carry (attribution chip). */
export function requestAttribution(request: ReviewRequest): string {
  return request.reviewerName.trim() || "Reviewer";
}

/** True when a live request's peer is currently in the room — derived from
 *  awareness invite hashes, never persisted. */
export function isConnected(
  request: ReviewRequest,
  presentInviteHashes: ReadonlySet<string>,
): boolean {
  return (
    request.mode === "live" &&
    request.status === "pending" &&
    !!request.inviteHash &&
    presentInviteHashes.has(request.inviteHash)
  );
}

export function isExpired(request: ReviewRequest, now: number): boolean {
  return !!request.expiresAt && now > request.expiresAt;
}

/** Live invites that still count toward room access: everything not revoked.
 *  (Resolved live requests keep access until explicitly revoked — resolving
 *  marks the review done, it doesn't slam the door mid-conversation.) */
export function activeLiveRequests(requests: ReviewRequest[]): ReviewRequest[] {
  return requests.filter(
    (r) => r.mode === "live" && r.status !== "revoked" && !!r.invite,
  );
}

/** Serialization for the Rust-side opaque blob (`get/set_collab_requests`). */
export function parseRequests(json: string): ReviewRequest[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ReviewRequest =>
        typeof r === "object" &&
        r !== null &&
        typeof r.id === "string" &&
        typeof r.reviewerName === "string" &&
        (r.mode === "live" || r.mode === "async"),
    );
  } catch {
    return [];
  }
}

export function serializeRequests(requests: ReviewRequest[]): string {
  return JSON.stringify(requests);
}

/** Summary of one return import for the Collaboration Center status line. */
export interface ImportSummary {
  imported: Comment[];
  orphans: ReturnComment[];
  baseVersion: number;
  currentVersion: number;
}
