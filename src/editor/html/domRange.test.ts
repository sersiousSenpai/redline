// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { charRangeToDomRange } from "./domRange";

function block(html: string): HTMLElement {
  const el = document.createElement("p");
  el.innerHTML = html;
  return el;
}

describe("charRangeToDomRange", () => {
  it("selects a span inside a single text node", () => {
    const el = block("Hello brave world");
    const range = charRangeToDomRange(el, 6, 11);
    expect(range?.toString()).toBe("brave");
  });

  it("selects across inline mark boundaries (mirrors textContent offsets)", () => {
    // textContent === "Hello brave world"; "brave" lives inside <strong>.
    const el = block("Hello <strong>brave</strong> world");
    expect(el.textContent).toBe("Hello brave world");
    expect(charRangeToDomRange(el, 0, 5)?.toString()).toBe("Hello");
    expect(charRangeToDomRange(el, 6, 11)?.toString()).toBe("brave");
    expect(charRangeToDomRange(el, 0, 17)?.toString()).toBe("Hello brave world");
  });

  it("round-trips the offsets useTextSelection would capture", () => {
    const el = block("alpha <em>beta</em> gamma");
    const text = el.textContent ?? "";
    const start = text.indexOf("beta");
    const end = start + "beta".length;
    expect(charRangeToDomRange(el, start, end)?.toString()).toBe("beta");
  });

  it("clamps an end offset past the block's text length", () => {
    const el = block("short");
    const range = charRangeToDomRange(el, 0, 999);
    expect(range?.toString()).toBe("short");
  });

  it("normalizes a reversed range", () => {
    const el = block("Hello world");
    expect(charRangeToDomRange(el, 11, 6)?.toString()).toBe("world");
  });
});
