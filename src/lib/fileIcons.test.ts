// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { fileIconKind } from "./fileIcons";

describe("fileIconKind", () => {
  it("reads the kind from the name alone", () => {
    expect(fileIconKind("/repo/src/App.tsx")).toBe("code");
    expect(fileIconKind("auth.test.ts")).toBe("test");
    expect(fileIconKind("lease_test.go")).toBe("test");
    expect(fileIconKind("styles.css")).toBe("style");
    expect(fileIconKind("index.html")).toBe("markup");
    expect(fileIconKind("schema.json")).toBe("data");
    expect(fileIconKind("README.md")).toBe("markdown");
    expect(fileIconKind("logo.PNG")).toBe("image");
    expect(fileIconKind("tauri.conf.toml")).toBe("config");
    expect(fileIconKind("redline.sh")).toBe("shell");
    expect(fileIconKind("LICENSE")).toBe("text");
  });
  it("knows manifests, locks and dotfiles before extensions", () => {
    expect(fileIconKind("package.json")).toBe("package");
    expect(fileIconKind("Cargo.toml")).toBe("package");
    expect(fileIconKind("package-lock.json")).toBe("lock");
    expect(fileIconKind("Cargo.lock")).toBe("lock");
    expect(fileIconKind(".gitignore")).toBe("config");
    expect(fileIconKind("Dockerfile")).toBe("config");
  });
});
