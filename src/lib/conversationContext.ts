// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Which conversation the dock is holding — the generalization of
// `discussionContext.ts`, and it inherits that module's law verbatim:
//
//     context follows what's on screen; a pin only breaks genuine ties.
//
// Redline grew nine chat UIs (plan voice, drafter voice, the browser's page /
// linked / mission panels, Memory Ask, the chat room, review annotations,
// comment sidecars) sitting on ONE backend runtime: one turn lifecycle, one
// thread table, one active-surface cell. The dock collapses the UIs; this
// module is the mapping that lets it — (surface, surface state) in, an ordered
// list of the conversations available there out, plus which one is live.
//
// Memory Ask is the one of the nine the dock does NOT hold. Its thread is a
// singleton — one conversation over the whole lake, keyed `memchat`, with no
// thread column in `mem_chat_messages` — so it can have exactly one live mount
// or two mounts drive one turn lifecycle and stream into each other. It has
// that mount as the first tab of the Memory surface, at plate width, where its
// citations can drive the Timeline behind them. Do not add it back here.
//
// Deliberately pure and component-free: the dock's JSX only looks up a body by
// `kind` and hands it `id`. Every decision about WHICH conversation belongs to
// a surface is testable without mounting anything.

import type { ChatPill } from "./browseChatState";
import type { DocumentPlateMode } from "./documentPlate";
import { MAIN_SURFACE_KEY } from "./mainSurface";

/** The conversation kinds the dock can hold. These are the backend's own
 *  `thread_table` kinds (db.rs) minus the ones that are not dock
 *  conversations: `session`/`fork` are the plan's comment threads, which stay
 *  in the discussion pane — a margin, not a conversation — and `memchat` is
 *  the Memory surface's own first tab (see the header). */
export type ConversationKind =
  | "voice"
  | "drafter"
  | "browse"
  | "browselist"
  | "linked"
  | "mission"
  | "companion";

/** The one member of the union that is NOT a conversation: a browser tab's
 *  working list.
 *
 *  It is here because the dock is the app's ONE right column, and the list has
 *  always shared that column with the page discussion — the two hand items
 *  back and forth (`💬` on an item seeds the chat; a reply appends to the
 *  list), so splitting them across two columns would be a step backwards from
 *  what the browser already had. It is never voice-capable and never leads. */
export const NON_CONVERSATION_KINDS: readonly ConversationKind[] = ["browselist"];

/** Kinds that may take the CENTER PLATE rather than the side column.
 *
 *  The rule is one line: a conversation can take the plate when it is not
 *  about what the plate is showing. The plan's voice thread and the drafter's
 *  are about the document they sit beside, and covering it with them would be
 *  absurd; the browser's three are about a page whose webview IS the plate.
 *  (Memory Ask is the limit case of the same rule and the reason it is not a
 *  dock kind at all: it cites into the Timeline behind it, so it belongs to
 *  that surface — it is a tab of it.) The Companion is the one conversation
 *  with no document of its own — it is about everything — so it is the one
 *  that can become a room. */
export const EXPANDABLE_KINDS: readonly ConversationKind[] = ["companion"];

/** Where the dock's conversation is showing.
 *
 *  `docked` is the column beside a surface: the conversation FOLLOWING you.
 *  `expanded` is the plate itself: the conversation you have gone INTO. Same
 *  thread, same room, two scales — the Prompt Drafter's own two poses, applied
 *  to the conversation the app is built around. */
export type ConversationPose = "hidden" | "docked" | "expanded";

export function conversationPose(i: {
  open: boolean;
  /** The kind the user asked to see as a ROOM, or null for the column. Not
   *  the ACTIVE kind: the pose has to be decidable before the context list is
   *  built (App computes its panel mask high up, above the state the list
   *  needs), and "what did the user ask for" is knowable that early while
   *  "what is currently active" is not. App reconciles the two. */
  expandedKind: ConversationKind | null;
  /** The center plate is at REST — the Front Door, with no document, no
   *  draft, no browser of its own. Nothing to cover is exactly the condition
   *  under which a conversation may take it, which is also why the Front Door
   *  can open INTO a conversation rather than navigating away to one. */
  plateAtRest: boolean;
}): ConversationPose {
  if (!i.open) return "hidden";
  if (
    i.expandedKind &&
    i.plateAtRest &&
    EXPANDABLE_KINDS.includes(i.expandedKind)
  )
    return "expanded";
  return "docked";
}

/** The kinds the browser pane owns and renders itself (into the dock's slot). */
export const BROWSER_DOCK_KINDS: readonly ConversationKind[] = [
  "browse",
  "browselist",
  "linked",
  "mission",
];

export interface ConversationDescriptor {
  kind: ConversationKind;
  /** Unique across every kind, and — for the voice-capable kinds — exactly the
   *  key `voice.rs` dispatches on (a bare plan session id; `drafter:<id>`;
   *  `companion:<id>` once A7 lands). Doubles as the dock body's React key, so
   *  switching conversations remounts rather than mutating a warm session. */
  key: string;
  /** The kind-scoped raw id: plan session id, draft id, browseId, linkedId,
   *  missionId, companionId. The singleton kinds carry their own name. */
  id: string;
  /** What the context switcher shows. Short — this is a tab, not a title bar. */
  label: string;
  /** Whether `voice.rs` will take this key: mic, TTS and the read-aloud modes
   *  are live here. The others are typed conversations in the same dock. */
  voiceCapable: boolean;
}

/** The kinds `voice.rs` accepts today. A7 adds "companion" here and in the
 *  Rust key-shape dispatch — one line on each side. */
export const VOICE_CAPABLE_KINDS: readonly ConversationKind[] = [
  "voice",
  "drafter",
];

export interface ConversationInputs {
  /** The manifest's `voice` surface toggle. Off removes the plan and draft
   *  conversations — those two ARE the voice surface, and a workspace that
   *  turned it off must not get them back through the dock. */
  voiceEnabled: boolean;
  /** The manifest's `chat` surface toggle. Off removes the Companion. Kept
   *  separate because the two are independently switchable, and a workspace
   *  with chat but no voice must still reach its conversation. */
  chatEnabled: boolean;
  /** The selected main surface. Widened to `string` for the same reason
   *  `SurfaceId` is: a manifest may name a surface this build cannot render,
   *  and an unknown id must degrade to "Companion only", never to a crash. */
  surface: string;
  /** Which face the document plate is showing — a file viewer and the Front
   *  Door are not a plan, and neither has a plan conversation. */
  plateMode: DocumentPlateMode;
  /** The selected plan review session. */
  activeId: string | null;
  planTitle: string | null;
  /** The open Prompt Drafter document. */
  drafterDraftId: string | null;
  drafterTitle: string | null;
  /** The browser's foreground tab. */
  browseId: string | null;
  browseTitle: string | null;
  /** The tab's remembered pill — the browser's on-screen truth about which of
   *  its three conversations the user last had up. `list` names a working
   *  list, which is not a conversation, so it selects nothing here. */
  browsePill: ChatPill | null;
  /** The linked (cross-tab) discussion, when one exists. */
  linkedId: string | null;
  /** The active research mission, when one is running. */
  missionId: string | null;
  missionTitle: string | null;
  /** The Companion chat this dock is on, or null before one has been chosen.
   *  The CONTEXT is present either way — the Companion is the one conversation
   *  that spans every surface, so it has to be reachable from a surface that
   *  has none of its own, which is precisely the case where no chat is open
   *  yet. A null id means "the Companion, no conversation picked": the dock
   *  adopts the most recent one, or offers to start the first. */
  companionId: string | null;
  companionTitle: string | null;
}

function companionDescriptor(
  companionId: string | null,
  companionTitle: string | null,
): ConversationDescriptor {
  const id = companionId ?? "";
  return {
    kind: "companion",
    // The id is part of the key, so the room REMOUNTS when the conversation
    // arrives (or changes) rather than carrying one chat's half-typed thought
    // into another — the same reason ChatRoom was keyed by `chatId`.
    key: `companion:${id}`,
    id,
    label: companionTitle?.trim() || "Companion",
    voiceCapable: VOICE_CAPABLE_KINDS.includes("companion"),
  };
}

/** The conversations available on a surface, in the order the switcher shows
 *  them: the surface's OWN conversation(s) first, the Companion always last.
 *
 *  That order is the law restated as data. The dock opens on `list[0]` unless
 *  the pin names something else that is actually here, so a surface with a
 *  conversation of its own opens on it — the browser opens on the page you are
 *  looking at, the plan on the plan — and the Companion is the deliberate
 *  step sideways, never the accident. */
export function conversationContexts(
  s: ConversationInputs,
): ConversationDescriptor[] {
  const own: ConversationDescriptor[] = [];

  if (
    s.voiceEnabled &&
    s.surface === "document" &&
    s.plateMode === "plan" &&
    s.activeId
  ) {
    own.push({
      kind: "voice",
      // Bare: a plan's voice key IS its session id (the backend derives the
      // kind from the key SHAPE, and an unprefixed id means "plan").
      key: s.activeId,
      id: s.activeId,
      label: s.planTitle?.trim() || "Plan",
      voiceCapable: VOICE_CAPABLE_KINDS.includes("voice"),
    });
  }

  if (s.voiceEnabled && s.surface === "drafter" && s.drafterDraftId) {
    own.push({
      kind: "drafter",
      key: `drafter:${s.drafterDraftId}`,
      id: s.drafterDraftId,
      label: s.drafterTitle?.trim() || "Draft",
      voiceCapable: VOICE_CAPABLE_KINDS.includes("drafter"),
    });
  }

  if (s.surface === "browser") {
    if (s.browseId) {
      own.push({
        kind: "browse",
        key: `browse:${s.browseId}`,
        id: s.browseId,
        label: s.browseTitle?.trim() || "Page",
        voiceCapable: VOICE_CAPABLE_KINDS.includes("browse"),
      });
      own.push({
        kind: "browselist",
        key: `browselist:${s.browseId}`,
        id: s.browseId,
        label: "List",
        voiceCapable: false,
      });
    }
    if (s.linkedId) {
      own.push({
        kind: "linked",
        key: `linked:${s.linkedId}`,
        id: s.linkedId,
        label: "Linked",
        voiceCapable: VOICE_CAPABLE_KINDS.includes("linked"),
      });
    }
    if (s.missionId) {
      own.push({
        kind: "mission",
        key: `mission:${s.missionId}`,
        id: s.missionId,
        label: s.missionTitle?.trim() || "Mission",
        voiceCapable: VOICE_CAPABLE_KINDS.includes("mission"),
      });
    }
    // The tab remembers which of the three it was on; that memory is the
    // browser's on-screen truth, so it leads. Rotating rather than filtering
    // keeps the other two reachable in one click.
    const lead = pillKind(s.browsePill);
    const at = lead ? own.findIndex((d) => d.kind === lead) : -1;
    if (at > 0) own.unshift(...own.splice(at, 1));
  }

  // memory / review / servers / runs / anything a manifest names: the
  // Companion alone. Memory looks like it should carry its Ask thread here and
  // it deliberately does not — that thread is a singleton and its one mount is
  // the Memory surface's first tab (see the header).
  //
  // Code Review's annotations are NOT listed here on purpose — they are the
  // diff's margin and they stay in the discussion pane.
  if (!s.chatEnabled) return own;
  return [...own, companionDescriptor(s.companionId, s.companionTitle)];
}

/** The browser's own vocabulary (a per-tab `ChatPill`) ↔ the dock's. */
export function pillKind(pill: ChatPill | null): ConversationKind | null {
  if (pill === "page") return "browse";
  if (pill === "list") return "browselist";
  if (pill === "linked") return "linked";
  if (pill === "mission") return "mission";
  return null;
}

export function kindPill(kind: ConversationKind | null): ChatPill | null {
  if (kind === "browse") return "page";
  if (kind === "browselist") return "list";
  if (kind === "linked") return "linked";
  if (kind === "mission") return "mission";
  return null;
}

/**
 * Which conversation is live.
 *
 * The pin is a TIE-BREAK, exactly as `effectiveDiscussionContext`'s is: with
 * nothing available there is no conversation, with one there is no choice to
 * make, and a pin naming a kind this surface does not have is ignored rather
 * than obeyed into an empty dock. Only a genuine choice consults it.
 */
export function activeConversation(
  list: ConversationDescriptor[],
  pinned: ConversationKind | null,
): ConversationDescriptor | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  if (pinned) {
    const hit = list.find((d) => d.kind === pinned);
    if (hit) return hit;
  }
  return list[0];
}

export const CONVERSATION_PIN_KEY = "redline.conversation.context";

/** One-shot: "open the dock on boot". Written by the migration below and
 *  consumed once by App — a persisted "the dock was up" bit is exactly the
 *  snapshot-and-restore layout state this app legislates against. */
const DOCK_SEED_KEY = "redline.conversation.dockSeed";

/** The chat room used to be a main surface of its own, and `redline.mainSurface`
 *  is persisted — so a user who quit inside a chat would come back to a surface
 *  this build no longer renders. Move them to the document with the dock open
 *  on the Companion instead, which is where that conversation lives now.
 *
 *  Idempotent by construction: it only ever fires on the literal stored value
 *  `"chat"`, and it rewrites that value. `"chat"` stays in the `MainSurface`
 *  union for one release so a downgrade still reads its own key. */
export function migrateChatSurfaceOnce(storage: Storage): void {
  try {
    if (JSON.parse(storage.getItem(MAIN_SURFACE_KEY) ?? "null") !== "chat")
      return;
    storage.setItem(MAIN_SURFACE_KEY, JSON.stringify("document"));
    storage.setItem(CONVERSATION_PIN_KEY, JSON.stringify("companion"));
    storage.setItem(DOCK_SEED_KEY, JSON.stringify(true));
  } catch {
    /* storage unavailable — defaults apply */
  }
}

/** Read-and-clear the boot seed. Consumed exactly once, so a later restart
 *  opens with the dock closed like any other. */
export function takeDockSeed(storage: Storage): boolean {
  try {
    const seeded = JSON.parse(storage.getItem(DOCK_SEED_KEY) ?? "false") === true;
    if (seeded) storage.removeItem(DOCK_SEED_KEY);
    return seeded;
  } catch {
    return false;
  }
}
