// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Join-code encoding for live collaboration rooms.
 *
 * A join code is everything a collaborator needs to attach to a running
 * session: which room to join (session identity), where to find the mesh
 * (signaling URLs), and the shared room secret that encrypts signaling
 * payloads end-to-end. It deliberately carries NO plan content — the body
 * hydrates over the encrypted mesh after joining.
 *
 * Format: `RLC1.<base64url(JSON payload)>` — versioned by the prefix so the
 * wire format can evolve without breaking old codes. The same string works as
 * a paste-able code, the payload of a link, and the contents of a QR.
 */

/** Owner = the process that holds the blocked `ExitPlanMode` POST; release
 *  authority is physical (only the owner's daemon can approve/revise), so
 *  this role only gates UI + seeding, never security. */
export type CollabRole = "owner" | "collaborator";

/** Presence identity shown on cursors and the roster. */
export interface CollabUser {
  name: string;
  color: string;
}

/** One room per plan revision, 1:1 with the editor's `revisionKey`
 *  (`<sessionId>:<threadStart>:<version>`). The session identity (sessionId +
 *  threadStart) is stable across revisions, so a collaborator holding a join
 *  code can re-derive the next room name when the owner rolls the revision.
 */
export interface CollabRoomId {
  sessionId: string;
  threadStart: number;
  version: number;
  /** Key-rotation epoch. A revoke rotates the room secret and bumps this —
   *  the room name changes so the revoked peer's old secret opens nothing.
   *  Absent/0 = the original key (room name stays pre-rotation-compatible). */
  epoch?: number;
}

export interface CollabConfig {
  /** Stable session identity; combine with a version for a room name. */
  sessionId: string;
  threadStart: number;
  /** Revision the code was minted against — the room to join FIRST. The
   *  live `meta.currentVersion` may already be ahead; joiners re-point. */
  version: number;
  /** Websocket signaling URLs for the y-webrtc mesh. */
  signaling: string[];
  /** Shared room secret — y-webrtc encrypts signaling payloads with it, so
   *  even the signaling server only ever sees ciphertext. */
  secret: string;
  /** Per-invite token (revocation handle). Distinct per Review Request. */
  invite: string;
  /** Owner display name, for the joiner's UI before presence arrives. */
  ownerName?: string;
  /** Current key-rotation epoch (see CollabRoomId.epoch). NOT part of the
   *  join-code wire format — a joiner discovers the live epoch (and the
   *  rotated secret, sealed to its invite token) from the signaling server's
   *  access channel. */
  epoch?: number;
}

const JOIN_CODE_PREFIX = "RLC1.";

export function collabRoomName(id: CollabRoomId): string {
  const base = `redline:${id.sessionId}:${id.threadStart}:v${id.version}`;
  return id.epoch && id.epoch > 0 ? `${base}:e${id.epoch}` : base;
}

/** The room-family key a signaling server manages access by: every version
 *  and epoch of one review session shares this prefix. */
export function collabRoomBase(id: {
  sessionId: string;
  threadStart: number;
}): string {
  return `redline:${id.sessionId}:${id.threadStart}`;
}

/** The `revisionKey` used by planYDoc persistence, for the same triple. */
export function collabRevisionKey(id: CollabRoomId): string {
  return `${id.sessionId}:${id.threadStart}:${id.version}`;
}

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

/** Deterministic presence color for a display name — both sides derive the
 *  same color for the same person with no negotiation. Palette chosen to
 *  stay legible as a caret + label over light and dark themes. */
const PRESENCE_COLORS = [
  "#d94f30",
  "#2f7fd9",
  "#2f9e44",
  "#b0489b",
  "#c7841f",
  "#0f9d9d",
  "#7048b0",
  "#c23a5f",
];

export function presenceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

/** Random URL-safe token (room secrets, invite ids). */
export function randomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Compact wire form — short keys keep the QR payload small. */
interface JoinCodeWire {
  v: 1;
  s: string; // sessionId
  t: number; // threadStart
  n: number; // version
  g: string[]; // signaling
  k: string; // secret
  i: string; // invite token
  o?: string; // owner display name
}

export function encodeJoinCode(config: CollabConfig): string {
  const wire: JoinCodeWire = {
    v: 1,
    s: config.sessionId,
    t: config.threadStart,
    n: config.version,
    g: config.signaling,
    k: config.secret,
    i: config.invite,
    ...(config.ownerName ? { o: config.ownerName } : {}),
  };
  return (
    JOIN_CODE_PREFIX +
    toBase64Url(new TextEncoder().encode(JSON.stringify(wire)))
  );
}

/** Returns null for anything that isn't a well-formed RLC1 code — callers
 *  surface "invalid code", never throw at the user. */
export function decodeJoinCode(code: string): CollabConfig | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(JOIN_CODE_PREFIX)) return null;
  let wire: unknown;
  try {
    wire = JSON.parse(
      new TextDecoder().decode(
        fromBase64Url(trimmed.slice(JOIN_CODE_PREFIX.length)),
      ),
    );
  } catch {
    return null;
  }
  if (typeof wire !== "object" || wire === null) return null;
  const w = wire as Partial<JoinCodeWire>;
  if (
    w.v !== 1 ||
    typeof w.s !== "string" ||
    !w.s ||
    typeof w.t !== "number" ||
    typeof w.n !== "number" ||
    !Array.isArray(w.g) ||
    w.g.length === 0 ||
    !w.g.every((u) => typeof u === "string") ||
    typeof w.k !== "string" ||
    !w.k ||
    typeof w.i !== "string" ||
    !w.i
  ) {
    return null;
  }
  return {
    sessionId: w.s,
    threadStart: w.t,
    version: w.n,
    signaling: w.g,
    secret: w.k,
    invite: w.i,
    ...(typeof w.o === "string" && w.o ? { ownerName: w.o } : {}),
  };
}
