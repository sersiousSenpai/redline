// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { ProjectOption } from "../components/ProjectPicker";
import {
  composePrompt,
  frontDoorSuggestions,
  launchStillLive,
  otherDestination,
  projectNameFromPrompt,
  resolveLaunchProject,
  submitAction,
  type ProjectChoice,
} from "./frontDoor";

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
    }
  });
});

describe("launchStillLive", () => {
  it("is dead only when a REPORTED set omits the terminal", () => {
    expect(launchStillLive("t1", ["t2", "t3"])).toBe(false);
    expect(launchStillLive("t1", [])).toBe(false);
  });

  it("stays alive while the terminal is still open", () => {
    expect(launchStillLive("t1", ["t1"])).toBe(true);
    expect(launchStillLive("t1", ["t2", "t1"])).toBe(true);
  });

  it("treats an unreported dock as ignorance, not death", () => {
    // The frames before the dock's first report would otherwise cancel every
    // launch the instant it started.
    expect(launchStillLive("t1", null)).toBe(true);
  });

  it("has nothing to track without a terminal id", () => {
    expect(launchStillLive(null, [])).toBe(true);
    expect(launchStillLive(null, null)).toBe(true);
  });

  it("a swap that keeps the count the same is still a death", () => {
    // The reason a tab COUNT can't answer this: close one, open another, and
    // the count never moved.
    expect(launchStillLive("t1", ["t9"])).toBe(false);
  });
});

describe("otherDestination", () => {
  it("is an involution — flipping twice returns you", () => {
    expect(otherDestination("plan")).toBe("drafter");
    expect(otherDestination("drafter")).toBe("plan");
    expect(otherDestination(otherDestination("plan"))).toBe("plan");
  });
});

describe("resolveLaunchProject", () => {
  const options: ProjectOption[] = [
    { path: "/Users/me/redline", name: "redline", source: "session" },
    { path: "/Users/me/qwallah", name: "qwallah", source: "folder" },
  ];
  const base = {
    projectOptions: options,
    openFolder: null as string | null,
    lastDrafterProject: null as string | null,
  };

  it("obeys an explicit chip over everything else", () => {
    const chip: ProjectChoice = { path: "/Users/me/other" };
    expect(
      resolveLaunchProject("fix a bug in redline", chip, {
        ...base,
        openFolder: "/Users/me/qwallah",
        lastDrafterProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/other");
  });

  it("treats an explicit Home pick as a real choice, not as 'unset'", () => {
    // The distinction that matters: {path:null} must NOT fall through to the
    // guess, or picking Home would snap back to a repo on the next keystroke.
    expect(
      resolveLaunchProject("fix a bug in redline", { path: null }, base),
    ).toBeNull();
  });

  it("guesses the repo named in the prompt when the chip is untouched", () => {
    expect(resolveLaunchProject("fix a bug in redline", null, base)).toBe(
      "/Users/me/redline",
    );
  });

  it("falls back to the open folder, then the last drafter project", () => {
    expect(
      resolveLaunchProject("add a toggle", null, {
        ...base,
        openFolder: "/Users/me/folder",
        lastDrafterProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/folder");
    expect(
      resolveLaunchProject("add a toggle", null, {
        ...base,
        lastDrafterProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/last");
  });

  it("ends at Home when nothing resolves", () => {
    expect(resolveLaunchProject("add a toggle", null, base)).toBeNull();
  });

  it("prefers the prompt's repo over the folder the user happens to browse", () => {
    expect(
      resolveLaunchProject("fix qwallah's login", null, {
        ...base,
        openFolder: "/Users/me/redline",
      }),
    ).toBe("/Users/me/qwallah");
  });
});

describe("composePrompt", () => {
  it("passes a bare prompt through, trimmed", () => {
    expect(composePrompt("  add a toggle  ", [])).toBe("add a toggle");
  });

  it("appends attachments as a Context path list", () => {
    expect(composePrompt("add a toggle", ["/a/b.ts", "/c/d.ts"])).toBe(
      "add a toggle\n\nContext:\n- /a/b.ts\n- /c/d.ts",
    );
  });

  it("dedupes and drops blank paths", () => {
    expect(composePrompt("x", ["/a.ts", " ", "/a.ts", "  /b.ts  "])).toBe(
      "x\n\nContext:\n- /a.ts\n- /b.ts",
    );
  });

  it("returns empty for an empty prompt — there is nothing to launch", () => {
    expect(composePrompt("   ", ["/a.ts"])).toBe("");
  });

  it("keeps multi-line prompts intact", () => {
    expect(composePrompt("one\ntwo", [])).toBe("one\ntwo");
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
