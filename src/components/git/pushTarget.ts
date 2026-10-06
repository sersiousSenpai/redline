// SPDX-License-Identifier: Apache-2.0
import type { GitRefs, GitWorkingStatus } from "../../lib/git/types";
import { splitUpstream } from "./api";

/** Where a plain Push sends the current branch: its upstream, or the first
 *  remote with `--set-upstream`. Null when detached or there is no remote. */
export function pushTarget(status: GitWorkingStatus | null, refs: GitRefs | null) {
  if (!status?.branch || !refs) return null;
  const upstream = splitUpstream(status.upstream, refs.remotes);
  if (upstream) return { remote: upstream[0], branch: status.branch, setUpstream: false, label: status.upstream as string };
  const remote = refs.remotes.includes("origin") ? "origin" : refs.remotes[0];
  if (!remote) return null;
  return { remote, branch: status.branch, setUpstream: true, label: `${remote}/${status.branch}` };
}
