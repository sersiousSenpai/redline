// Synthetic Tauri boundary for the repository view fixture. Production components are imported intact.
import { commits, refs, head, headAhead, headBehind, CURRENT } from "./repo";

const noop = () => {};

const status = {
  branch: CURRENT, head, upstream: `origin/${CURRENT}`, ahead: headAhead, behind: headBehind, inProgress: null,
  staged: [{ path: "src/components/git/HistoryView.tsx", status: "M" }, { path: "src/lib/git/graph.ts", status: "A" }],
  unstaged: [
    { path: "src/components/git/FileStatusView.tsx", status: "M" },
    { path: "src/components/ReviewPanel.tsx", status: "M" },
    { path: "src/hooks/useSync.ts", status: "D" },
    { path: "docs/git-gui-notes.md", status: "?" },
  ],
  conflicted: [],
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
