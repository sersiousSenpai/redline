// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Signed return blobs — how async Review Request annotations travel back.
 *
 * The browser viewer signs its comment set with the per-request HMAC key
 * embedded in the snapshot link; the owner re-derives that key from the
 * owner secret + request id and verifies before importing. That makes a
 * return verifiably from the person the link was minted for (whoever holds
 * the link), untampered, and bound to THAT request — a forwarded blob can't
 * land under a different request, and a revoked/expired request rejects a
 * stale return.
 *
 * Blob format: `RLR1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)>`
 *
 * Import re-anchors comments by `blockId` onto the CURRENT revision
 * (reviewer decision from the plan review): blocks that survived revisions
 * land normally; comments whose block is gone are surfaced as orphans in the
 * Collaboration Center, never silently dropped.
 */

import type {
  CommentSelection,
  CommentType,
  EditPayload,
  NewCommentRequest,
} from "../types";

/** One annotation coming back from the viewer. Anchoring is blockId-first;
 *  `anchorId` is resolved owner-side at import against the current revision. */
export interface ReturnComment {
  type: CommentType;
  blockId: string;
  body: string;
  edit?: EditPayload;
  selection?: CommentSelection;
}

export interface ReturnPayload {
  v: 1;
  requestId: string;
  /** Revision the reviewer annotated (from the snapshot). */
  baseVersion: number;
  reviewerName: string;
  createdAt: number;
  comments: ReturnComment[];
}

const PREFIX = "RLR1";

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

async function hmacKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64Url(keyB64) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Derive the per-request signing key from the owner secret. Deterministic,
 *  so the owner verifies any return with nothing stored per request. */
export async function deriveSigningKey(
  ownerSecret: string,
  requestId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(ownerSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`redline-review-sign-v1:${requestId}`),
  );
  return toBase64Url(new Uint8Array(mac));
}

/** Sign a return (viewer side). */
export async function signReturn(
  payload: ReturnPayload,
  signingKeyB64: string,
): Promise<string> {
  const body = enc.encode(JSON.stringify(payload));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(signingKeyB64),
    body as BufferSource,
  );
  return [
    PREFIX,
    toBase64Url(body),
    toBase64Url(new Uint8Array(mac)),
  ].join(".");
}

/** Parse WITHOUT verifying — to read the requestId and look up which request
 *  (and therefore which derived key) to verify against. Never import from
 *  an unverified parse. */
export function peekReturn(blob: string): ReturnPayload | null {
  const parts = blob.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const parsed = JSON.parse(dec.decode(fromBase64Url(parts[1]))) as ReturnPayload;
    if (
      parsed.v !== 1 ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.baseVersion !== "number" ||
      !Array.isArray(parsed.comments)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Verify a return blob against the request's signing key. Null on any
 *  mismatch: tampered payload, wrong request's key, malformed blob. */
export async function verifyReturn(
  blob: string,
  signingKeyB64: string,
): Promise<ReturnPayload | null> {
  const parts = blob.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const body = fromBase64Url(parts[1]);
    const mac = fromBase64Url(parts[2]);
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(signingKeyB64),
      mac as BufferSource,
      body as BufferSource,
    );
    if (!ok) return null;
    return peekReturn(blob);
  } catch {
    return null;
  }
}

export interface ReanchorResult {
  /** Ready for `add_comment` — blockId still exists in the current revision,
   *  anchorId resolved against it. `reviewer` carries attribution. */
  placed: NewCommentRequest[];
  /** Blocks gone from the current revision — surface, don't drop. */
  orphans: ReturnComment[];
}

/** Land a verified return on the CURRENT revision by blockId. `anchors` is
 *  the current revision's blockId → anchorId map (`anchorByBlockId`). */
export function reanchorReturn(
  payload: ReturnPayload,
  anchors: ReadonlyMap<string, string>,
): ReanchorResult {
  const placed: NewCommentRequest[] = [];
  const orphans: ReturnComment[] = [];
  for (const c of payload.comments) {
    if (typeof c.blockId !== "string" || typeof c.body !== "string") continue;
    const anchorId = anchors.get(c.blockId);
    if (!anchorId) {
      orphans.push(c);
      continue;
    }
    placed.push({
      type: c.type,
      anchorId,
      blockId: c.blockId,
      body: c.body,
      ...(c.edit ? { edit: c.edit } : {}),
      // The selection's quotedText tier self-heals offset drift inside a
      // block whose text changed — same machinery as native comments.
      ...(c.selection ? { selection: c.selection } : {}),
      reviewer: payload.reviewerName,
    });
  }
  return { placed, orphans };
}
