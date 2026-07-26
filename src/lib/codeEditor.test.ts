// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import {
  languageForPath,
  resolveDiskChange,
  saveKeyBinding,
} from "./codeEditor";

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
