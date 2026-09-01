# Redline on mobile — north-star roadmap

**Status:** proposed direction (2026-09-01), not started. Scope decided with the
owner: **owner-first** (unblock your own agent from anywhere), **full
functionality over a tunnel**, terminating either at **your own device** or at a
**cloud-hosted Redline**. Build path was open; this document decides it and says
why.

---

## The one governing rule (read this first)

> **Transport is an adapter, exactly like a file format is an adapter.** The
> frontend speaks to one seam — never to Tauri, never to a socket, never to
> `fetch` — and mobile is a *second implementation of that seam*, not a second
> application.

This is the north-star doc's format-socket rule ([document-ide-northstar.md](document-ide-northstar.md))
applied one layer down. The payoff is the same: every surface that speaks only
through the seam becomes remotable *the day the seam exists*, with no per-surface
mobile work. The plan editor, terminals, the work graph, code review, memory —
none of them need to know they are being driven from a phone on a train.

The corollary is the discipline: **a surface that reaches around the seam does
not work on mobile, and that is a bug in the surface, not in mobile.**

---

## What the mobile app is for

Redline installs a `PreToolUse` hook on `ExitPlanMode`. When Claude Code finishes
planning, the POST is **held open for up to 12 hours** while you review (SPEC
§13.1). That hold is the product's whole thesis — and today it has one failure
mode: *you walked away from the Mac.* The agent doesn't idle for a minute, it
idles until you're back.

The mobile app exists to close that gap. Everything else it does is downstream of
one sentence:

> **A blocked agent should never be waiting on your commute.**

That framing decides a lot. It means the app is measured in *time-to-decision*,
not in feature parity. It means the Inbox and the three decision verbs are the
spine, and the terminal is a convenience. And it means push notification is not a
nicety — without it the app cannot do its job, because you don't know to open it.

Secondary, and free once the tunnel exists: the invited reviewer on a phone
(today served by `/viewer/` and live join codes), and the glanceable monitor for
orchestration runs.

---

## Why "port the app" is the wrong frame

The desktop app is 130 React components over a Rust backend that is deeply,
correctly macOS-coupled: `portable-pty` shells, native child webviews for the
embedded browser, `SFSpeechRecognizer` dictation, a tray icon, an axum daemon,
and a local `claude` binary spawned as a subprocess for every agent surface.
None of that ports to a phone, and none of it should.

But the frontend does not actually depend on any of it. It depends on **two
seams**, and only two:

| Seam | Shape | Size today |
|---|---|---|
| **Tauri IPC** | `invoke()` request/response, `listen()` events, `Channel` byte streams (PTY output) | **296** `#[tauri::command]`s; **161** `invoke` call sites across **32** files; **25** `listen` sites |
| **The `/v1` daemon** | HTTP on `127.0.0.1:7676`, with a fail-closed `ROUTE_TABLE` in `auth.rs` | ~60 registered routes, already enumerated and already access-controlled |

That is the entire contract between "the UI" and "the machine." Make those two
seams remotable and the phone is running the real product, not a reimplementation
of it.

The second seam is the pleasant surprise: `auth.rs` already **fails closed on
unregistered routes** — a new route 401s until it earns a `ROUTE_TABLE` entry,
and the table generates `docs/api-v1.md` so it cannot drift from the router
silently. That mechanism, built to freeze `/v1`, is exactly the remote-exposure
allowlist we would otherwise have to invent.

---

## Phase 0 — The transport seam (do this first, ship nothing)

**The enabling move.** One module, one interface, one codemod. Zero behavior
change on desktop.

```ts
// src/transport/index.ts
export interface RedlineTransport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn>;
  channel(cmd: string, args?: Record<string, unknown>): Promise<ByteStream>;
  readonly kind: "local" | "tunnel";
  readonly status: "connected" | "reconnecting" | "offline";
}
```

Two implementations:

- **`LocalTauriTransport`** — forwards to `@tauri-apps/api`. This is what the
  desktop app runs, forever. It is a pass-through; if it is ever more than that,
  something has leaked.
- **`TunnelTransport`** — Phase 1. Same interface, frames over an encrypted
  socket.

Work:

1. Write the interface and `LocalTauriTransport`.
2. Codemod all 161 `invoke` sites and 25 `listen` sites off
   `@tauri-apps/api/core` and onto the seam. Mechanical, reviewable in one pass.
3. Add a lint rule (or a `size.yml`-style CI guard) that fails the build on a
   direct `@tauri-apps/api` import outside `src/transport/`. **The rule is the
   deliverable** — without it the seam erodes in a month.
4. Surface `transport.status` in the UI shell. On desktop it is always
   `connected` and renders nothing; on mobile it is the connection pill. Building
   it now means no retrofit later.

Also in Phase 0, because it is cheap and it de-risks everything after it:
**audit which surfaces already respect the seam.** Anything holding a `window.__TAURI__`
reference, a hardcoded `127.0.0.1:7676`, or a raw `fetch` to the daemon is on the
Phase 0 fix list.

**Why first:** it is the only work that is required under *every* build-path
outcome below, and it is the only work whose cost grows every week it is
deferred.

---

## Phase 1 — The tunnel

### The constraint that shapes everything

The daemon binds `127.0.0.1` and that is a **pinned invariant**, asserted by the
test `daemon_binds_loopback_only` and enumerated in
[local-only-audit.md](local-only-audit.md). We are not widening that bind. Not
behind a flag, not "just for paired devices."

So the remote edge is **not an inbound listener at all**. The Mac **dials out**:

```
   iPhone                    Relay (zero-knowledge)                Mac
     │                              │                               │
     │ ── wss (outbound) ─────────▶ │ ◀───────── wss (outbound) ─── │
     │                              │                               │
     │    E2E frames (X25519 + AEAD); relay pipes ciphertext        │
     │                              │                               │
     │                       ┌──────┴──────┐                        │
     │                       │ sees: token │                        │
     │                       │ hashes, box │                        │
     │                       │ sizes, time │                        │
     │                       └─────────────┘                        │
     │                                                              │
     │                                        tunnel terminates ────┤
     │                                        INSIDE Redline's      │
     │                                        process, then calls   │
     │                                        127.0.0.1:7676 like   │
     │                                        any other local client│
```

Consequences, all good:

- **No inbound port, no NAT traversal, no firewall change, no router config.**
  Works on cellular, on hotel wifi, behind CGNAT.
- **The loopback invariant is preserved literally.** The tunnel is a local client
  of the daemon, indistinguishable from the hook.
- **The relay is zero-knowledge by construction** — same posture the signaling
  server already holds.

### Reuse the signaling server, don't build a second relay

`signaling-server/` already does the hard parts: token-hash-only storage,
room-family access management (`rl-manage`), revocation that **drops live
connections and refuses new ones**, and key rotation that seals a new room secret
into per-invite AES-256-GCM envelopes so a revoked peer holds a dead room name.

The tunnel is a new message type on that server, not a new server. One piece of
infra to self-host, one auth model, one revocation story.

### Transport split, by traffic shape

Do not force everything down one pipe. Two shapes, two mechanisms, both already
in the stack:

| Traffic | Mechanism | Why |
|---|---|---|
| Plan document, comments, presence | **Existing y-webrtc mesh** (P2P, DTLS-SRTP) | It is built, it is CRDT-native, and it already survives partition. Do not re-plumb Yjs through a request/response pipe. |
| `invoke` request/response, events, PTY byte streams | **Multiplexed E2E WebSocket** through the relay | Terminals are a *stream*, not a document; xterm.js already consumes bytes. Request/response over CRDT is an anti-pattern. |

The phone runs both. `TunnelTransport` owns the WebSocket; the collab provider
owns the mesh, unchanged.

### Remote route policy — extend the fail-closed table

`ROUTE_TABLE` gets one new field per entry: whether the route is reachable **over
the tunnel**. It fails closed exactly as it does today, so:

- A route added tomorrow is remote-*unreachable* until someone writes it down.
- `docs/api-v1.md` generation extends to publish the remote column, so the remote
  attack surface is a generated document, not tribal knowledge.

The same treatment for the 296 Tauri commands: a `#[remote]` opt-in attribute (or
a registry list) with the default being **local-only**. Commands like
`pty_kill_all` or the extension-host writes may never want a remote caller;
that's a per-command decision made once, in code, reviewable in a diff.

### Device pairing

The QR machinery exists (`InviteDialog`, `qrcode`, `RLC1.` join codes). Pairing a
phone is a new code family:

1. Desktop shows a pairing QR: relay URL, a one-time pairing token, and the
   desktop's public key.
2. Phone generates a keypair **in the Secure Enclave**, scans, and completes an
   authenticated key exchange. The private key never leaves the enclave and is
   not extractable, not even by the app.
3. Desktop stores the device in a **paired-devices** list — name, public key,
   pairing time, last seen. Revoking a device reuses the invite-revocation path:
   drop live connections, rotate, re-seal envelopes to the survivors.
4. The pairing token is single-use and short-lived. A pairing QR left on a screen
   is not a standing credential.

**Pairing establishes device identity. It does not establish authority** — see
the next section, which is the subtle part.

### Release authority stays physical

Only the owner's daemon holds the `tokio::oneshot::Sender` for a held POST.
`approve_plan` is a `#[tauri::command]`, reachable from no `/v1` route, by
deliberate design. **We are not moving that, and the tunnel must not appear to
move it.**

What the phone sends is **intent**, not a release:

```
{ kind: "decision", verb: "approve" | "ask" | "revise",
  sessionId, version, revisionHash,
  nonce, issuedAt, expiresAt,
  sig: <device key signature over the above> }
```

The Mac verifies the signature against a paired device, checks that
`revisionHash` still matches the live revision, checks the nonce is unused and
the record unexpired — and *then* calls the same `approve_plan` /
`submit_feedback` path a click would. One code path, one enforcement point, one
audit trail. A compromised relay can drop or delay a decision; it cannot forge
one, replay one, or apply one to a plan that has since changed underneath it.

This is also what makes offline safe (below).

### Privilege tiers on the device

Not every remote action deserves the same friction:

| Tier | Actions | Gate |
|---|---|---|
| Read | plans, files, diffs, run status, memory | paired device |
| Annotate | comments, suggestions, drafter edits | paired device |
| **Decide** | **approve**, revise, ask | **biometric per action** |
| **Write to the world** | commit, push to branch, `gh pr create` | **biometric + explicit confirm** |
| Administrative | pair/revoke a device, change interception mode | **desktop only** |

Approve releases a blocked agent to act on your machine. It is the highest-
privilege verb in the product and should feel like it — Face ID, every time, no
"remember for 30 minutes."

Administrative-on-desktop-only is deliberate: a stolen unlocked phone must not be
able to pair a second attacker device.

---

## Phase 2 — The mobile client

### The build-path decision

Four candidates, judged against one dominant constraint: **the editor is
ProseMirror/TipTap over Yjs, it is the crown jewel, and it must not fork.**
`src/editor/` (schema, markdown parser/serializer, `rl:blk-` sidecars, the
`rl_ins`/`rl_del` suggestion marks) plus `src/collab/` and `src/theme/` are
~100% reusable TypeScript. Terminals are xterm.js. `/viewer/` already proves the
editor renders and behaves at phone width.

| Path | Verdict |
|---|---|
| **Tauri 2 mobile (iOS first)** | **Chosen.** Reuses the entire editor/collab/theme layer verbatim. The mobile Rust backend is *new and small* — tunnel client, keychain, push token, biometric bridge — it does **not** reuse `src-tauri` and should not try. Same toolchain, same idioms, one design system, one team. |
| Installable PWA | **Yes — as a Phase 0/1 probe, not the destination.** iOS 16.4+ gives home-screen PWAs web push, so it can validate the whole loop with no App Store. Loses background sockets, Secure Enclave, on-device speech, Live Activities. |
| React Native | **No.** You still host ProseMirror in a WebView, and now you also maintain a second component system and a JS bridge. Cost of native, benefit of neither. |
| Native SwiftUI | **Not now.** Best platform feel, highest cost, and it either forks the document model or wraps it in `WKWebView` anyway — at which point it is the fallback shell below, not a separate product. |

**The sequence, and the de-risking structure that makes it safe:**

> **PWA probe → Tauri 2 iOS → Android.**

The probe is not throwaway. Whatever ships in the probe is the same web bundle
Tauri hosts. And the native shell's contract — keychain, push registration,
biometrics, background socket, share sheet, on-device speech — is **identical
whether Tauri or a hand-written SwiftUI shell provides it.** So the decision gate
is concrete and the retreat is contained:

> If Tauri iOS blocks on background WebSocket lifetime or push plumbing, swap the
> shell for a thin SwiftUI `WKWebView` host implementing the same six
> capabilities. **Nothing above the shell changes.** That is a shell rewrite, not
> a product rewrite.

Android follows iOS and inherits everything except the shell.

### Screens

Twelve, not one hundred and thirty.

1. **Inbox** — pending reviews across projects. Each row: project, plan title,
   version, and **how long the agent has been blocked, counting down against the
   12-hour hook timeout.** That countdown is the most mobile-native thing in the
   product; on desktop it is a footnote, on a phone it is the whole emotional
   proposition.
2. **Reader** — the plan through the same TipTap schema. TOC sheet, section jump,
   reading time, revision timeline, diff shading against the previous revision.
3. **Annotate** — long-press to select → sheet with the four comment types
   (edit / feedback / question / structural). Anchors by `blockId` + character
   range, losslessly, because the sidecar IDs ride along.
4. **Decide** — Approve / Ask / Revise. Biometric on Approve. Shows exactly what
   is about to be sent.
5. **Discussion** — fork-agent threads, chat-shaped. The `claude` subprocess
   still runs on the Mac; the phone relays turns and renders deltas.
6. **Voice** — see below; this is the differentiator.
7. **Terminal** — one at a time, not a tile grid.
8. **Files** — tree + read-only viewer, with the existing off-thread highlighter.
9. **Code review** — hunk-by-hunk accept/reject. Phones are *good* at this;
   GitHub proved it.
10. **Work** — orchestration runs, verdicts, claim/close. `/v1/work/*` exists.
11. **Devices & connection** — pairing, revocation, tunnel status, relay choice.
12. **Settings** — theme, font, notifications, biometric policy.

### Voice is the reason the app is worth opening twice

Typing a redline on a phone keyboard is miserable, and the mobile use case is
overwhelmingly *hands-busy*: walking, driving, cooking. Redline already has every
piece — on-device dictation, a persistent voice agent, and TTS.

> **Read me the plan. I'll talk back my redlines.**

TTS reads the plan section by section; you dictate a comment and it anchors to
the section being read; the voice agent answers questions about the plan; "approve"
is spoken, then confirmed with Face ID. This is not desktop-Redline-on-a-phone.
It is a mode the desktop cannot offer, and it is the answer to "why would I open
this instead of waiting until I'm home."

It also inverts the usual mobile compromise: the small screen stops mattering.

### Per-surface verdict

"Full functionality over the tunnel" means every surface is *reachable*. It does
not mean every surface is *usable at 390 points wide*, and pretending otherwise
would produce a bad app. The honest table:

| Surface | Mobile | Notes |
|---|---|---|
| Plan review + track changes | **Full** | The reason the app exists. |
| Approve / Ask / Revise | **Full** | Biometric-gated; signed intent. |
| Discussion forks | **Full** | Chat shape fits natively. |
| Voice / dictation / TTS | **Full, and better than desktop** | On-device speech; hands-free mode. |
| Prompt Drafter | **Full** | It is a text editor. |
| Terminals | **Adapted** | One PTY at a time; saved-command palette instead of fighting a soft keyboard. Streams fine. |
| File explorer / viewer | **Full read**, adapted edit | CodeMirror is workable on mobile. |
| Code review (diff) | **Adapted — genuinely good** | Hunk-by-hunk; commit/push biometric-gated. |
| Work graph / orchestration | **Adapted glance + drill-in** | Strong mobile fit; routes exist. |
| Memory | **Read + Ask** | The treemap does not fit; the Ask agent does. |
| Missions | **Read brief, add findings, steer** | Do not mirror the tab strip. |
| Embedded browser + page agents | **Off-device** | Mirroring native webviews is a screen-sharing problem, not a data problem, and solving it badly would be the worst feature in the app. Expose the *agent* (ask, extract, pin) without the viewport. |
| Tray / hook install / mode toggle | **Desktop only** | Administrative tier. |

The one genuine amputation is the embedded browser. Everything else is a layout
problem, and layout problems are cheap once Phase 0 is done.

---

## Phase 3 — Notifications

Push is the one place where "local-first" and "the app does its job" actually
collide, and the collision is unavoidable: APNs and FCM are servers, and there is
no on-device substitute. iOS background refresh is scheduled at the system's
discretion and cannot be relied on to surface a time-sensitive review.

**Recommendation: contentless push, self-hostable, opt-in, off by default.**

The payload carries **no plan content, no plan title, no project name** — an
opaque request id and a wake. The phone wakes, connects over the tunnel, pulls
the content P2P, and *renders the real notification locally* from data that
never left your machine. Apple and Google learn that a device received a wake, and
nothing else.

The relay ships like `signaling-server/` does: a small self-hostable service, with
a default instance you may opt into. It gets its own row in
[local-only-audit.md](local-only-audit.md) stating precisely what leaves the
machine — that file is the contract, and a change that adds egress must update
it.

Fallbacks, honestly labeled in the UI rather than silently degraded:

- **No push configured** → foreground only. The app is a tool you open, not one
  that reaches you. Say so plainly at setup.
- **Live Activity** (iOS) → a lock-screen countdown for a held review while the
  app has recently been foregrounded. Excellent fit for the 12-hour timer;
  cannot be the primary channel.

**Never** put plan content in a push payload, and never a token in a URL.

> **Open decision:** the owner's scope answer addressed *reach*, not *payload*.
> Contentless-vs-rich push is still an explicit call to make, and it is the one
> that determines whether the README's local-first paragraph survives unchanged.
> Contentless is recommended precisely because it costs nothing real.

---

## Phase 4 — Cloud-hosted Redline (the always-on option)

The tunnel has one honest weakness: **a sleeping Mac is an offline Mac.** No
tunnel, no push worth sending, no agent to unblock. Wake-on-LAN and Power Nap are
partial and unreliable. The only complete answer is a Redline that does not sleep.

This is a **separate program with a separate posture**, not a mobile feature, and
it should be scoped as one. What it requires:

- **A headless mode** — no tray, no native webviews, no `SFSpeechRecognizer`, no
  macOS assumptions. A meaningful fraction of `src-tauri` needs a `cfg` audit.
- **A container image + persistent volume** for `redline.db`, the workspace, and
  the git checkouts.
- **Claude Code running on rented hardware, authenticated as you.** This is the
  crux and it deserves to be stated without softening: cloud-hosted Redline means
  your credentials, your source, your plans, and your prompt history live on a
  machine you do not physically control. Every word of the README's local-first
  section stops applying to that deployment.

The right shape is therefore **two clearly-labeled deployments, never one blurred
product**:

| | Device-hosted | Cloud-hosted |
|---|---|---|
| Data location | your Mac | rented hardware |
| Availability | Mac must be awake | always |
| Local-first claim | **intact** | **void, and must be said so** |
| Default | **yes** | opt-in, separate onboarding |

The mobile client should not care which it is talking to — same tunnel, same
seam, same auth — but the *user* must always know, and the UI should show it
persistently rather than in a settings page. Deferring the cloud program does not
block any of Phases 0–3.

---

## Offline & decision staleness

The phone will lose connectivity mid-review. Two different answers, deliberately:

- **Reads and annotations are offline-first.** Yjs already handles this — annotate
  in a tunnel, merge on reconnect, no conflict UI needed. Cache the plan, the
  comments, and the revision timeline locally.
- **Decisions are online-only.** An Approve queued offline and delivered three
  hours later — after the hold timed out, or after the plan moved to v3 — is a
  correctness bug wearing a convenience costume.

The signed decision record from Phase 1 makes this mechanical rather than
judgmental: `revisionHash` mismatched, nonce reused, or `expiresAt` passed → the
Mac rejects it and the phone shows *what changed* and re-asks. A decision is never
silently dropped and never silently applied to the wrong revision.

---

## Security model, in one place

- **No inbound port on the Mac, ever.** Outbound dial only; the loopback bind is
  untouched and its test stays green.
- **The relay is zero-knowledge.** E2E frames; it sees token hashes, frame sizes,
  and timing. Same posture the signaling server already holds — and the same
  caveat: sizes and timing are metadata, and we should not claim otherwise.
- **Remote reachability is an allowlist, fails closed**, for both `/v1` routes
  and Tauri commands, generated into `docs/api-v1.md` so the surface is auditable.
- **Device keys live in the Secure Enclave**, non-extractable. Revocation drops
  live connections and rotates.
- **Privilege tiers** with biometric gating on Decide and on writes to the world.
- **Administrative actions are desktop-only** — a stolen unlocked phone cannot
  pair another device.
- **Plan content is untrusted input** on the phone exactly as it is in the viewer
  (SPEC §17). Same sanitization, no HTML execution, no remote asset loads from
  document content.
- **The tunnel terminates inside Redline's process**, never in a shell. A remote
  frame is a typed message, not a command line.

The threat we are explicitly buying protection against: relay operator
compromise, network observation, and a lost phone. The threat we are **not**
claiming to solve: a compromised Mac. If the machine running `claude` is owned,
mobile changes nothing about that.

---

## Honest sizing & sequencing

Rough, deliberately coarse, assuming the current pace and one person:

| Phase | Work | Size | Blocks |
|---|---|---|---|
| **0** | Transport seam + codemod + CI guard + status plumbing | **~1–2 weeks** | everything |
| **0.5** | PWA probe: mobile-first `/viewer/`, live join, validate the loop | ~1 week | nothing (parallel) |
| **1** | Tunnel: relay message type, E2E framing, pairing, remote allowlist, signed decisions | **~3–4 weeks** | 2, 3 |
| **2** | Tauri iOS shell + the twelve screens + voice mode | **~4–6 weeks** | — |
| **3** | Contentless push relay + Live Activity + audit-doc update | ~1–2 weeks | — |
| **4** | Cloud-hosted Redline | **separate program** | — |

Phase 0 is the one with an unusual property: it is required under every possible
outcome of every later decision, it changes nothing user-visible, and its cost
strictly increases with every new `invoke` site written before it lands. **It
should start regardless of whether the rest of this document is approved.**

---

## Open questions

1. **Push payload posture** — contentless (recommended) vs. rich. The only
   question here that touches the README's central claim.
2. **Relay hosting** — self-host only, or a default hosted instance? Signaling
   already faces this; answer both at once, with one policy.
3. **TURN.** Symmetric-NAT peers need a relay for the WebRTC half, and TURN
   bandwidth is a real recurring cost. Or: route the document over the tunnel
   WebSocket too and drop the mesh on mobile — simpler and cheaper, at the cost
   of P2P latency and one more transport-specific code path. Worth measuring
   before committing.
4. **App Store review.** An app that opens a terminal on your own machine is
   well-trodden (Blink, Termius, Prompt), but an app that *approves an AI agent's
   plan to modify a machine* is novel enough to warrant a careful review
   narrative. Not a blocker; not a thing to discover at submission.
5. **Android timing** — inherits everything except the shell, but doubles the
   push and biometric integration surface. Recommend deferring until iOS is real.
6. **The 12-hour hold vs. iOS background limits.** The hold lives on the Mac, so
   it is unaffected — but a phone that has been backgrounded for six hours has no
   live tunnel and no fresh state. The Inbox must be correct on cold start from a
   push wake, which makes cold-start hydration a first-class path, not an
   afterthought.
