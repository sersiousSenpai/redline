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
  it("⏎ and ⌘⏎ both launch the plan on the plan route — never a Draft", () => {
    expect(submitAction(key("Enter"))).toBe("plan");
    expect(submitAction(key("Enter", { metaKey: true }))).toBe("plan");
    expect(submitAction(key("Enter", { ctrlKey: true }))).toBe("plan");
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
  });

  it("sends a chat on ⏎, plans on ⌘⏎, and keeps ⇧⏎ a newline", () => {
    expect(submitAction(key("Enter", { metaKey: true }), "chat")).toBe("plan");
    expect(submitAction(key("Enter", { ctrlKey: true }), "chat")).toBe("plan");
    expect(submitAction(key("Enter", { shiftKey: true }), "chat")).toBe("newline");
    expect(submitAction(key("Enter", { isComposing: true }), "chat")).toBe("ignore");
  });

  it("puts the plan on the modifier, whichever is selected", () => {
    // The re-walk: ⌘⏎ on the plan route opened a Draft and swapped the
    // project chip. The build is one keystroke away from every route.
    expect(submitAction(key("Enter", { metaKey: true }), "plan")).toBe(
      "plan",
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
      "plan",
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
  it("is the plan from every route, the plan route included", () => {
    expect(fallbackDestination("plan")).toBe("plan");
    expect(fallbackDestination("drafter")).toBe("plan");
    expect(fallbackDestination("browser")).toBe("plan");
  });

  it("gives chat a sane modifier — ⌘⏎ plans", () => {
    // "I've written it out, just build it" is the move that belongs one key
    // away from a half-formed thought.
    expect(fallbackDestination("chat")).toBe("plan");
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
    // W6: App mounts the room through the chat pane's `CompanionRoom`.
    const start = app.indexOf("<CompanionRoom");
    expect(start).toBeGreaterThan(-1);
    expect(app.indexOf("<CompanionRoom", start + 1)).toBe(-1);
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
    const room = app.slice(app.indexOf("<CompanionRoom"), app.indexOf("harness={", app.indexOf("<CompanionRoom")));
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

  it("the island owns the door's caret on a summons, and a chat it holds takes it every time", () => {
    const door = app.slice(app.indexOf("const renderMonochatComposer"), app.indexOf("<MenuOverlayProvider"));
    // The door's composer never focuses itself: every summons puts the caret
    // in (D27 took the pill's quiet one) — the island decides, in one place.
    expect(door).toContain('autoFocusOnShow={where === "chat" && !!chatPane}');
    const island = readFileSync(join(process.cwd(), "src/components/MonochatIsland.tsx"), "utf8");
    expect(island).toMatch(/const field = composerIn\(body\.current\);\s*if \(field\) \{\s*field\.focus\(/);
    expect(island).not.toContain('"quiet"');
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
    const palette = app.slice(app.indexOf("openSession: (id) => {"), app.indexOf("toggleDock: toggleTalk,"));
    expect(palette.match(/tripDoor\(\);/g)).toHaveLength(3);
    expect(app.slice(app.indexOf("const openDoorRecent = (r: DoorRecent) => {"), app.indexOf("// Leaving the room carries"))).toContain("tripDoor();");
    // W1: the session is selected before "document", which acts on the
    // selected set (openSurface("document") brings that set's Plan tab).
    expect(app).toMatch(/onOpenPlan=\{id => \{ tripDoor\(\); selectSessions\(\); setActiveId\(id\); selectSurface\("document"\);/);
  });

  it("tells a screen reader when a launch is handed off and a plan arrives", () => {
    // The plate quietly becomes the plan, which is never read out: the
    // island's status line says it.
    const island = app.slice(app.indexOf("<MonochatIsland"), app.indexOf("</MonochatIsland>"));
    expect(island).toContain("announce={doorNews}");
    const launch = app.slice(app.indexOf("const launchFromFrontDoor = async"), app.indexOf("const drafterFromFrontDoor = () =>"));
    expect(launch).toMatch(/noteDoorLaunchTab\(r\.launchId\);\s*announceDoor\(/);
    expect(app).toContain("announceDoor(arrivalMessage(title, revision));");
    // A new version of the plan already selected says so, wherever it lands.
    expect(app).toContain("const revision = payload.sessionId === activeId;\n        const focus = arrivalFocus({");
  });

  it("builds the in-flight launch once per launch, not per render", () => {
    const flight = app.slice(app.indexOf("const frontDoorFlight ="), app.indexOf("const frontDoorFlight =") + 400);
    expect(flight).toMatch(/^const frontDoorFlight = useMemo\(/);
    expect(flight).toContain("[pendingLaunch]");
  });
});

// One chat, two places (10/10): the door's room at plate scale, the
// conversation dock's column once you leave the room. Carried, never closed.
describe("a companion chat is a pane, and the one room follows it", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("the ChatRoom body is mounted once and shown by the pane on screen, else the dock's column", () => {
    // The pane's SingletonSlot takes the host; the dock's column gets it
    // only while no pane shows it, and never pulls it out of a pane.
    expect(app).toContain("const chatPane = useWorkbench(wb, selectVisibleCompanion);");
    expect(app).toContain("const chatTarget = chatPane ? null : chatDockSlot;");
    const move = app.slice(app.indexOf("const chatTarget = chatPane"), app.indexOf("}, [chatTarget, chatHost]);"));
    expect(move).toContain("if (!target) return;");
    // A moved scroller starts at its top: the thread is put back where it was.
    expect(move).toContain('const thread = chatHost.querySelector<HTMLElement>("[data-chat-messages]");');
    expect(move).toContain("kept.thread.scrollTop = kept.end ? kept.thread.scrollHeight : kept.top;");
    expect(app).toMatch(/<div ref=\{setChatDockSlot\}/);
    // W6: the room's element is the chat pane module's; App portals it into
    // the host exactly once, and a companion pane shows the host's slot.
    const chat = readFileSync(join(process.cwd(), "src/workbench/panes/chat.tsx"), "utf8");
    expect(app.match(/<ChatRoom\b/g)).toBe(null);
    expect(chat.match(/<ChatRoom\b/g)).toHaveLength(1);
    expect(app.match(/<CompanionRoom\b/g)).toHaveLength(1);
    expect(app).toMatch(/\{chatId && createPortal\(\s*<CompanionRoom\b[\s\S]*?\/>\s*, chatHost\)\}/);
    expect(app).toContain("<CompanionPane host={chatHost} ctx={ctx} />");
    expect(chat).toContain('<SingletonSlot host={host} name="conversation" active={ctx.visible} />');
    // The pane on screen is the open conversation.
    expect(app).toContain("if (chatPane && chatPane !== chatId) setChatId(chatPane);");
  });

  it("the island never holds a chat: no room slot, no New, the door's own composer always", () => {
    expect(app).not.toContain("chatInRoom");
    expect(app).not.toContain("roomChat");
    expect(app).not.toContain("onNewChat=");
    expect(app).not.toContain("rl-frontdoor-chat-slot");
    expect(app).toMatch(/<MonochatIsland[\s\S]*?>\s*\{renderMonochatComposer\("door"\)\}\s*<\/MonochatIsland>/);
  });

  it("the door's Chat destination and an opened chat become a pane in place, or come forward", () => {
    const mint = app.slice(app.indexOf("const chatFromFrontDoor = async () => {"), app.indexOf("const openChat = (id: string"));
    expect(mint).toContain('if (!convertDoorPane({ kind: "chat", data: { source: "companion", companionId: chat.companionId } })) wb.dispatch({ type: "openSurface", kind: "chat", data: { source: "companion", companionId: chat.companionId } });');
    expect(mint).toContain("setFrontDoorOpen(false);");
    const open = app.slice(app.indexOf("const openChat = (id: string"), app.indexOf("const startChat = useCallback("));
    expect(open).not.toBe("");
    // Picked in a door, the door becomes it; from a sidebar row (D29) it is
    // a tab of its own in the set on screen.
    expect(open).toContain("else if (!convertDoorPane(pane)) wb.dispatch({ type: \"openSurface\", kind: \"chat\", data: pane.data });");
    expect(open).toContain('if (opts.inPlace === false) wb.dispatch({ type: "openInActive", pane });');
    expect(open).toContain("setFrontDoorOpen(false);");
    expect(open).not.toContain("setFrontDoorOpen(true);");
  });

  it("putting the dock away hands the column back to the surface's own conversation", () => {
    const close = app.slice(app.indexOf("const closeDock = useCallback("), app.indexOf("const openDock = useCallback("));
    expect(close).toContain('setConversationPin(pin => (pin === "companion" ? null : pin));');
  });

  it("opening the plan's discussion opens its own voice, never a carried chat", () => {
    // Voice stays first-class: a companion pin is dropped before Talk opens
    // (the Agent pane's Talk; the Discuss pill went with W4).
    const discuss = app.slice(app.indexOf("const openDiscussion = useCallback("), app.indexOf("}, [setConversationPin, openDock]);"));
    expect(discuss).toContain('setConversationPin(pin => (pin === "companion" ? null : pin));');
    expect(discuss).toContain("openDock();");
    expect(app).not.toContain("<DiscussPill");
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
