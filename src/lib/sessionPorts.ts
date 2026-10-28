// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which session a running dev server belongs to (W7's ports chip). A server
//! belongs to a session when its project folder (the scan's `projectPath`,
//! resolved from the process's own cwd) is the session's folder or inside
//! it; the most specific folder wins, and every session there shares it. A
//! server no session holds stays on the Localhost place alone.

/** What the chip needs from a scan's running server. */
export interface PortServer {
  port: number;
  url: string;
  projectPath: string;
  projectName: string;
  runCommand: string;
}

/** A session row's chip: plain strings, so a rescan that found the same
 *  servers keeps the row's props equal by value. */
export interface PortChip {
  label: string;
  url: string;
  title: string;
}

const trim = (p: string) => p.replace(/\/+$/, "");

/** The home folder and above (`/`, `/Users/me`, `/home/me`, `/root`) are not
 *  a project: a session started there would claim every server it has. */
const isProjectFolder = (p: string) => !/^(\/(Users|home)(\/[^/]+)?|\/root)?$/.test(p);

/** ":5173", or ":5173 +2" when more servers share the session. */
export function portChipLabel(ports: readonly number[]): string {
  if (ports.length === 0) return "";
  return `:${ports[0]}` + (ports.length > 1 ? ` +${ports.length - 1}` : "");
}

export function portChips(
  servers: readonly PortServer[],
  sessions: readonly { sessionId: string; projectPath: string | null }[],
): Record<string, PortChip> {
  const byFolder = new Map<string, string[]>();
  for (const s of sessions) {
    const folder = s.projectPath ? trim(s.projectPath) : "";
    if (isProjectFolder(folder)) (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(s.sessionId);
  }
  const held = new Map<string, PortServer[]>();
  for (const server of servers) {
    const path = trim(server.projectPath);
    let best = "";
    for (const folder of byFolder.keys()) {
      if ((path === folder || path.startsWith(folder + "/")) && folder.length > best.length) best = folder;
    }
    if (best) for (const id of byFolder.get(best)!) (held.get(id) ?? held.set(id, []).get(id)!).push(server);
  }
  const out: Record<string, PortChip> = {};
  for (const [id, list] of held) {
    const sorted = [...new Map(list.map((x) => [x.port, x])).values()].sort((a, b) => a.port - b.port);
    out[id] = {
      label: portChipLabel(sorted.map((x) => x.port)),
      url: sorted[0].url,
      title: sorted.map((x) => `:${x.port} · ${x.runCommand || x.projectName}`).join("\n"),
    };
  }
  return out;
}
