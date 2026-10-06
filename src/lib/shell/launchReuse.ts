// SPDX-License-Identifier: Apache-2.0
import type { AgentShellLaunch } from "./types";
const pathKey = (path: string) => path.replace(/\/+$/, "") || "/";
/** Mode and model have live controls; startup directory grants, effort and
 * settings do not. Restart the same transcript to apply or revoke those. */
export function requiresHostedRestart(cwd: string, previous: AgentShellLaunch | undefined, next: AgentShellLaunch): boolean {
  if (next.restore || pathKey(next.cwd ?? cwd) !== pathKey(cwd)) return true;
  const roots = (dirs: string[] | undefined) => [...new Set((dirs ?? []).map(pathKey))].sort().join("\0");
  return roots(previous?.addDirs) !== roots(next.addDirs)
    || (previous?.settingsPath ?? null) !== (next.settingsPath ?? null)
    || (previous?.effort ?? null) !== (next.effort ?? null)
    || (previous?.backend ?? "claude-code") !== (next.backend ?? "claude-code");
}
