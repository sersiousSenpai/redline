// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Transport-side access control for live collaboration rooms.
 *
 * The enforcement point is the signaling server: without signaling, a peer
 * cannot set up new WebRTC connections even if it still holds the room
 * secret. Every websocket to the server carries `?auth=<token>` (a
 * per-invite token for collaborators, the room's admin token for the owner);
 * the server stores only SHA-256 hashes of tokens, so its state never
 * contains a usable bearer credential.
 *
 * Revocation is cryptographic, not advisory: revoking an invite rotates the
 * room secret to a new epoch and seals the new secret into per-invite
 * envelopes (AES-256-GCM under a key derived from each REMAINING invite
 * token). Compliant peers fetch their envelope over this access channel and
 * re-key; the revoked peer has no envelope, no signaling access, and a dead
 * room name.
 *
 * Wire protocol (JSON, additive to the y-webrtc signaling protocol so one
 * server serves both):
 *   → {type:"rl-hello",  base}                          any authed conn
 *   ← {type:"rl-room",   base, managed, allowed, epoch, envelope}
 *   → {type:"rl-manage", base, allowed[], revoked[], envelopes{}, epoch}
 *   ← {type:"rl-denied", base}                          then server closes
 */

/** Room state as the signaling server reports it to THIS connection. */
export interface RoomAccessInfo {
  base: string;
  /** An admin has registered this room family — access is enforced. */
  managed: boolean;
  /** This connection's token is currently allowed (always true unmanaged). */
  allowed: boolean;
  /** Current key-rotation epoch (0 = the join-code secret is current). */
  epoch: number;
  /** This invite's sealed {secret, epoch} for the current epoch, if any. */
  envelope: string | null;
  /** Owner-published room facts the server relays opaquely — currently
   *  `{version}` (latest revision), so a joiner whose code was minted
   *  against an old revision finds the live room even when the old room
   *  is empty (no peers → no meta forwarding). */
  extra: Record<string, unknown>;
}

/** Owner-declared access state pushed to the server (hashes, never tokens). */
export interface RoomManageState {
  allowed: string[];
  revoked: string[];
  envelopes: Record<string, string>;
  epoch: number;
  /** Opaque room facts served back in rl-room (see RoomAccessInfo.extra). */
  extra?: Record<string, unknown>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** SHA-256 hex of a token — the only form of a token the server ever sees
 *  in manage state, and the form awareness shares for roster→invite maps. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Sealed room-secret payload: what an envelope encrypts. */
export interface SecretEnvelopePayload {
  secret: string;
  epoch: number;
}

async function envelopeKey(
  inviteToken: string,
  base: string,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(inviteToken),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("redline-invite-envelope-v1"),
      info: enc.encode(base),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal the rotated room secret to ONE invite token (owner side). */
export async function sealEnvelope(
  inviteToken: string,
  base: string,
  payload: SecretEnvelopePayload,
): Promise<string> {
  const key = await envelopeKey(inviteToken, base);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

/** Open this invite's envelope (collaborator side). Null on any mismatch —
 *  wrong token, wrong room, tampered blob. */
export async function openEnvelope(
  inviteToken: string,
  base: string,
  blob: string,
): Promise<SecretEnvelopePayload | null> {
  try {
    const bytes = fromBase64Url(blob);
    if (bytes.length < 13) return null;
    const key = await envelopeKey(inviteToken, base);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    );
    const parsed = JSON.parse(dec.decode(pt)) as SecretEnvelopePayload;
    if (typeof parsed.secret !== "string" || typeof parsed.epoch !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Append the auth token to a signaling URL. y-webrtc dedupes signaling
 *  connections by exact URL, so distinct tokens get distinct sockets. */
export function withAuth(url: string, token: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("auth", token);
    return u.toString();
  } catch {
    return url;
  }
}

export interface RoomAccessOptions {
  /** Signaling websocket URL (same endpoint the y-webrtc mesh uses). */
  url: string;
  /** Room-family key — `collabRoomBase(...)`. */
  base: string;
  /** This side's credential: invite token or admin token. */
  token: string;
  /** Server state for this room reached this connection (hello reply or a
   *  manage-update push). */
  onUpdate?: (info: RoomAccessInfo) => void;
  /** This token was denied — revoked or never allowed. Terminal. */
  onDenied?: () => void;
}

export interface RoomAccess {
  /** Push owner access state (idempotent, re-sent on reconnect). */
  manage: (state: RoomManageState) => void;
  close: () => void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Persistent access channel to the signaling server. Collaborators keep one
 * open per joined room (epoch discovery + revocation notice); the owner keeps
 * one per signaling server (manage + revoke pushes). Reconnects with backoff
 * and replays hello/manage so server restarts lose nothing.
 */
export function connectRoomAccess(options: RoomAccessOptions): RoomAccess {
  let ws: WebSocket | null = null;
  let closed = false;
  let denied = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastManage: RoomManageState | null = null;

  const send = (msg: Record<string, unknown>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Reconnect loop replays state; nothing to do here.
      }
    }
  };

  const connect = () => {
    if (closed || denied) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(withAuth(options.url, options.token));
    } catch {
      scheduleRetry();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      send({ type: "rl-hello", base: options.base });
      if (lastManage) {
        send({ type: "rl-manage", base: options.base, ...lastManage });
      }
    };
    socket.onmessage = (event) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.base !== options.base) return;
      if (m.type === "rl-denied") {
        denied = true;
        options.onDenied?.();
        socket.close();
        return;
      }
      if (m.type === "rl-room") {
        options.onUpdate?.({
          base: options.base,
          managed: !!m.managed,
          allowed: !!m.allowed,
          epoch: typeof m.epoch === "number" ? m.epoch : 0,
          envelope: typeof m.envelope === "string" ? m.envelope : null,
          extra:
            typeof m.extra === "object" && m.extra !== null
              ? (m.extra as Record<string, unknown>)
              : {},
        });
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      scheduleRetry();
    };
    socket.onerror = () => {
      // onclose follows; the retry loop owns recovery.
    };
  };

  const scheduleRetry = () => {
    if (closed || denied || retryTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4),
    );
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  connect();

  return {
    manage(state: RoomManageState) {
      lastManage = state;
      send({ type: "rl-manage", base: options.base, ...state });
    },
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      ws?.close();
      ws = null;
    },
  };
}
