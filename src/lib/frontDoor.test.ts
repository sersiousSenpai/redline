import { chatSubmitAction } from "./frontDoor";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fallbackDestination,
  projectNameFromPrompt,
  submitAction,
} from "./frontDoor";

// `launchStillLive`, `resolveLaunchProject` and `composePrompt` moved to
// `launch.test.ts` with the functions themselves — they are every door's
// property now, not this one's.

const key = (
  k: string,
  mods: Partial<Parameters<typeof submitAction>[0]> = {},
) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

describe("submitAction", () => {
  it("defaults to the original binding: ⏎ plans, ⌘⏎ drafts", () => {
    expect(submitAction(key("Enter"))).toBe("plan");
    expect(submitAction(key("Enter", { metaKey: true }))).toBe("drafter");
    expect(submitAction(key("Enter", { ctrlKey: true }))).toBe("drafter");
  });

  it("sends to chat on ⏎ and falls back to plan on ⌘⏎", () => {
    expect(submitAction(key("Enter"), "chat")).toBe("chat");
    expect(submitAction(key("Enter", { metaKey: true }), "chat")).toBe("plan");
    expect(submitAction(key("Enter", { ctrlKey: true }), "chat")).toBe("plan");
    // ⇧⏎ is still a newline on the third destination too.
    expect(submitAction(key("Enter", { shiftKey: true }), "chat")).toBe(
      "newline",
    );
    expect(submitAction(key("Enter", { isComposing: true }), "chat")).toBe(
      "ignore",
    );
  });

  it("follows the selected destination on a bare Enter", () => {
    expect(submitAction(key("Enter"), "plan")).toBe("plan");
    expect(submitAction(key("Enter"), "drafter")).toBe("drafter");
    expect(submitAction(key("Enter"), "run")).toBe("run");
  });

  it("sends a run on ⏎, plans on ⌘⏎, and keeps ⇧⏎ a newline", () => {
    expect(submitAction(key("Enter", { metaKey: true }), "run")).toBe("plan");
    expect(submitAction(key("Enter", { ctrlKey: true }), "run")).toBe("plan");
    expect(submitAction(key("Enter", { shiftKey: true }), "run")).toBe("newline");
    expect(submitAction(key("Enter", { isComposing: true }), "run")).toBe("ignore");
  });

  it("puts the OTHER destination on the modifier, whichever is selected", () => {
    // The point: both destinations stay one keystroke away in either mode.
    expect(submitAction(key("Enter", { metaKey: true }), "plan")).toBe(
      "drafter",
    );
    expect(submitAction(key("Enter", { metaKey: true }), "drafter")).toBe(
      "plan",
    );
    expect(submitAction(key("Enter", { ctrlKey: true }), "drafter")).toBe(
      "plan",
    );
  });

  it("keeps ⇧⏎ as a newline in every mode — the composer is multi-line", () => {
    expect(submitAction(key("Enter", { shiftKey: true }), "plan")).toBe(
      "newline",
    );
    expect(submitAction(key("Enter", { shiftKey: true }), "drafter")).toBe(
      "newline",
    );
  });

  it("lets the command modifier win over shift", () => {
    expect(submitAction(key("Enter", { metaKey: true, shiftKey: true }))).toBe(
      "drafter",
    );
  });

  it("ignores an Enter that is committing an IME candidate", () => {
    expect(submitAction(key("Enter", { isComposing: true }))).toBe("ignore");
    expect(
      submitAction(key("Enter", { isComposing: true, metaKey: true })),
    ).toBe("ignore");
  });

  it("ignores every other key", () => {
    for (const k of ["a", "Escape", "Tab", "ArrowDown", " ", "Backspace"]) {
      expect(submitAction(key(k))).toBe("ignore");
      expect(submitAction(key(k), "drafter")).toBe("ignore");
      expect(submitAction(key(k), "chat")).toBe("ignore");
    }
  });
});

describe("fallbackDestination", () => {
  it("reproduces the two-destination behavior exactly", () => {
    // The whole point of the rename: plan⇄drafter is untouched.
    expect(fallbackDestination("plan")).toBe("drafter");
    expect(fallbackDestination("drafter")).toBe("plan");
    expect(fallbackDestination(fallbackDestination("plan"))).toBe("plan");
  });

  it("gives chat a sane modifier — ⌘⏎ plans", () => {
    // "I've written it out, just build it" is the move that belongs one key
    // away from a half-formed thought.
    expect(fallbackDestination("chat")).toBe("plan");
  });

  it("puts plan one key away from a direct run", () => {
    // "Just do it" → the modifier is "show me first", never another run.
    expect(fallbackDestination("run")).toBe("plan");
  });
});

describe("projectNameFromPrompt", () => {
  it("drops the leading verb and articles", () => {
    expect(projectNameFromPrompt("add a dark mode toggle")).toBe(
      "dark-mode-toggle",
    );
    expect(
      projectNameFromPrompt("add a dark mode toggle to the settings page"),
    ).toBe("dark-mode-toggle");
  });

  it("keeps identity words in order", () => {
    expect(projectNameFromPrompt("Fix the login redirect bug")).toBe(
      "fix-login-redirect",
    );
  });

  it("de-punctuates", () => {
    expect(projectNameFromPrompt("Build a *CRM* (v2)!")).toBe("crm-v2");
  });

  it("caps the length and never ends in a dash", () => {
    const slug = projectNameFromPrompt(
      "supercalifragilistic expialidocious extravaganza",
    );
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back rather than proposing nothing", () => {
    expect(projectNameFromPrompt("")).toBe("new-project");
    expect(projectNameFromPrompt("!!! ???")).toBe("new-project");
    // All filler — the raw words are better than nothing.
    expect(projectNameFromPrompt("please make it for me")).toBe(
      "please-make-it",
    );
  });

  it("always emits a slug the Rust validator would accept", () => {
    for (const prompt of [
      "add a dark mode toggle",
      "Fix ../../etc/passwd handling",
      "build /usr/bin thing",
      "....",
      "a",
      "Ünïcödé nàmes",
    ]) {
      const slug = projectNameFromPrompt(prompt);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(slug).not.toContain("/");
      expect(slug).not.toBe("..");
    }
  });
});

// Source invariant — the front door already clears its composer on send; a
// prompt left on screen after it shipped reads as "not sent yet" and invites
// an accidental relaunch. Pinned here, house-style (cf. drafterCache.test.ts).
describe("front door clear-on-send wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("launchFromFrontDoor clears text and attachments after handing them off", () => {
    const fn = app.indexOf("const launchFromFrontDoor");
    expect(fn).toBeGreaterThan(-1);
    const launch = app.indexOf("launchPlan({", fn);
    const text = app.indexOf('setFrontDoorText("")', fn);
    const attachments = app.indexOf("setFrontDoorAttachments([])", fn);
    expect(launch).toBeGreaterThan(fn);
    expect(text).toBeGreaterThan(launch);
    expect(attachments).toBeGreaterThan(launch);
  });

  it("it hands over a composer restore, so a dead launch gives the sentence back", () => {
    const fn = app.indexOf("const launchFromFrontDoor");
    const end = app.indexOf("const drafterFromFrontDoor", fn);
    expect(app.slice(fn, end)).toContain('kind: "composer"');
  });

  it("the Drafter's launch owes nothing back — its document never left", () => {
    // Decision 3, pinned. A `composer` restore here would mean the Drafter had
    // taken the document away, which is the one thing it must never do.
    const fn = app.indexOf("const launchFromDrafter");
    const end = app.indexOf("const applyReadinessFix", fn);
    expect(fn).toBeGreaterThan(-1);
    const body = app.slice(fn, end);
    expect(body).toContain('restore: { kind: "none" }');
    expect(body).not.toContain("newDraft(");
    expect(body).not.toContain("setDrafterDraftId(");
  });

  it("the drafter hand-off clears it too", () => {
    const fn = app.indexOf("const drafterFromFrontDoor");
    expect(fn).toBeGreaterThan(-1);
    const text = app.indexOf('setFrontDoorText("")', fn);
    const attachments = app.indexOf("setFrontDoorAttachments([])", fn);
    expect(text).toBeGreaterThan(fn);
    expect(attachments).toBeGreaterThan(text);
  });

  // The other half of clear-on-send, and the half that actually produced the
  // report: clearing the composer is worthless if something writes the
  // sentence back into it. The pay-back is for the INVOLUNTARY case only —
  // the terminal died under the launch — so it has exactly one caller.
  it("the pay-back has exactly one caller: the terminal-death effect", () => {
    const calls = app.match(/repayPending\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // And it is the death effect, not something that merely looks like one.
    const call = app.indexOf("repayPending(");
    expect(app.slice(call, call + 120)).toContain("that terminal was closed");
  });

  it("dismissing or revealing the in-flight pill never refills the composer", () => {
    // "Start something else" was a deliberate dismissal wired to the
    // involuntary-death machinery: it handed the just-sent sentence back into
    // the now-empty composer, which is the bug reported as "the prompt comes
    // back and I have to delete it".
    const start = app.indexOf("onCancelPending={");
    const end = app.indexOf("onCreateProject=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wiring = app.slice(start, end);
    // Both halves of the pill live in this slice — neither pays anything back.
    expect(wiring).toContain("onRevealPending=");
    expect(wiring).not.toContain("repayPending(");
    expect(wiring).toContain("setPendingLaunch(null)");
  });

  it("displacing an older pending launch does not refill the composer either", () => {
    // The displaced plan keeps running in its own tile. Handing its sentence
    // back would drop a stale prompt on top of the one that just shipped.
    const fn = app.indexOf("const launchPlan = async (req:");
    const end = app.indexOf("const runDevServer", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(fn);
    expect(app.slice(fn, end)).not.toContain("repayPending(");
  });
});

// The card's chips reach a chat out of band (island plan step 6): read per
// send, deduped per conversation, never folded into the bubble's text.
describe("chat context wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("the room reads the pressed chips per send, and forgets a chat whose attachment was lost", () => {
    const start = app.indexOf("<ChatRoom");
    expect(start).toBeGreaterThan(-1);
    expect(app.indexOf("<ChatRoom", start + 1)).toBe(-1);
    const mount = app.slice(start, app.indexOf("/>", app.indexOf("onSeedConsumed=", start)));
    expect(mount).toContain('contextFor={async () => chatAttachment(chatId, await gatherContext("chat"))}');
    expect(mount).toContain("onContextLost={(why) => forgetSent(chatContextSent.current, chatId, why)}");
    expect(mount).toContain("seedContext={chatSeed?.companionId === chatId ? chatSeed.context : null}");
  });

  it("a chat started from the composer seeds what was attached as the sentence left", () => {
    const fn = app.indexOf("const chatFromFrontDoor");
    expect(fn).toBeGreaterThan(-1);
    const body = app.slice(fn, app.indexOf("const openChat", fn));
    expect(body).toContain('gatherContext("chat")');
    expect(body).toContain("chatAttachment(chat.companionId, blocks)");
    expect(body).toMatch(/setChatSeed\(\{[^}]*\bcontext \}\)/);
    // Out of band: the sentence the room sends is the one that was typed.
    expect(body).not.toContain("withContext(");
  });
});

// Responsiveness, Phase 2: typing touches only the component being typed in.
// The sentence was App-level persisted state with no debounce, so every
// keystroke re-rendered the whole shell and wrote localStorage synchronously.
// It is the composer's shared draft now; App may read and write it at the
// moments something is sent or handed back, and never subscribe to it.
describe("the composer's sentence stays out of App", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("App holds no state for it and never subscribes to it", () => {
    expect(app).not.toContain('"redline.frontDoor.text"');
    expect(app).not.toMatch(/const \[frontDoorText\b/);
    expect(app).not.toMatch(/\buseSharedDraft\(/);
    const stateKeys = [...app.matchAll(/\buse(?:PersistedState|State)(?:<[^()]*?>)?\(\s*([^,)]*)/g)].map((m) => m[1].trim());
    expect(stateKeys).not.toContain("FRONT_DOOR_TEXT_KEY");
  });

  it("hands neither composer a copy of it", () => {
    const door = app.slice(app.indexOf("const renderMonochatComposer"), app.indexOf("<MenuOverlayProvider"));
    expect(door).toContain("<FrontDoor");
    expect(door).not.toMatch(/\btext=\{/);
    expect(door).not.toContain("onTextChange");
    // The room is told where the sentence lives instead.
    const room = app.slice(app.indexOf("<ChatRoom"), app.indexOf("harness={", app.indexOf("<ChatRoom")));
    expect(room).toContain("composer={{ draftKey: FRONT_DOOR_TEXT_KEY,");
  });
});

// The door's caret and its two keys (10/10 front-door return): nothing that
// merely happens — a launch, a render, a plan arriving — opens the island,
// closes it, or moves the caret. Only a gesture does.
describe("the island never moves on its own", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("boots shut — resting on the empty plate, never opened over the work", () => {
    const init = app.slice(app.indexOf("const [frontDoorOpen, setFrontDoorOpen] = useState("), app.indexOf("const [doorCompact"));
    expect(init).toContain("return false;");
    expect(app).toMatch(/landing=\{plateAtRest && shellReady/);
    // The open door hides the native page; the compact card is cut out of it.
    const overlay = app.slice(app.indexOf("const browserOverlayActive ="), app.indexOf("const browserVisible ="));
    expect(overlay).toContain("frontDoorOpen ||");
    expect(overlay).not.toContain("doorCompact");
  });

  it("a hover never takes the caret; the door, or the chat it holds, takes it on every summons", () => {
    const door = app.slice(app.indexOf("const renderMonochatComposer"), app.indexOf("<MenuOverlayProvider"));
    expect(door).toMatch(/autoFocusOnShow=\{where === "door" \? frontDoorOpen : where === "chat" && roomChat\}/);
    // The type-to-start handoff is the door's alone.
    expect(door).toContain('focusNonce={where === "door" ? frontDoorFocus : 0}');
    expect(app).not.toContain("doorSummonedQuiet");
  });

  it("closes only on navigation the user started — never on a plan arriving", () => {
    const island = app.slice(app.indexOf("<MonochatIsland"), app.indexOf("</MonochatIsland>"));
    expect(island).toContain("surfaceKey={doorNavKey}");
    const nav = app.match(/const doorNavKey = `([^`]*)`;/);
    expect(nav, "the navigation key moved").not.toBeNull();
    expect(nav![1]).not.toContain("activeId");
    // The chips still reset on what is on screen, a plan arriving included.
    expect(app).toMatch(/const islandSurfaceKey = `[^`]*activeId[^`]*`;/);
  });

  it("a place asked for on the surface already showing is navigation too", () => {
    // A plan from the palette, a recent or a chat's receipt must not land
    // under a door left open over it.
    expect(app.match(/const doorNavKey = `([^`]*)`;/)![1]).toContain("${doorTrip}");
    const palette = app.slice(app.indexOf("openSession: (id) => {"), app.indexOf("toggleDock: toggleDoor,"));
    expect(palette.match(/tripDoor\(\);/g)).toHaveLength(3);
    expect(app.slice(app.indexOf("const openDoorRecent = (r: DoorRecent) => {"), app.indexOf("// Leaving the room carries"))).toContain("tripDoor();");
    expect(app).toMatch(/onOpenPlan=\{id => \{ tripDoor\(\); selectSurface\("document"\);/);
  });

  it("tells a screen reader when a launch is handed off and a plan arrives", () => {
    // The pill only shows "Working", and the plate quietly becomes the plan:
    // neither is ever read out. The island's status line says both.
    const island = app.slice(app.indexOf("<MonochatIsland"), app.indexOf("</MonochatIsland>"));
    expect(island).toContain("announce={doorNews}");
    const launch = app.slice(app.indexOf("const launchFromFrontDoor = async"), app.indexOf("const drafterFromFrontDoor = () =>"));
    expect(launch).toMatch(/setDoorCompact\(false\);\s*announceDoor\(/);
    expect(app).toContain("announceDoor(arrivalMessage(title));");
  });

  it("builds the in-flight launch once per launch, not per render", () => {
    const flight = app.slice(app.indexOf("const frontDoorFlight ="), app.indexOf("const frontDoorFlight =") + 400);
    expect(flight).toMatch(/^const frontDoorFlight = useMemo\(/);
    expect(flight).toContain("[pendingLaunch, runFlight]");
  });
});

// One chat, two places (10/10): the door's room at plate scale, the
// conversation dock's column once you leave the room. Carried, never closed.
describe("the room's chat is carried, never closed", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("moves one mounted chat between the room's slot and the dock's", () => {
    expect(app).toContain("const chatTarget = roomChat ? chatRegularSlot : chatDockSlot;");
    expect(app).toMatch(/<div ref=\{setChatDockSlot\}/);
    // One ChatRoom, portalled into the host that moves.
    expect(app.match(/<ChatRoom\b/g)).toHaveLength(1);
    expect(app).toContain("</ErrorBoundary></Suspense>, chatHost)}");
  });

  it("leaving the room, however it was left, carries the chat into the dock", () => {
    const carry = app.slice(app.indexOf("// Leaving the room carries its chat"), app.indexOf("const chatDocked ="));
    expect(carry).toContain("if (frontDoorOpen || !chatInRoom) return;");
    expect(carry).toContain('setConversationPin("companion");');
    expect(carry).toContain("openDock();");
    // Never over the surface's own conversation already in the dock, and
    // never as a pin on a surface with no dock to show it.
    expect(carry).toContain("if (!chatId || dockOpen || !dockScopeRef.current) return;");
    // Nor lost when the door shut while the chat was still being minted.
    expect(carry).toContain("}, [frontDoorOpen, chatInRoom]);");
  });

  it("putting the dock away hands the column back to the surface's own conversation", () => {
    const close = app.slice(app.indexOf("const closeDock = useCallback("), app.indexOf("const openDock = useCallback("));
    expect(close).toContain('setConversationPin(pin => (pin === "companion" ? null : pin));');
  });

  it("the Discuss pill opens the plan's own discussion, never a carried chat", () => {
    // The carry's pin outlives a home dock shut by walking to a plan; voice
    // stays first-class, so the pill drops it before it opens the column.
    const discuss = app.slice(app.indexOf("const openDiscussion = useCallback("), app.indexOf("}, [setConversationPin, openDock]);"));
    expect(discuss).toContain('setConversationPin(pin => (pin === "companion" ? null : pin));');
    expect(discuss).toContain("openDock();");
    expect(app).toMatch(/<DiscussPill\s+onClick=\{openDiscussion\}/);
  });
});

describe("chat composer submission", () => {
  const enter = { key: "Enter", metaKey: false, shiftKey: false };
  it("uses a one-shot mode and Cmd-Enter plans directly", () => {
    expect(chatSubmitAction(enter, "chat")).toBe("chat");
    expect(chatSubmitAction(enter, "plan")).toBe("plan");
    expect(chatSubmitAction({ ...enter, metaKey: true }, "chat")).toBe("plan");
    expect(chatSubmitAction({ ...enter, shiftKey: true }, "plan")).toBe("newline");
    expect(chatSubmitAction({ ...enter, isComposing: true }, "plan")).toBeNull();
  });
});
