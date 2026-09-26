// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";
import {
  dockScope, withDockOpen, toggleDockIn, onScopeChange,
  activeConversation,
  conversationContexts,
  conversationPose,
  kindPill,
  migrateChatSurfaceOnce,
  pillKind,
  takeDockSeed,
  type ConversationInputs,
} from "./conversationContext";

function inputs(over: Partial<ConversationInputs> = {}): ConversationInputs {
  return {
    voiceEnabled: true,
    chatEnabled: true,
    surface: "document",
    plateMode: "plan",
    activeId: "plan-1",
    planTitle: "Refactor the dock",
    drafterDraftId: null,
    drafterTitle: null,
    browseId: null,
    browseTitle: null,
    browsePill: null,
    cartId: "cart:regular",
    missionId: null,
    missionTitle: null,
    companionId: "cmp-1",
    companionTitle: null,
    ...over,
  };
}

const kinds = (i: ConversationInputs) =>
  conversationContexts(i).map((d) => d.kind);

describe("surface conversations", () => {
  it("Home alone owns the Companion", () => {
    expect(kinds(inputs({ plateMode: "door", activeId: null }))).toEqual(["companion"]);
    expect(kinds(inputs())).toEqual(["voice"]);
    expect(kinds(inputs({ surface: "drafter", drafterDraftId: "draft" }))).toEqual(["drafter"]);
    for (const surface of ["memory", "review", "servers", "runs", "unknown"]) expect(kinds(inputs({ surface }))).toEqual([]);
    expect(kinds(inputs({ plateMode: "file" }))).toEqual([]);
    expect(kinds(inputs({ plateMode: "door", chatEnabled: false }))).toEqual([]);
    expect(kinds(inputs({ voiceEnabled: false }))).toEqual([]);
  });
  it("keys plan voice to the session and chat to the Companion", () => {
    expect(conversationContexts(inputs())[0]).toMatchObject({ key: "plan-1", voiceCapable: true });
    expect(conversationContexts(inputs({ plateMode: "door", companionId: null }))[0].key).toBe("companion:");
  });
  it("browser conversations follow its remembered pill", () => {
    const list = conversationContexts(inputs({ surface: "browser", browseId: "tab", cartId: "cart:workspace", missionId: "mission", browsePill: "mission" }));
    expect(list.map(row => row.kind)).toEqual(["mission", "browse", "browselist"]);
    expect(list.find(row => row.kind === "browselist")?.id).toBe("cart:workspace");
    expect(activeConversation(list, "companion")?.kind).toBe("mission");
    expect(list.find(row => row.kind === "browselist")?.voiceCapable).toBe(false);
  });
  it("a stale pin cannot move a plan conversation", () => {
    expect(activeConversation(conversationContexts(inputs()), "companion")?.kind).toBe("voice");
    expect(activeConversation([], "companion")).toBeNull();
  });
});

describe("scope visibility", () => {
  it("opening the plan does not open the browser", () => {
    const opened = withDockOpen({}, "plan", true);
    expect(opened).toEqual({ plan: true });
    expect(toggleDockIn(opened, null, false)).toBe(opened);
    expect(toggleDockIn(opened, "browser", false)).toBe(opened);
    expect(toggleDockIn(opened, "browser", true)).toEqual({ plan: true, browser: true });
  });
  it("leaving Home closes only Home", () => {
    expect(onScopeChange({ home: true, plan: true }, "home", "browser")).toEqual({ home: false, plan: true });
    expect(dockScope("document", "door")).toBe("home");
    expect(dockScope("document", "plan")).toBe("plan");
    expect(dockScope("document", "file")).toBeNull();
    expect(dockScope("memory", "plan")).toBeNull();
  });
});

describe("migration", () => {
  beforeEach(() => localStorage.clear());
  it("moves legacy chat to Home, clearing its obsolete pin and seeding Home once", () => {
    localStorage.setItem("redline.mainSurface", JSON.stringify("chat"));
    localStorage.setItem("redline.conversation.context", JSON.stringify("companion"));
    migrateChatSurfaceOnce(localStorage);
    expect(localStorage.getItem("redline.mainSurface")).toBe('"document"');
    expect(localStorage.getItem("redline.conversation.context")).toBeNull();
    expect(takeDockSeed(localStorage) ? { home: true } : {}).toEqual({ home: true });
    expect(takeDockSeed(localStorage)).toBe(false);
    migrateChatSurfaceOnce(localStorage);
    expect(takeDockSeed(localStorage)).toBe(false);
  });
  it("clears a stale Companion pin on other surfaces without opening Home", () => {
    localStorage.setItem("redline.mainSurface", '"browser"');
    localStorage.setItem("redline.conversation.context", '"companion"');
    migrateChatSurfaceOnce(localStorage);
    expect(localStorage.getItem("redline.mainSurface")).toBe('"browser"');
    expect(localStorage.getItem("redline.conversation.context")).toBeNull();
    expect(takeDockSeed(localStorage)).toBe(false);
  });
});

describe("pill ↔ kind", () => {
  it("round-trips every browser pill", () => {
    for (const pill of ["page", "cart", "mission"] as const) {
      expect(kindPill(pillKind(pill))).toBe(pill);
    }
  });

  it("the kinds that are not the browser's map to no pill", () => {
    for (const kind of ["voice", "drafter", "companion"] as const) {
      expect(kindPill(kind)).toBeNull();
    }
    expect(pillKind(null)).toBeNull();
    expect(kindPill(null)).toBeNull();
  });
});

describe("conversationPose", () => {
  it("expands an open Home chat and docks a document conversation", () => {
    expect(conversationPose({ open: false, plateAtRest: true })).toBe("hidden");
    expect(conversationPose({ open: true, plateAtRest: true })).toBe("expanded");
    expect(conversationPose({ open: true, plateAtRest: false })).toBe("docked");
  });
});
