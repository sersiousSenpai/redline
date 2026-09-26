// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { replaceablePlaceholder } from "./placeholderTerminal";

const shell = { id: "shell", cwd: null, placeholder: true };
const home = "/Users/me";
describe("replaceablePlaceholder", () => {
  it("replaces a sole untouched convenience shell with no cwd yet", () => {
    expect(replaceablePlaceholder([shell], new Map(), null)).toBe("shell");
  });
  it("recognizes its startup directory and HOME despite trailing slashes", () => {
    expect(replaceablePlaceholder([shell], new Map([["shell", `${home}/`]]), home)).toBe("shell");
    expect(replaceablePlaceholder([{ ...shell, cwd: "/repo/" }], new Map([["shell", "/repo"]]), home)).toBe("shell");
  });
  it("preserves shells that were typed in, moved directory, or explicitly opened", () => {
    expect(replaceablePlaceholder([{ ...shell, placeholder: false }], new Map(), home)).toBeNull();
    expect(replaceablePlaceholder([shell], new Map([["shell", "/repo"]]), home)).toBeNull();
    expect(replaceablePlaceholder([{ id: "shell", cwd: null }], new Map(), home)).toBeNull();
  });
  it("preserves a placeholder beside another terminal, and handles no tabs", () => {
    expect(replaceablePlaceholder([shell, { id: "work", cwd: "/repo" }], new Map(), home)).toBeNull();
    expect(replaceablePlaceholder([], new Map(), home)).toBeNull();
  });
  it("preserves a live shell until its unknown startup HOME can be checked", () => {
    expect(replaceablePlaceholder([shell], new Map([["shell", home]]), null)).toBeNull();
  });
});
