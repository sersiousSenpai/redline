// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import {
  hydrate,
  reduceChatWorld,
  type ChatEvent,
  type ChatTab,
  type ChatWorld,
  type WorkspaceKey,
} from "../lib/browserChat/scope";
import { LINKED_MODE_KEY, SHARED_CHATS_KEY, readSharedChats } from "../lib/browseChatState";

/** What BrowserPane owns and the chat only reads: its tabs, the tab on
 *  screen and the workspace. They drive the native webviews, so they stay
 *  the pane's. */
export interface ChatView {
  workspace: WorkspaceKey;
  tabs: readonly ChatTab[];
  activeId: string;
}

/** The rest of the world: the anchored conversation, linked mode, the
 *  momentary flip and each workspace's shared thread. Only the reducer
 *  writes it. */
type ChatSlice = Pick<ChatWorld, "discussionId" | "linkedMode" | "flipFor" | "shared">;

const sliceOf = ({ discussionId, linkedMode, flipFor, shared }: ChatWorld): ChatSlice => ({ discussionId, linkedMode, flipFor, shared });
const sameSlice = (a: ChatSlice, b: ChatSlice) =>
  a.discussionId === b.discussionId && a.linkedMode === b.linkedMode && a.flipFor === b.flipFor && a.shared === b.shared;

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the slice still works in memory */
  }
}

/** The page chat's scope as BrowserPane holds it: the structure layer's
 *  `ChatWorld`, assembled at render from the pane's view plus one slice.
 *  Every gesture that moves the conversation is a `dispatch`, so "mode wins"
 *  and "a shared chat exists before anything renders it" (BC-3, BC-9) hold in
 *  the same step as the gesture, never in an effect after a render.
 *
 *  `dispatch` reduces from the world as of the last dispatch rather than the
 *  last render, so two gestures in one handler (open a tab, then return to
 *  its own chat) see each other, and it returns that world. The pane still
 *  makes each gesture's tab and page changes itself; the reducer's copy of
 *  them only has to agree, and the next render takes the pane's.
 *
 *  Linked mode and the shared threads persist; the anchor and the flip never
 *  do (BC-2, BC-3). */
export function useChatWorld(view: ChatView, mint: () => string) {
  const [slice, setSlice] = useState<ChatSlice>(() =>
    sliceOf(
      hydrate(
        {
          ...view,
          discussionId: view.activeId,
          linkedMode: readStored(LINKED_MODE_KEY) === true,
          flipFor: null,
          shared: readSharedChats(readStored(SHARED_CHATS_KEY)),
        },
        mint,
      ),
    ),
  );
  const world: ChatWorld = { ...view, ...slice };
  const latest = useRef(world);
  latest.current = world;
  const dispatch = useCallback(
    (event: ChatEvent): ChatWorld => {
      const next = reduceChatWorld(latest.current, event, mint);
      latest.current = next;
      const nextSlice = sliceOf(next);
      setSlice((prev) => (sameSlice(prev, nextSlice) ? prev : nextSlice));
      return next;
    },
    [mint],
  );
  useEffect(() => writeStored(LINKED_MODE_KEY, slice.linkedMode), [slice.linkedMode]);
  useEffect(() => writeStored(SHARED_CHATS_KEY, slice.shared), [slice.shared]);
  return { world, dispatch };
}
