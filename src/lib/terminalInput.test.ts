// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { terminalInputOrigin } from "./terminalInput";
import { loadXterm } from "./xtermLoader";

// This exercises the real terminal parser without opening a DOM renderer.
// Browser-only addons are loaded by the shared loader but unused here.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));

describe("installed xterm input origin contract", () => {
  it("distinguishes keyboard/paste/IME input from DSR and DA replies during queued replay", async () => {
    const { Terminal } = await loadXterm();
    const term = new Terminal();
    // No renderer is needed for this parser/input contract. Paste only needs
    // the textarea's value slot to clear its clipboard staging field.
    (term as unknown as { _core: { textarea: { value: string } } })._core.textarea = { value: "" };
    const touched = vi.fn();
    const origin = terminalInputOrigin(term, touched);
    let replaying = true;
    const sent: string[] = [];
    const ignored: string[] = [];
    term.onData((data) => {
      const user = origin.takeUserInput();
      (replaying && !user ? ignored : sent).push(data);
    });
    const replayDone = new Promise<void>((resolve) => term.write("\x1b[6n\x1b[c", () => {
      replaying = false;
      resolve();
    }));
    // input(..., true) is the same core path used by keys and CompositionHelper
    // for IME; paste exercises its separate public clipboard path as well.
    term.input("keyboard", true);
    term.input("組み立て", true);
    term.paste("clipboard");
    await replayDone;
    expect(sent).toEqual(["keyboard", "組み立て", "clipboard"]);
    expect(ignored).toHaveLength(2);
    expect(ignored[0]).toBe("\x1b[1;1R");
    expect(ignored[1]).toMatch(/^\x1b\[\?/);
    expect(touched).toHaveBeenCalledTimes(3);
    await new Promise<void>((resolve) => term.write("\x1b[6n", resolve));
    expect(sent[sent.length - 1]).toBe("\x1b[1;1R");
    expect(touched).toHaveBeenCalledTimes(3);
    origin.dispose();
    term.dispose();
  });

  it("degrades to public gesture tracking if the optional private seam is absent", () => {
    const touched = vi.fn();
    const origin = terminalInputOrigin({}, touched);
    expect(origin.takeUserInput()).toBe(false);
    origin.noteGesture();
    expect(origin.takeUserInput()).toBe(true);
    expect(origin.takeUserInput()).toBe(false);
    expect(touched).toHaveBeenCalledTimes(1);
    origin.dispose();
  });
});
