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
 * Run: `node server.mjs [--port 4444] [--host 0.0.0.0]`
 */
import { WebSocketServer } from "ws";

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

function send(conn, message) {
  if (conn.readyState !== conn.OPEN) return;
  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
}

const wss = new WebSocketServer({ port: PORT, host: HOST });

wss.on("connection", (conn) => {
  const subscribed = new Set();
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
          let subs = topics.get(topic);
          if (!subs) {
            subs = new Set();
            topics.set(topic, subs);
          }
          subs.add(conn);
          subscribed.add(topic);
        }
        break;
      case "unsubscribe":
        for (const topic of msg.topics ?? []) {
          topics.get(topic)?.delete(conn);
          subscribed.delete(topic);
        }
        break;
      case "publish": {
        if (typeof msg.topic !== "string") break;
        const subs = topics.get(msg.topic);
        if (!subs) break;
        msg.clients = subs.size;
        for (const receiver of subs) send(receiver, msg);
        break;
      }
      case "ping":
        send(conn, { type: "pong" });
        break;
    }
  });

  conn.on("close", () => {
    clearInterval(pinger);
    for (const topic of subscribed) {
      const subs = topics.get(topic);
      if (!subs) continue;
      subs.delete(conn);
      if (subs.size === 0) topics.delete(topic);
    }
  });
});

console.log(`redline signaling listening on ws://${HOST}:${PORT}`);
