// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { effectiveDiscussionContext } from "./discussionContext";

describe("effectiveDiscussionContext", () => {
  it("review closed → always plan, regardless of the pin", () => {
    expect(effectiveDiscussionContext(false, true, "review")).toBe("plan");
    expect(effectiveDiscussionContext(false, false, "review")).toBe("plan");
  });

  it("review open with no plan side → review, regardless of the pin", () => {
    expect(effectiveDiscussionContext(true, false, "plan")).toBe("review");
  });

  it("true split honors the pinned toggle", () => {
    expect(effectiveDiscussionContext(true, true, "plan")).toBe("plan");
    expect(effectiveDiscussionContext(true, true, "review")).toBe("review");
  });
});
