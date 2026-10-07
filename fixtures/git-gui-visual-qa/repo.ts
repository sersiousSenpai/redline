// A simulated repository for the visual fixture: ~150 commits, 7 local
// branches (one stale, one merged but kept), remote-only and tracking remote
// branches, tags, merged-and-deleted feature branches and an octopus merge.
// Deterministic: same output every run.
type Ref = { name: string; kind: "head" | "local" | "remote" | "tag" };
export type FixtureCommit = { sha: string; parents: string[]; subject: string; authorName: string; authorEmail: string; date: number; refs: Ref[] };

const people: Array<[string, string]> = [["Yusuf Al-Bazian", "yusuf@redline.dev"], ["Mara Lindqvist", "mara@redline.dev"], ["Theo Okafor", "theo@redline.dev"], ["Priya Raman", "priya@redline.dev"]];
const words: Record<string, string[]> = {
  main: ["Bound the plate on narrow windows", "Keep the browser following the tab rail", "Tighten the hunk header spacing", "Retry fetch when the remote hangs up", "Split the review header controls", "Preserve recents and island layout", "Open every launch on the Front Door", "Drop the narrated pose", "Polish ref chips in dark themes", "Raise the boot-path budget note", "Fix the watchdog liveness probe", "Teach the dock about popups"],
  gui: ["Add the repository toolbar", "Stage hunks from the diff pane", "Line selection with shift-click", "Commit box with amend prefill", "Push changes immediately option", "Virtualize the history table", "Page history 200 at a time", "Lane assignment for the graph", "Merge curves in the graph column", "Context menu for commits", "Hard reset needs confirmation", "Output drawer keeps the last op", "Stash list in the sidebar", "Branch context menu", "Refresh on git-gui-changed"],
  graph: ["Rail layout: first-parent claims", "Pack anonymous chains into rows", "Sticky rail labels", "Date axis along the top", "Wheel and pinch zoom", "Highlight ancestors on select", "Commit drawer under the graph", "Keyboard movement along rails"],
  fix: ["Detect renames in commit files", "Handle copies with -C", "Test rename + edit in one commit"],
  wasm: ["Spike: wasmi plate host", "Plate manifest parser", "Sandbox the plate imports", "Measure cold start", "Notes on the marketplace"],
  docs: ["Document the git client contract", "Describe the backend commands", "Explain refresh and polling"],
  collab: ["Cursor presence over the relay", "Throttle cursor broadcasts", "Show collaborator names", "Fade idle cursors", "Colour cursors by seat", "Reconnect after sleep"],
  release: ["Bump version to 0.9.0", "Changelog for 0.9", "Fix updater signature check", "Hotfix: crash on empty repo", "Bump version to 0.9.1"],
  anon: ["Add stash preview", "Fix diff word wrap", "Speed up status parsing", "Handle unborn branches", "Show ahead/behind badges", "Tidy sidebar spacing", "Guard against huge diffs", "Respect core.autocrlf", "Remember the sidebar sections", "Escape refs in menus", "Trim trailing output", "Keyboard nav in file lists"],
};
let seq = 0;
let clock = 1_788_000_000; // late Aug 2026
const counters: Record<string, number> = {};
const all: FixtureCommit[] = [];
const sha = (n: number) => {
  let h = (n * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < 5; i++) {
    h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
};
function commit(topic: string, parents: string[], subject?: string): string {
  const list = words[topic];
  const i = (counters[topic] = (counters[topic] ?? 0) + 1) - 1;
  const n = seq++;
  clock += 2400 + ((n * 7919) % 9) * 3000;
  const person = people[(n * 3 + topic.length) % people.length];
  const s = sha(n + 1);
  all.push({ sha: s, parents, subject: subject ?? list[i % list.length] + (i >= list.length ? ` (${Math.floor(i / list.length) + 1})` : ""), authorName: person[0], authorEmail: person[1], date: clock, refs: [] });
  return s;
}

const heads: Record<string, string> = {};
const tags: Record<string, string> = {};
const step = (branch: string, topic: string, n = 1) => {
  for (let i = 0; i < n; i++) heads[branch] = commit(topic, heads[branch] ? [heads[branch]] : []);
  return heads[branch];
};
const fork = (branch: string, from: string) => {
  heads[branch] = heads[from];
};
const merge = (into: string, from: string, subject?: string) => {
  heads[into] = commit("main", [heads[into], heads[from]], subject ?? `Merge ${from.startsWith("_") ? "a feature branch" : from} into ${into}`);
};

// Early history
heads.main = commit("main", [], "Initial commit");
step("main", "main", 12);
tags["v0.8.0"] = heads.main;
fork("_a", "main"); step("_a", "anon", 2); step("main", "main"); step("_a", "anon", 2); step("main", "main");
merge("main", "_a", "Merge pull request #41 from mara/stash-preview");
fork("_b", "main"); step("_b", "anon", 3);
step("main", "main");
merge("main", "_b", "Merge pull request #44 from theo/status-speed");
tags["v0.8.2"] = heads.main;
fork("upstream/main", "main");
step("main", "main", 3);
// merged-and-deleted branches before any of today's branches existed
const prs = ["guard-diffs", "autocrlf", "nav-keys", "trim-output", "menus", "badges", "crlf-tests", "sidebar-gap", "dock-focus"];
const prMerge = (k: number) => {
  const name = `_f${k}`;
  fork(name, "main");
  step(name, "anon", 1 + (k % 3));
  step("main", "main");
  if (k === 6) step("feature/git-gui", "gui", 2);
  if (k === 7) step("feature/branch-graph", "graph", 1);
  merge("main", name, `Merge pull request #${70 + k} from ${people[k % 4][0].split(" ")[0].toLowerCase()}/${prs[k]}`);
};
for (let k = 0; k < 5; k++) prMerge(k);
fork("release/0.9", "main"); step("release/0.9", "release", 2);
tags["v0.9.0"] = heads["release/0.9"];
fork("experiment/wasm-plates", "main"); step("experiment/wasm-plates", "wasm", 2);
fork("_c", "main"); step("_c", "anon", 2); step("main", "main");
step("experiment/wasm-plates", "wasm", 3);
merge("main", "release/0.9", "Merge release/0.9 into main");
merge("main", "_c", "Merge pull request #52 from priya/unborn");
fork("feature/git-gui", "main");
fork("fix/rename-detection", "main");
step("feature/git-gui", "gui", 4);
step("fix/rename-detection", "fix", 3);
fork("origin/feature/collab-cursors", "main");
step("main", "main", 2);
merge("main", "fix/rename-detection", "Merge fix/rename-detection into main");
step("origin/feature/collab-cursors", "collab", 3);
step("feature/git-gui", "gui", 3);
fork("_d", "main"); step("_d", "anon", 2);
fork("docs/contract", "feature/git-gui"); step("docs/contract", "docs", 2);
step("release/0.9", "release", 2);
tags["v0.9.1"] = heads["release/0.9"];
merge("main", "_d", "Merge pull request #58 from yusuf/word-wrap");
merge("feature/git-gui", "main", "Merge main into feature/git-gui");
step("feature/git-gui", "gui", 3);
merge("feature/git-gui", "docs/contract", "Merge docs/contract into feature/git-gui");
step("origin/feature/collab-cursors", "collab", 3);
// octopus: three tiny fixes land together
fork("_o1", "main"); fork("_o2", "main"); fork("_o3", "main");
step("_o1", "anon"); step("_o2", "anon"); step("_o3", "anon");
heads.main = commit("main", [heads.main, heads._o1, heads._o2, heads._o3], "Merge branches 'fix/menus', 'fix/output' and 'fix/keys'");
fork("feature/branch-graph", "feature/git-gui");
step("feature/branch-graph", "graph", 3);
step("feature/git-gui", "gui", 2);
step("main", "main", 2);
fork("_e", "main"); step("_e", "anon", 3);
step("feature/branch-graph", "graph", 3);
merge("main", "_e", "Merge pull request #63 from mara/sidebar-sections");
step("feature/git-gui", "gui", 3);
step("main", "main", 2);
step("feature/branch-graph", "graph", 2);
step("origin/feature/collab-cursors", "collab", 2);
// a run of main work with more merged-and-deleted branches
for (let k = 5; k < 9; k++) prMerge(k);
fork("origin/main", "main");
step("main", "main", 2);
step("feature/git-gui", "gui", 4);
fork("origin/feature/git-gui", "feature/git-gui");
step("feature/branch-graph", "graph", 2);

export const CURRENT = "feature/git-gui";
const locals = ["main", "feature/git-gui", "feature/branch-graph", "fix/rename-detection", "release/0.9", "docs/contract", "experiment/wasm-plates"];
const upstreams: Record<string, string> = { main: "origin/main", "feature/git-gui": "origin/feature/git-gui", "release/0.9": "origin/release/0.9" };
fork("origin/release/0.9", "release/0.9");
const remotes = ["origin/main", "origin/feature/git-gui", "origin/release/0.9", "origin/feature/collab-cursors", "upstream/main"];

export const commits: FixtureCommit[] = [...all].sort((a, b) => b.date - a.date);
const byShaIndex = new Map(commits.map((c) => [c.sha, c]));
for (const name of locals) byShaIndex.get(heads[name])!.refs.push({ name, kind: name === CURRENT ? "head" : "local" });
for (const name of remotes) byShaIndex.get(heads[name])!.refs.push({ name, kind: "remote" });
for (const [name, at] of Object.entries(tags)) byShaIndex.get(at)!.refs.push({ name, kind: "tag" });

const aheadBehind = (local: string, remote: string) => {
  const reach = (from: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...byShaIndex.get(s)!.parents);
    }
    return seen;
  };
  const a = reach(heads[local]);
  const b = reach(heads[remote]);
  return { ahead: [...a].filter((s) => !b.has(s)).length, behind: [...b].filter((s) => !a.has(s)).length };
};

export const refs = {
  current: CURRENT,
  local: locals.map((name) => {
    const upstream = upstreams[name] ?? null;
    const ab = upstream ? aheadBehind(name, upstream) : { ahead: 0, behind: 0 };
    return { name, sha: heads[name], upstream, ...ab, current: name === CURRENT, gone: false };
  }),
  remote: remotes.map((name) => ({ remote: name.split("/")[0], name, sha: heads[name] })),
  tags: Object.entries(tags).map(([name, at]) => ({ name, sha: at })),
  stashes: [{ index: 0, message: "WIP on feature/git-gui: toolbar badges", sha: sha(9999), date: clock - 3600 }],
  remotes: ["origin", "upstream"],
};
export const head = heads[CURRENT];
const local = refs.local.find((b) => b.name === CURRENT)!;
export const headAhead = local.ahead;
export const headBehind = local.behind;
