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

  it("the browser pane hands its memoized page chat no inline closure or object", () => {
    const pane = read("src/components/BrowserPane.tsx");
    const start = pane.indexOf("<BrowserChat\n");
    expect(start).toBeGreaterThan(-1);
    expect(pane.slice(start, pane.indexOf("/>", start))).not.toMatch(/=>|=\{\{/);
  });

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
    "src/components/OrchestrationSurface.tsx",
    "src/components/MemoryStatusPill.tsx",
    "src/components/StreamInspector.tsx",
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

describe("chat drafts", () => {
  // A keystroke writes memory and re-renders the box's subscribers; the disk
  // copy trails on a debounce. A synchronous localStorage.setItem per key is
  // what Phase 2 took off the Front Door.
  it.each([
    ["src/components/BrowserChat.tsx", "rl.chatDraft.browse."],
    ["src/components/MissionChat.tsx", "rl.chatDraft.mission."],
    ["src/components/MemoryAsk.tsx", "rl.chatDraft.memchat"],
  ])("%s keeps its draft in the shared draft store", (path, key) => {
    const source = read(path);
    expect(source).toMatch(new RegExp(`useSharedDraft\\([\`"]${key.replace(/\./g, "\\.")}`));
    expect(source).not.toContain("usePersistedState");
  });
});

describe("one reply anatomy", () => {
  // Design decision 4: every chat surface draws a reply through `ReplyBlock`,
  // whose tail row is the turn's one status line — so no surface keeps a
  // progress strip, a second working indicator, or a bubble of its own.
  const SURFACES = [
    "src/components/ChatRoom.tsx",
    "src/components/BrowserChat.tsx",
    "src/components/MissionChat.tsx",
    "src/components/MemoryAsk.tsx",
    "src/components/CommentThread.tsx",
    "src/components/ReviewThread.tsx",
    "src/components/DrafterSidecar.tsx",
  ];

  it.each(SURFACES)("%s streams and settles its replies through ReplyBlock", (path) => {
    const source = read(path);
    expect(source).toMatch(/<ReplyBlock[^>]*\n?[^>]*phase="live"/);
    expect(source).toMatch(/<ReplyBlock[^>]*\n?[^>]*phase="settled"/);
    // The old bubble, footer and per-surface markdown rows are gone.
    expect(source).not.toMatch(/StreamingBubble|<TurnFooter|<MarkdownView|<StreamingText/);
  });

  it.each(SURFACES)("%s draws no working indicator in its thread", (path) => {
    const source = read(path);
    const uses = source.match(/<WorkingIndicator\b/g) ?? [];
    if (!path.endsWith("CommentThread.tsx")) return expect(uses).toEqual([]);
    // The plan comment's one: the collapsed heading's badge, shown only
    // while the thread (and so its reply's status line) is folded away.
    expect(uses).toHaveLength(1);
    const at = source.indexOf("<WorkingIndicator");
    expect(source.slice(at - 300, at)).toContain('status === "streaming" && !expanded');
  });

  it("a surface that opens links in a Redline tab opens the reviewer's links there too", () => {
    for (const path of ["src/components/BrowserChat.tsx", "src/components/MissionChat.tsx"]) {
      expect(read(path), path).toMatch(/<UserTurn [^>]*onOpenLink=\{onOpenLink\}/);
    }
  });

  it("the chat room has no progress strip: Stop is the composer's, status the reply's", () => {
    const room = read("src/components/ChatRoom.tsx");
    expect(room).not.toContain("ChatTurnProgress");
    expect(room).not.toContain("data-chat-progress");
    expect(room).toMatch(/streaming, onStop: cancel/);
  });

  it("every queueing surface shows its queue in the tray, and no surface shows it in the transcript", () => {
    // The page chat's tray is one of its status rail's (BC-39), from the
    // same pill and rows.
    for (const path of SURFACES.slice(0, 4)) expect(read(path), path).toMatch(path.endsWith("BrowserChat.tsx") ? /<StatusRail\b/ : /<QueueTray\b/);
    expect(read("src/components/BrowserChatParts.tsx")).toMatch(/<QueuePill\b[\s\S]*<QueueRows\b|<QueueRows\b[\s\S]*<QueuePill\b/);
    expect(read("src/hooks/useAgentTurn.ts")).toMatch(/messages: state\.messages,/);
    for (const path of SURFACES) expect(read(path), path).not.toMatch(/QueuedChip|status === "queued"/);
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
    expect(read("src/components/SessionSidebar.tsx")).toContain('<li className="rl-session-row relative group"');
    expect(read("src/components/SessionSidebar.tsx")).toContain('<li className="rl-revision-row">');
    expect(read("src/components/FileTree.tsx")).toContain("rl-file-row");
  });

  it("nowhere else: comment cards and transcripts scroll to and pin rows it would misplace", () => {
    const users = css("src").filter((path) => /content-visibility/.test(read(path)));
    expect(users).toEqual([join("src", "styles.css")]);
    // Three declarations: the rows' `auto` above, `hidden` on the folded
    // terminal dock — a 0px fold nothing scrolls to, whose xterm layers would
    // otherwise be kept warm behind it (perf-budget "Idle heat") — and
    // `hidden` on a workbench tab that is kept mounted but not showing (W1):
    // its webview, editor and terminal state survive the switch, it is
    // `inert`, and nothing scrolls to a row inside a hidden tab.
    const styles = read("src/styles.css");
    expect(styles.match(/content-visibility:/g)).toHaveLength(3);
    expect(styles).toMatch(/\.rl-term-dock\[data-collapsed\]\s*\{\s*content-visibility:\s*hidden;\s*\}/);
    expect(styles).toMatch(/\.rl-wb-tab-body\[data-hidden\]\s*\{\s*content-visibility:\s*hidden;/);
  });
});
