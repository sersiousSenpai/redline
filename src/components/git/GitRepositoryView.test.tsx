import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommit, GitDiffFile, GitRefs, GitWorkingStatus } from "../../lib/git/types";

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
import GitRepositoryView from "./GitRepositoryView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO = "/code/demo";
const status: GitWorkingStatus = {
  branch: "main",
  head: "c".repeat(40),
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  inProgress: null,
  staged: [{ path: "src/staged.ts", status: "M" }],
  unstaged: [{ path: "src/app.ts", status: "M" }, { path: "notes.md", status: "?" }],
  conflicted: [],
};
const refs: GitRefs = {
  current: "main",
  local: [
    { name: "main", sha: "c".repeat(40), upstream: "origin/main", ahead: 2, behind: 1, current: true, gone: false },
    { name: "feature", sha: "f".repeat(40), upstream: null, ahead: 0, behind: 0, current: false, gone: false },
  ],
  remote: [{ remote: "origin", name: "origin/main", sha: "b".repeat(40) }],
  tags: [{ name: "v1.0", sha: "a".repeat(40) }],
  stashes: [],
  remotes: ["origin"],
};
const appDiff: GitDiffFile = {
  oldPath: "src/app.ts",
  newPath: "src/app.ts",
  status: "modified",
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      header: "",
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "one" },
        { kind: "del", oldLine: 2, newLine: null, text: "two" },
        { kind: "add", oldLine: null, newLine: 2, text: "TWO" },
        { kind: "add", oldLine: null, newLine: 3, text: "extra" },
        { kind: "context", oldLine: 3, newLine: 4, text: "three" },
      ],
    },
  ],
};
const commits: GitCommit[] = [
  { sha: "c".repeat(40), parents: ["b".repeat(40), "f".repeat(40)], subject: "Merge feature", authorName: "Ada", authorEmail: "ada@x", date: 1_790_000_000, refs: [{ name: "main", kind: "head" }, { name: "origin/main", kind: "remote" }] },
  { sha: "f".repeat(40), parents: ["a".repeat(40)], subject: "Feature work", authorName: "Lin", authorEmail: "lin@x", date: 1_789_990_000, refs: [{ name: "feature", kind: "local" }] },
  { sha: "b".repeat(40), parents: ["a".repeat(40)], subject: "Main work", authorName: "Ada", authorEmail: "ada@x", date: 1_789_980_000, refs: [] },
  { sha: "a".repeat(40), parents: [], subject: "Initial commit", authorName: "Ada", authorEmail: "ada@x", date: 1_789_970_000, refs: [{ name: "v1.0", kind: "tag" }] },
];

const op = { output: "", conflicts: [] };
function handlers(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (overrides[command]) return overrides[command](args);
    switch (command) {
      case "git_gui_status": return status;
      case "git_gui_refs": return refs;
      case "git_gui_file_diff": return args.path === "src/app.ts" ? appDiff : null;
      case "git_gui_log": return args.skip === 0 ? commits : [];
      case "git_gui_commit_detail": return { ...commits.find((c) => c.sha === args.sha)!, body: "Body text", committerName: "Ada", committerDate: 1_790_000_000 };
      case "git_gui_commit_files": return [appDiff];
      case "git_gui_last_message": return "Previous message\n";
      default: return op;
    }
  });
}
const calls = (command: string) => invokeMock.mock.calls.filter(([c]) => c === command).map(([, args]) => args);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function flush(ms = 0) {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function mount(view: "status" | "history" = "status") {
  localStorage.setItem("redline.git.view", JSON.stringify(view));
  await act(async () => root.render(<GitRepositoryView repo={REPO} />));
  await flush();
}
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
}

describe("Repository view: File status", () => {
  it("stages a file from its checkbox", async () => {
    handlers();
    await mount();
    expect(host.textContent).toContain("Unstaged files");
    await click(host.querySelector('input[aria-label="Stage src/app.ts"]'));
    expect(calls("git_gui_stage")).toEqual([{ repo: REPO, paths: ["src/app.ts"] }]);
    // every op refreshes status afterwards
    expect(calls("git_gui_status").length).toBeGreaterThan(1);
  });

  it("stages a hunk by applying the built patch to the index", async () => {
    handlers();
    await mount();
    await click(button("Stage hunk"));
    expect(calls("git_gui_apply_patch")).toEqual([
      {
        repo: REPO,
        target: "index",
        reverse: false,
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,3 +1,4 @@",
          " one",
          "-two",
          "+TWO",
          "+extra",
          " three",
          "",
        ].join("\n"),
      },
    ]);
  });

  it("stages a shift-click line range", async () => {
    handlers();
    await mount();
    const lines = host.querySelectorAll<HTMLElement>(".rl-git-line");
    await act(async () => lines[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await act(async () => lines[3].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: true })));
    expect(host.querySelectorAll(".rl-git-line[data-selected]").length).toBe(2);
    await click(button("Stage lines"));
    expect(calls("git_gui_apply_patch")[0]).toMatchObject({
      target: "index",
      reverse: false,
      patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,5 @@\n one\n two\n+TWO\n+extra\n three\n",
    });
  });

  it("asks before discarding, and only discards on confirm", async () => {
    handlers();
    await mount();
    await click(button("Discard file"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Discard changes to app.ts?");
    expect(calls("git_gui_discard")).toEqual([]);
    await click(button("Cancel", dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls("git_gui_discard")).toEqual([]);
    await click(button("Discard file"));
    await click(button("Discard", document.querySelector('[role="dialog"]')!));
    expect(calls("git_gui_discard")).toEqual([{ repo: REPO, paths: ["src/app.ts"] }]);
  });

  it("discards selected lines as a reverse worktree patch after confirmation", async () => {
    handlers();
    await mount();
    await click(button("Discard hunk"));
    expect(calls("git_gui_apply_patch")).toEqual([]);
    await click(button("Discard", document.querySelector('[role="dialog"]')!));
    expect(calls("git_gui_apply_patch")[0]).toMatchObject({ target: "worktree", reverse: true });
  });

  it("amends with the last message prefilled", async () => {
    handlers();
    await mount();
    const amend = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Amend last commit"))!.querySelector("input")!;
    await click(amend);
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
    expect(textarea.value).toBe("Previous message");
    await click(button("Amend"));
    expect(calls("git_gui_commit")).toEqual([{ repo: REPO, message: "Previous message", amend: true }]);
    expect(textarea.value).toBe("");
  });

  it("commits with ⌘Enter and pushes immediately when asked", async () => {
    handlers();
    await mount();
    const push = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Push changes immediately"))!.querySelector("input")!;
    await click(push);
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Ship it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    await flush();
    expect(calls("git_gui_commit")).toEqual([{ repo: REPO, message: "Ship it", amend: false }]);
    expect(calls("git_gui_push")).toEqual([{ repo: REPO, remote: "origin", branch: "main", setUpstream: false, forceWithLease: false }]);
  });

  it("shows git's raw error in the output drawer", async () => {
    handlers({ git_gui_stage: () => Promise.reject("fatal: pathspec 'x' did not match any files") });
    await mount();
    await click(host.querySelector('input[aria-label="Stage src/app.ts"]'));
    expect(host.querySelector('[aria-label="Git output"]')?.textContent).toContain("fatal: pathspec 'x' did not match any files");
  });

  it("offers only Mark resolved and Discard for a conflicted file", async () => {
    handlers({
      git_gui_status: () => ({ ...status, inProgress: "merge", unstaged: [], staged: [], conflicted: [{ path: "src/app.ts", status: "U" }] }),
    });
    await mount();
    expect(host.textContent).toContain("Merge in progress.");
    expect(button("Stage hunk")).toBeUndefined();
    expect(button("Discard hunk")).toBeUndefined();
    await click(button("Mark resolved"));
    expect(calls("git_gui_stage")).toEqual([{ repo: REPO, paths: ["src/app.ts"] }]);
  });

  it("shows the toolbar's ahead/behind badges", async () => {
    handlers();
    await mount();
    const badges = [...host.querySelectorAll(".rl-git-tool-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["1", "2"]);
  });
});

describe("Repository view: History", () => {
  it("renders the graph and ref chips, and loads a selected commit's detail and files", async () => {
    handlers();
    await mount("history");
    expect(calls("git_gui_log")[0]).toEqual({ repo: REPO, skip: 0, limit: 200, all: true });
    const rows = host.querySelectorAll('[role="row"].rl-git-row');
    expect(rows.length).toBe(4);
    expect(rows[0].querySelectorAll("svg path").length).toBeGreaterThanOrEqual(2); // merge fans out
    const chips = [...rows[0].querySelectorAll<HTMLElement>(".rl-git-chip")].map((c) => [c.dataset.kind, c.textContent]);
    expect(chips).toEqual([["head", "● main"], ["remote", "origin/main"]]);
    expect(rows[3].querySelector('.rl-git-chip[data-kind="tag"]')?.textContent).toContain("v1.0");

    await flush(80);
    expect(calls("git_gui_commit_detail").map((a) => a.sha)).toContain("c".repeat(40));
    await click(rows[2]);
    await flush(80);
    expect(calls("git_gui_commit_detail").map((a) => a.sha)).toContain("b".repeat(40));
    expect(calls("git_gui_commit_files").map((a) => a.sha)).toContain("b".repeat(40));
    expect(host.querySelector(".rl-git-detail")?.textContent).toContain("Main work");
    expect(host.querySelector(".rl-git-detail .rl-git-line[data-kind='add']")?.textContent).toContain("TWO");
  });

  it("asks before a hard reset from the commit menu", async () => {
    handlers();
    await mount("history");
    const row = host.querySelectorAll('[role="row"].rl-git-row')[2];
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    await click(button("Hard — discard all changes…", document.querySelector('[role="menu"]')!));
    expect(calls("git_gui_reset")).toEqual([]);
    await click(button("Hard reset", document.querySelector('[role="dialog"]')!));
    expect(calls("git_gui_reset")).toEqual([{ repo: REPO, sha: "b".repeat(40), mode: "hard" }]);
  });

  it("shows an empty state on an unborn branch", async () => {
    handlers({ git_gui_log: () => [] });
    await mount("history");
    expect(host.textContent).toContain("No commits yet on main.");
  });
});

describe("Repository view: refresh", () => {
  it("never overlaps status polls", async () => {
    let release: () => void = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    handlers({
      git_gui_status: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => { release = () => { inFlight--; resolve(status); }; });
      },
    });
    await act(async () => root.render(<GitRepositoryView repo={REPO} />));
    // focus events while the first read is still pending only queue a follow-up
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    expect(maxInFlight).toBe(1);
    await act(async () => release());
    await flush();
    await act(async () => release());
    await flush();
    expect(maxInFlight).toBe(1);
    expect(calls("git_gui_status").length).toBe(2);
  });

  it("refreshes on the git-gui-changed event for this repo", async () => {
    let emit: (payload: unknown) => void = () => {};
    listenMock.mockImplementation((name: string, cb: (e: { payload: unknown }) => void) => {
      if (name === "git-gui-changed") emit = (payload) => cb({ payload });
      return Promise.resolve(() => {});
    });
    handlers();
    await mount();
    const before = calls("git_gui_status").length;
    await act(async () => emit({ repo: "/other" }));
    await flush();
    expect(calls("git_gui_status").length).toBe(before);
    await act(async () => emit({ repo: REPO }));
    await flush();
    expect(calls("git_gui_status").length).toBe(before + 1);
  });
});
