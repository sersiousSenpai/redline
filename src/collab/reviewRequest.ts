// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Live Review Requests: one per invited person. The per-invite token is
 * both the collaborator's identity on the roster (as a SHA-256 hash in
 * awareness) and the owner's revocation handle — revoking evicts them at
 * the signaling server and rotates the room secret to a new epoch.
 *
 * (An async encrypted-snapshot mode existed briefly and was removed —
 * live-only keeps the surface small. `mode` stays on the wire so persisted
 * registries stay parseable and any legacy async entries are dropped.)
 */

export type ReviewRequestStatus = "pending" | "revoked";

export interface ReviewRequest {
  id: string;
  /** Who this invite is for — "John Doe". */
  reviewerName: string;
  /** Always "live"; legacy persisted entries with other modes are dropped. */
  mode: "live";
  status: ReviewRequestStatus;
  createdAt: number;
  /** Revision the invite was minted against (joiners roll forward). */
  baseVersion: number;
  /** The per-invite bearer token embedded in the join code. Kept owner-side
   *  because key rotation seals the new room secret to it. */
  invite: string;
  /** SHA-256 hex of `invite` — what the signaling server enforces and
   *  awareness advertises (never the raw token). */
  inviteHash: string;
}

/** True when a live request's peer is currently in the room — derived from
 *  awareness invite hashes, never persisted. */
export function isConnected(
  request: ReviewRequest,
  presentInviteHashes: ReadonlySet<string>,
): boolean {
  return (
    request.status === "pending" &&
    presentInviteHashes.has(request.inviteHash)
  );
}

/** Invites that still count toward room access: everything not revoked. */
export function activeLiveRequests(requests: ReviewRequest[]): ReviewRequest[] {
  return requests.filter((r) => r.status !== "revoked" && !!r.invite);
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
        r.mode === "live" &&
        typeof r.invite === "string" &&
        typeof r.inviteHash === "string",
    );
  } catch {
    return [];
  }
}

export function serializeRequests(requests: ReviewRequest[]): string {
  return JSON.stringify(requests);
}
