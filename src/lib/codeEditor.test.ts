// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import type { FileContent } from "../types";
import {
  languageForPath,
  prepareEditContent,
  resolveDiskChange,
  saveKeyBinding,
} from "./codeEditor";

const text = (content: string): FileContent => ({
  content,
  isBinary: false,
  tooLarge: false,
  size: content.length,
});

describe("languageForPath", () => {
  it("maps common source extensions to their grammars", () => {
    expect(languageForPath("/repo/src/App.tsx")?.name).toBe("TSX");
    expect(languageForPath("/repo/src/lib.rs")?.name).toBe("Rust");
    expect(languageForPath("script.py")?.name).toBe("Python");
    expect(languageForPath("/deep/path/main.go")?.name).toBe("Go");
    expect(languageForPath("styles.css")?.name).toBe("CSS");
    expect(languageForPath("index.html")?.name).toBe("HTML");
    expect(languageForPath("Cargo.toml")?.name).toBe("TOML");
  });

  it("matches on the basename, not the directory", () => {
    // A dotted directory segment must not confuse the extension match.
    expect(languageForPath("/home/user.rs/notes.py")?.name).toBe("Python");
  });

  it("returns null when no grammar matches", () => {
    expect(languageForPath("/repo/LICENSE")).toBeNull();
    expect(languageForPath("data.xyzzy")).toBeNull();
  });
});

describe("prepareEditContent", () => {
  it("resolves content and language together", async () => {
    await expect(
      prepareEditContent(
        () => Promise.resolve(text("let x = 1;")),
        () => Promise.resolve("lang"),
      ),
    ).resolves.toEqual({ content: "let x = 1;", language: "lang" });
  });

  it("no grammar for this file → language null, content intact", async () => {
    await expect(
      prepareEditContent(() => Promise.resolve(text("plain")), null),
    ).resolves.toEqual({ content: "plain", language: null });
  });

  it("a rejecting grammar load falls back to plain instead of failing", async () => {
    await expect(
      prepareEditContent(
        () => Promise.resolve(text("still fine")),
        () => Promise.reject(new Error("chunk load failed")),
      ),
    ).resolves.toEqual({ content: "still fine", language: null });
  });

  it("propagates read failures", async () => {
    await expect(
      prepareEditContent(
        () => Promise.reject(new Error("io")),
        () => Promise.resolve("lang"),
      ),
    ).rejects.toThrow("io");
  });

  it("rejects non-editable files with the editor's exact messages", async () => {
    await expect(
      prepareEditContent(
        () =>
          Promise.resolve({
            content: null,
            isBinary: false,
            tooLarge: true,
            size: 99,
          }),
        null,
      ),
    ).rejects.toThrow("File is too large to edit (2 MB cap).");
    await expect(
      prepareEditContent(
        () =>
          Promise.resolve({
            content: null,
            isBinary: true,
            tooLarge: false,
            size: 99,
          }),
        null,
      ),
    ).rejects.toThrow("Binary file — not editable.");
  });
});

describe("resolveDiskChange", () => {
  it("ignores our own save echo (disk == saved), dirty or not", () => {
    expect(
      resolveDiskChange({ dirty: false, disk: "a", saved: "a" }),
    ).toBe("ignore");
    // Still typing after a save when the echo lands — must not banner.
    expect(
      resolveDiskChange({ dirty: true, disk: "a", saved: "a" }),
    ).toBe("ignore");
  });

  it("silently reloads a clean buffer (CodeView's live-reload contract)", () => {
    expect(
      resolveDiskChange({ dirty: false, disk: "new", saved: "old" }),
    ).toBe("reload");
  });

  it("raises the conflict banner only for a dirty buffer + foreign change", () => {
    expect(
      resolveDiskChange({ dirty: true, disk: "new", saved: "old" }),
    ).toBe("conflict");
  });
});

describe("saveKeyBinding", () => {
  it("binds Mod-s, runs save, and claims the key", () => {
    const save = vi.fn();
    const binding = saveKeyBinding(save);
    expect(binding.key).toBe("Mod-s");
    // Returning true is what stops WebKit's own save dialog.
    expect(binding.run()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
