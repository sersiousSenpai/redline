// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_KEYS,
  DOUBLE_TAP_MS,
  HOLD_MS,
  HOTKEY_IDLE,
  VoiceHotkey,
  loadHoldKey,
  saveHoldKey,
  soloPress,
  stepHotkey,
  type HoldKey,
  type HotkeyEvent,
  type HotkeyState,
} from "./voiceHotkey";

/** Run events through the machine: the effects, and the swallowed ones. */
function run(events: HotkeyEvent[], from: HotkeyState = HOTKEY_IDLE) {
  let state = from;
  const effects: string[] = [];
  const swallowed: string[] = [];
  for (const e of events) {
    const step = stepHotkey(state, e);
    state = step.state;
    if (step.effect) effects.push(step.effect.type === "start" ? `start:${step.effect.mode}` : step.effect.type);
    if (step.swallow) swallowed.push(e.type);
  }
  return { state, effects, swallowed };
}
const down = (at: number, solo = true): HotkeyEvent => ({ type: "down", at, source: APP_KEYS, solo });
const up = (at: number): HotkeyEvent => ({ type: "up", at });
const elapsed = (at: number): HotkeyEvent => ({ type: "elapsed", at });

describe("stepHotkey", () => {
  it("starts on a solo hold of HOLD_MS, and finishes on the release", () => {
    const r = run([down(0), elapsed(HOLD_MS), up(1200)]);
    expect(r.effects).toEqual(["start:hold", "finish"]);
    expect(r.state.phase).toBe("busy");
    expect(run([{ type: "settled" }], r.state).state.phase).toBe("idle");
  });

  it("does nothing for a tap, or for a timer that fires early", () => {
    expect(run([down(0), elapsed(HOLD_MS - 1), up(120)]).effects).toEqual([]);
  });

  it("passes another key pressed during the hold through, and never starts (AltGr typing)", () => {
    const pending = run([down(0), { type: "other", at: 80 }, elapsed(HOLD_MS), up(400)]);
    expect(pending.effects).toEqual([]);
    expect(pending.swallowed).toEqual([]);
    expect(pending.state.phase).toBe("idle");
    // A slow AltGr: the hold had started; the key cancels it, and still types.
    const holding = run([down(0), elapsed(HOLD_MS), { type: "other", at: 300 }, up(400)]);
    expect(holding.effects).toEqual(["start:hold", "cancel"]);
    expect(holding.swallowed).toEqual([]);
    expect(holding.state.phase).toBe("idle");
  });

  it("ignores the key pressed with another modifier", () => {
    const r = run([down(0, false), elapsed(HOLD_MS), up(600)]);
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe("idle");
  });

  it("locks the mic open on a double tap; the next tap ends it", () => {
    const r = run([down(0), up(90), down(90 + DOUBLE_TAP_MS - 10), up(300)]);
    expect(r.effects).toEqual(["start:lock"]);
    // The second press's own release didn't end it; typing doesn't either.
    expect(r.state.phase).toBe("locked");
    const more = run([{ type: "other", at: 900 }, down(2000), up(2100)], r.state);
    expect(more.effects).toEqual(["finish"]);
    // Two taps too far apart are two taps.
    expect(run([down(0), up(90), down(90 + DOUBLE_TAP_MS + 1), up(500)]).effects).toEqual([]);
    // A tap, a letter, a tap: no lock.
    expect(run([down(0), up(90), { type: "other", at: 120 }, down(200), up(260)]).effects).toEqual([]);
  });

  it("cancels on Esc, keeping that Esc from the page", () => {
    const held = run([down(0), elapsed(HOLD_MS), { type: "escape", at: 500 }, up(600)]);
    expect(held.effects).toEqual(["start:hold", "cancel"]);
    expect(held.swallowed).toEqual(["escape"]);
    expect(held.state.phase).toBe("idle");
    const locked = run([down(0), up(90), down(200), up(260), { type: "escape", at: 900 }]);
    expect(locked.effects).toEqual(["start:lock", "cancel"]);
    expect(locked.swallowed).toEqual(["escape"]);
    // With nothing to cancel, Esc belongs to whatever has focus.
    expect(run([{ type: "escape", at: 0 }]).swallowed).toEqual([]);
    expect(run([down(0), { type: "escape", at: 50 }]).swallowed).toEqual([]);
  });

  it("ignores the key while a capture is being placed, and a repeat while held", () => {
    const busy = run([down(0), elapsed(HOLD_MS), up(800)]).state;
    expect(run([down(900), elapsed(900 + HOLD_MS), up(1300), down(1400), up(1450)], busy).effects).toEqual([]);
    expect(run([down(0), elapsed(HOLD_MS), down(300), down(350), up(800)]).effects).toEqual(["start:hold", "finish"]);
  });

  it("finishes a hold whose release was lost to another window, and drops a pending one", () => {
    expect(run([down(0), elapsed(HOLD_MS), { type: "blur", at: 900 }]).effects).toEqual(["start:hold", "finish"]);
    const pending = run([down(0), { type: "blur", at: 100 }, elapsed(HOLD_MS)]);
    expect(pending.effects).toEqual([]);
    expect(pending.state.phase).toBe("idle");
  });

  it("treats a mic button's capture as a lock: the key's tap ends it, Esc cancels it", () => {
    const locked = run([{ type: "locked", at: 0 }]).state;
    expect(run([down(500), up(560)], locked).effects).toEqual(["finish"]);
    expect(run([{ type: "escape", at: 500 }], locked).effects).toEqual(["cancel"]);
  });

  it("waits for the release of a key still held when its capture settles", () => {
    const held = run([down(0), elapsed(HOLD_MS), { type: "settled" }]);
    expect(held.state.phase).toBe("spent");
    const after = run([up(900), down(1000), elapsed(1000 + HOLD_MS)], held.state);
    expect(after.effects).toEqual(["start:hold"]);
  });
});

describe("soloPress", () => {
  const flags = { altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, isComposing: false };
  it("allows only the key's own modifier", () => {
    expect(soloPress({ ...flags, altKey: true }, "AltRight")).toBe(true);
    expect(soloPress({ ...flags, altKey: true, metaKey: true }, "AltRight")).toBe(false);
    expect(soloPress({ ...flags, altKey: true, shiftKey: true }, "AltRight")).toBe(false);
    expect(soloPress({ ...flags, metaKey: true }, "MetaRight")).toBe(true);
    expect(soloPress({ ...flags, metaKey: true, altKey: true }, "MetaRight")).toBe(false);
    expect(soloPress({ ...flags, altKey: true, isComposing: true }, "AltRight")).toBe(false);
  });
});

describe("VoiceHotkey on the window", () => {
  let hooks: { start: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  let key: HoldKey;
  let hotkey: VoiceHotkey;
  let detach: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    hooks = { start: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
    key = "AltRight";
    hotkey = new VoiceHotkey(hooks, () => key, () => Date.now());
    detach = hotkey.attach(window);
  });
  afterEach(() => {
    detach();
    vi.useRealTimers();
  });
  const press = (type: "keydown" | "keyup", init: KeyboardEventInit) => {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(e);
    return e;
  };

  it("starts after HOLD_MS of Right Option alone and finishes on its release", () => {
    press("keydown", { code: "AltRight", key: "Alt", altKey: true });
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(hooks.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.start).toHaveBeenCalledWith("hold", expect.any(Number), APP_KEYS);
    press("keyup", { code: "AltRight", key: "Alt" });
    expect(hooks.finish).toHaveBeenCalledOnce();
  });

  it("never keeps a typed key from the page, and keeps only the Esc that cancels", () => {
    press("keydown", { code: "AltRight", key: "Alt", altKey: true });
    const typed = press("keydown", { code: "KeyL", key: "@", altKey: true });
    expect(typed.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hooks.start).not.toHaveBeenCalled();
    press("keyup", { code: "AltRight", key: "Alt" });
    // Hold again, then Esc: cancelled, and the Esc goes no further.
    press("keydown", { code: "AltRight", key: "Alt", altKey: true });
    vi.advanceTimersByTime(HOLD_MS);
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    const esc = press("keydown", { code: "Escape", key: "Escape", altKey: true });
    document.removeEventListener("keydown", behind);
    expect(hooks.cancel).toHaveBeenCalledOnce();
    expect(esc.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();
  });

  it("ignores key-repeats, other keys' modifiers and the key turned off", () => {
    press("keydown", { code: "AltRight", key: "Alt", altKey: true, repeat: true });
    vi.advanceTimersByTime(HOLD_MS);
    press("keydown", { code: "AltRight", key: "Alt", altKey: true, metaKey: true });
    vi.advanceTimersByTime(HOLD_MS);
    press("keyup", { code: "AltRight", key: "Alt" });
    key = "off";
    press("keydown", { code: "AltRight", key: "Alt", altKey: true });
    vi.advanceTimersByTime(HOLD_MS);
    expect(hooks.start).not.toHaveBeenCalled();
    // Right Command, when that is the key.
    key = "MetaRight";
    press("keydown", { code: "MetaRight", key: "Meta", metaKey: true });
    vi.advanceTimersByTime(HOLD_MS);
    expect(hooks.start).toHaveBeenCalledOnce();
  });

  it("hears the key from a web page, with where its focus was", () => {
    hotkey.page("browser-t1", "field:AltRight");
    vi.advanceTimersByTime(HOLD_MS);
    expect(hooks.start).toHaveBeenCalledWith("hold", expect.any(Number), { page: "browser-t1", field: true });
    hotkey.page("browser-t1", "up");
    expect(hooks.finish).toHaveBeenCalledOnce();
    hotkey.dispatch({ type: "settled" });
    // Another right-hand modifier is just another key.
    hotkey.page("browser-t1", "down:MetaRight");
    vi.advanceTimersByTime(HOLD_MS);
    expect(hooks.start).toHaveBeenCalledOnce();
  });
});

describe("the configured key", () => {
  it("defaults to Right Option and remembers a choice", () => {
    expect(loadHoldKey()).toBe("AltRight");
    saveHoldKey("ControlRight");
    expect(loadHoldKey()).toBe("ControlRight");
    expect(localStorage.getItem("redline.dictation.key")).toBe("ControlRight");
    saveHoldKey("AltRight");
  });
});
