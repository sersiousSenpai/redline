// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Re-render hygiene in the shell, asserted at the source: the memoized heavy
// children get props that keep their identity, reads that changed nothing
// keep the previous state, every poll runs through `usePoll`, the dock's
// fleet poll is the only thing that runs `lsof` for terminals, and
// `content-visibility` stays on the lists where nothing scrolls to a row.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const app = read("src/App.tsx");
/** The JSX element `<Name … />` as App renders it. */
const element = (name: string) => {
  const start = app.indexOf(`<${name}\n`);
  expect(start).toBeGreaterThan(-1);
  return app.slice(start, app.indexOf("/>", start));
};

describe("the shell keeps its memoized children's props stable", () => {
  it.each(["SessionSidebar", "BrowserPane", "TerminalTabs"])(
    "%s gets no inline closure — its handlers go through useStableHandlers",
    (name) => {
      expect(element(name)).not.toMatch(/=>/);
    },
  );

  it("each session row is memoized, with id-based handlers", () => {
    const sidebar = read("src/components/SessionSidebar.tsx");
    expect(sidebar).toContain("const SessionRow = memo(SessionRowBase);");
    expect(sidebar).toMatch(/onClick=\{clickRow\}\s*onToggleExpand=\{toggleExpand\}\s*onDelete=\{onDelete\}/);
  });

  it("a read that changed nothing keeps the previous state", () => {
    const refresh = app.slice(app.indexOf("async function refreshSummaries"), app.indexOf("const setPlanState"));
    expect(refresh).toContain("setSummaries((prev) => keepEqualRows(prev, list, (s) => s.sessionId))");
    const load = app.slice(app.indexOf("async function loadSession"), app.indexOf("// ── Core bootstrap"));
    expect(load).toContain("setSession((prev) => keepEqual(prev, full))");
    expect(app).toContain("setPresentHashes((prev) => keepEqual(prev, next))");
    expect(app).toContain("setCollabComments((prev) => keepEqual(prev, next))");
  });
});

describe("polling", () => {
  const migrated = [
    "src/components/TerminalTabs.tsx",
    "src/components/ChatRoom.tsx",
    "src/components/PromptDrafter.tsx",
    "src/components/BrowserPane.tsx",
    "src/hooks/usePush.ts",
    "src/hooks/useReview.ts",
    "src/hooks/useRunGraph.ts",
  ];
  it.each(migrated)("%s polls only through usePoll", (path) => {
    const source = read(path);
    expect(source).toContain("usePoll(");
    expect(source).not.toMatch(/\bsetInterval\(/);
  });

  it("the shell runs no lsof of its own: it follows the fleet poll's report", () => {
    expect(app).not.toMatch(/"pty_cwds?"|"pty_procs"/);
    expect(element("TerminalTabs")).toContain("onFocusedCwd={handleFocusedCwd}");
  });

  it("the dock samples cwds and processes on one clock", () => {
    const dock = read("src/components/TerminalTabs.tsx");
    const fleet = dock.slice(dock.indexOf("const sampleFleetNow = usePoll("), dock.indexOf("FLEET_POLL_MS,\n"));
    expect(fleet).toContain('"pty_cwds"');
    expect(fleet).toContain("sampleProcs()");
    expect(dock.match(/"pty_procs"/g)).toHaveLength(1);
  });
});

describe("content-visibility", () => {
  const ROWS = [".rl-session-row", ".rl-revision-row", ".rl-file-row"];
  const css = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return css(path);
      return /\.(css|tsx)$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
    });

  it("is on the sessions list, the revisions and the file tree, each with a reserved height", () => {
    const styles = read("src/styles.css");
    const rule = styles.match(/((?:\.[\w-]+,\s*)*\.[\w-]+)\s*\{\s*content-visibility:\s*auto;\s*\}/);
    expect(rule?.[1].split(",").map((s) => s.trim())).toEqual(ROWS);
    for (const row of ROWS) {
      expect(styles).toMatch(new RegExp(`\\${row}[^{]*\\{\\s*contain-intrinsic-height:\\s*auto \\d+px;`));
    }
    expect(read("src/components/SessionSidebar.tsx")).toContain('<li className="rl-session-row relative group">');
    expect(read("src/components/SessionSidebar.tsx")).toContain('<li className="rl-revision-row">');
    expect(read("src/components/FileTree.tsx")).toContain("rl-file-row");
  });

  it("nowhere else: comment cards and transcripts scroll to and pin rows it would misplace", () => {
    const users = css("src").filter((path) => /content-visibility/.test(read(path)));
    expect(users).toEqual([join("src", "styles.css")]);
    expect(read("src/styles.css").match(/content-visibility:/g)).toHaveLength(1);
  });
});
