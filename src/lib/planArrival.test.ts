// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { arrivalFocus, arrivalMessage, isWritingKey, ownDoorLaunch, writingNow, WRITING_MS, type ArrivalState, type DoorAtArrival } from "./planArrival";

const at = (over: Partial<ArrivalState>): ArrivalState => ({
  activeId: null,
  sessionId: "B",
  mainSurface: "document",
  plateMode: "door",
  ...over,
});

describe("arrivalFocus", () => {
  it("focuses from the Front Door — the plate becomes the plan", () => {
    expect(arrivalFocus(at({}))).toBe("focus");
  });

  it("flashes while you are reading another plan", () => {
    expect(arrivalFocus(at({ activeId: "A", plateMode: "plan" }))).toBe("flash");
  });

  it("focuses when the same session's plan re-arrives — it's the answer you waited for", () => {
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan" }))).toBe("focus");
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan", viewedVersion: null }))).toBe("focus");
  });

  it("flashes a new version while you look back at an older one", () => {
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan", viewedVersion: 2 }))).toBe("flash");
    // Off the plate there is no older version on screen to keep.
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan", viewedVersion: 2, mainSurface: "browser" }))).toBe("focus");
  });

  it("lands a new version of the selected plan in place, even mid-sentence: nothing else moves", () => {
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan", writing: true }))).toBe("focus");
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan", writing: true, mainSurface: "drafter" }))).toBe("focus");
  });

  it("focuses the selection on a masked surface (the caller leaves the surface alone)", () => {
    for (const mainSurface of ["browser", "memory", "runs"] as const) {
      expect(arrivalFocus(at({ activeId: "A", plateMode: "plan", mainSurface }))).toBe("focus");
    }
  });

  it("flashes while a file, not a plan, is on the plate — reading is reading", () => {
    expect(arrivalFocus(at({ activeId: "A", plateMode: "file" }))).toBe("flash");
    expect(arrivalFocus(at({ activeId: "B", plateMode: "file" }))).toBe("flash");
    expect(arrivalFocus(at({ plateMode: "file" }))).toBe("flash");
  });

  it("flashes while you are writing, wherever you are", () => {
    expect(arrivalFocus(at({ writing: true }))).toBe("flash");
    expect(arrivalFocus(at({ writing: true, mainSurface: "browser" }))).toBe("flash");
    expect(arrivalFocus(at({ writing: true, activeId: "A", plateMode: "plan", mainSurface: "drafter" }))).toBe("flash");
  });
});

describe("your own launch from the door", () => {
  // The ⏎ itself is the last key typed: minutes before the plan lands.
  const NOW = 600_000;
  const door: DoorAtArrival = { open: true, showing: "L1", draft: "", attachments: 0, typedAt: NOW - 120_000 };
  const own = (d: DoorAtArrival, launchId: string | null) => ownDoorLaunch(d, launchId, NOW);

  it("hands off into the plan: ⏎ was the gesture, wherever the door was opened", () => {
    // The open door always counts as writing; a handoff wins over that.
    expect(arrivalFocus(at({ writing: true, ownDoorLaunch: true }))).toBe("handoff");
    expect(arrivalFocus(at({ writing: true, ownDoorLaunch: true, activeId: "A", plateMode: "plan" }))).toBe("handoff");
    expect(arrivalFocus(at({ writing: true, ownDoorLaunch: true, mainSurface: "browser" }))).toBe("handoff");
  });

  it("is the launch the open door is showing, with nothing new begun there", () => {
    expect(own(door, "L1")).toBe(true);
    // Someone else's plan, or one with no launch behind it, still flashes.
    expect(own(door, "L2")).toBe(false);
    expect(own(door, null)).toBe(false);
    expect(own({ ...door, showing: null }, null)).toBe(false);
    // A door closed since, or one where a new draft was begun, keeps to the
    // flash: the door stays, and so does the sentence.
    expect(own({ ...door, open: false }, "L1")).toBe(false);
    expect(own({ ...door, draft: "And then the docs" }, "L1")).toBe(false);
    expect(own({ ...door, draft: "  " }, "L1")).toBe(true);
    expect(own({ ...door, attachments: 1 }, "L1")).toBe(false);
  });

  it("is never a door someone is typing in, even with its box empty again", () => {
    // A sentence typed and cleared, or a word still in the input method's
    // hands, is composing (R12): the door stays and the plan flashes.
    expect(own({ ...door, typedAt: NOW - 800 }, "L1")).toBe(false);
    expect(own({ ...door, typedAt: NOW - WRITING_MS + 1 }, "L1")).toBe(false);
    expect(own({ ...door, typedAt: NOW - WRITING_MS }, "L1")).toBe(true);
  });
});

describe("writingNow", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const mount = (html: string) => {
    document.body.innerHTML = html;
    return document.body.querySelector<HTMLElement>("[data-focus]")!;
  };
  const NOW = 100_000;

  it("counts a keystroke for five seconds", () => {
    expect(writingNow(null, NOW - 100, NOW)).toBe(true);
    expect(writingNow(null, NOW - WRITING_MS + 1, NOW)).toBe(true);
    expect(writingNow(null, NOW - WRITING_MS, NOW)).toBe(false);
  });

  it("counts the caret anywhere in the door or the compact card, typed in or not", () => {
    expect(writingNow(mount('<div class="rl-frontdoor-focus"><textarea data-focus></textarea></div>'), 0, NOW)).toBe(true);
    expect(writingNow(mount('<div class="rl-frontdoor-focus"><button data-focus>Plans</button></div>'), 0, NOW)).toBe(true);
    expect(writingNow(mount('<div class="rl-monochat-float"><textarea data-focus></textarea></div>'), 0, NOW)).toBe(true);
  });

  it("counts another text field only while it holds words", () => {
    const field = mount('<input data-focus>') as HTMLInputElement;
    expect(writingNow(field, 0, NOW)).toBe(false);
    field.value = "  ";
    expect(writingNow(field, 0, NOW)).toBe(false);
    field.value = "auth";
    expect(writingNow(field, 0, NOW)).toBe(true);
    const editor = mount('<div contenteditable="true" data-focus>A sentence</div>');
    Object.defineProperty(editor, "isContentEditable", { value: true });
    expect(writingNow(editor, 0, NOW)).toBe(true);
  });

  it("never counts the terminal, or a page with nothing to write in", () => {
    expect(writingNow(mount('<div class="xterm"><textarea class="xterm-helper-textarea" data-focus>ls</textarea></div>'), 0, NOW)).toBe(false);
    expect(writingNow(mount('<button data-focus>Approve</button>'), 0, NOW)).toBe(false);
    expect(writingNow(document.body, 0, NOW)).toBe(false);
  });

  it("starts the clock only for keys aimed at a text field outside the terminal", () => {
    expect(isWritingKey(mount("<textarea data-focus></textarea>"))).toBe(true);
    expect(isWritingKey(mount('<div class="xterm"><textarea data-focus></textarea></div>'))).toBe(false);
    expect(isWritingKey(mount("<button data-focus></button>"))).toBe(false);
    expect(isWritingKey(window)).toBe(false);
  });
});

describe("arrivalMessage", () => {
  it("names the plan and never says intercepted", () => {
    expect(arrivalMessage("Auth rewrite")).toBe("New plan · Auth rewrite");
    expect(arrivalMessage(null)).toBe("New plan");
    expect(arrivalMessage("  ")).toBe("New plan");
  });

  it("calls a revision of the plan you are reading a new version", () => {
    expect(arrivalMessage("Auth rewrite", true)).toBe("New version · Auth rewrite");
    expect(arrivalMessage(null, true)).toBe("New version");
  });
});
