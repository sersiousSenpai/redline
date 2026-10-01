// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Companion } from "../types";

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
      if (request === generation.current) setChats(rows);
    }).catch(() => { /* History availability never blocks composing. */ });
  }, []);
  useEffect(() => {
    refreshChats();
    const subscription = listen("companion-retitled", refreshChats);
    return () => {
      generation.current++;
      void subscription.then(stop => stop()).catch(() => {});
    };
  }, [refreshChats]);
  return { chatId, setChatId, chats, refreshChats };
}
