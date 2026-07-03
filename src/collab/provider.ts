// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The transport seam for live collaboration (decision c-002).
 *
 * Everything above this file talks to a `CollabProviderHandle`; only this
 * file knows the transport is a y-webrtc P2P mesh. The escape hatch for
 * large rooms — a Hocuspocus/SFU server stack — drops in as a second
 * `createCollabProvider` implementation behind the same handle without
 * touching PlanEditor, comments sync, or presence.
 *
 * IndexedDB persistence (`persistPlanYDoc`) is a separate, composable
 * concern: it attaches to the same Y.Doc and is never routed through here.
 */
import type * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";

import { collabRoomName, type CollabConfig, type CollabRoomId } from "./collabConfig";
import { withAuth } from "./access";

export interface CollabProviderHandle {
  /** The room doc this provider is attached to — the comments map and meta
   *  live on it, so presence-level consumers (App) reach them through the
   *  handle instead of threading the Y.Doc separately. */
  ydoc: Y.Doc;
  awareness: Awareness;
  /** True once the doc has completed an initial sync with at least one peer.
   *  An owner alone in a room stays unsynced — that's fine, the owner never
   *  gates on it; collaborators gate hydration on it. */
  readonly synced: boolean;
  /** Resolves the first time `synced` flips true. */
  whenSynced: Promise<void>;
  /** Fires on peer roster changes (join/leave), after `peerCount` updates. */
  onPeersChanged: (cb: (peerCount: number) => void) => () => void;
  /** Connected remote peers (webrtc conns; broadcast-channel peers count). */
  readonly peerCount: number;
  destroy: () => void;
}

export interface CreateProviderOptions {
  /** Room revision override — join codes carry the minted version, but on a
   *  revision rollover the collaborator re-points to a newer room. */
  room?: CollabRoomId;
  /** Extra ICE servers (STUN/TURN). A reachable TURN relay is mandatory for
   *  symmetric-NAT peers — configured via relay settings, not hardcoded. */
  iceServers?: RTCIceServer[];
  /** Credential presented to the signaling server (`?auth=`): the owner's
   *  admin token, or a collaborator's per-invite token. Defaults to the
   *  config's invite token. Managed rooms enforce it; unmanaged relays
   *  ignore it. */
  authToken?: string;
}

/** y-webrtc's ICE default is Google STUN only; keep it explicit so the relay
 *  config can replace it wholesale (self-hosted coturn). */
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
];

export function createCollabProvider(
  ydoc: Y.Doc,
  config: CollabConfig,
  options: CreateProviderOptions = {},
): CollabProviderHandle {
  const room = options.room ?? {
    sessionId: config.sessionId,
    threadStart: config.threadStart,
    version: config.version,
  };
  // Auth rides the signaling URL so reconnects re-present it automatically
  // (y-webrtc also keys its shared signaling conns by exact URL, so distinct
  // tokens never share a socket).
  const auth = options.authToken ?? config.invite;
  const provider = new WebrtcProvider(collabRoomName(room), ydoc, {
    signaling: config.signaling.map((u) => withAuth(u, auth)),
    // y-webrtc derives an encryption key from the password and encrypts all
    // signaling payloads with it — the signaling server relays ciphertext.
    // Media/data between peers is DTLS-SRTP end-to-end encrypted by WebRTC.
    password: config.secret,
    maxConns: 8,
    // Two Redline instances on one machine (the E2E rig) must still go
    // through signaling; BroadcastChannel shortcuts are same-profile only
    // and would make local testing behave unlike the real network path.
    filterBcConns: false,
    peerOpts: {
      config: { iceServers: options.iceServers ?? DEFAULT_ICE },
    },
  });

  let synced = false;
  let resolveSynced: () => void = () => undefined;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  provider.on("synced", () => {
    synced = true;
    resolveSynced();
  });

  let peerCount = 0;
  const peerListeners = new Set<(n: number) => void>();
  provider.on(
    "peers",
    (e: { webrtcPeers: string[]; bcPeers: string[] }) => {
      peerCount = e.webrtcPeers.length + e.bcPeers.length;
      for (const cb of peerListeners) cb(peerCount);
    },
  );

  return {
    ydoc,
    awareness: provider.awareness,
    get synced() {
      return synced;
    },
    whenSynced,
    onPeersChanged(cb) {
      peerListeners.add(cb);
      return () => peerListeners.delete(cb);
    },
    get peerCount() {
      return peerCount;
    },
    destroy() {
      peerListeners.clear();
      provider.destroy();
    },
  };
}
