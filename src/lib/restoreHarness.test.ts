// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  detachedBannerCopy,
  detachedPillTitle,
  harnessLabel,
  resolveRestoreHarness,
  restoreCopiedNote,
  restoreStartedNote,
  type RestorePrep,
} from "./restoreHarness";

const prep = (over: Partial<RestorePrep> = {}): RestorePrep => ({
  cwd: "/Users/me/redline",
  history: "available",
  relocated: false,
  primed: false,
  ...over,
});

describe("resolveRestoreHarness", () => {
  it("takes the stored provenance as the answer", () => {
    // It came from the hook payload of the session that actually wrote the
    // plan. That is the only witness there is.
    const codex = resolveRestoreHarness({ backend: "codex" });
    expect(codex.harness).toBe("codex");
    expect(codex.legacy).toBe(false);
    expect(codex.label).toBe("Codex");

    const claude = resolveRestoreHarness({ backend: "claude-code" });
    expect(claude.harness).toBe("claude-code");
    expect(claude.legacy).toBe(false);
    expect(claude.label).toBe("Claude Code");
  });

  it("never lets a reviewer's pick override stored provenance", () => {
    // There is nothing to override: the conversation exists in exactly one
    // harness's store. Honouring the pick here is how a known-Codex thread id
    // reaches `claude --resume`.
    expect(
      resolveRestoreHarness({ backend: "codex", choice: "claude-code" }).harness,
    ).toBe("codex");
    expect(
      resolveRestoreHarness({ backend: "claude-code", choice: "codex" }).harness,
    ).toBe("claude-code");
  });

  it("treats an unknown stored backend as Claude, not as legacy", () => {
    // Something was recorded, so there is nothing to ask about — and Claude is
    // the behaviour every row had before there was anything else to be.
    const d = resolveRestoreHarness({ backend: "gemini" });
    expect(d.harness).toBe("claude-code");
    expect(d.legacy).toBe(false);
  });

  it("asks on a legacy row, and runs Claude until it is answered", () => {
    const unasked = resolveRestoreHarness({ backend: null });
    expect(unasked.legacy).toBe(true);
    expect(unasked.chosen).toBe(false);
    expect(unasked.harness).toBe("claude-code");

    // Blank and whitespace-only are the same nothing.
    expect(resolveRestoreHarness({ backend: "" }).legacy).toBe(true);
    expect(resolveRestoreHarness({ backend: "   " }).legacy).toBe(true);
    expect(resolveRestoreHarness({}).legacy).toBe(true);
  });

  it("honours the pick once a legacy row's reviewer makes one", () => {
    const picked = resolveRestoreHarness({ backend: null, choice: "codex" });
    expect(picked.harness).toBe("codex");
    expect(picked.chosen).toBe(true);
    // Still legacy — nothing was stored, so the banner keeps offering the
    // choice rather than pretending Redline knows.
    expect(picked.legacy).toBe(true);
    expect(picked.label).toBe("Codex");
  });

  it("never infers a harness from the session id's shape", () => {
    // Current Codex issues UUID session ids, indistinguishable from Claude's.
    // The decision takes no id at all — this pins that it cannot start to.
    const uuid = "57b38664-9fa4-4b71-a5a2-fe88f70ac1b9";
    expect(resolveRestoreHarness({ backend: null }).harness).toBe(
      resolveRestoreHarness({ backend: null }).harness,
    );
    // The input type has no id field; passing one changes nothing.
    expect(
      resolveRestoreHarness({ backend: null, ...({ sessionId: uuid } as object) })
        .harness,
    ).toBe("claude-code");
  });
});

describe("restore notes — the two paths cannot diverge", () => {
  it("names the harness the restore actually runs", () => {
    const codex = resolveRestoreHarness({ backend: "codex" });
    expect(restoreStartedNote(codex, prep()).message).toContain("Codex session");
    expect(restoreCopiedNote(codex, prep()).message).toContain(
      "Codex resume command copied",
    );

    const claude = resolveRestoreHarness({ backend: "claude-code" });
    expect(restoreStartedNote(claude, prep()).message).toContain(
      "Claude Code session",
    );
  });

  it("never warns a Codex reviewer about a missing Claude transcript", () => {
    // `unchecked` is what a Codex preparation reports: nobody looked. Spending
    // the "resuming as a fresh conversation" warning on it would be a claim
    // about a private session-file layout Redline deliberately never reads.
    const codex = resolveRestoreHarness({ backend: "codex" });
    const started = restoreStartedNote(codex, prep({ history: "unchecked" }));
    const copied = restoreCopiedNote(codex, prep({ history: "unchecked" }));
    for (const m of [started.message, copied.message]) {
      expect(m).not.toContain("transcript");
      expect(m).not.toContain("fresh conversation");
      expect(m).not.toContain("Claude");
    }
  });

  it("still warns when Claude really has nothing to resume into", () => {
    // The one genuinely bad outcome, and the reviewer is owed it: the restore
    // lands (the sentinel carries the held plan's id) but the plan's history
    // is gone from that session's context.
    const claude = resolveRestoreHarness({ backend: "claude-code" });
    const started = restoreStartedNote(claude, prep({ history: "missing" }));
    expect(started.message).toContain("No saved transcript");
    expect(started.message).toContain("fresh conversation");
    expect(started.ms).toBe(8000);

    const copied = restoreCopiedNote(claude, prep({ history: "missing" }));
    expect(copied.message).toContain("no saved transcript");
  });

  it("says nothing about history when preparation never answered", () => {
    // The `unchecked` fallback: `prepare_restore` threw. Claiming either
    // "available" or "missing" from that would be inventing an answer.
    const claude = resolveRestoreHarness({ backend: "claude-code" });
    const m = restoreStartedNote(claude, prep({ history: "unchecked" })).message;
    expect(m).not.toContain("fresh conversation");
    expect(m).toContain("Claude Code session");
  });
});

describe("detached copy", () => {
  it("names the harness that actually left", () => {
    const codex = detachedBannerCopy(resolveRestoreHarness({ backend: "codex" }));
    expect(codex.lede).toBe("Codex is no longer waiting for this plan.");
    // A Codex reviewer told "the Claude Code session ended" is being pointed
    // at a process they never started.
    expect(codex.lede + codex.body).not.toContain("Claude");

    const claude = detachedBannerCopy(
      resolveRestoreHarness({ backend: "claude-code" }),
    );
    expect(claude.lede).toBe("Claude is no longer waiting for this plan.");
    expect(claude.body).toContain("Claude Code session ended");
  });

  it("claims neither harness on an unanswered legacy row", () => {
    const legacy = detachedBannerCopy(resolveRestoreHarness({ backend: null }));
    expect(legacy.lede + legacy.body).not.toContain("Claude");
    expect(legacy.lede + legacy.body).not.toContain("Codex");
    expect(legacy.body).toContain("pick the harness");
  });

  it("names it once the legacy row's reviewer has chosen", () => {
    const chosen = detachedBannerCopy(
      resolveRestoreHarness({ backend: null, choice: "codex" }),
    );
    expect(chosen.lede).toContain("Codex");
    expect(chosen.body).not.toContain("pick the harness");
  });

  it("keeps the sidebar pill honest for all three cases", () => {
    expect(detachedPillTitle("codex")).toContain("Codex");
    expect(detachedPillTitle("codex")).not.toContain("Claude");
    expect(detachedPillTitle("claude-code")).toContain("Claude Code");
    // Legacy: the pill can't name a harness it doesn't know.
    const legacy = detachedPillTitle(null);
    expect(legacy).not.toContain("Claude");
    expect(legacy).not.toContain("Codex");
    expect(legacy).toContain("Restore plan session");
  });

  it("labels both harnesses the way the reviewer would say them", () => {
    expect(harnessLabel("codex")).toBe("Codex");
    expect(harnessLabel("claude-code")).toBe("Claude Code");
  });
});
