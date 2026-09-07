// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";
import {
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
    linkedId: null,
    missionId: null,
    missionTitle: null,
    companionId: "cmp-1",
    companionTitle: null,
    ...over,
  };
}

const kinds = (i: ConversationInputs) =>
  conversationContexts(i).map((d) => d.kind);

describe("conversationContexts", () => {
  it("document/plan → the plan's voice thread, then the Companion", () => {
    expect(kinds(inputs())).toEqual(["voice", "companion"]);
  });

  it("a plan's voice key is its bare session id (voice.rs keys on shape)", () => {
    const [voice] = conversationContexts(inputs());
    expect(voice.key).toBe("plan-1");
    expect(voice.id).toBe("plan-1");
    expect(voice.voiceCapable).toBe(true);
  });

  it("the door and the file viewer have no plan conversation", () => {
    expect(kinds(inputs({ plateMode: "door", activeId: null }))).toEqual([
      "companion",
    ]);
    expect(kinds(inputs({ plateMode: "file" }))).toEqual(["companion"]);
  });

  it("drafter → the draft's voice thread, keyed drafter:<id>", () => {
    const list = conversationContexts(
      inputs({ surface: "drafter", drafterDraftId: "d7" }),
    );
    expect(list.map((d) => d.kind)).toEqual(["drafter", "companion"]);
    expect(list[0].key).toBe("drafter:d7");
    expect(list[0].voiceCapable).toBe(true);
  });

  it("memory, review, servers and runs carry the Companion alone", () => {
    // Memory is in this list on purpose: its Ask thread is a singleton, so its
    // one mount is the first tab of the memory surface, not a dock context.
    for (const surface of ["memory", "review", "servers", "runs"]) {
      expect(kinds(inputs({ surface }))).toEqual(["companion"]);
    }
  });

  it("a surface this build cannot render degrades to the Companion", () => {
    expect(kinds(inputs({ surface: "some-future-pack-surface" }))).toEqual([
      "companion",
    ]);
  });

  it("browser lists only the conversations that exist", () => {
    // The working list rides with the page: it is the tab's own artifact, and
    // it has always shared the browser's one right column with the chat.
    expect(kinds(inputs({ surface: "browser", browseId: "b1" }))).toEqual([
      "browse",
      "browselist",
      "companion",
    ]);
    expect(
      kinds(
        inputs({
          surface: "browser",
          browseId: "b1",
          linkedId: "l1",
          missionId: "m1",
        }),
      ),
    ).toEqual(["browse", "browselist", "linked", "mission", "companion"]);
  });

  it("no tab → no page conversation and no list", () => {
    expect(kinds(inputs({ surface: "browser" }))).toEqual(["companion"]);
  });

  it("the tab's remembered pill leads, without hiding the others", () => {
    const list = conversationContexts(
      inputs({
        surface: "browser",
        browseId: "b1",
        linkedId: "l1",
        missionId: "m1",
        browsePill: "mission",
      }),
    );
    expect(list.map((d) => d.kind)).toEqual([
      "mission",
      "browse",
      "browselist",
      "linked",
      "companion",
    ]);
  });

  it("the tab's list leads when that is where the user left the tab", () => {
    expect(
      kinds(
        inputs({
          surface: "browser",
          browseId: "b1",
          linkedId: "l1",
          browsePill: "list",
        }),
      ),
    ).toEqual(["browselist", "browse", "linked", "companion"]);
  });

  it("the working list is never voice-capable", () => {
    const list = conversationContexts(
      inputs({ surface: "browser", browseId: "b1" }),
    );
    expect(list.find((d) => d.kind === "browselist")?.voiceCapable).toBe(false);
  });

  it("the Companion never rides ahead of the surface's own conversation", () => {
    const list = conversationContexts(inputs({ surface: "browser", browseId: "b1" }));
    expect(list[list.length - 1].kind).toBe("companion");
  });

  it("the Companion is present before any conversation is chosen", () => {
    // It has to be: a surface with no conversation of its own is exactly where
    // you need the one that spans them all, and that is also the state in
    // which no chat exists yet.
    expect(kinds(inputs({ companionId: null }))).toEqual(["voice", "companion"]);
    expect(kinds(inputs({ surface: "review", companionId: null }))).toEqual([
      "companion",
    ]);
    const [companion] = conversationContexts(
      inputs({ surface: "review", companionId: null }),
    );
    expect(companion.id).toBe("");
    expect(companion.key).toBe("companion:");
  });

  it("the Companion's key carries its id, so the room remounts per chat", () => {
    const [c] = conversationContexts(
      inputs({ surface: "review", companionId: "cmp-9" }),
    );
    expect(c.key).toBe("companion:cmp-9");
  });
});

describe("the manifest's surface toggles", () => {
  it("voice off removes the plan and draft conversations", () => {
    expect(kinds(inputs({ voiceEnabled: false }))).toEqual(["companion"]);
    expect(
      kinds(
        inputs({
          voiceEnabled: false,
          surface: "drafter",
          drafterDraftId: "d1",
        }),
      ),
    ).toEqual(["companion"]);
  });

  it("chat off removes the Companion", () => {
    expect(kinds(inputs({ chatEnabled: false }))).toEqual(["voice"]);
    expect(kinds(inputs({ chatEnabled: false, surface: "review" }))).toEqual([]);
  });

  it("chat on with voice off still reaches its conversation", () => {
    // The dock is not the voice surface wearing a new name: a workspace can
    // keep one and drop the other.
    expect(kinds(inputs({ voiceEnabled: false, chatEnabled: true }))).toEqual([
      "companion",
    ]);
  });

  it("the browser and memory conversations are not the voice surface", () => {
    expect(
      kinds(
        inputs({ voiceEnabled: false, surface: "browser", browseId: "b1" }),
      ),
    ).toEqual(["browse", "browselist", "companion"]);
    expect(kinds(inputs({ voiceEnabled: false, surface: "memory" }))).toEqual([
      "companion",
    ]);
  });
});

describe("activeConversation", () => {
  const list = conversationContexts(inputs());

  it("nothing available → no conversation", () => {
    expect(activeConversation([], "companion")).toBeNull();
  });

  it("one available → the pin cannot override what is on screen", () => {
    const only = conversationContexts(inputs({ surface: "review" })).slice(0, 1);
    expect(activeConversation(only, "voice")?.kind).toBe("companion");
  });

  it("a genuine tie honors the pin", () => {
    expect(activeConversation(list, "companion")?.kind).toBe("companion");
    expect(activeConversation(list, "voice")?.kind).toBe("voice");
  });

  it("a pin naming a kind this surface lacks falls back to the leader", () => {
    expect(activeConversation(list, "mission")?.kind).toBe("voice");
  });

  it("no pin → the surface's own conversation leads", () => {
    expect(activeConversation(list, null)?.kind).toBe("voice");
  });
});

describe("migrateChatSurfaceOnce", () => {
  beforeEach(() => localStorage.clear());

  it("moves a user who quit inside the chat surface into the dock", () => {
    localStorage.setItem("redline.mainSurface", JSON.stringify("chat"));
    migrateChatSurfaceOnce(localStorage);
    expect(localStorage.getItem("redline.mainSurface")).toBe('"document"');
    expect(localStorage.getItem("redline.conversation.context")).toBe(
      '"companion"',
    );
    expect(takeDockSeed(localStorage)).toBe(true);
  });

  it("the boot seed is consumed exactly once", () => {
    localStorage.setItem("redline.mainSurface", JSON.stringify("chat"));
    migrateChatSurfaceOnce(localStorage);
    expect(takeDockSeed(localStorage)).toBe(true);
    expect(takeDockSeed(localStorage)).toBe(false);
  });

  it("leaves every other surface — and a second run — alone", () => {
    for (const surface of ["document", "browser", "review"]) {
      localStorage.clear();
      localStorage.setItem("redline.mainSurface", JSON.stringify(surface));
      migrateChatSurfaceOnce(localStorage);
      expect(localStorage.getItem("redline.mainSurface")).toBe(
        JSON.stringify(surface),
      );
      expect(takeDockSeed(localStorage)).toBe(false);
    }
    // Idempotent: the rewritten value is no longer "chat".
    localStorage.setItem("redline.mainSurface", JSON.stringify("chat"));
    migrateChatSurfaceOnce(localStorage);
    takeDockSeed(localStorage);
    migrateChatSurfaceOnce(localStorage);
    expect(takeDockSeed(localStorage)).toBe(false);
  });

  it("a fresh install has nothing to migrate", () => {
    migrateChatSurfaceOnce(localStorage);
    expect(localStorage.getItem("redline.mainSurface")).toBeNull();
    expect(takeDockSeed(localStorage)).toBe(false);
  });
});

describe("pill ↔ kind", () => {
  it("round-trips every browser pill", () => {
    for (const pill of ["page", "list", "linked", "mission"] as const) {
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
  const at = (over: Parameters<typeof conversationPose>[0]) =>
    conversationPose(over);

  it("a closed dock shows nothing, however it was left", () => {
    expect(
      at({ open: false, expandedKind: "companion", plateAtRest: true }),
    ).toBe("hidden");
  });

  it("the column is the default — the conversation follows you", () => {
    expect(at({ open: true, expandedKind: null, plateAtRest: true })).toBe(
      "docked",
    );
  });

  it("the room needs the plate at rest AND the user to have asked", () => {
    expect(
      at({ open: true, expandedKind: "companion", plateAtRest: true }),
    ).toBe("expanded");
    // A plan, a draft or the browser is on the plate: the conversation goes
    // beside it, never over it.
    expect(
      at({ open: true, expandedKind: "companion", plateAtRest: false }),
    ).toBe("docked");
  });

  it("only a conversation with no document of its own can be a room", () => {
    // The plan's and the draft's threads are ABOUT the thing they sit beside,
    // and the browser's are about a page whose webview is the plate itself.
    for (const kind of ["voice", "drafter", "browse", "linked", "mission"] as const) {
      expect(at({ open: true, expandedKind: kind, plateAtRest: true })).toBe(
        "docked",
      );
    }
  });
});
