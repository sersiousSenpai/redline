// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Generate `src/lib/codexPlanContract.ts` from the redline-plan-review skill.
//
// WHY THIS IS GENERATED RATHER THAN WRITTEN
//
// A Claude plan session gets the round-trip contract from the
// `redline-plan-review` skill, loaded on demand. Codex has no equivalent
// guarantee: skills are installed under `~/.codex/skills` but *enablement* is
// a separate, unverified axis, and there is no `Skill` tool on the plan path.
// So Codex gets the contract through `developer_instructions`, delivered as a
// Codex CONFIG PROFILE (`~/.codex/redline-plan.config.toml`, selected with
// `-p redline-plan`) rather than inline on the command line. It was inline
// first, and the command it produced was 6,476 bytes — which the macOS tty
// input queue truncated at byte 1023, so the launch arrived at the shell cut
// off mid-word and never ran. The profile file makes the launch ~200 bytes.
// (Precedent for inlining the contract at all rather than trusting a skill
// load: `memchat.rs` does the same with the retrieval contract.)
//
// Inlining a hand-copied contract is how the two halves drift. Shipping a
// Codex planner that knows the `<proposed_plan>` shape but *not* the revision
// contract is the single worst outcome available here — it looks like it works
// on v1 and silently corrupts the diff on v2. So the sections that actually
// carry the round-trip (§1–§4) are lifted verbatim from the skill, and the
// handful of Claude-only mechanics inside them are rewritten by an explicit
// table that FAILS LOUDLY when a pattern stops matching. A reworded skill
// breaks this script rather than quietly emitting Claude instructions to a
// harness that has no ExitPlanMode.
//
// Run: node scripts/gen-codex-contract.mjs        (writes the file)
//      node scripts/gen-codex-contract.mjs --check (exit 1 if out of date)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(root, "skills/redline-plan-review/SKILL.md");
// Plain text, read by Rust with `include_str!` and written into the user's
// Codex profile at install time. It used to be a TS module, back when the
// launch command carried the contract as an argument; nothing in the frontend
// needs these 6 KB now, and they were 6 KB of the boot chunk.
const OUT = join(root, "src-tauri/src/codex_plan_contract.txt");

/** The skill sections that carry the round-trip, in order. Everything else is
 *  Claude-only plumbing: §0 is the out-of-band fetch (a Codex plan session is
 *  sandboxed with no network and is handed the review inline instead), §5 is
 *  discussion forks, §6 is the agent-in-doc write bridge (same network wall),
 *  §7 is the `--resume` restore handshake (the Codex resume prompt carries its
 *  own, self-contained). */
const SECTIONS = [
  "## 1. Write presentation-aware markdown — never raw HTML",
  "## 2. Preserve block-identity sidecars on a revision",
  "## 3. Answer every comment in a REDLINE_RESOLUTIONS block",
  "## 4. The feedback payload — comment kinds and the two modes",
];

/** Claude mechanic → Codex mechanic. Every entry MUST match at least once;
 *  a miss means the skill was reworded and this script needs updating, which
 *  is exactly the drift we want to be told about. */
const TRANSLATIONS = [
  [
    "When you call\n`ExitPlanMode` again, include at the top of the plan body",
    "When you emit\nyour revised plan, include at the top of the plan body",
  ],
  [
    "keep the sidecars (§2), add the\n  resolution block (§3), and call `ExitPlanMode`.",
    "keep the sidecars (§2), add the\n  resolution block (§3), and emit the whole plan in one `<proposed_plan>`\n  block.",
  ],
  [
    "**read each one with the `Read`\n  tool**",
    "**open and read each one**",
  ],
];

/** Nothing Claude-only may survive into the contract. */
const FORBIDDEN = ["ExitPlanMode", "Claude Code", "`Read` tool"];

function section(md, heading) {
  const start = md.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`skill section not found: ${heading}`);
  const from = start + 1;
  const nextHeading = md.indexOf("\n## ", from);
  const end = nextHeading === -1 ? md.length : nextHeading + 1;
  return md.slice(from, end).trimEnd();
}

/** The Codex-specific frame. The skill cannot supply this: it describes a
 *  harness whose plan submission is a tool call, and Codex's is a block in the
 *  final message. */
const PREAMBLE = `# Redline plan contract

You are the planning agent for Redline, a desktop plan-review companion.
Until the reviewer approves the plan, research and propose it READ-ONLY.
Do not create, modify or delete any file, run a mutating command, or start a
build during planning or revision.

After approval, Redline changes this thread to implementation mode and sends
"Redline plan approved" with the approved plan. That ends the planning-only
restriction: implement the approved plan, run appropriate checks, and report
the result. Do not ask for approval again or resubmit the approved plan.
A restore request starts a new read-only review; wait for its new approval.

## How you submit a plan

End your turn with EXACTLY ONE block, at the very end of your final message:

    <proposed_plan>
    ...the complete plan, as markdown...
    </proposed_plan>

That block IS the submission — there is no tool call and no mode to exit.
Rules, all load-bearing:

- Exactly one opening and one closing marker in the whole message. Two blocks,
  an unclosed block, or the marker mentioned in prose all mean Redline
  captures nothing and your work is lost.
- The block holds the WHOLE plan, not a summary of one. Anything outside it is
  conversation and is discarded.
- Never write the marker while merely discussing it.

## How a review comes back to you

Redline holds your turn while the reviewer marks the plan up in a
track-changes editor. Their review is returned to you as the continuation of
this same turn: a message carrying the full feedback payload described in §4.

**You do not fetch it and you must not try.** Your sandbox has no network, so
any curl you run will hang or fail — the payload is already in front of you.
When it arrives, produce the next version per §2–§4 and end the turn with a
fresh \`<proposed_plan>\` block.
`;

function build() {
  const md = readFileSync(SKILL, "utf8");
  const version = /^version:\s*(\d+)\s*$/m.exec(md)?.[1] ?? "0";
  let body = SECTIONS.map((h) => section(md, h)).join("\n\n");
  for (const [from, to] of TRANSLATIONS) {
    if (!body.includes(from)) {
      throw new Error(
        `translation no longer matches the skill — reword or update it:\n  ${JSON.stringify(from)}`,
      );
    }
    body = body.split(from).join(to);
  }
  const contract = `${PREAMBLE}\n${body}\n`;
  for (const bad of FORBIDDEN) {
    if (contract.includes(bad)) {
      throw new Error(`Claude-only mechanic survived into the contract: ${bad}`);
    }
  }
  // The two halves that must never be missing. Asserted here as well as in the
  // vitest guard so a bad generate can't even be written to disk.
  for (const required of ["rl:blk-", "REDLINE_RESOLUTIONS", "<proposed_plan>"]) {
    if (!contract.includes(required)) {
      throw new Error(`contract is missing ${required}`);
    }
  }
  return contract
}

const generated = build();
if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== generated) {
    console.error(
      `${OUT} is out of date with the skill — run: node scripts/gen-codex-contract.mjs`,
    );
    process.exit(1);
  }
  console.log("codex plan contract is in sync");
} else {
  // Compare before writing. `npm run build` runs this through `prebuild`, and
  // OUT lives inside `tauri dev`'s watch root: an mtime bump on a file that
  // `include_str!` pulls in kills the running app and relinks the whole crate.
  // Two Front Door plan sessions died that way on 2026-09-01 — each ran
  // `ANALYZE=1 npm run build` about twenty seconds in, and the unconditional
  // write below took the app down with it. A no-op regenerate must be a no-op
  // on disk. (`src-tauri/.taurignore` covers the case where it genuinely does
  // change; this covers the case where it does not, which is nearly always.)
  if (existsSync(OUT) && readFileSync(OUT, "utf8") === generated) {
    console.log(`${OUT} is up to date`);
  } else {
    writeFileSync(OUT, generated);
    console.log(`wrote ${OUT}`);
  }
}
