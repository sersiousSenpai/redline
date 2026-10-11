// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import { DictationBroker } from "./dictationBroker";

type Handler = (e: { payload: never }) => void;

/** A stand-in for dictation.rs's ownership rules and its events. */
function native() {
  const handlers = new Map<string, Handler[]>();
  const calls: [string, Record<string, unknown> | undefined][] = [];
  let holder: string | null = null;
  let stopGate: Promise<void> = Promise.resolve();
  const emit = (event: string, payload: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn({ payload } as never);
  };
  const bridge = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<never> => {
      calls.push([cmd, args]);
      const owner = args?.owner as string;
      if (cmd === "dictation_start") {
        if (holder === owner) return { granted: true, holder: owner } as never;
        if (holder && args?.kind !== "hold") return { granted: false, holder } as never;
        const preempted = holder ?? undefined;
        holder = owner;
        if (preempted) emit("dictation-preempted", { owner: preempted, by: owner, text: "half a sentence" });
        return { granted: true, holder: owner, ...(preempted ? { preempted } : {}) } as never;
      }
      if (cmd === "dictation_stop") {
        await stopGate;
        if (holder !== owner) return "" as never;
        holder = null;
        return `final from ${owner}` as never;
      }
      if (cmd === "dictation_cycle") return (holder === owner ? `utterance from ${owner}` : "") as never;
      if (cmd === "dictation_kill_all") {
        if (holder === owner) holder = null;
      }
      return null as never;
    }),
    listen: vi.fn(async (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => {};
    }),
  };
  return {
    bridge,
    calls,
    emit,
    holder: () => holder,
    gateStops: () => {
      let open!: () => void;
      stopGate = new Promise((r) => (open = r));
      return () => open();
    },
  };
}

describe("DictationBroker", () => {
  it("routes each event to the owner it names, and to no one else", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    const door = { partial: vi.fn(), level: vi.fn(), error: vi.fn() };
    const voice = { partial: vi.fn(), level: vi.fn(), error: vi.fn() };
    b.attach("door", door);
    b.attach("voice", voice);
    await b.start("door", { kind: "hold" });
    n.emit("dictation-partial", { owner: "door", text: "rename the" });
    n.emit("dictation-level", { owner: "door", rms: -30, peak: -12, ms: 50 });
    n.emit("dictation-error", { owner: "door", error: "mic busy" });
    expect(door.partial).toHaveBeenCalledWith("rename the");
    expect(door.level).toHaveBeenCalledWith({ owner: "door", rms: -30, peak: -12, ms: 50 });
    expect(door.error).toHaveBeenCalledWith({ owner: "door", error: "mic busy" });
    expect(voice.partial).not.toHaveBeenCalled();
    expect(voice.level).not.toHaveBeenCalled();
    expect(voice.error).not.toHaveBeenCalled();
  });

  it("passes the owner, the kind, the vocabulary and the pre-roll to Rust", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    await b.start("door", { kind: "hold", vocab: ["Kokoro"], preroll: false });
    expect(n.calls[0]).toEqual(["dictation_start", { owner: "door", kind: "hold", vocab: ["Kokoro"], preroll: false }]);
    expect(await b.stop("door")).toBe("final from door");
    expect(n.calls[1]).toEqual(["dictation_stop", { owner: "door" }]);
  });

  it("lets a held key take the mic from an open one, which hears what it had", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    const preempted = vi.fn();
    b.attach("voice", { preempted });
    await b.start("voice", { kind: "open" });
    expect(b.current()).toBe("voice");
    const grant = await b.start("dictation", { kind: "hold" });
    expect(grant).toMatchObject({ granted: true, preempted: "voice" });
    expect(preempted).toHaveBeenCalledWith("dictation", "half a sentence");
    expect(b.current()).toBe("dictation");
    // Its late stop takes nothing from the new holder.
    expect(await b.stop("voice")).toBe("");
    expect(n.holder()).toBe("dictation");
  });

  it("refuses an open start while another owner holds the mic", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    await b.start("dictation", { kind: "hold" });
    const grant = await b.start("voice", { kind: "open" });
    expect(grant).toEqual({ granted: false, holder: "dictation" });
    expect(b.current()).toBe("dictation");
  });

  it("waits for an owner's stop before starting it again", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    await b.start("door", { kind: "hold" });
    const open = n.gateStops();
    const stopped = b.stop("door");
    const restarted = b.start("door", { kind: "hold" });
    await Promise.resolve();
    expect(n.calls.map(([c]) => c)).toEqual(["dictation_start", "dictation_stop"]);
    open();
    expect(await stopped).toBe("final from door");
    await restarted;
    expect(n.calls.map(([c]) => c)).toEqual(["dictation_start", "dictation_stop", "dictation_start"]);
    expect(n.holder()).toBe("door");
  });

  it("cancels only the detaching owner's capture, by name", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    const detachDoor = b.attach("door", {});
    const detachVoice = b.attach("voice", {});
    await b.start("door", { kind: "hold" });
    // Not the holder: unmounting cancels nothing.
    detachVoice();
    expect(n.calls.filter(([c]) => c === "dictation_kill_all")).toEqual([]);
    detachDoor();
    expect(n.calls.filter(([c]) => c === "dictation_kill_all")).toEqual([["dictation_kill_all", { owner: "door" }]]);
    expect(b.current()).toBeNull();
    // A detached owner hears nothing more.
    const partial = vi.fn();
    b.attach("voice", { partial });
    n.emit("dictation-partial", { owner: "door", text: "late" });
    expect(partial).not.toHaveBeenCalled();
  });

  it("ends an owner's utterance by name and keeps its mic open", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    await b.start("voice", { kind: "open" });
    expect(await b.cycle("voice")).toBe("utterance from voice");
    expect(n.calls[n.calls.length - 1]).toEqual(["dictation_cycle", { owner: "voice" }]);
    expect(b.current()).toBe("voice");
    // Another owner's cycle ends nothing of this one's.
    expect(await b.cycle("door")).toBe("");
    expect(n.holder()).toBe("voice");
  });

  it("tells subscribers when the holder changes", async () => {
    const n = native();
    const b = new DictationBroker(n.bridge);
    const seen: (string | null)[] = [];
    b.subscribe(() => seen.push(b.current()));
    await b.start("door", { kind: "hold" });
    await b.start("voice", { kind: "hold" });
    b.cancel("voice");
    expect(seen).toEqual(["door", "voice", null]);
  });
});
