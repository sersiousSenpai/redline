import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommit, GitDiffFile, GitRefs, GitWorkingStatus } from "../../lib/git/types";

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
import GitRepositoryView from "./GitRepositoryView";
import * as fixture from "../../../fixtures/git-gui-visual-qa/repo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO = "/code/demo";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const F = "f".repeat(40);
const status: GitWorkingStatus = { branch: "main", head: C, upstream: "origin/main", ahead: 0, behind: 0, inProgress: null, staged: [], unstaged: [], conflicted: [] };
const refs: GitRefs = {
  current: "main",
  local: [
    { name: "main", sha: C, upstream: "origin/main", ahead: 0, behind: 0, current: true, gone: false },
    { name: "feature", sha: F, upstream: null, ahead: 0, behind: 0, current: false, gone: false },
  ],
  remote: [{ remote: "origin", name: "origin/main", sha: C }],
  tags: [{ name: "v1.0", sha: A }],
  stashes: [],
  remotes: ["origin"],
};
// main: a - b - c (merges feature) ; feature: a - f
const commits: GitCommit[] = [
  { sha: C, parents: [B, F], subject: "Merge feature", authorName: "Ada", authorEmail: "ada@x", date: 1_790_000_000, refs: [{ name: "main", kind: "head" }, { name: "origin/main", kind: "remote" }] },
  { sha: F, parents: [A], subject: "Feature work", authorName: "Lin", authorEmail: "lin@x", date: 1_789_990_000, refs: [{ name: "feature", kind: "local" }] },
  { sha: B, parents: [A], subject: "Main work", authorName: "Ada", authorEmail: "ada@x", date: 1_789_980_000, refs: [] },
  { sha: A, parents: [], subject: "Initial commit", authorName: "Ada", authorEmail: "ada@x", date: 1_789_970_000, refs: [{ name: "v1.0", kind: "tag" }] },
];
const file: GitDiffFile = {
  oldPath: "src/app.ts",
  newPath: "src/app.ts",
  status: "modified",
  binary: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "", lines: [{ kind: "del", oldLine: 1, newLine: null, text: "old" }, { kind: "add", oldLine: null, newLine: 1, text: "NEW" }] }],
};
const op = { output: "", conflicts: [] };
let currentRefs = refs;
let currentLog = commits;
function handlers() {
  currentRefs = refs;
  currentLog = commits;
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "git_gui_status": return status;
      case "git_gui_refs": return currentRefs;
      case "git_gui_file_diff": return null;
      case "git_gui_log": return args.skip === 0 ? currentLog : [];
      case "git_gui_commit_detail": return { ...currentLog.find((c) => c.sha === args.sha)!, body: "", committerName: "Ada", committerDate: 1_790_000_000 };
      case "git_gui_commit_files": return [file];
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

async function flush(ms = 0, rounds = 4) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await flush(10, 1);
  expect(check()).toBe(true);
}
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const node = (sha: string) => host.querySelector<SVGGElement>(`.rl-bg-node[data-sha="${sha}"]`);
const stateOf = (sha: string) => node(sha)?.getAttribute("data-state") ?? null;
async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}
async function openBranches() {
  handlers();
  localStorage.setItem("redline.git.view", JSON.stringify("status"));
  await act(async () => root.render(<GitRepositoryView repo={REPO} />));
  await flush();
  await click(button("Branches", host.querySelector(".rl-git-sidebar")!));
  await waitFor(() => host.querySelectorAll(".rl-bg-node").length === 4);
}

describe("Repository view: Branches", () => {
  it("opens from the sidebar as rails with labels, tip chips and the HEAD ring", async () => {
    await openBranches();
    expect(calls("git_gui_log")).toContainEqual({ repo: REPO, skip: 0, limit: 500, all: true });
    expect(host.querySelector('.rl-git-side-item[data-active]')?.textContent).toContain("Branches");
    const labels = [...host.querySelectorAll(".rl-bg-label")].map((l) => l.textContent);
    expect(labels).toEqual(["main+1", "feature"]);
    expect(host.querySelector(`.rl-bg-node[data-sha="${C}"]`)?.hasAttribute("data-head")).toBe(true);
    expect(host.querySelector(`.rl-bg-chipset[data-sha="${F}"]`)?.textContent).toContain("feature");
    expect(host.querySelector(`.rl-bg-chipset[data-sha="${A}"]`)?.textContent).toContain("v1.0");
    // merge curve into main + fork from a
    expect([...host.querySelectorAll(".rl-bg-edge")].some((p) => p.getAttribute("d")!.includes("C"))).toBe(true);
  });

  it("highlights a clicked commit's ancestors, softens descendants, dims the rest and loads its detail", async () => {
    await openBranches();
    await click(node(B)!.querySelector(".rl-bg-dot"));
    expect(stateOf(B)).toBe("sel");
    expect(stateOf(A)).toBe("anc");
    expect(stateOf(C)).toBe("desc");
    expect(stateOf(F)).toBe("dim");
    await flush(80);
    expect(calls("git_gui_commit_detail").map((a) => a.sha)).toContain(B);
    expect(calls("git_gui_commit_files").map((a) => a.sha)).toContain(B);
    const drawer = host.querySelector(".rl-bg-drawer")!;
    expect(drawer.textContent).toContain("Main work");
    expect(drawer.querySelector(".rl-git-line[data-kind='add']")?.textContent).toContain("NEW");
    // the drawer closes without losing the selection
    await click(host.querySelector('button[aria-label="Close commit details"]'));
    expect(host.querySelector(".rl-bg-drawer")).toBeNull();
    expect(stateOf(B)).toBe("sel");
  });

  it("clears the selection with Esc and on an empty-canvas click", async () => {
    await openBranches();
    const canvas = host.querySelector<HTMLElement>(".rl-bg-canvas")!;
    await click(node(F)!.querySelector(".rl-bg-dot"));
    expect(stateOf(F)).toBe("sel");
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(host.querySelector(".rl-bg-node[data-state]")).toBeNull();
    expect(host.querySelector(".rl-bg-drawer")).toBeNull();
    await click(node(F)!.querySelector(".rl-bg-dot"));
    await click(canvas);
    expect(host.querySelector(".rl-bg-node[data-state]")).toBeNull();
  });

  it("moves along rails with the arrow keys", async () => {
    await openBranches();
    const canvas = host.querySelector<HTMLElement>(".rl-bg-canvas")!;
    const key = async (k: string) => {
      await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
      await flush();
    };
    await key("ArrowLeft"); // nothing selected: starts at HEAD
    expect(stateOf(C)).toBe("sel");
    await key("ArrowLeft");
    expect(stateOf(B)).toBe("sel");
    await key("ArrowDown");
    expect(stateOf(F)).toBe("sel");
    await key("ArrowRight");
    expect(stateOf(C)).toBe("sel");
    expect(host.querySelector(".rl-bg-drawer")).toBeNull();
    await key("Enter");
    expect(host.querySelector(".rl-bg-drawer")).not.toBeNull();
  });

  it("selects a ref's tip when it is clicked in the sidebar, staying in the view", async () => {
    await openBranches();
    const feature = [...host.querySelectorAll<HTMLButtonElement>(".rl-git-sidebar .rl-git-side-item")].find((b) => b.textContent?.trim() === "feature");
    await click(feature);
    await flush();
    expect(host.querySelector(".rl-bg-canvas")).not.toBeNull();
    expect(stateOf(F)).toBe("sel");
    const tag = [...host.querySelectorAll<HTMLButtonElement>(".rl-git-sidebar .rl-git-side-item")].find((b) => b.textContent?.trim() === "v1.0");
    await click(tag);
    await flush();
    expect(stateOf(A)).toBe("sel");
  });

  it("offers History's commit menu on a node and the branch menu on a rail label", async () => {
    await openBranches();
    await act(async () => node(B)!.querySelector(".rl-bg-dot")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await flush();
    await click(button("Revert commit", document.querySelector('[role="menu"]')!));
    expect(calls("git_gui_revert_commit")).toEqual([{ repo: REPO, sha: B }]);

    const label = [...host.querySelectorAll(".rl-bg-label")].find((l) => l.textContent === "feature")!;
    await act(async () => label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await flush();
    await click(button("Check out feature", document.querySelector('[role="menu"]')!));
    expect(calls("git_gui_checkout")).toEqual([{ repo: REPO, target: "feature", kind: "branch" }]);
  });

  it("hides commits only remote branches reach when Remote branches is off", async () => {
    await openBranches();
    const remotes = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Remote branches"))!.querySelector("input")!;
    await click(remotes);
    expect(host.querySelector(`.rl-bg-chipset[data-sha="${C}"]`)?.textContent).not.toContain("origin/main");
    expect(host.querySelectorAll(".rl-bg-node").length).toBe(4);
  });

  it("re-reads and re-lays out when a ref moves, keeping the selection", async () => {
    let emit: (payload: unknown) => void = () => {};
    listenMock.mockImplementation((name: string, cb: (e: { payload: unknown }) => void) => {
      if (name === "git-gui-changed") emit = (payload) => cb({ payload });
      return Promise.resolve(() => {});
    });
    await openBranches();
    await click(node(F)!.querySelector(".rl-bg-dot"));
    const before = calls("git_gui_log").length;
    const N = "e".repeat(40);
    currentLog = [{ sha: N, parents: [F], subject: "More feature", authorName: "Lin", authorEmail: "lin@x", date: 1_790_100_000, refs: [{ name: "feature", kind: "local" }] }, ...commits];
    currentRefs = { ...refs, local: refs.local.map((b) => (b.name === "feature" ? { ...b, sha: N } : b)) };
    await act(async () => emit({ repo: REPO }));
    await waitFor(() => host.querySelectorAll(".rl-bg-node").length === 5);
    expect(calls("git_gui_log").length).toBeGreaterThan(before);
    expect(stateOf(F)).toBe("sel");
    expect(stateOf(N)).toBe("desc");
  });

  it("opens on a fit that puts every named rail's tip on screen (fixture repo)", async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case "git_gui_status": return { ...status, branch: fixture.CURRENT, head: fixture.head, upstream: `origin/${fixture.CURRENT}` };
        case "git_gui_refs": return fixture.refs;
        case "git_gui_log": return fixture.commits.slice(args.skip as number, (args.skip as number) + (args.limit as number));
        default: return op;
      }
    });
    localStorage.setItem("redline.git.view", JSON.stringify("branches"));
    await act(async () => root.render(<GitRepositoryView repo={REPO} />));
    await waitFor(() => host.querySelectorAll(".rl-bg-label").length >= 8);
    // jsdom has no layout: the view uses its 1200x640 fallback canvas with a 196px label gutter
    const tips = [...fixture.refs.local.map((b) => [b.name, b.sha]), ["origin/feature/collab-cursors", fixture.refs.remote.find((r) => r.name === "origin/feature/collab-cursors")!.sha]];
    const labels = [...host.querySelectorAll(".rl-bg-label")].map((l) => l.textContent);
    for (const [name, sha] of tips) {
      expect(labels.some((l) => l?.startsWith(name)), name).toBe(true);
      const dot = node(sha)?.querySelector(".rl-bg-dot");
      expect(dot, `${name} tip is rendered`).toBeTruthy();
      const cx = Number(dot!.getAttribute("cx"));
      const cy = Number(dot!.getAttribute("cy"));
      expect(cx, `${name} tip x`).toBeGreaterThan(196);
      expect(cx, `${name} tip x`).toBeLessThan(1200);
      expect(cy, `${name} tip y`).toBeGreaterThan(26);
      expect(cy, `${name} tip y`).toBeLessThan(640);
    }
    // no label is marked as off to one side
    expect(host.querySelector(".rl-bg-label[data-away]")).toBeNull();
    // and nodes keep a clickable spacing
    const xs = [...host.querySelectorAll(".rl-bg-dot")].map((d) => Number(d.getAttribute("cx"))).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]).filter((g) => g > 0.5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8 - 0.01);
  });
});
