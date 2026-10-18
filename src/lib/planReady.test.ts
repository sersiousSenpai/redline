// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { planReadySummary } from "./planReady";

describe("planReadySummary", () => {
  it("counts the ## sections and the steps listed under them", () => {
    const md = [
      "# Din roadmap: next steps",
      "Picks up from note 28.",
      "- not a step: it is above every section",
      "## 1. Finish Track B",
      "1. Compile the build in Xcode on the Mac.",
      "2. Apply the migration.",
      "3. Deploy the Worker.",
      "## 2. Next by priority",
      "- D6: the pattern loop",
      "  - nested, still a step",
      "```",
      "- in a fence: not a step",
      "## not a section either",
      "```",
      "## 3. Later",
      "Prose only.",
    ].join("\n");
    expect(planReadySummary(md)).toBe("3 sections · 5 steps.");
  });

  it("says what it has, and nothing when it has nothing", () => {
    expect(planReadySummary("## One\n\nJust prose.")).toBe("1 section.");
    expect(planReadySummary("# Title\n\nProse.")).toBeNull();
    expect(planReadySummary("")).toBeNull();
  });
});
