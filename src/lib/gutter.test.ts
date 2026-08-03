// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { gutterDigits, gutterWidthCss } from "./gutter";

describe("gutterDigits", () => {
  it("counts digits of the widest line number, floored at one", () => {
    expect(gutterDigits(0)).toBe(1);
    expect(gutterDigits(1)).toBe(1);
    expect(gutterDigits(9)).toBe(1);
    expect(gutterDigits(10)).toBe(2);
    expect(gutterDigits(99)).toBe(2);
    expect(gutterDigits(100)).toBe(3);
    expect(gutterDigits(5000)).toBe(4);
    expect(gutterDigits(123456)).toBe(6);
  });
});

describe("gutterWidthCss", () => {
  it("emits CM6's metrics: digits in ch + 8px padding, 20px floor", () => {
    expect(gutterWidthCss(1)).toBe("max(20px, calc(1ch + 8px))");
    expect(gutterWidthCss(50)).toBe("max(20px, calc(2ch + 8px))");
    expect(gutterWidthCss(5000)).toBe("max(20px, calc(4ch + 8px))");
  });

  it("keeps the 20px floor for tiny files", () => {
    expect(gutterWidthCss(0)).toBe("max(20px, calc(1ch + 8px))");
  });
});
