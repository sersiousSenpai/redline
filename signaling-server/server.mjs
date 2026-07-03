// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Tiny self-hosted signaling server for Redline's y-webrtc collaboration
 * mesh. Speaks the y-webrtc signaling protocol: clients subscribe to room
 * topics and publish opaque messages to them; the server is a dumb relay.
 *
 * It never sees plan content: y-webrtc encrypts every published payload with
 * the room secret from the join code, and once peers connect, doc + media
 * flow peer-to-peer over DTLS-SRTP — not through this server.
 *
 * Transport-side access control (revocation) rides on top: connections
 * present `?auth=<token>` (per-invite tokens from join codes; the owner's
 * admin token); the owner registers who is allowed per room family via
 * `rl-manage`, and subscribe/publish on managed rooms is enforced against
 * it. Revoking an invite drops its live connections and refuses new ones.
 * The server stores only SHA-256 hashes of tokens and opaque encrypted
 * secret envelopes — never a usable credential, never a room secret.
 * Unmanaged rooms behave exactly as before (open relay).
 *
 * Run: `node server.mjs [--port 4444] [--host 0.0.0.0]`
 */
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";

import { RoomManager, topicBase } from "./manager.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(process.env.SIGNALING_PORT ?? flag("port", "4444"));
const HOST = process.env.SIGNALING_HOST ?? flag("host", "0.0.0.0");
const PING_INTERVAL_MS = 30_000;

/** topic name -> Set<WebSocket> */
const topics = new Map();
const manager = new RoomManager();
/** Every live connection, for revocation sweeps and rl-room pushes. */
const conns = new Set();

function send(conn, message) {
  if (conn.readyState !== conn.OPEN) return;
  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
}

function unsubscribeAll(conn) {
  for (const topic of conn.rlSubscribed) {
    const subs = topics.get(topic);
    if (!subs) continue;
    subs.delete(conn);
    if (subs.size === 0) topics.delete(topic);
  }
  conn.rlSubscribed.clear();
}

/** Room facts for one connection, as an rl-room message. */
function roomMessage(base, conn) {
  return { type: "rl-room", base, ...manager.info(base, conn.rlAuthHash) };
}

const wss = new WebSocketServer({ port: PORT, host: HOST });

wss.on("connection", (conn, req) => {
  conn.rlSubscribed = new Set();
  /** Room families this conn has shown interest in (subscribe or hello) —
   *  the push list for access updates. */
  conn.rlBases = new Set();
  conn.rlAuthHash = null;
  try {
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get(
      "auth",
    );
    if (token) {
      conn.rlAuthHash = createHash("sha256").update(token, "utf8").digest("hex");
    }
  } catch {
    // No auth — fine for unmanaged rooms.
  }
  conns.add(conn);
  let alive = true;

  const pinger = setInterval(() => {
    if (!alive) {
      conn.terminate();
      return;
    }
    alive = false;
    conn.ping();
  }, PING_INTERVAL_MS);
  conn.on("pong", () => {
    alive = true;
  });

  conn.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object" || !msg.type) return;
    switch (msg.type) {
      case "subscribe":
        for (const topic of msg.topics ?? []) {
          if (typeof topic !== "string") continue;
          const base = topicBase(topic);
          if (base) conn.rlBases.add(base);
          if (!manager.canJoin(topic, conn.rlAuthHash)) {
            send(conn, { type: "rl-denied", topic, base });
            continue;
          }
          let subs = topics.get(topic);
          if (!subs) {
            subs = new Set();
            topics.set(topic, subs);
          }
          subs.add(conn);
          conn.rlSubscribed.add(topic);
        }
        break;
      case "unsubscribe":
        for (const topic of msg.topics ?? []) {
          topics.get(topic)?.delete(conn);
          conn.rlSubscribed.delete(topic);
        }
        break;
      case "publish": {
        if (typeof msg.topic !== "string") break;
        if (!manager.canJoin(msg.topic, conn.rlAuthHash)) break;
        const subs = topics.get(msg.topic);
        if (!subs) break;
        msg.clients = subs.size;
        for (const receiver of subs) send(receiver, msg);
        break;
      }
      case "ping":
        send(conn, { type: "pong" });
        break;
      case "rl-hello": {
        if (typeof msg.base !== "string") break;
        conn.rlBases.add(msg.base);
        send(conn, roomMessage(msg.base, conn));
        break;
      }
      case "rl-manage": {
        if (typeof msg.base !== "string" || !conn.rlAuthHash) break;
        const result = manager.manage(msg.base, conn.rlAuthHash, msg);
        if (!result.ok) {
          send(conn, { type: "rl-denied", base: msg.base });
          break;
        }
        conn.rlBases.add(msg.base);
        const kicked = new Set(result.kicked);
        for (const other of conns) {
          if (other === conn || !other.rlBases.has(msg.base)) continue;
          if (other.rlAuthHash && kicked.has(other.rlAuthHash)) {
            // Transport-side eviction: notify, detach from every topic,
            // close. The token hash stays revoked, so reconnects bounce.
            send(other, { type: "rl-denied", base: msg.base });
            unsubscribeAll(other);
            other.close();
          } else {
            // Still-allowed members learn the new epoch (and their sealed
            // secret envelope) immediately — no polling.
            send(other, roomMessage(msg.base, other));
          }
        }
        send(conn, roomMessage(msg.base, conn));
        break;
      }
    }
  });

  conn.on("close", () => {
    clearInterval(pinger);
    conns.delete(conn);
    unsubscribeAll(conn);
  });
});

console.log(`redline signaling listening on ws://${HOST}:${PORT}`);
