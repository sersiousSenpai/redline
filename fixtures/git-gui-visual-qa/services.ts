// Synthetic Tauri boundary for the repository view fixture. Production components are imported intact.
const noop = () => {};
const sha = (n: number) => (n.toString(16).padStart(4, "0") + "9f3c2a7b1e5d8c4f6a0b3e7d9c1f5a8b2e4d").slice(0, 40);
const people = [["Yusuf Al-Bazian", "y@x"], ["Mara Lindqvist", "m@x"], ["Theo Okafor", "t@x"]];
const subjects = ["Keep the browser following the tab rail", "Merge the October plans into main", "Open every launch on the Front Door", "Build the twelve October plans", "Preserve recents and island layout", "Tighten the hunk header spacing", "Fix rename detection in commit files", "Add stash list to the sidebar", "Bound the plate on narrow windows", "Document the git client contract", "Teach the graph about octopus merges", "Polish ref chips in dark themes", "Retry fetch when the remote hangs up", "Drop the narrated pose", "Split the review header controls"];
type C = { sha: string; parents: string[]; subject: string; authorName: string; authorEmail: string; date: number; refs: { name: string; kind: string }[] };
const commits: C[] = [];
const N = 60;
for (let i = 0; i < N; i++) {
  const p = people[i % 3];
  commits.push({ sha: sha(i), parents: [], subject: subjects[i % subjects.length], authorName: p[0], authorEmail: p[1], date: 1_791_300_000 - i * 5400, refs: [] });
}
// main: 0,1,3,5,6,8,... feature: 2,4 merged at 1; topic: 7,9 merged at 6; release branch tip 10 off 12
const link = (i: number, ...ps: number[]) => { commits[i].parents = ps.map(sha); };
for (let i = 0; i < N - 1; i++) link(i, i + 1);
link(N - 1);
link(1, 3, 2); link(2, 4); link(4, 11);
link(6, 8, 7); link(7, 9); link(9, 12);
link(3, 5); link(5, 6); link(8, 10); link(10, 11); link(11, 12);
link(14, 15, 16, 17); link(15, 18); link(16, 18); link(17, 18);
commits[0].refs = [{ name: "main", kind: "head" }, { name: "origin/main", kind: "remote" }];
commits[2].refs = [{ name: "feature/git-gui", kind: "local" }, { name: "origin/feature/git-gui", kind: "remote" }];
commits[7].refs = [{ name: "topic/graph", kind: "local" }];
commits[12].refs = [{ name: "v0.9.0", kind: "tag" }];
commits[20].refs = [{ name: "v0.8.2", kind: "tag" }];

const status = {
  branch: "main", head: sha(0), upstream: "origin/main", ahead: 2, behind: 3, inProgress: null,
  staged: [{ path: "src/components/git/HistoryView.tsx", status: "M" }, { path: "src/lib/git/graph.ts", status: "A" }],
  unstaged: [
    { path: "src/components/git/FileStatusView.tsx", status: "M" },
    { path: "src/components/ReviewPanel.tsx", status: "M" },
    { path: "src/hooks/useSync.ts", status: "D" },
    { path: "docs/git-gui-notes.md", status: "?" },
  ],
  conflicted: [],
};
const refs = {
  current: "main",
  local: [
    { name: "main", sha: sha(0), upstream: "origin/main", ahead: 2, behind: 3, current: true, gone: false },
    { name: "feature/git-gui", sha: sha(2), upstream: "origin/feature/git-gui", ahead: 0, behind: 0, current: false, gone: false },
    { name: "topic/graph", sha: sha(7), upstream: null, ahead: 0, behind: 0, current: false, gone: false },
    { name: "old/experiment", sha: sha(30), upstream: "origin/old/experiment", ahead: 0, behind: 0, current: false, gone: true },
  ],
  remote: [
    { remote: "origin", name: "origin/main", sha: sha(0) },
    { remote: "origin", name: "origin/feature/git-gui", sha: sha(2) },
    { remote: "upstream", name: "upstream/main", sha: sha(5) },
  ],
  tags: [{ name: "v0.9.0", sha: sha(12) }, { name: "v0.8.2", sha: sha(20) }],
  stashes: [{ index: 0, message: "WIP on main: toolbar badges", sha: sha(99), date: 1_791_290_000 }],
  remotes: ["origin", "upstream"],
};
const L = (kind: string, text: string, o: number | null, n: number | null) => ({ kind, text, oldLine: o, newLine: n });
const diff = {
  oldPath: "src/components/git/FileStatusView.tsx", newPath: "src/components/git/FileStatusView.tsx", status: "modified", binary: false,
  hunks: [
    { oldStart: 12, oldLines: 7, newStart: 12, newLines: 9, header: "export function FileStatusView({", lines: [
      L("context", "  const { api, status, refs, run, busy } = git;", 12, 12),
      L("context", "  const staged = status?.staged ?? [];", 13, 13),
      L("del", "  const unstaged = status?.unstaged ?? [];", 14, null),
      L("add", "  const unstaged = useMemo(() => {", null, 14),
      L("add", "    const conflicted = status?.conflicted ?? [];", null, 15),
      L("add", "    return [...conflicted, ...(status?.unstaged ?? [])];", null, 16),
      L("add", "  }, [status]);", null, 17),
      L("context", "  const [selected, setSelected] = useState<Selected | null>(null);", 15, 18),
      L("context", "", 16, 19),
      L("del", "  // TODO: keep the selection valid", 17, null),
      L("context", "  useEffect(() => {", 18, 20),
    ] },
    { oldStart: 88, oldLines: 6, newStart: 90, newLines: 7, header: "const toggle = useCallback(", lines: [
      L("context", "    (entry: GitFileEntry, area: GitArea) => {", 88, 90),
      L("context", "      const paths = [entry.path];", 89, 91),
      L("del", "      void run(`Stage ${entry.path}`, () => api.stage(paths));", 90, null),
      L("add", "      if (area === \"staged\") void run(`Unstage ${entry.path}`, () => api.unstage(paths));", null, 92),
      L("add", "      else void run(`Stage ${entry.path}`, () => api.stage(paths));", null, 93),
      L("context", "    },", 91, 94),
      L("context", "    [api, run],", 92, 95),
      L("context", "  );", 93, 96),
    ] },
  ],
};
export async function invoke(command: string, args: any = {}) {
  switch (command) {
    case "git_gui_status": return status;
    case "git_gui_refs": return refs;
    case "git_gui_file_diff": return diff;
    case "git_gui_log": return commits.slice(args.skip, args.skip + args.limit);
    case "git_gui_commit_detail": { const c = commits.find((x) => x.sha === args.sha)!; return { ...c, body: "Lanes never shift sideways, so each row is drawn from pass, top and bottom\nsegments. Parents outside the page keep their lane open.", committerName: c.authorName, committerDate: c.date }; }
    case "git_gui_commit_files": return [diff, { ...diff, oldPath: "/dev/null", newPath: "src/lib/git/graph.ts", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, header: "", lines: [L("add", "// SPDX-License-Identifier: Apache-2.0", null, 1), L("add", "export const LANE_COLOR_COUNT = 8;", null, 2), L("add", "", null, 3)] }] }];
    case "git_gui_stash_files": return [diff];
    case "git_gui_last_message": return "Keep the browser following the tab rail";
    default: return { output: "", conflicts: [] };
  }
}
export async function listen() { return noop; }
export async function emit() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
