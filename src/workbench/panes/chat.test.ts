// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import { stoppedRetry } from "./chat";

// LAST2 walk: the stopped strip of a plan's agent killed in review had no
// Retry, and a launch killed before its plan had no strip at all.
describe("every stopped strip has Retry", () => {
  const handlers = () => ({ onRetryBuild: vi.fn(), onRetryReview: vi.fn(), onRetryLaunch: vi.fn() });

  it("a launch stopped before its plan types its command again, in its own terminal", () => {
    const h = handlers();
    stoppedRetry({ launch: { stopped: true }, own: false, building: false, terminalId: "T1", handlers: h })!();
    expect(h.onRetryLaunch).toHaveBeenCalledWith("T1");
  });

  it("a plan's agent: building resumes the build, in review takes the plan's Restore", () => {
    const h = handlers();
    stoppedRetry({ launch: null, own: true, building: true, terminalId: "T1", handlers: h })!();
    expect(h.onRetryBuild).toHaveBeenCalledOnce();
    stoppedRetry({ launch: null, own: true, building: false, terminalId: "T1", handlers: h })!();
    expect(h.onRetryReview).toHaveBeenCalledOnce();
  });

  it("an agent tab that is not the session's has nothing of its own to retry", () => {
    expect(stoppedRetry({ launch: null, own: false, building: false, terminalId: "T1", handlers: handlers() })).toBeNull();
  });
});
