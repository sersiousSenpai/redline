// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Replay every saved selection-anchored plan comment through the real
// in-editor highlight resolver and report which ones paint their quote.
//
//   cp ~/Library/Application\ Support/com.redline.app/redline.db{,-wal,-shm} /private/tmp/rl-replay/
//   npx vite-node --config vitest.config.ts scripts/replay-comment-highlights.ts /private/tmp/rl-replay/redline.db
//
// Always point it at a COPY: the live database is refused. Each comment is
// resolved against the revision it was captured on (the coordinate system its
// charStart/charEnd were measured in), with the same Tiptap schema and
// `CommentHighlights` plugin the plan editor mounts. A comment counts as
// painted when the decorated text equals its quote as the block spells it:
// verbatim where it appears (a code block keeps real newlines), otherwise with
// newlines dropped — `Selection.toString()` puts them between list items /
// paragraphs, while the document's text joins textblocks with nothing.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dbArg = process.argv[2];
if (!dbArg) {
  console.error("usage: replay-comment-highlights.ts <copy-of-redline.db>");
  process.exit(2);
}
// `.native` also canonicalizes letter case, so a differently-cased spelling
// of the live path on a case-insensitive volume can't slip past the guard.
const dbPath = realpathSync.native(dbArg);
const liveDir = path.join(
  os.homedir(),
  "Library/Application Support/com.redline.app",
);
let liveReal = liveDir;
try {
  liveReal = realpathSync.native(liveDir);
} catch {
  // No app data on this machine — nothing to protect.
}
if (dbPath.startsWith(liveReal + path.sep)) {
  console.error(`refusing to open the live database; copy it out of ${liveDir} first`);
  process.exit(2);
}

// ProseMirror builds DOM even headless; install a jsdom window before the
// editor modules load (hence the dynamic imports below).
const { JSDOM } = await import("jsdom");
const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => (window as unknown as Record<string, unknown>)[key],
    });
  }
}

// Via getBuiltinModule: vite-node's resolver doesn't know `node:sqlite` yet.
const { DatabaseSync } = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");
const { Editor } = await import("@tiptap/core");
const { planExtensions } = await import("../src/editor/extensions/planExtensions");
const { CommentHighlights, commentHighlightsKey } = await import(
  "../src/editor/extensions/CommentHighlights"
);
const { planMarkdownToDoc } = await import("../src/editor/markdown");
type Range = import("../src/editor/resolveHighlightRange").CommentHighlightRange;
type DecorationSet = import("@tiptap/pm/view").DecorationSet;

interface Row {
  sessionId: string;
  commentId: string;
  revision: number;
  blockId: string;
  subBlockId: string | null;
  charStart: number;
  charEnd: number;
  quotedText: string;
  markdown: string;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare(
    `SELECT c.session_id AS sessionId, c.id AS commentId,
            c.version_number AS revision, c.block_id AS blockId,
            c.sel_sub_block_id AS subBlockId, c.sel_char_start AS charStart,
            c.sel_char_end AS charEnd, c.sel_quoted_text AS quotedText,
            r.raw_plan_markdown AS markdown
       FROM comments c
       JOIN revisions r
         ON r.session_id = c.session_id AND r.version_number = c.version_number
      WHERE c.sel_char_start IS NOT NULL AND c.block_id IS NOT NULL
      ORDER BY c.session_id, c.version_number, c.id`,
  )
  .all() as unknown as Row[];
db.close();

const byRevision = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.sessionId}\u0000${row.revision}`;
  const list = byRevision.get(key);
  if (list) list.push(row);
  else byRevision.set(key, [row]);
}

// `drifted`: the block is gone from the revision or no longer contains the
// quote — real drift no resolver can recover.
type Outcome = "painted" | "wrong-text" | "unpainted" | "drifted";
const tally: Record<Outcome, number> = {
  painted: 0,
  "wrong-text": 0,
  unpainted: 0,
  drifted: 0,
};
const failuresByType = new Map<string, number>();
const failures: string[] = [];

for (const group of byRevision.values()) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [...planExtensions(), CommentHighlights],
    content: planMarkdownToDoc(group[0].markdown).toJSON(),
  });
  const ranges: Range[] = group.map((row) => ({
    commentId: row.commentId,
    blockId: row.blockId,
    charStart: row.charStart,
    charEnd: row.charEnd,
    quotedText: row.quotedText,
    ...(row.subBlockId ? { subBlockId: row.subBlockId } : {}),
    muted: false,
  }));
  editor.commands.setCommentHighlights(ranges);

  const { state } = editor;
  const plugin = commentHighlightsKey.get(state)!;
  const decorations = plugin.props.decorations!.call(plugin, state) as DecorationSet;
  const painted = new Map<string, string>();
  for (const deco of decorations.find()) {
    // Inline decorations keep their attrs on the (internal) `type`.
    const attrs = (deco as unknown as { type: { attrs: Record<string, string> } })
      .type.attrs;
    painted.set(attrs["data-comment-id"], state.doc.textBetween(deco.from, deco.to));
  }
  const blocks = new Map<string, { type: string; text: string }>();
  state.doc.forEach((node) => {
    if (node.attrs.blockId) {
      blocks.set(node.attrs.blockId, { type: node.type.name, text: node.textContent });
    }
  });

  for (const row of group) {
    const text = painted.get(row.commentId);
    const block = blocks.get(row.blockId);
    const quote = block?.text.includes(row.quotedText)
      ? row.quotedText
      : row.quotedText.replace(/\n+/g, "");
    let outcome: Outcome;
    if (text === quote) outcome = "painted";
    else if (!block || !block.text.includes(quote)) outcome = "drifted";
    else if (text === undefined) outcome = "unpainted";
    else outcome = "wrong-text";
    tally[outcome] += 1;
    if (outcome === "painted") continue;
    const type = block?.type ?? "(missing)";
    failuresByType.set(type, (failuresByType.get(type) ?? 0) + 1);
    failures.push(
      `  ${outcome.padEnd(11)} ${row.sessionId.slice(0, 8)} r${row.revision} ${row.commentId} ` +
        `${type} [${row.charStart},${row.charEnd}]${row.subBlockId ? ` ${row.subBlockId}` : ""} ` +
        JSON.stringify(row.quotedText.slice(0, 60)) +
        (text !== undefined ? ` → ${JSON.stringify(text.slice(0, 60))}` : ""),
    );
  }
  editor.destroy();
  el.remove();
}

console.log(`${rows.length} selection-anchored comments over ${byRevision.size} revisions`);
for (const [outcome, n] of Object.entries(tally)) {
  console.log(`  ${outcome.padEnd(11)} ${n}`);
}
if (failures.length > 0) {
  console.log("not painted, by block type:");
  for (const [type, n] of failuresByType) console.log(`  ${type.padEnd(11)} ${n}`);
  console.log("details:");
  for (const line of failures) console.log(line);
}
