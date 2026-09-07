// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_PLAN_PROFILE } from "./resumeCommand";

// The contract Codex plans under is INLINE, because Codex has no on-demand
// skill load on the plan path. That makes it the one piece of the round-trip
// that can rot without anything failing: a Codex planner that knows the
// `<proposed_plan>` shape but not the sidecar rule looks correct on v1 and
// silently paints the whole document as changed on v2.
//
// It is generated from the skill, lives as plain text (Rust reads it with
// `include_str!` and writes it into the user's Codex profile), and is asserted
// on from BOTH sides — `codex_profile.rs` owns the delivery half, this owns
// the drift half, because `npm test` is the fast loop.

const root = process.cwd();
const contract = readFileSync(
  join(root, "src-tauri/src/codex_plan_contract.txt"),
  "utf8",
);

describe("the codex plan contract", () => {
  it("is in sync with skills/redline-plan-review/SKILL.md", () => {
    // Regenerates in a subprocess and diffs against the committed file. A
    // reworded skill fails HERE rather than in a plan session's second round.
    expect(() =>
      execFileSync("node", ["scripts/gen-codex-contract.mjs", "--check"], {
        cwd: root,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("regenerating an in-sync contract does not touch the file", () => {
    // The file lives inside `tauri dev`'s watch root and is pulled in with
    // `include_str!`, so an mtime bump on it kills the running app and relinks
    // the crate. `npm run build` regenerates it through `prebuild` — which on
    // 2026-09-01 took Redline down twice, mid-review, when two Front Door plan
    // sessions each ran `ANALYZE=1 npm run build` about twenty seconds in. A
    // no-op regenerate has to be a no-op on disk.
    const path = join(root, "src-tauri/src/codex_plan_contract.txt");
    const before = statSync(path).mtimeMs;
    execFileSync("node", ["scripts/gen-codex-contract.mjs"], {
      cwd: root,
      stdio: "pipe",
    });
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(path, "utf8")).toBe(contract);
  });

  it("is off the dev watcher, so even a real change can't kill a session", () => {
    // Belt to the braces above: when the skill genuinely changes, the write
    // DOES happen, and it still must not tear down whatever is running. The
    // `.taurignore` entry is the only thing standing between a legitimate
    // regenerate and a dead window, so renaming or moving the artifact without
    // updating it has to fail here rather than in someone's session.
    const ignore = readFileSync(join(root, "src-tauri/.taurignore"), "utf8");
    expect(ignore).toContain("src/codex_plan_contract.txt");
  });

  it("carries the sidecar preservation rule — the silent half", () => {
    expect(contract).toContain("rl:blk-");
    expect(contract).toContain("preserve every");
    expect(contract).toContain("Never invent");
  });

  it("carries the resolutions contract — Redline can't close comments without it", () => {
    expect(contract).toContain("REDLINE_RESOLUTIONS");
    expect(contract).toContain("Do not skip any.");
  });

  it("carries every comment kind, so a question can't be applied as an edit", () => {
    for (const kind of ["[edit, local]", "[feedback, local]", "[question]"]) {
      expect(contract).toContain(kind);
    }
    expect(contract).toContain("in the resolution block only");
  });

  it("names the submission shape Codex actually has", () => {
    expect(contract).toContain("<proposed_plan>");
    expect(contract).toContain("</proposed_plan>");
    expect(contract).toContain("EXACTLY ONE block");
  });

  it("forbids raw HTML — it cannot carry block-id sidecars", () => {
    expect(contract).toContain("Never emit raw HTML");
  });

  it("tells Codex the review arrives inline, because its sandbox has no network", () => {
    // Verified on the real binary: a command run under codex's sandbox cannot
    // reach 127.0.0.1 at all. A contract that pointed at `GET …/feedback` the
    // way the Claude skill does would hang the round-trip.
    expect(contract).toContain("You do not fetch it");
    expect(contract).not.toContain("/v1/sessions/");
  });

  it("carries no Claude-only mechanic", () => {
    // There is no ExitPlanMode here, and telling a model to call a tool it
    // does not have is how a turn ends in confusion instead of a plan.
    expect(contract).not.toContain("ExitPlanMode");
    expect(contract).not.toContain("`Read` tool");
  });

  it("is delivered by a profile name both sides agree on", () => {
    // `codex -p <name>` with no such file is SILENT — not an error. A drifted
    // name would launch a plan session that was never told any of the above,
    // and nothing would say so until a revision destroyed a diff.
    const rust = readFileSync(join(root, "src-tauri/src/codex_profile.rs"), "utf8");
    const declared = /pub const PROFILE: &str = "([^"]+)"/.exec(rust)?.[1];
    expect(declared).toBe(CODEX_PLAN_PROFILE);
  });

  it("is not on the boot path — it is 6 KB of launch-time text", () => {
    // It lived in `src/lib/` as a TS module while the launch command carried
    // it as an argument. Nothing in the frontend needs the bytes now.
    expect(() => readFileSync(join(root, "src/lib/codexPlanContract.ts"))).toThrow();
  });
});
