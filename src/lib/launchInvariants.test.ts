// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Cross-file laws. The house pattern for a claim that spans files and has no
// pure home — each one here is a rule that a future edit could break silently
// and that no unit test would notice.

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8");
const app = read("src/App.tsx");
const drafter = read("src/components/PromptDrafter.tsx");
const frontDoor = read("src/components/FrontDoor.tsx");

describe("the restore contract spans TS and Rust", () => {
  // The restore's environment is written in TypeScript and read in Rust, by
  // name, through a shell. Nothing checks the two agree at build time: a
  // renamed variable on either side produces a hook that forwards an empty
  // header, a route that sees no restore, and a restore that still WORKS —
  // just without the hidden protocol, silently, forever.
  const rustEnv = read("src-tauri/src/restore_context.rs");
  const hook = read("src-tauri/src/hook.rs");
  // The command itself is rendered by the Polis hook installer since the
  // extraction's Session A6 (a git dependency since A7, so its source is not
  // in this tree); Redline's hook.rs hands it the (header, env) pairs and
  // pins the rendered bytes (`capture_command_is_pinned`) — that pin is what
  // this file reads.
  const ts = read("src/lib/resumeCommand.ts");

  it("names the same three environment variables on both sides", () => {
    for (const name of [
      "REDLINE_RESTORE_TARGET",
      "REDLINE_RESTORE_PRIMED",
      "REDLINE_RESTORE_RESCINDED",
    ]) {
      expect(ts, `${name} missing from the TS half`).toContain(name);
      expect(rustEnv, `${name} missing from the Rust half`).toContain(name);
    }
  });

  it("agrees on the seat the restore runs under", () => {
    expect(ts).toContain('export const RESTORE_SEAT = "restore";');
    expect(rustEnv).toContain('pub const RESTORE_SEAT: &str = "restore";');
  });

  it("agrees on the prefix that identifies the trigger itself", () => {
    // Not decoration. The metadata rides the resumed process's ENVIRONMENT, so
    // it is on every prompt that session submits — including the CLI's own
    // `<system-reminder>` injections, which fire UserPromptSubmit shaped
    // exactly like a keystroke. Drift here means an injection consumes the
    // one-shot arming and the real restore gets no protocol at all.
    expect(ts).toContain(
      'export const RESTORE_TRIGGER_PREFIX = "Redline restore \u00b7 ";',
    );
    expect(rustEnv).toContain(
      'pub const TRIGGER_PREFIX: &str = "Redline restore \\u{b7} ";',
    );
  });

  it("the capture hook is what carries the environment across", () => {
    // The one place the two halves actually meet. `${VAR:-}` inside DOUBLE
    // quotes: single quotes would ship the literal variable name. Redline
    // wires the pair; the pinned rendering shows the spec expanding it the
    // right way.
    expect(hook).toContain(".with_header(rc::HEADER_TARGET, rc::ENV_TARGET)");
    expect(hook).toContain(
      '-H \\"X-Redline-Restore: ${REDLINE_RESTORE_TARGET:-}\\"',
    );
  });
});

describe("one launch pipeline", () => {
  it("the plan launch command is built in exactly one place", () => {
    // Three surfaces launch the same `claude --permission-mode plan`. A second
    // construction site is how they drifted apart in the first place — only one
    // of them gated on readiness or handled a missing terminal.
    const hits = countIn("src", "buildPlanLaunchCommand(");
    expect(hits, `built in ${hits} places`).toBe(1);
  });

  it("the ledger write is followed by a .catch — the missing one, as a guard", () => {
    const at = app.indexOf("record_plan_launch");
    expect(at).toBeGreaterThan(-1);
    // Window sized to the whole invoke + its handler; the argument object has
    // grown (recordBody/userText and their comments) and a tight slice would
    // fail on the comment, not on a missing guard.
    const after = app.slice(at, at + 1400);
    expect(
      after,
      "a bare `void invoke(...)` here made a failed ledger write 100% silent",
    ).toContain(".catch(");
  });

  it("the codex launch is built in that same one place", () => {
    // A second builder is how a Codex launch would quietly lose `-s read-only`
    // — which is the entire difference between a plan session and one that can
    // edit the repo.
    const hits = countIn("src", "-s read-only -a never");
    expect(hits, `codex sandbox flags written in ${hits} places`).toBe(1);
    // Remote resume rejects permission flags; its server owns the defaults.
    const launcher = read("src-tauri/src/codex_plan_launch.sh");
    expect(launcher).toContain('sandbox_mode="read-only"');
    expect(launcher).toContain('approval_policy="never"');
  });

  it("both restore paths pick their harness from one decision", () => {
    // The embedded terminal and the clipboard fallback build the same command.
    // If either read `session.backend` directly it would ignore a legacy row's
    // harness choice — and hand `claude --resume` a Codex thread id, which does
    // not error: it silently starts a FRESH session that writes the restore
    // sentinel under an id Redline never held.
    expect(countIn("src", "buildResumeCommand(")).toBe(2);
    const sites = app.split("buildResumeCommand(").slice(1);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      const args = site.slice(0, 800);
      expect(args).toContain("backend: restoreDecision.harness");
      expect(args).not.toContain("backend: session.backend");
    }
  });

  it("fresh provider readiness gates BOTH restore paths", () => {
    // Two guards, one per path. A gate on only the embedded terminal is worse
    // than none: "Copy resume command" then becomes the way to route around it,
    // and it fails in a shell where nothing is watching for the answer.
    expect(countIn("src", "await checkRestoreHealth()")).toBe(2);
    expect(app).toContain("integrationHealth.refresh({ backend: restoreDecision.harness");
  });

  it("restore preparation always names the harness", () => {
    // `prepare_restore` reads ~/.claude for a transcript, a startup cwd and a
    // plan file to prime. Called without a backend it runs all three for a
    // Codex thread, arrives at "missing", and the UI reports that to the
    // reviewer as "no saved transcript — resuming as a fresh conversation".
    expect(countIn("src", '"prepare_restore"')).toBe(1);
    const call = app.slice(app.indexOf('"prepare_restore"'));
    expect(call.slice(0, 900)).toContain("backend:");
  });

  it("the door's harness pick has exactly one owner", () => {
    // The Drafter and the browser's "Send to Redline" launch through the same
    // `launchPlan`, which reads this one stored value. A second persisted
    // copy is how two doors would launch onto different backends from the
    // same setting.
    expect(countIn("src", '"redline.frontDoor.backend"')).toBe(1);
  });

  it("the combine brief is composed in exactly one place, and not in src/", () => {
    // The brief is mostly contract prose, and prose in a TS module is boot
    // bytes on the door's own path — the exact reason the Codex plan contract
    // moved to `src-tauri/src/codex_plan_contract.txt` behind `include_str!`
    // and took 6.4 KB back off the entry chunk. `combine_brief` is the one
    // composition site; the frontend asks for the brief, it never builds one.
    expect(countIn("src", '"combine_brief"')).toBe(1);
    // No contract prose leaked back into the bundle. These are phrases from
    // `src-tauri/src/combine_contract.txt` — if any of them appear in src/,
    // someone has started composing the brief here again.
    for (const prose of [
      "orchestration-ready plan",
      "Depends on: Track",
      "Verification per track",
    ]) {
      expect(countIn("src", prose), `contract prose "${prose}" is in src/`).toBe(
        0,
      );
    }
    // And the brief itself never round-trips through a second construction:
    // App hands `combine_brief`'s output straight to the one launch door.
    expect(app).toContain('origin: "combine"');
    expect(app).toContain("prompt: composed.brief");
  });

  it("the lake never receives the brief, only the record", () => {
    // A `CorpusRole::User` row with `author: None` is permanently
    // uncompactable (`keeper::select_compaction_candidates` filters
    // `role != "user"`), so filing 120 KB of concatenated machine-written
    // plans there would embed and FTS-index a machine blob as if it had been
    // typed. `recordBody` is how the row diverges from the typed body.
    const at = app.indexOf("recordBody: composed.record");
    expect(at, "the launch must record the record, not the brief").toBeGreaterThan(
      -1,
    );
    expect(app).not.toContain("recordBody: composed.brief");
  });

  it("the pending launch is NEVER persisted", () => {
    // A stale "Planning…" card outliving a restart claims a session that
    // certainly isn't running.
    expect(app).toContain("useState<PendingLaunch | null>(null)");
    expect(app).not.toContain('usePersistedState<PendingLaunch');
  });
});

describe("the door's tall menu is placed, not guessed", () => {
  it("the harness picker measures its room instead of capping at a vh", () => {
    // It stacks harness + up to nine models + up to seven efforts. An
    // absolutely-positioned `bottom: 100%` menu capped at `56vh` quotes a
    // fraction of the WINDOW, which says nothing about the room above the chip
    // — so it ran off the top of the screen and the Harness rows, rendered
    // first, were unreachable. `useClickPopover` portals to document.body and
    // hands back the room that is actually there as `maxHeight`.
    expect(frontDoor).toContain("useClickPopover(btnRef");
    const at = frontDoor.indexOf("function BackendMenu");
    expect(at).toBeGreaterThan(-1);
    const body = frontDoor.slice(at, frontDoor.indexOf("const MENU_GLASS", at));
    expect(body).not.toMatch(/\bvh\b/);
    expect(body).not.toContain("rl-fd-menu ");
  });
});

describe("the second door adds no new probing", () => {
  it("preflight_status is INVOKED in exactly one place", () => {
    // It can reach `codex --help` and an interactive login shell — child
    // processes, TCC-visible, and slow. A second caller would double that for
    // nothing. That one place is now `lib/integrationHealth`, which shares a
    // single in-flight probe across boot, the focus refresh, the settings
    // panel and the launch gate; App no longer invokes it at all. Counted as
    // a CALL, not as a word: the name appears in doc comments too, and
    // pinning those would make this fail on a rewording.
    expect(countIn("src", '"preflight_status", {')).toBe(1);
    expect(app, "App must go through the shared service").not.toContain(
      'invoke<PreflightStatus>("preflight_status")',
    );
  });

  it("the shared health service is the only cache, and every asker uses it", () => {
    // A second `makeHealthService(...)` would be a second in-flight probe
    // wearing the same name — the exact duplication this replaced.
    const health = read("src/lib/integrationHealth.ts");
    expect(
      [...health.matchAll(/makeHealthService\(/g)].length,
      "one factory, one call — a second instance is a second cache",
    ).toBe(2); // the definition and its single instantiation
    // Boot's old five-invoke status batch is gone: the shell asks
    // `bootstrap_state` (no child processes) and health follows the reveal.
    for (const gone of [
      'invoke<HookStatus>("get_hook_status")',
      'invoke<CodexHookStatus>("get_codex_hook_status")',
      'invoke<SkillStatus>("get_codex_skill_status")',
      'invoke<SkillStatus>("get_skill_status")',
    ]) {
      expect(app, `${gone} is back on the boot path`).not.toContain(gone);
    }
    expect(app).toContain('invoke<BootstrapState>("bootstrap_state")');
  });

  it("a launch awaits the probe rather than reading React state", () => {
    // The gate used to read `readinessRef.current`, which on the tick after an
    // await still holds the PRE-probe value. Deriving from the payload just
    // awaited is what makes "the shell came up fast" safe.
    const at = app.indexOf("const launchPlan = async");
    expect(at, "launchPlan must be async to await the boundary").toBeGreaterThan(
      -1,
    );
    const body = app.slice(at, at + 4000);
    expect(body).toContain("await integrationHealth");
    expect(body).toContain("await ensureDaemonReady()");
    expect(body).toContain("readinessInputRef.current({");
  });

  it("integration faults surface AFTER the reveal, and never allow a launch", () => {
    // Both halves of the deal. The setup modal must not FLASH before the
    // post-reveal probe answers — `integrationReady` (`preflight !== null`)
    // leads its condition, so "not asked yet" withholds it rather than
    // rendering it against null status…
    expect(app).toContain("const integrationReady = preflight !== null;");
    const modal = app.indexOf("const setupModalActive =");
    expect(modal).toBeGreaterThan(-1);
    expect(app.slice(modal, modal + 200)).toContain("integrationReady &&");
    // …and the shell's own bootstrap must not wait for any of it: the boot
    // effect asks `bootstrap_state` and nothing else.
    const bootEffect = app.slice(
      app.indexOf("// ── Core bootstrap ─"),
      app.indexOf("// Route external links"),
    );
    expect(bootEffect).toContain('invoke<BootstrapState>("bootstrap_state")');
    for (const probe of ["preflight_status", "get_hook_status", "get_skill_status"]) {
      expect(bootEffect, `${probe} is back on the shell's critical path`).not.toContain(
        probe,
      );
    }
  });

  it("PromptDrafter probes nothing itself — it renders what App derived", () => {
    expect(drafter).not.toContain('invoke("preflight_status"');
    expect(drafter).not.toContain('invoke<PreflightStatus>');
    expect(drafter).not.toContain("deriveReadiness(");
  });
});

describe("readiness in the Drafter is deliberately asymmetric", () => {
  it("renders BlockedLaunch but never a standing strip", () => {
    // Decision 4: readiness appears at exactly two moments — a refused launch,
    // and a pending one that has gone quiet. A permanent fault row under
    // someone's prose is chrome they learn to stop seeing, which is the exact
    // failure readiness exists to fix.
    expect(drafter).toContain("BlockedLaunch");
    expect(drafter).not.toContain("<ReadinessStrip items={readiness}");
  });

  it("but the blocker itself is never optional", () => {
    // Without it the Drafter runs the identical launch with zero preflight and
    // hands the user a terminal spinning over nothing.
    expect(drafter).toContain("attemptLaunch(readiness)");
  });
});

describe("the project pick is tagged", () => {
  it("the load effect no longer guards with `if (path)`", () => {
    // That guard is what let document A's repo answer for document B —
    // permanently reassigning B and launching its prompt into the wrong cwd.
    expect(app).not.toMatch(/if \(loaded\?\.projectPath\) setDrafterProject/);
    expect(app).toContain("setDrafterProject({ forId");
  });

  it("the persist unwraps through projectForDoc", () => {
    const persist = app.indexOf("const drafterPersist");
    const end = app.indexOf("[drafterDraftId, drafterProject]", persist);
    expect(app.slice(persist, end)).toContain("projectForDoc(drafterProject");
  });
});

/** Count occurrences of `needle` across the .ts/.tsx files under `dir`,
 *  excluding tests (which quote these names to pin them). */
function countIn(dir: string, needle: string): number {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  let n = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(join(process.cwd(), d))) {
      const rel = `${d}/${entry}`;
      const full = join(process.cwd(), rel);
      if (statSync(full).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      let i = text.indexOf(needle);
      while (i !== -1) {
        // Skip the import statement — importing a symbol isn't a call site.
        const lineStart = text.lastIndexOf("\n", i) + 1;
        const line = text.slice(lineStart, text.indexOf("\n", i));
        if (!/^\s*(import|export)\b/.test(line) && !line.trimStart().startsWith("*"))
          n += 1;
        i = text.indexOf(needle, i + 1);
      }
    }
  };
  walk(dir);
  return n;
}
