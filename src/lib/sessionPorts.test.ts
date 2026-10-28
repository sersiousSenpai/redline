// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { portChipLabel, portChips, type PortServer } from "./sessionPorts";

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

describe("portChips: which session a server belongs to", () => {
  const sessions = [
    { sessionId: "repo", projectPath: "/Users/me/redline" },
    { sessionId: "repo2", projectPath: "/Users/me/redline/" },
    { sessionId: "web", projectPath: "/Users/me/redline/apps/web" },
    { sessionId: "other", projectPath: "/Users/me/redline-site" },
    { sessionId: "home", projectPath: "/Users/me" },
    { sessionId: "root", projectPath: "/" },
    { sessionId: "none", projectPath: null },
    { sessionId: "srv", projectPath: "/srv/app" },
  ];
  it.each<[string, PortServer, string[]]>([
    ["the session's own folder", server(1420, "/Users/me/redline"), ["repo", "repo2"]],
    ["inside it, a trailing slash ignored", server(1421, "/Users/me/redline/crates/x/"), ["repo", "repo2"]],
    ["the most specific folder wins", server(5173, "/Users/me/redline/apps/web"), ["web"]],
    ["a sibling sharing a prefix is not inside", server(4321, "/Users/me/redline-site"), ["other"]],
    ["a sibling's subfolder neither", server(4322, "/Users/me/redline-sites/x"), []],
    ["home and / never claim a server", server(8000, "/Users/me/scratch"), []],
    ["a two-segment project folder is a project", server(9000, "/srv/app/web"), ["srv"]],
    ["outside every session: Localhost only", server(3000, "/tmp/demo"), []],
  ])("%s", (_, s, owners) => {
    expect(Object.keys(portChips([s], sessions)).sort()).toEqual(owners);
  });

  it("one chip per session: ports sorted and deduped, the lowest opens, the title names each command", () => {
    const chips = portChips(
      [server(5174, "/Users/me/redline/apps/web", "vite"), server(1420, "/Users/me/redline"), server(1420, "/Users/me/redline"), server(7000, "/Users/me/redline/docs", "")],
      [{ sessionId: "repo", projectPath: "/Users/me/redline" }],
    );
    expect(chips).toEqual({
      repo: { label: ":1420 +2", url: "http://localhost:1420", title: ":1420 · npm run dev\n:5174 · vite\n:7000 · docs" },
    });
  });

  it("no servers, no chips", () => {
    expect(portChips([], sessions)).toEqual({});
  });
});
