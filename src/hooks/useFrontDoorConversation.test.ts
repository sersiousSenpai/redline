// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { Companion } from "../types";
import { withChatProject } from "./useFrontDoorConversation";

describe("a chat's folder for the sidebar", () => {
  const row = (over: Partial<Companion> = {}): Companion => ({ companionId: "c1", title: "Chat", status: "active", createdAt: 1, updatedAt: 2, ...over });
  const store = (value: string | null) => ({ getItem: (key: string) => (key === "rl.chatProject.c1" ? value : null) });

  it("is the daemon's when it has one", () => {
    expect(withChatProject(row({ projectPath: "/a" }), store('{"path":"/b"}')).projectPath).toBe("/a");
  });
  it("else the one its door launch recorded before the room bound it", () => {
    expect(withChatProject(row(), store('{"path":"/b"}')).projectPath).toBe("/b");
  });
  it("else none: unreadable or absent records change nothing", () => {
    const r = row();
    expect(withChatProject(r, store(null))).toBe(r);
    expect(withChatProject(r, store("{nope"))).toBe(r);
    expect(withChatProject(r, null)).toBe(r);
  });
});
