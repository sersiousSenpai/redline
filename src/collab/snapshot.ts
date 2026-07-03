// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Encrypted plan snapshots — the async delivery mode of a Review Request.
 *
 * The snapshot travels as a self-contained token designed to live in a URL
 * `#fragment`, which never reaches any server (zero-knowledge by
 * construction). The payload is AES-256-GCM encrypted with a random key that
 * rides IN the fragment next to the ciphertext — that split matters for the
 * future zero-knowledge paste service (ciphertext on the server, key stays
 * in the fragment); for pure-fragment delivery it costs nothing.
 *
 * Token format: `RLS1.<flag>.<key>.<data>`
 *   flag  "z" = payload deflate-raw compressed before encryption, "n" = not
 *   key   base64url raw 32-byte AES-GCM key
 *   data  base64url (12-byte IV || ciphertext)
 *
 * The payload embeds the per-request HMAC signing key, so the browser viewer
 * can sign its return blob without any channel back to the owner.
 */

export interface SnapshotPayload {
  v: 1;
  /** Review Request id this snapshot belongs to. */
  requestId: string;
  /** Revision the snapshot captured. Returns re-anchor to CURRENT at import. */
  baseVersion: number;
  reviewerName: string;
  ownerName?: string;
  projectName?: string;
  planTitle?: string;
  /** Sidecar-augmented plan markdown — `rl:blk-` block identity rides along,
   *  so viewer annotations anchor by blockId losslessly. */
  markdown: string;
  /** Per-request HMAC key (base64url) the viewer signs its return with. */
  signingKey: string;
  expiresAt?: number;
  note?: string;
  createdAt: number;
}

const PREFIX = "RLS1";

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

/** Plans are markdown — deflate typically cuts the token to a third. Falls
 *  back to uncompressed where CompressionStream is unavailable. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export async function encodeSnapshot(payload: SnapshotPayload): Promise<string> {
  const plain = enc.encode(JSON.stringify(payload));
  const compressed = await deflate(plain);
  const useCompressed = compressed !== null && compressed.length < plain.length;
  const body = useCompressed ? compressed : plain;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body as BufferSource),
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));

  const data = new Uint8Array(iv.length + ct.length);
  data.set(iv, 0);
  data.set(ct, iv.length);
  return [
    PREFIX,
    useCompressed ? "z" : "n",
    toBase64Url(rawKey),
    toBase64Url(data),
  ].join(".");
}

/** Null for anything that isn't a well-formed, decryptable snapshot token —
 *  the viewer surfaces "invalid or corrupted link", never throws. */
export async function decodeSnapshot(
  token: string,
): Promise<SnapshotPayload | null> {
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, flag, keyPart, dataPart] = parts;
  if (flag !== "z" && flag !== "n") return null;
  try {
    const data = fromBase64Url(dataPart);
    if (data.length < 13) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(keyPart) as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    let body = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.slice(0, 12) },
        key,
        data.slice(12),
      ),
    );
    if (flag === "z") {
      const inflated = await inflate(body);
      if (!inflated) return null;
      body = inflated;
    }
    const parsed = JSON.parse(dec.decode(body)) as SnapshotPayload;
    if (
      parsed.v !== 1 ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.markdown !== "string" ||
      typeof parsed.signingKey !== "string" ||
      typeof parsed.baseVersion !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Build the shareable link: viewer base URL + fragment. The fragment (and
 *  with it the key + plan) is never sent to the host serving the viewer. */
export function snapshotLink(viewerBase: string, token: string): string {
  const base = viewerBase.trim().replace(/#.*$/, "");
  return `${base}#${token}`;
}

/**
 * Validate/normalize a user-typed viewer base into an absolute http(s) URL,
 * or null when it can't be one. Guards the Collaboration Center against
 * minting `T1#RLS1.…`-style non-links out of a stray persisted keystroke —
 * anything that doesn't normalize is delivered as a bare snapshot code
 * instead of being labeled a link.
 *
 * A bare host is upgraded to https:// but only when it plausibly IS a host
 * (contains a dot, or is localhost/loopback — `T1` doesn't qualify); an
 * explicit scheme is taken at its word so intranet hosts still work.
 */
export function normalizeViewerBase(input: string): string | null {
  const s = input.trim().replace(/#.*$/, "");
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme) {
    const host = s.replace(/\/.*$/, "").replace(/:\d+$/, "");
    const plausible =
      host.includes(".") || host === "localhost" || host === "127.0.0.1";
    if (!plausible) return null;
  }
  try {
    const url = new URL(hasScheme ? s : `https://${s}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Pull the snapshot token out of a viewer URL or a bare pasted token. */
export function tokenFromLink(linkOrToken: string): string | null {
  const s = linkOrToken.trim();
  const hash = s.indexOf("#");
  const candidate = hash >= 0 ? s.slice(hash + 1) : s;
  return candidate.startsWith(`${PREFIX}.`) ? candidate : null;
}
