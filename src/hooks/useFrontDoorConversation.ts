// SPDX-License-Identifier: Apache-2.0
import { dropListener } from "../lib/dropListener";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Companion } from "../types";

/** Said on the window when a chat's row changes in a way no backend event
 *  announces — its project bound (`companion_set_project`): the sidebar's
 *  copy of the list reads again, so the chat joins its project's Chats. */
export const CHATS_CHANGED_EVENT = "redline:chats-changed";

/** A chat's folder: the daemon's, else the one its door launch recorded
 *  (`rl.chatProject.<id>`) before the room ever mounted to bind it. */
export function withChatProject(chat: Companion, storage: Pick<Storage, "getItem"> | null): Companion {
  if (chat.projectPath || !storage) return chat;
  try {
    const prior = JSON.parse(storage.getItem(`rl.chatProject.${chat.companionId}`) ?? "null") as { path?: unknown } | null;
    return typeof prior?.path === "string" && prior.path ? { ...chat, projectPath: prior.path } : chat;
  } catch {
    return chat;
  }
}

/** History is an explicit destination. Loading or refreshing it must never
 * choose what appears at the front door. An active exchange survives tucking
 * the door away, while a fresh app session starts at the composer. */
export function useFrontDoorConversation() {
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<Companion[]>([]);
  const generation = useRef(0);
  const refreshChats = useCallback(() => {
    const request = ++generation.current;
    void invoke<Companion[]>("companion_list").then(rows => {
      let storage: Storage | null = null;
      try { storage = localStorage; } catch { /* no fallback folder */ }
      if (request === generation.current) setChats(Array.isArray(rows) ? rows.map((row) => withChatProject(row, storage)) : []);
    }).catch(() => { /* History availability never blocks composing. */ });
  }, []);
  useEffect(() => {
    refreshChats();
    const subscription = listen("companion-retitled", refreshChats);
    // A reply moves a chat up its group; a bound project moves it into one.
    const done = listen("companion-done", refreshChats);
    window.addEventListener(CHATS_CHANGED_EVENT, refreshChats);
    return () => {
      generation.current++;
      void subscription.then(dropListener).catch(() => {});
      void done.then(dropListener).catch(() => {});
      window.removeEventListener(CHATS_CHANGED_EVENT, refreshChats);
    };
  }, [refreshChats]);
  return { chatId, setChatId, chats, refreshChats };
}
