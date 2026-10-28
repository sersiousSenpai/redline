// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  SHELL_PROMPT,
  deliverToTerminal,
  type HandoffDeps,
} from "./terminalHandoff";

interface FakeOptions {
  spawn?: () => Promise<void>;
  live?: boolean;
  ready?: boolean;
  failWriteMatching?: RegExp;
}

function makeFake(opts: FakeOptions = {}) {
  const writes: string[] = [];
  const journal: string[] = [];
  const deps: HandoffDeps = {
    whenSpawned: () => (opts.spawn ? opts.spawn() : Promise.resolve()),
    isLive: () => Promise.resolve(opts.live ?? false),
    writeChecked: (_id, data) => {
      if (opts.failWriteMatching?.test(data)) {
        return Promise.reject(new Error("terminal tab-x is not running"));
      }
      writes.push(data);
      return Promise.resolve();
    },
    awaitOutput: (_id, _re, _t) => Promise.resolve(opts.ready ?? true),
    journal: (stage, detail) => journal.push(detail ? `${stage}:${detail}` : stage),
    sleep: () => Promise.resolve(),
  };
  return { deps, writes, journal };
}

describe("deliverToTerminal", () => {
  it("delivers once the spawn resolves, even when it resolves late", async () => {
    // openSessionTerminal returns before mount — a caller may await the
    // spawn before the TerminalView for that id even exists.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const fake = makeFake({ spawn: () => gate });
    const p = deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "npm run dev\r" },
    ]);
    release();
    expect(await p).toEqual({ ok: true });
    expect(fake.writes).toEqual(["npm run dev\r"]);
    expect(fake.journal).toContain("handoff_spawned");
    expect(fake.journal).toContain("handoff_launch_written");
  });

  it("fails at stage spawn when the terminal never comes up", async () => {
    const fake = makeFake({
      spawn: () => Promise.reject(new Error("terminal tab-1 did not spawn within 50ms")),
      live: false,
    });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("spawn");
      expect(r.reason).toContain("did not spawn");
    }
    expect(fake.writes).toEqual([]);
  });

  it("believes the live registry over a stale spawn signal", async () => {
    // A failed first mount whose remount succeeded leaves the deferred
    // rejected while the PTY is alive — the registry is ground truth.
    const fake = makeFake({
      spawn: () => Promise.reject(new Error("stale")),
      live: true,
    });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
    ]);
    expect(r).toEqual({ ok: true });
    expect(fake.writes).toEqual(["claude\r"]);
  });

  it("falls back to a settle and still writes when the marker never appears", async () => {
    const fake = makeFake({ ready: false });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      {
        stage: "prompt",
        data: "hello\r",
        awaitBefore: SHELL_PROMPT,
        awaitTimeoutMs: 5,
        fallbackSettleMs: 1,
      },
    ]);
    expect(r).toEqual({ ok: true });
    expect(fake.writes).toEqual(["hello\r"]);
  });

  it("surfaces a rejected write as a stage failure", async () => {
    const fake = makeFake({ failWriteMatching: /hello/ });
    const r = await deliverToTerminal(fake.deps, "tab-1", [
      { stage: "launch", data: "claude\r" },
      { stage: "prompt", data: "hello\r" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("prompt");
      expect(r.reason).toContain("not running");
    }
    expect(fake.writes).toEqual(["claude\r"]);
  });
});

describe("SHELL_PROMPT — write once the shell owns the echo", () => {
  it("matches the prompt a login zsh leaves on screen", () => {
    // The exact tail from the field (macOS zsh, default theme).
    expect(
      SHELL_PROMPT.test("yusufalbazian@Yusufs-MacBook-Pro dialcrown % "),
    ).toBe(true);
    expect(SHELL_PROMPT.test("bash-3.2$ ")).toBe(true);
    expect(SHELL_PROMPT.test("root@box:/srv# ")).toBe(true);
    // Themed prompts end in their own glyph.
    expect(SHELL_PROMPT.test("~/redline ❯ ")).toBe(true);
  });

  it("still matches through the escape sequences a themed prompt trails", () => {
    // Colour reset after the prompt character, and the OSC title/cwd
    // sequences macOS's own zshrc emits.
    expect(SHELL_PROMPT.test("me@box redline % \x1b[0m")).toBe(true);
    expect(
      SHELL_PROMPT.test("me@box redline % \x1b]7;file://box/Users/me\x07"),
    ).toBe(true);
  });

  it("does not fire on the rc-file noise that precedes the prompt", () => {
    // The banner that used to sit BETWEEN the two echoes of the command.
    expect(SHELL_PROMPT.test("Restored session: Wed Aug 26 16:07:33 PDT 2026\n")).toBe(
      false,
    );
    expect(SHELL_PROMPT.test("...saving history...truncating history files...\n")).toBe(
      false,
    );
    // A stray % mid-output is not a prompt: the match is anchored to the tail.
    expect(SHELL_PROMPT.test("100% complete\nfetching…")).toBe(false);
  });
});
