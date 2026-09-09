// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  agentLabelFor,
  choiceLabel,
  defaultChoice,
  effortsFor,
  isDefaultChoice,
  modelsFor,
  normalizeChoice,
  parseChoice,
  type CodexModel,
} from "./backendChoice";
import { EFFORT_OPTIONS } from "./seatAssign";

const CATALOG: CodexModel[] = [
  {
    slug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    defaultEffort: "low",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    slug: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh"],
  },
];

describe("defaults", () => {
  it("starts on Claude with no flags — today's command exactly", () => {
    expect(defaultChoice()).toEqual({
      backend: "claude-code",
      model: null,
      effort: null,
    });
    expect(isDefaultChoice(defaultChoice())).toBe(true);
    expect(
      isDefaultChoice({ backend: "claude-code", model: "opus", effort: null }),
    ).toBe(false);
  });
});

describe("the option lists", () => {
  it("uses stable planning aliases until the binary catalog answers, with shared efforts", () => {
    expect(modelsFor("claude-code", []).map((m) => m.value)).toEqual(
      ["opus", "sonnet", "haiku"],
    );
    expect(effortsFor("claude-code", "opus", [])).toEqual(EFFORT_OPTIONS);
  });

  it("offers only what the live Codex catalog advertises", () => {
    expect(modelsFor("codex", CATALOG).map((m) => m.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    // Per-model, and a different set from Claude's — `ultra` is Codex-only.
    expect(effortsFor("codex", "gpt-5.6-sol", CATALOG)).toContain("ultra");
    expect(effortsFor("codex", "gpt-5.5", CATALOG)).not.toContain("ultra");
  });

  it("offers nothing for Codex when the probe hasn't answered", () => {
    // Never a hardcoded fallback list: it would offer a model that fails at
    // the first token the next time the ChatGPT app updates.
    expect(modelsFor("codex", [])).toEqual([]);
    expect(effortsFor("codex", "gpt-5.6-sol", [])).toEqual([]);
    expect(effortsFor("codex", null, CATALOG)).toEqual([]);
  });
});

describe("normalizeChoice", () => {
  it("drops an effort the chosen model doesn't advertise", () => {
    // The case this exists for: pick Sol · ultra, then switch to GPT-5.5,
    // which stops at xhigh. Sending `ultra` is a launch that dies at the
    // first token.
    expect(
      normalizeChoice(
        { backend: "codex", model: "gpt-5.5", effort: "ultra" },
        CATALOG,
      ),
    ).toEqual({ backend: "codex", model: "gpt-5.5", effort: null });
  });

  it("keeps an effort the model does advertise", () => {
    expect(
      normalizeChoice(
        { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
        CATALOG,
      ).effort,
    ).toBe("ultra");
  });

  it("drops a model the other backend can't run", () => {
    // A Claude alias is not a Codex slug.
    expect(
      normalizeChoice(
        { backend: "codex", model: "opus", effort: "high" },
        CATALOG,
      ),
    ).toEqual({ backend: "codex", model: null, effort: null });
    expect(
      normalizeChoice(
        { backend: "claude-code", model: "gpt-5.6-sol", effort: "ultra" },
        CATALOG,
      ),
    ).toEqual({ backend: "claude-code", model: null, effort: null });
  });

  it("passes a stored Codex pick through while the catalog is still loading", () => {
    // Clearing it on every cold boot would make the sticky preference
    // un-sticky exactly when the user notices.
    expect(
      normalizeChoice(
        { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
        [],
      ),
    ).toEqual({ backend: "codex", model: "gpt-5.6-sol", effort: "ultra" });
  });
});

describe("parseChoice", () => {
  it("reads a stored blob", () => {
    expect(
      parseChoice({ backend: "codex", model: "gpt-5.5", effort: "high" }),
    ).toEqual({ backend: "codex", model: "gpt-5.5", effort: "high" });
  });

  it("degrades anything unrecognised to the default backend", () => {
    // Launching on a backend nobody chose is worse than losing a preference.
    for (const junk of [null, undefined, "codex", 7, [], { backend: "gpt" }]) {
      expect(parseChoice(junk).backend).toBe("claude-code");
    }
    expect(parseChoice({ backend: "codex", model: "  ", effort: 3 })).toEqual({
      backend: "codex",
      model: null,
      effort: null,
    });
  });
});

describe("choiceLabel", () => {
  it("reads the way the CLI's own picker does", () => {
    expect(choiceLabel(defaultChoice(), [])).toBe("Claude");
    expect(
      choiceLabel({ backend: "claude-code", model: "opus", effort: null }, []),
    ).toBe("Claude · opus");
    expect(
      choiceLabel(
        { backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
        CATALOG,
      ),
    ).toBe("Codex · GPT-5.6-Sol · xhigh");
  });

  it("falls back to the slug before the catalog loads", () => {
    expect(
      choiceLabel({ backend: "codex", model: "gpt-5.6-sol", effort: null }, []),
    ).toBe("Codex · gpt-5.6-sol");
  });
});

describe("agentLabelFor", () => {
  it("names the agent behind a stored session backend", () => {
    expect(agentLabelFor("codex")).toBe("Codex");
    expect(agentLabelFor("claude-code")).toBe("Claude");
    // Folded exactly like `ForkBackend::from_stored`, which picks the binary —
    // a thread must never run on Codex while its labels say Claude.
    expect(agentLabelFor(" Codex ")).toBe("Codex");
  });

  it("reads every legacy and unrecognised value as Claude", () => {
    // `sessions.backend` is NULL on every session written before a plan could
    // run on anything else, and those are all Claude. A blank or raw
    // identifier must never reach the discussion UI.
    for (const legacy of [null, undefined, "", "  ", "gpt", "anthropic"]) {
      expect(agentLabelFor(legacy)).toBe("Claude");
    }
  });
});
