// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Where a running dev server's ports chip goes (W7, D44). Two places, never
//! more:
//!
//! - **The project's header**, once: every server whose project folder (the
//!   scan's `projectPath`, resolved from the process's own cwd) is that
//!   project's folder or inside it, the most specific project winning.
//! - **A session's row**, only when the server is that session's own: a
//!   process under one of its terminals listens on the port (`pty_procs`
//!   walks each listener up to the terminal's shell). A folder is not
//!   ownership: one dev server in a repo once put the same chip on every plan
//!   of that repo.
//!
//! A server neither holds stays on the Localhost place alone.

/** What the chip needs from a scan's running server. */
export interface PortServer {
  port: number;
  url: string;
  projectPath: string;
  projectName: string;
  runCommand: string;
}

/** A chip: plain strings, so a rescan that found the same servers keeps the
 *  row's props equal by value. */
export interface PortChip {
  label: string;
  url: string;
  title: string;
}

const trim = (p: string) => p.replace(/\/+$/, "");

/** The home folder and above (`/`, `/Users/me`, `/home/me`, `/root`) are not
 *  a project: a section there would claim every server it has. */
const isProjectFolder = (p: string) => !/^(\/(Users|home)(\/[^/]+)?|\/root)?$/.test(p);

/** ":5173", or ":5173 +2" when more servers share the chip. */
export function portChipLabel(ports: readonly number[]): string {
  if (ports.length === 0) return "";
  return `:${ports[0]}` + (ports.length > 1 ? ` +${ports.length - 1}` : "");
}

/** One chip for several servers: ports sorted and deduped, the lowest opens,
 *  the title names each command. */
function chipOf(list: readonly PortServer[]): PortChip {
  const sorted = [...new Map(list.map((x) => [x.port, x])).values()].sort((a, b) => a.port - b.port);
  return {
    label: portChipLabel(sorted.map((x) => x.port)),
    url: sorted[0].url,
    title: sorted.map((x) => `:${x.port} · ${x.runCommand || x.projectName}`).join("\n"),
  };
}

function collect<K>(pairs: Iterable<[K, PortServer]>): Map<K, PortServer[]> {
  const out = new Map<K, PortServer[]>();
  for (const [key, server] of pairs) (out.get(key) ?? out.set(key, []).get(key)!).push(server);
  return out;
}

/** The project headers' chips, by project folder (as the sidebar's sections
 *  key it: no trailing slash). */
export function projectPortChips(
  servers: readonly PortServer[],
  projectPaths: readonly string[],
): Record<string, PortChip> {
  const folders = projectPaths.map(trim).filter(isProjectFolder);
  const pairs: [string, PortServer][] = [];
  for (const server of servers) {
    const path = trim(server.projectPath);
    let best = "";
    for (const folder of folders) {
      if ((path === folder || path.startsWith(folder + "/")) && folder.length > best.length) best = folder;
    }
    if (best) pairs.push([best, server]);
  }
  return Object.fromEntries([...collect(pairs)].map(([folder, list]) => [folder, chipOf(list)]));
}

/** The session rows' chips, by session id: a server whose port a process
 *  under one of the session's own terminals listens on. */
export function ownPortChips(
  servers: readonly PortServer[],
  terminals: Readonly<Record<string, readonly { ports?: readonly number[] }[] | undefined>>,
): Record<string, PortChip> {
  const pairs: [string, PortServer][] = [];
  for (const [sessionId, list] of Object.entries(terminals)) {
    if (!sessionId || !list) continue;
    const ports = new Set(list.flatMap((t) => t.ports ?? []));
    if (ports.size === 0) continue;
    for (const server of servers) if (ports.has(server.port)) pairs.push([sessionId, server]);
  }
  return Object.fromEntries([...collect(pairs)].map(([id, list]) => [id, chipOf(list)]));
}
