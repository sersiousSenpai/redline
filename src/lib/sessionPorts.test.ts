// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ownPortChips, portChipLabel, projectPortChips, type PortServer } from "./sessionPorts";

const server = (port: number, projectPath: string, runCommand = "npm run dev"): PortServer => ({
  port,
  url: `http://localhost:${port}`,
  projectPath,
  projectName: projectPath.split("/").pop() ?? "",
  runCommand,
});

describe("portChipLabel", () => {
  it.each([
    [[], ""],
    [[5173], ":5173"],
    [[5173, 3000], ":5173 +1"],
    [[3000, 5173, 8080], ":3000 +2"],
  ])("%j → %j", (ports, label) => {
    expect(portChipLabel(ports)).toBe(label);
  });
});

describe("projectPortChips: which project header a server sits on", () => {
  const projects = ["/Users/me/redline", "/Users/me/redline/apps/web", "/Users/me/redline-site", "/Users/me", "/", "/srv/app"];
  it.each<[string, PortServer, string[]]>([
    ["the project's own folder", server(1420, "/Users/me/redline"), ["/Users/me/redline"]],
    ["inside it, a trailing slash ignored", server(1421, "/Users/me/redline/crates/x/"), ["/Users/me/redline"]],
    ["the most specific project wins", server(5173, "/Users/me/redline/apps/web"), ["/Users/me/redline/apps/web"]],
    ["a sibling sharing a prefix is not inside", server(4321, "/Users/me/redline-site"), ["/Users/me/redline-site"]],
    ["a sibling's subfolder neither", server(4322, "/Users/me/redline-sites/x"), []],
    ["home and / never claim a server", server(8000, "/Users/me/scratch"), []],
    ["a two-segment project folder is a project", server(9000, "/srv/app/web"), ["/srv/app"]],
    ["outside every project: Localhost only", server(3000, "/tmp/demo"), []],
  ])("%s", (_, s, owners) => {
    expect(Object.keys(projectPortChips([s], projects)).sort()).toEqual(owners);
  });

  it("one chip per project: ports sorted and deduped, the lowest opens, the title names each command", () => {
    const chips = projectPortChips(
      [server(5174, "/Users/me/redline/apps/web", "vite"), server(1420, "/Users/me/redline"), server(1420, "/Users/me/redline"), server(7000, "/Users/me/redline/docs", "")],
      ["/Users/me/redline/"],
    );
    expect(chips).toEqual({
      "/Users/me/redline": { label: ":1420 +2", url: "http://localhost:1420", title: ":1420 · npm run dev\n:5174 · vite\n:7000 · docs" },
    });
  });

  it("no servers, no chips", () => {
    expect(projectPortChips([], projects)).toEqual({});
  });
});

describe("ownPortChips: a session row's chip is its own terminals' servers alone", () => {
  // One dev server in qwallah: its plans share the folder, one owns the server.
  const servers = [server(3000, "/Users/me/qwallah"), server(5173, "/Users/me/qwallah/web", "vite"), server(7676, "/Users/me/redline")];
  it("a session whose terminal listens on the port wears it; its folder-mates do not", () => {
    const chips = ownPortChips(servers, {
      a: [{ ports: [] }, { ports: [3000] }],
      b: [{ ports: [] }],
      c: undefined,
    });
    expect(chips).toEqual({ a: { label: ":3000", url: "http://localhost:3000", title: ":3000 · npm run dev" } });
  });

  it("several servers under one session's terminals are one chip", () => {
    expect(ownPortChips(servers, { a: [{ ports: [5173] }, { ports: [3000, 3000] }] }).a.label).toBe(":3000 +1");
  });

  it("a port the scan does not list (stopped, or not a dev server) draws nothing", () => {
    expect(ownPortChips(servers, { a: [{ ports: [9229] }] })).toEqual({});
  });

  it("Home's terminals (key \"\") have no row and so no chip", () => {
    expect(ownPortChips(servers, { "": [{ ports: [3000] }] })).toEqual({});
  });

  it("terminals with no process sample yet draw nothing", () => {
    expect(ownPortChips(servers, { a: [{}] })).toEqual({});
  });
});
