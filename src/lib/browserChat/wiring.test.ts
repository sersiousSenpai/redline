// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import contract from "./contract.json";

// Cross-file conformance: the laws a future edit could break silently because
// they span two languages, the skill, or three components. The Rust half is
// `mod contract` in browse.rs, which reads the same contract.json.
//
// Two kinds of test:
//   it(...)        holds today; keep it green.
//   it.fails(...)  a KNOWN VIOLATION found on 2026-10-10. It passes while the
//                  code is still wrong and turns RED the moment someone fixes
//                  it, which is the cue to change `it.fails` to `it` in the
//                  same change. A ratchet: the fix lands with its guard.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const browseRs = read("src-tauri/src/browse.rs");
const actionsRs = read("src-tauri/src/browser_actions.rs");
const libRs = read("src-tauri/src/lib.rs");
const turnRs = read("src-tauri/src/turn.rs");
const codeRs = read("src-tauri/src/code.rs");
const procRs = read("src-tauri/src/claude_proc.rs");
const skillRs = read("src-tauri/src/skill.rs");
const skill = read("skills/browse/SKILL.md");
const chat = read("src/components/BrowserChat.tsx");
const pane = read("src/components/BrowserPane.tsx");
const app = read("src/App.tsx");
/** App plus the Front Door and the pill's card, wherever they are drawn. */
const door = [app, ...readdirSync(join(process.cwd(), "src/components"))
  .filter((f) => /^(FrontDoor|.*Island).*\.tsx$/.test(f) && !f.includes(".test."))
  .map((f) => read(`src/components/${f}`))].join("\n");

/** The body of `fn name(` up to the next top-level closing brace. */
const fnBody = (src: string, name: string) => {
  const at = src.indexOf(`fn ${name}(`);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
};
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** A route's last segment as text names it (`/navigate`, `/click`). */
const routeLeaf = (route: string) => route.slice(route.lastIndexOf("/"));
/** A test elsewhere in the repo pins this rule; prove it still exists. */
const pinnedBy = (file: string, title: string) =>
  expect(read(file).includes(title), `${file} no longer has "${title}"`).toBe(true);

describe("backend and front end speak one contract", () => {
  it("BC-12 the envelope's keys are browse_send's parameters", () => {
    const at = browseRs.indexOf("pub async fn browse_send(");
    const sig = browseRs.slice(at, browseRs.indexOf(") -> Result<SendOutcome", at));
    const params = [...sig.matchAll(/^\s{4}(\w+): (?!tauri::State|AppHandle)/gm)].map((m) => camel(m[1]));
    expect(params).toEqual(contract.sendParams);
  });
  it("BC-12 per-turn scope phrases are the ones the backend writes", () => {
    for (const phrase of Object.values(contract.scopePhrases)) expect(browseRs).toContain(`"${phrase}"`);
  });
  it("BC-19 the action kinds the contract names are the ones the route accepts", () => {
    const at = actionsRs.indexOf("pub enum Operation");
    const op = actionsRs.slice(at, actionsRs.indexOf("}\n", at));
    expect([...op.matchAll(/^\s{4}(\w+) \{/gm)].map((m) => m[1].toLowerCase())).toEqual(contract.actionKinds);
    expect(libRs).toContain(`"${contract.actionRoute}"`);
    const served = [...contract.readRoutes, ...contract.tabRoutes, contract.writeRoute, ...contract.codeRoutes];
    for (const route of served) expect(libRs).toContain(`"${route}"`);
  });
  it("BC-19 the old page routes keep answering an agent that still calls them", () => {
    for (const route of contract.legacyRoutes) expect(libRs).toContain(`"${route}"`);
  });
  it("BC-27 the queue cap is turn.rs's", () => {
    expect(turnRs).toContain(`pub const QUEUE_CAP: usize = ${contract.queueCap};`);
  });
  it("BC-17 the project cap is code.rs's", () => {
    expect(codeRs).toContain(`pub const MAX_PROJECTS: usize = ${contract.maxProjects};`);
  });
  it("BC-13 a Mosaic's page chat is captured as 'no mission'", () => {
    const capture = fnBody(browseRs, "captured_browse_mission");
    for (const prefix of contract.noMissionWorkspaces.prefixes) expect(capture).toContain(`"${prefix}"`);
  });
});

describe("the skill and the prompt teach what the backend does", () => {
  it("BC-1 BC-20 BC-21 tabs by number, web tools granted, download is the only write", () => {
    expect(skill).toContain("never the internal id");
    expect(skill).toContain("You are granted WebSearch and WebFetch");
    expect(skill).toContain("*only* path to disk");
  });
  it("BC-R2 the linked skill stays retired", () => {
    expect(skillRs).toMatch(/RETIRED_SKILLS: &\[&str\] = &\[[^\]]*"linked"/);
    expect(existsSync(join(process.cwd(), "skills/linked"))).toBe(false);
  });
  it("BC-19 the skill teaches the captured target, the action route and shared chats", () => {
    for (const phrase of contract.skill.mustMention) expect(skill.toLowerCase(), `SKILL.md should mention ${phrase}`).toContain(phrase.toLowerCase());
    for (const route of contract.legacyRoutes) expect(skill, `SKILL.md still teaches ${route}`).not.toContain(routeLeaf(route));
  });
  it("BC-19 the first-turn tool docs teach the action route, not the old page routes", () => {
    const docs = fnBody(browseRs, "build_first_turn_prompt");
    expect(docs).toContain(contract.actionRoute);
    for (const route of contract.legacyRoutes) expect(docs, `the first turn still teaches ${route}`).not.toContain(routeLeaf(route));
  });
  it("BC-R3 retired behaviour is gone from the skill", () => {
    for (const phrase of contract.skill.mustNotMention) expect(skill, `SKILL.md still teaches: ${phrase}`).not.toContain(phrase);
  });
  // Open: the tandem sources strip's commands have no caller. They span
  // lib.rs, db.rs and state.rs, so they go in one deletion of their own.
  it.fails("BC-R3 KNOWN DEAD PATH: the retired sources strip's commands are gone", () => {
    expect(libRs, "set_source_feedback has no caller").not.toContain("fn set_source_feedback(");
  });
  it("BC-13 a page chat's first turn reads the CAPTURED mission's routes, not the global ones", () => {
    expect(browseRs).not.toMatch(/[^_]mission_context_block\(/);
    expect(browseRs).toContain("captured_mission_context_block(");
  });
  it("BC-22 the consult framing names its real caller", () => {
    expect(fnBody(browseRs, "consult_framing")).toContain("Companion");
    for (const phrase of contract.consultMustNotMention) expect(browseRs).not.toContain(phrase);
  });
  // Open, needs a schema decision: in linked mode the discussion about a tab
  // lives in the shared chat, so this check-in reads that tab's empty thread.
  it.todo("BC-22 /thread?tab= also returns the shared-chat turns that targeted that tab");
  it("BC-23 pinned by browse.rs first_turn_prompt_embeds_active_mission_goal", () => pinnedBy("src-tauri/src/browse.rs", "fn first_turn_prompt_embeds_active_mission_goal"));
  it("BC-17 pinned by browse.rs project_cards_are_once_per_session_and_never_match_snapshot_text", () => pinnedBy("src-tauri/src/browse.rs", "fn project_cards_are_once_per_session_and_never_match_snapshot_text"));
  it("BC-18 pinned by browse.rs provider-switch tests", () => {
    pinnedBy("src-tauri/src/browse.rs", "fn a_provider_switch_never_resumes_the_other_providers_id");
    pinnedBy("src-tauri/src/browse.rs", "fn a_switched_provider_is_handed_the_turns_it_missed");
  });
  it("BC-30 pinned by db.rs a_browse_chat_pick_outlives_its_session_but_not_its_thread", () => pinnedBy("src-tauri/src/db.rs", "fn a_browse_chat_pick_outlives_its_session_but_not_its_thread"));
});

describe("the activity line names what the agent is doing", () => {
  it.fails("BC-34 KNOWN VIOLATION: a page action is named in the activity line, not as a bare 'Bash…'", () => {
    const phrases = [...Object.values(contract.activityLabels), ...Object.values(contract.actionLabels), ...Object.values(contract.tabActivityLabels)];
    for (const phrase of phrases) expect(procRs, `claude_proc.rs has no "${phrase}"`).toContain(phrase);
    for (const route of contract.retiredRoutes) expect(procRs, `dead branch for ${route}`).not.toContain(route);
  });
  it.fails("BC-34 KNOWN VIOLATION: a page action's acknowledgement says what it did and on which tab", () => {
    const result = actionsRs.slice(actionsRs.indexOf("pub struct ActionResult"), actionsRs.indexOf("}\n", actionsRs.indexOf("pub struct ActionResult")));
    expect(result).toMatch(/pub kind: /);
    expect(result).toMatch(/pub tab: /);
  });
  it.fails("BC-34 KNOWN GAP: the action route's acknowledgements reach the chat's tool row", () => {
    expect(actionsRs).toContain('emit("browser-action"');
    expect(/listen<[^>]*>\(\s*"browser-action"/.test(chat + pane), "nothing listens to browser-action").toBe(true);
  });
});

describe("the page chat's UI laws", () => {
  it("BC-27 the composer is never disabled", () => {
    const textarea = chat.slice(chat.indexOf("<textarea"), chat.indexOf("/>", chat.indexOf("<textarea")));
    expect(textarea).not.toMatch(/\bdisabled=/);
  });
  it("BC-33 nothing in the chat takes the caret on mount", () => {
    expect(chat).not.toMatch(/autoFocus/);
  });
  it("BC-35 links in replies open as Redline tabs", () => {
    expect(chat).toMatch(/<MarkdownView[^>]*onLinkClick=\{onOpenLink\}/);
  });
  it("BC-36 linked mode is an icon in the chat header", () => {
    expect(chat).toContain('aria-label="Linked mode"');
  });
  it("BC-R4 BC-R5 no rail, no pane-owned switcher, no iframe", () => {
    expect(existsSync(join(process.cwd(), "src/components/DockEdgeTab.tsx"))).toBe(false);
    expect(pane).not.toContain("DiscussionSwitcher");
    expect(pane + chat).not.toMatch(/^\s*<iframe\b/m);
  });
  it("BC-R1 pinned by BrowserPane.lifecycle.test 'forgets the retired per-tab chat key'", () => pinnedBy("src/components/BrowserPane.lifecycle.test.tsx", "forgets the retired per-tab chat key"));
  it("BC-2 BC-3 pinned by BrowserPane.lifecycle.test linked-mode cases", () => {
    pinnedBy("src/components/BrowserPane.lifecycle.test.tsx", "gives every tab its own chat by default, and a flip to shared lasts until you switch away");
    pinnedBy("src/components/BrowserPane.lifecycle.test.tsx", "switches every tab to the shared chat with the mode toggle, and back");
  });
  it("BC-25 pinned by BrowseHarnessChip.test", () => {
    pinnedBy("src/components/BrowseHarnessChip.test.tsx", "is never disabled, so a pick can change while a reply streams");
    pinnedBy("src/components/BrowseHarnessChip.test.tsx", "inherits the last pick on a new chat and stores it on the first send only");
  });
  it("BC-26 pinned by BrowserChat.header.test", () => {
    pinnedBy("src/components/BrowserChat.header.test.tsx", "signs each reply with the provider that wrote it");
    pinnedBy("src/components/BrowserChat.header.test.tsx", "bylines the streaming reply with the provider it was sent to, not a pick made since");
  });
  it("BC-28 pinned by useAgentTurn.test", () => {
    pinnedBy("src/hooks/useAgentTurn.test.ts", "restores a mid-turn stream from the probe, then folds only the new deltas");
    pinnedBy("src/hooks/useAgentTurn.test.ts", "drops a send whose args were still building when the panel went away");
  });
  it("BC-32 pinned by browseChatState.test", () => pinnedBy("src/lib/browseChatState.test.ts", "NEVER drops a tab that still exists, however stale"));
  it.fails("BC-9 KNOWN VIOLATION: the shared thread is minted by the gesture, not by an effect after render", () => {
    expect(pane).not.toMatch(/useEffect\(\(\) => \{\s*if \(dockPill !== "page" \|\| ownChat \|\| linkedByWorkspace\[workspaceKey\]\) return;/);
  });
  it.fails("BC-5 KNOWN VIOLATION: the header names the page, never the shared chat's own title as an origin", () => {
    expect(pane).not.toMatch(/anchoredFromTitle=\{\s*linkedConversation\?\.title/);
  });
  it.fails("BC-24 KNOWN VIOLATION: no reply action is threaded that can never render", () => {
    const providerAlwaysWraps = /<ConversationSourceContext\.Provider value=\{\{/.test(chat);
    const gatedOff = /!source && onSendTo(Redline|Drafter)/.test(chat);
    expect(providerAlwaysWraps && gatedOff, "Send to Claude Code / Open in Drafter are dead props").toBe(false);
  });
  it.fails("BC-24 KNOWN VIOLATION: Add to mission records the page the reply was about, not the anchored tab", () => {
    const pin = pane.slice(pane.indexOf("onAddToMission={"), pane.indexOf("/>", pane.indexOf("onAddToMission={")));
    expect(pin).not.toMatch(/sourceUrl:\s*discussionTab\.url/);
  });
  it.fails("BC-11 KNOWN VIOLATION: the grounding watermark moves only once a send succeeds", () => {
    const build = chat.slice(chat.indexOf("buildSendArgs:"), chat.indexOf("makeMessage:"));
    expect(build, "a failed send would skip the next re-snapshot").not.toMatch(/lastGroundedLabel\.current\s*=/);
  });
  it.fails("BC-31 KNOWN VIOLATION: a tab a running turn TARGETS stays live (a shared chat runs on a thread no tab owns)", () => {
    expect(browseRs).toContain("record_target(");
    expect(fnBody(libRs, "browser_can_suspend")).toContain("is_targeted(");
  });
  it.fails("BC-37 KNOWN VIOLATION: the browser pill's hover composer launches Plan/Run only", () => {
    const restricted = /pillComposerDestinations\(\s*"browser"\s*\)/.test(door) || /allowedDestinations=\{[^}]*"plan",\s*"run"/.test(door);
    expect(restricted, "the browser's compact composer must restrict destinations").toBe(true);
  });
});
