// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AwayReply, LINGER_MS, type AwayDeps } from "./awayReply";
import type { SpeechDriver } from "./speech";
import { captionFor, voiceCaption } from "./voiceCaption";

type Handler = (e: { payload: unknown }) => void;

/** voice.rs's events, a speech engine whose sentences end when told (and
 *  what it was told besides), and the window Esc is pressed in. */
function rig(engine = "kokoro") {
  const handlers = new Map<string, Handler[]>();
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const spoken: string[] = [];
  const playing: (() => void)[] = [];
  const controls: string[] = [];
  const drivers: SpeechDriver[] = [];
  const surfaces: [string, boolean][] = [];
  const warmed: string[] = [];
  const win = new EventTarget();
  const makeDriver = (): SpeechDriver => ({
    speak(text, _opts, onDone) {
      spoken.push(text);
      playing.push(onDone);
    },
    cancel() {
      playing.length = 0;
      controls.push("cancel");
    },
    pause: () => void controls.push("pause"),
    resume: () => void controls.push("resume"),
  });
  const deps: AwayDeps = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return (cmd === "tts_get_settings" ? { engine } : null) as never;
    }),
    listen: vi.fn(async (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => {};
    }) as AwayDeps["listen"],
    driver: vi.fn(async () => {
      const d = makeDriver();
      drivers.push(d);
      return { engine, driver: d };
    }),
    warm: (e) => void warmed.push(e),
    surface: (s, open) => void surfaces.push([s, open]),
    win: win as unknown as Window,
  };
  const away = new AwayReply(deps);
  return {
    away,
    calls,
    spoken,
    controls,
    drivers,
    surfaces,
    warmed,
    win,
    emit(event: string, payload: Record<string, unknown>) {
      for (const fn of handlers.get(event) ?? []) fn({ payload });
    },
    /** The sentence playing now ends. */
    async end() {
      playing.shift()?.();
      await flush();
    },
    esc() {
      win.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape", repeat: false }));
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const turn = (n: number) => ({ sessionId: "plan-1", generation: 2, turn: n });

/** What the host does around a send: the caption thinks, the reply is
 *  expected, the turn goes and says which it was. */
async function send(r: ReturnType<typeof rig>, n = 5) {
  voiceCaption.set(captionFor("plan-1", "thinking", 0));
  await r.away.expect("plan-1");
  r.away.sent("plan-1", { generation: 2, turn: n });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  voiceCaption.set(null);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a reply to a turn sent with the panel closed", () => {
  it("is spoken in the user's engine — the spoken part only — and captioned sentence by sentence", async () => {
    const r = rig("kokoro");
    await send(r);
    expect(r.warmed).toEqual(["kokoro"]);
    r.emit("voice-meter", { ...turn(5), activity: { at: 1, kind: "tool", label: "Bash…" } });
    await flush();
    expect(voiceCaption.get()).toMatchObject({ phase: "thinking", activity: { label: "Bash…" } });
    r.emit("voice-delta", { ...turn(5), text: "⟦tone: calm⟧ Mostly safe. The risk is a double apply " });
    r.emit("voice-delta", { ...turn(5), text: "when the panel comes back.\n⟦screen⟧\n| Case | Fix |" });
    await flush();
    expect(voiceCaption.get()).toMatchObject({ phase: "speaking", text: "Mostly safe." });
    await r.end();
    expect(voiceCaption.get()).toMatchObject({ phase: "speaking", text: "The risk is a double apply when the panel comes back." });
    expect(r.spoken.join(" ")).not.toMatch(/Case|⟦/);
    expect(r.drivers).toHaveLength(1);
  });

  it("stays a moment once the reply is said, then shrinks back into the pill", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "It ships behind a flag." });
    r.emit("voice-done", { ...turn(5), body: "It ships behind a flag.", messageId: "m1" });
    await flush();
    expect(voiceCaption.get()?.phase).toBe("speaking");
    await r.end();
    expect(voiceCaption.get()).toMatchObject({ phase: "done", text: "It ships behind a flag." });
    vi.advanceTimersByTime(LINGER_MS - 1);
    expect(voiceCaption.get()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(voiceCaption.get()).toBeNull();
  });

  it("never speaks the reply it interrupted, nor another conversation's", async () => {
    const r = rig();
    voiceCaption.set(captionFor("plan-1", "thinking", 0));
    await r.away.expect("plan-1");
    // Before voice_send answers: the old turn's last words, and its end.
    r.emit("voice-delta", { ...turn(4), text: "As I was saying, the old answer. " });
    r.emit("voice-interrupted", { ...turn(4), text: "As I was saying" });
    r.emit("voice-delta", { ...turn(5), text: "The new answer. " });
    r.emit("voice-delta", { sessionId: "plan-2", generation: 2, turn: 5, text: "Someone else's. " });
    r.away.sent("plan-1", { generation: 2, turn: 5 });
    await flush();
    expect(r.spoken).toEqual(["The new answer."]);
    expect(voiceCaption.get()?.phase).toBe("speaking");
  });

  it("stops on Esc — the speech, and the turn still running — and the caption goes at once", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "A long answer begins here. And goes on." });
    await flush();
    r.esc();
    expect(r.calls).toContainEqual(["voice_interrupt", { sessionId: "plan-1" }]);
    expect(voiceCaption.get()).toBeNull();
    // What streams after is never spoken.
    const said = r.spoken.length;
    r.emit("voice-delta", { ...turn(5), text: " More words. " });
    await flush();
    expect(r.spoken).toHaveLength(said);
  });

  it("leaves Esc to a capture being heard, and to whoever handled it first", async () => {
    const r = rig();
    await send(r);
    voiceCaption.set(captionFor("plan-1", "hearing", 0));
    r.esc();
    expect(r.calls.some(([cmd]) => cmd === "voice_interrupt")).toBe(false);
    voiceCaption.set(captionFor("plan-1", "thinking", 0));
    const handled = new Event("keydown", { cancelable: true });
    Object.assign(handled, { key: "Escape" });
    handled.preventDefault();
    r.win.dispatchEvent(handled);
    expect(r.calls.some(([cmd]) => cmd === "voice_interrupt")).toBe(false);
  });

  it("is hushed by the next hold, and handed to the panel that opens on it without interrupting the turn", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "First sentence. Second one." });
    await flush();
    r.away.hush();
    const said = r.spoken.length;
    r.emit("voice-delta", { ...turn(5), text: " Third." });
    await flush();
    expect(r.spoken).toHaveLength(said);

    await send(r, 6);
    r.emit("voice-delta", { ...turn(6), text: "Another answer. " });
    await flush();
    r.away.release("plan-1");
    expect(voiceCaption.get()).toBeNull();
    expect(r.calls.some(([cmd]) => cmd === "voice_interrupt")).toBe(false);
  });

  it("pauses for a hold of the key, and plays on from where it paused when the hold comes to nothing", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "First sentence. Second one. " });
    await flush();
    const said = [...r.spoken];
    expect(said).toEqual(["First sentence."]);
    r.away.hold();
    expect(r.controls).toEqual(["pause"]);
    // What streams in, and the turn's end, wait; the caption stays as it was.
    r.emit("voice-delta", { ...turn(5), text: "Third one. " });
    r.emit("voice-done", { ...turn(5), body: "First sentence. Second one. Third one." });
    await flush();
    expect(r.spoken).toEqual(said);
    vi.advanceTimersByTime(LINGER_MS * 2);
    expect(voiceCaption.get()).toMatchObject({ phase: "speaking", text: said[0] });
    r.away.playOn();
    await flush();
    expect(r.controls).toEqual(["pause", "resume"]);
    expect(r.spoken).toEqual(["First sentence.", "Second one.", "Third one."]);
    // Said to its end, it settles as any reply does.
    for (let i = 0; i < r.spoken.length; i++) await r.end();
    expect(voiceCaption.get()).toMatchObject({ phase: "done", text: "Third one." });
    vi.advanceTimersByTime(LINGER_MS);
    expect(voiceCaption.get()).toBeNull();
    expect(r.calls.some(([cmd]) => cmd === "voice_interrupt")).toBe(false);
  });

  it("is hushed once the hold hears a word, the caption it froze going with it", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "First sentence. Second one. " });
    await flush();
    const said = r.spoken.length;
    r.away.hold();
    r.away.hush();
    expect(r.controls).toEqual(["pause", "cancel"]);
    expect(voiceCaption.get()).toBeNull();
    r.emit("voice-delta", { ...turn(5), text: "Third one. " });
    await flush();
    // The capture's end has nothing left to play on.
    r.away.playOn();
    await flush();
    expect(r.spoken).toHaveLength(said);
  });

  it("leaves a hold's own caption to it, and puts the reply's back when the hold sends nothing", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-delta", { ...turn(5), text: "First sentence. Second one. " });
    await flush();
    const speaking = voiceCaption.get();
    r.away.hold();
    // A hold sending a turn to the same conversation shows its hearing.
    const hearing = captionFor("plan-1", "hearing", 0);
    voiceCaption.set(hearing);
    await r.end();
    expect(voiceCaption.get()).toBe(hearing);
    // The key typed a character: the hold's caption goes, the reply's is back.
    voiceCaption.set(null);
    r.away.playOn();
    expect(voiceCaption.get()).toBe(speaking);
    // A hold that heard a word keeps the hearing caption the new turn needs.
    r.away.hold();
    voiceCaption.set(hearing);
    r.away.hush();
    expect(voiceCaption.get()).toBe(hearing);
  });

  it("goes at once when the turn fails or its child exits", async () => {
    const r = rig();
    await send(r);
    r.emit("voice-error", { ...turn(5), error: "rate limited" });
    await flush();
    expect(voiceCaption.get()).toBeNull();
    await send(r, 6);
    r.emit("voice-exit", { sessionId: "plan-1", generation: 2, deliberate: false });
    await flush();
    expect(voiceCaption.get()).toBeNull();
  });

  it("holds the studio voice open while it speaks, and lets it go after", async () => {
    const r = rig("studio");
    await send(r);
    expect(r.surfaces).toEqual([["away:plan-1", true]]);
    r.emit("voice-done", { ...turn(5), body: "Done." });
    await flush();
    await r.end();
    vi.advanceTimersByTime(LINGER_MS);
    expect(r.surfaces).toEqual([
      ["away:plan-1", true],
      ["away:plan-1", false],
    ]);
  });

  it("keeps one driver of its own across turns, and a new one only when the engine changes", async () => {
    const r = rig("kokoro");
    await send(r, 5);
    await send(r, 6);
    expect(r.drivers).toHaveLength(1);
  });
});
