// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Room access manager for the Redline signaling server — the pure, transport-
 * agnostic core of transport-side revocation. The ws glue in server.mjs owns
 * sockets; this module owns who may subscribe/publish where.
 *
 * Model: a "room family" (base = `redline:{sessionId}:{threadStart}`) covers
 * every version and key-epoch topic of one review session. The first
 * connection to manage a base becomes its admin (identified by the SHA-256
 * hash of its auth token — the server never sees raw tokens in manage state);
 * afterwards only that admin can update it. Unmanaged bases relay freely, so
 * plain y-webrtc clients and pre-revocation Redline builds keep working.
 *
 * Envelopes are opaque ciphertext blobs (the rotated room secret sealed to
 * each remaining invite token client-side). The server stores and serves
 * them but cannot read them — zero-knowledge is preserved.
 */

/** Extract the room-family key from a topic name, or null for topics this
 *  server does not manage (non-Redline rooms). */
export function topicBase(topic) {
  if (typeof topic !== "string" || !topic.startsWith("redline:")) return null;
  const parts = topic.split(":");
  if (parts.length < 3) return null;
  return parts.slice(0, 3).join(":");
}

export class RoomManager {
  constructor() {
    /** base -> {adminHash, allowed:Set<hash>, revoked:Set<hash>,
     *           envelopes:Map<hash, blob>, epoch:number} */
    this.rooms = new Map();
  }

  /**
   * Register/update a base's access state. The caller passes the SHA-256 hex
   * hash of the managing connection's auth token; the first manager claims
   * the base, later calls must present the same hash.
   * Returns `{ok, kicked}` — `kicked` lists hashes that must be disconnected
   * (newly revoked), for the transport layer to enforce.
   */
  manage(base, adminHash, state) {
    if (!base || !adminHash) return { ok: false, kicked: [] };
    let room = this.rooms.get(base);
    if (room && room.adminHash !== adminHash) return { ok: false, kicked: [] };
    if (!room) {
      room = {
        adminHash,
        allowed: new Set(),
        revoked: new Set(),
        envelopes: new Map(),
        epoch: 0,
        extra: {},
      };
      this.rooms.set(base, room);
    }
    const allowed = Array.isArray(state?.allowed) ? state.allowed : [];
    const revoked = Array.isArray(state?.revoked) ? state.revoked : [];
    const newlyRevoked = revoked.filter(
      (h) => typeof h === "string" && !room.revoked.has(h),
    );
    room.allowed = new Set(allowed.filter((h) => typeof h === "string"));
    room.revoked = new Set(revoked.filter((h) => typeof h === "string"));
    room.envelopes = new Map(
      Object.entries(state?.envelopes ?? {}).filter(
        ([, v]) => typeof v === "string",
      ),
    );
    if (typeof state?.epoch === "number" && state.epoch >= 0) {
      room.epoch = state.epoch;
    }
    if (typeof state?.extra === "object" && state.extra !== null) {
      room.extra = state.extra;
    }
    return { ok: true, kicked: newlyRevoked };
  }

  /** May a connection with this auth-token hash join/publish this topic?
   *  Unmanaged bases (including non-Redline topics) are open relay. */
  canJoin(topic, authHash) {
    const base = topicBase(topic);
    if (!base) return true;
    const room = this.rooms.get(base);
    if (!room) return true;
    if (!authHash) return false;
    if (authHash === room.adminHash) return true;
    return room.allowed.has(authHash) && !room.revoked.has(authHash);
  }

  /** Room facts for ONE connection: epoch, its envelope, whether it's still
   *  allowed. Safe to send to anyone — envelopes only open with the invite
   *  token they were sealed to. */
  info(base, authHash) {
    const room = this.rooms.get(base);
    if (!room) {
      return { managed: false, allowed: true, epoch: 0, envelope: null, extra: {} };
    }
    const allowed =
      !!authHash &&
      (authHash === room.adminHash ||
        (room.allowed.has(authHash) && !room.revoked.has(authHash)));
    return {
      managed: true,
      allowed,
      epoch: room.epoch,
      envelope: (authHash && room.envelopes.get(authHash)) || null,
      extra: room.extra,
    };
  }
}
