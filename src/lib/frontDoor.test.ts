// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fallbackDestination,
  frontDoorSuggestions,
  projectNameFromPrompt,
  submitAction,
} from "./frontDoor";

// `launchStillLive`, `resolveLaunchProject` and `composePrompt` moved to
// `launch.test.ts` with the functions themselves — they are every door's
// property now, not this one's.

const key = (
  k: string,
  mods: Partial<Parameters<typeof submitAction>[0]> = {},
) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

describe("submitAction", () => {
  it("defaults to the original binding: ⏎ plans, ⌘⏎ drafts", () => {
    expect(submitAction(key("Enter"))).toBe("plan");
    expect(submitAction(key("Enter", { metaKey: true }))).toBe("drafter");
    expect(submitAction(key("Enter", { ctrlKey: true }))).toBe("drafter");
  });

  it("sends to chat on ⏎ and falls back to plan on ⌘⏎", () => {
    expect(submitAction(key("Enter"), "chat")).toBe("chat");
    expect(submitAction(key("Enter", { metaKey: true }), "chat")).toBe("plan");
    expect(submitAction(key("Enter", { ctrlKey: true }), "chat")).toBe("plan");
    // ⇧⏎ is still a newline on the third destination too.
    expect(submitAction(key("Enter", { shiftKey: true }), "chat")).toBe(
      "newline",
    );
    expect(submitAction(key("Enter", { isComposing: true }), "chat")).toBe(
      "ignore",
    );
  });

  it("follows the selected destination on a bare Enter", () => {
    expect(submitAction(key("Enter"), "plan")).toBe("plan");
    expect(submitAction(key("Enter"), "drafter")).toBe("drafter");
  });

  it("puts the OTHER destination on the modifier, whichever is selected", () => {
    // The point: both destinations stay one keystroke away in either mode.
    expect(submitAction(key("Enter", { metaKey: true }), "plan")).toBe(
      "drafter",
    );
    expect(submitAction(key("Enter", { metaKey: true }), "drafter")).toBe(
      "plan",
    );
    expect(submitAction(key("Enter", { ctrlKey: true }), "drafter")).toBe(
      "plan",
    );
  });

  it("keeps ⇧⏎ as a newline in every mode — the composer is multi-line", () => {
    expect(submitAction(key("Enter", { shiftKey: true }), "plan")).toBe(
      "newline",
    );
    expect(submitAction(key("Enter", { shiftKey: true }), "drafter")).toBe(
      "newline",
    );
  });

  it("lets the command modifier win over shift", () => {
    expect(submitAction(key("Enter", { metaKey: true, shiftKey: true }))).toBe(
      "drafter",
    );
  });

  it("ignores an Enter that is committing an IME candidate", () => {
    expect(submitAction(key("Enter", { isComposing: true }))).toBe("ignore");
    expect(
      submitAction(key("Enter", { isComposing: true, metaKey: true })),
    ).toBe("ignore");
  });

  it("ignores every other key", () => {
    for (const k of ["a", "Escape", "Tab", "ArrowDown", " ", "Backspace"]) {
      expect(submitAction(key(k))).toBe("ignore");
      expect(submitAction(key(k), "drafter")).toBe("ignore");
      expect(submitAction(key(k), "chat")).toBe("ignore");
    }
  });
});

describe("fallbackDestination", () => {
  it("reproduces the two-destination behavior exactly", () => {
    // The whole point of the rename: plan⇄drafter is untouched.
    expect(fallbackDestination("plan")).toBe("drafter");
    expect(fallbackDestination("drafter")).toBe("plan");
    expect(fallbackDestination(fallbackDestination("plan"))).toBe("plan");
  });

  it("gives chat a sane modifier — ⌘⏎ plans", () => {
    // "I've written it out, just build it" is the move that belongs one key
    // away from a half-formed thought.
    expect(fallbackDestination("chat")).toBe("plan");
  });
});

describe("frontDoorSuggestions", () => {
  it("names the project when there is one", () => {
    const s = frontDoorSuggestions("redline");
    expect(s[0].label).toBe("Fix a bug in redline");
    expect(s[0].text).toBe("Fix a bug in redline: ");
  });

  it("stays generic with no project", () => {
    const s = frontDoorSuggestions(null);
    expect(s[0].label).toBe("Fix a bug");
    expect(s.some((x) => x.label.includes("undefined"))).toBe(false);
    for (const x of s) expect(x.text.length).toBeGreaterThan(0);
  });

  it("never returns text that would launch as-is by mistake", () => {
    // Chips FILL the composer. Each one is a prefix a human finishes, or a
    // complete question — never an empty string.
    for (const projectName of [null, "redline"]) {
      for (const s of frontDoorSuggestions(projectName)) {
        expect(s.text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("projectNameFromPrompt", () => {
  it("drops the leading verb and articles", () => {
    expect(projectNameFromPrompt("add a dark mode toggle")).toBe(
      "dark-mode-toggle",
    );
    expect(
      projectNameFromPrompt("add a dark mode toggle to the settings page"),
    ).toBe("dark-mode-toggle");
  });

  it("keeps identity words in order", () => {
    expect(projectNameFromPrompt("Fix the login redirect bug")).toBe(
      "fix-login-redirect",
    );
  });

  it("de-punctuates", () => {
    expect(projectNameFromPrompt("Build a *CRM* (v2)!")).toBe("crm-v2");
  });

  it("caps the length and never ends in a dash", () => {
    const slug = projectNameFromPrompt(
      "supercalifragilistic expialidocious extravaganza",
    );
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back rather than proposing nothing", () => {
    expect(projectNameFromPrompt("")).toBe("new-project");
    expect(projectNameFromPrompt("!!! ???")).toBe("new-project");
    // All filler — the raw words are better than nothing.
    expect(projectNameFromPrompt("please make it for me")).toBe(
      "please-make-it",
    );
  });

  it("always emits a slug the Rust validator would accept", () => {
    for (const prompt of [
      "add a dark mode toggle",
      "Fix ../../etc/passwd handling",
      "build /usr/bin thing",
      "....",
      "a",
      "Ünïcödé nàmes",
    ]) {
      const slug = projectNameFromPrompt(prompt);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(slug).not.toContain("/");
      expect(slug).not.toBe("..");
    }
  });
});

// Source invariant — the front door already clears its composer on send; a
// prompt left on screen after it shipped reads as "not sent yet" and invites
// an accidental relaunch. Pinned here, house-style (cf. drafterCache.test.ts).
describe("front door clear-on-send wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("launchFromFrontDoor clears text and attachments after handing them off", () => {
    const fn = app.indexOf("const launchFromFrontDoor");
    expect(fn).toBeGreaterThan(-1);
    const launch = app.indexOf("launchPlan({", fn);
    const text = app.indexOf('setFrontDoorText("")', fn);
    const attachments = app.indexOf("setFrontDoorAttachments([])", fn);
    expect(launch).toBeGreaterThan(fn);
    expect(text).toBeGreaterThan(launch);
    expect(attachments).toBeGreaterThan(launch);
  });

  it("it hands over a composer restore, so a dead launch gives the sentence back", () => {
    const fn = app.indexOf("const launchFromFrontDoor");
    const end = app.indexOf("const drafterFromFrontDoor", fn);
    expect(app.slice(fn, end)).toContain('kind: "composer"');
  });

  it("the Drafter's launch owes nothing back — its document never left", () => {
    // Decision 3, pinned. A `composer` restore here would mean the Drafter had
    // taken the document away, which is the one thing it must never do.
    const fn = app.indexOf("const launchFromDrafter");
    const end = app.indexOf("const applyReadinessFix", fn);
    expect(fn).toBeGreaterThan(-1);
    const body = app.slice(fn, end);
    expect(body).toContain('restore: { kind: "none" }');
    expect(body).not.toContain("newDraft(");
    expect(body).not.toContain("setDrafterDraftId(");
  });

  it("the drafter hand-off clears it too", () => {
    const fn = app.indexOf("const drafterFromFrontDoor");
    expect(fn).toBeGreaterThan(-1);
    const text = app.indexOf('setFrontDoorText("")', fn);
    const attachments = app.indexOf("setFrontDoorAttachments([])", fn);
    expect(text).toBeGreaterThan(fn);
    expect(attachments).toBeGreaterThan(text);
  });

  // The other half of clear-on-send, and the half that actually produced the
  // report: clearing the composer is worthless if something writes the
  // sentence back into it. The pay-back is for the INVOLUNTARY case only —
  // the terminal died under the launch — so it has exactly one caller.
  it("the pay-back has exactly one caller: the terminal-death effect", () => {
    const calls = app.match(/repayPending\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // And it is the death effect, not something that merely looks like one.
    const call = app.indexOf("repayPending(");
    expect(app.slice(call, call + 120)).toContain("that terminal was closed");
  });

  it("dismissing or revealing the in-flight pill never refills the composer", () => {
    // "Start something else" was a deliberate dismissal wired to the
    // involuntary-death machinery: it handed the just-sent sentence back into
    // the now-empty composer, which is the bug reported as "the prompt comes
    // back and I have to delete it".
    const start = app.indexOf("onCancelPending={");
    const end = app.indexOf("onHowItWorks=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wiring = app.slice(start, end);
    // Both halves of the pill live in this slice — neither pays anything back.
    expect(wiring).toContain("onRevealPending=");
    expect(wiring).not.toContain("repayPending(");
    expect(wiring).toContain("setPendingLaunch(null)");
  });

  it("displacing an older pending launch does not refill the composer either", () => {
    // The displaced plan keeps running in its own tile. Handing its sentence
    // back would drop a stale prompt on top of the one that just shipped.
    const fn = app.indexOf("const launchPlan = async (req:");
    const end = app.indexOf("const runDevServer", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(fn);
    expect(app.slice(fn, end)).not.toContain("repayPending(");
  });
});
