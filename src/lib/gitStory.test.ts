import { describe, expect, it } from "vitest";
import type { GitStatus } from "../types";
import { gitStory } from "./gitStory";
import { gitActions, gitWords } from "./gitWords";
const clean: GitStatus = {
  branch: "main",
  headShort: "abc",
  headSubject: "Saved",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  remotes: ["origin"],
  defaultRemote: "origin",
  defaultBranch: "main",
  inProgress: null,
  ghAvailable: true,
  ghAuthed: true,
};
describe("Guided next action", () => {
  it.each([
    ["clean", {}, 0, false, "workspace"],
    ["unsaved", { unstaged: 1 }, 1, false, "save"],
    ["unshared", { ahead: 2 }, 0, false, "share"],
    ["behind", { behind: 2 }, 0, false, "updates"],
    ["diverged", { behind: 1, ahead: 1 }, 0, false, "updates"],
    ["in progress", { inProgress: "merge" }, 0, false, "recover"],
    ["detached", { branch: null }, 0, false, "workspace"],
    [
      "no team copy",
      { remotes: [], defaultRemote: null },
      0,
      false,
      "timeline",
    ],
    ["GitHub missing", { ghAvailable: false }, 0, false, "connect"],
    ["GitHub signed out", { ghAuthed: false }, 0, false, "connect"],
    ["held review", {}, 1, true, "notes"],
    ["unpublished workspace", { upstream: null }, 0, false, "share"],
  ] as const)("%s", (_name, patch, files, hold, primary) => {
    const result = gitStory(
      {
        ...clean,
        ...patch,
        remotes: "remotes" in patch ? [...patch.remotes] : clean.remotes,
      },
      { files },
      hold,
    );
    expect(result.primary).toBe(primary);
    expect(result.secondary).not.toContain(primary);
  });
  it("asks to save overlapping edits before updates", () => {
    const result = gitStory(
      { ...clean, behind: 1, unstaged: 1 },
      { files: 1, overlaps: 1 },
      false,
    );
    expect(result.primary).toBe("save");
    expect(result.detail).toContain("Save your work first");
  });
  it("works before status loads and in an empty new repo", () => {
    expect(gitStory(null, { files: 0 }, false).primary).toBe("check");
    expect(
      gitStory(
        { ...clean, branch: null, headShort: null, untracked: 1 },
        { files: 1 },
        false,
      ).primary,
    ).toBe("save");
  });
  it("every action has a glossary term and no hidden Git syntax", () => {
    for (const action of Object.values(gitActions)) {
      expect(gitWords[action.term].explain).toBeTruthy();
      expect(action.label).not.toMatch(/HEAD|refs\/|--|upstream|stag/i);
    }
  });
});
