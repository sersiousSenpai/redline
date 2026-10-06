import { describe, expect, it } from "vitest";
import { buildPatch, fileSelection, hunkSelection, lineKey } from "./patch";
import type { GitDiffFile, GitDiffLine } from "./types";

// Compact diff-line builders: " x" context, "-x" del, "+x" add, a trailing "\\"
// marks "\ No newline at end of file" after the line.
function hunkLines(spec: string[], oldStart: number, newStart: number): GitDiffLine[] {
  let o = oldStart;
  let n = newStart;
  return spec.map((raw) => {
    const noNewline = raw.endsWith("\\");
    const body = noNewline ? raw.slice(0, -1) : raw;
    const sign = body[0];
    const text = body.slice(1);
    const kind = sign === "+" ? "add" : sign === "-" ? "del" : "context";
    const line: GitDiffLine = {
      kind,
      oldLine: kind === "add" ? null : o++,
      newLine: kind === "del" ? null : n++,
      text,
    };
    if (noNewline) line.noNewline = true;
    return line;
  });
}

function file(
  path: string,
  hunks: Array<{ old: [number, number]; new: [number, number]; header?: string; lines: string[] }>,
  status: GitDiffFile["status"] = "modified",
): GitDiffFile {
  return {
    oldPath: status === "added" ? "/dev/null" : path,
    newPath: status === "deleted" ? "/dev/null" : path,
    status,
    binary: false,
    hunks: hunks.map((h) => ({
      oldStart: h.old[0],
      oldLines: h.old[1],
      newStart: h.new[0],
      newLines: h.new[1],
      header: h.header ?? "",
      lines: hunkLines(h.lines, h.old[0], h.new[0]),
    })),
  };
}

const keys = (...pairs: Array<[number, number]>) => new Set(pairs.map(([h, l]) => lineKey(h, l)));

// One modified file with two hunks:
//   hunk 0: line 5 rewritten, two lines added after line 6
//   hunk 1: line 20 removed
const modified = file("src/app.ts", [
  {
    old: [3, 5],
    new: [3, 7],
    header: "function main() {",
    lines: [" three", " four", "-five", "+FIVE", " six", "+added a", "+added b", " seven"],
  },
  { old: [18, 5], new: [20, 4], lines: [" l18", " l19", "-l20", " l21", " l22"] },
]);

describe("buildPatch: stage (forward)", () => {
  it("stages a whole hunk byte-for-byte", () => {
    expect(buildPatch(modified, hunkSelection(modified, 0), "stage")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,5 +3,7 @@ function main() {",
        " three",
        " four",
        "-five",
        "+FIVE",
        " six",
        "+added a",
        "+added b",
        " seven",
        "",
      ].join("\n"),
    );
  });

  it("drops unselected additions and keeps unselected deletions as context", () => {
    // select only "+added b"
    expect(buildPatch(modified, keys([0, 6]), "stage")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,5 +3,6 @@ function main() {",
        " three",
        " four",
        " five",
        " six",
        "+added b",
        " seven",
        "",
      ].join("\n"),
    );
  });

  it("cuts a partial selection across a -/+ run", () => {
    // select "-five" without "+FIVE": the line is deleted, the rewrite is not staged
    expect(buildPatch(modified, keys([0, 2]), "stage")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,5 +3,4 @@ function main() {",
        " three",
        " four",
        "-five",
        " six",
        " seven",
        "",
      ].join("\n"),
    );
  });

  it("emits only the hunks with selected changes, in order, across hunks", () => {
    expect(buildPatch(modified, keys([0, 3], [1, 2]), "stage")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,5 +3,6 @@ function main() {",
        " three",
        " four",
        " five",
        "+FIVE",
        " six",
        " seven",
        "@@ -18,5 +20,4 @@",
        " l18",
        " l19",
        "-l20",
        " l21",
        " l22",
        "",
      ].join("\n"),
    );
  });

  it("returns null when nothing changeable is selected", () => {
    expect(buildPatch(modified, new Set(), "stage")).toBeNull();
    expect(buildPatch(modified, keys([0, 0], [0, 1]), "stage")).toBeNull(); // context only
    expect(buildPatch({ ...modified, binary: true }, fileSelection(modified), "stage")).toBeNull();
  });
});

describe("buildPatch: reverse (unstage / discard, applied with -R)", () => {
  it("reverses a whole hunk unchanged (git apply -R flips it)", () => {
    expect(buildPatch(modified, hunkSelection(modified, 1), "reverse")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -18,5 +20,4 @@",
        " l18",
        " l19",
        "-l20",
        " l21",
        " l22",
        "",
      ].join("\n"),
    );
  });

  it("drops unselected deletions and keeps unselected additions as context", () => {
    // select only "+added a": unstaging/discarding it leaves FIVE and added b alone
    expect(buildPatch(modified, keys([0, 5]), "reverse")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,6 +3,7 @@ function main() {",
        " three",
        " four",
        " FIVE",
        " six",
        "+added a",
        " added b",
        " seven",
        "",
      ].join("\n"),
    );
  });

  it("cuts a partial selection across a -/+ run", () => {
    // select "+FIVE" only: discarding it removes FIVE without restoring five
    expect(buildPatch(modified, keys([0, 3]), "reverse")).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,6 +3,7 @@ function main() {",
        " three",
        " four",
        "+FIVE",
        " six",
        " added a",
        " added b",
        " seven",
        "",
      ].join("\n"),
    );
  });
});

describe("buildPatch: end of file without a newline", () => {
  // old: "a\nb\nfoo"   new: "a\nb\nfoo\nbar"
  const eof = file("eof.txt", [
    { old: [1, 3], new: [1, 4], lines: [" a", " b", "-foo\\", "+foo", "+bar\\"] },
  ]);

  it("preserves both markers for the full hunk", () => {
    expect(buildPatch(eof, hunkSelection(eof, 0), "stage")).toBe(
      [
        "diff --git a/eof.txt b/eof.txt",
        "--- a/eof.txt",
        "+++ b/eof.txt",
        "@@ -1,3 +1,4 @@",
        " a",
        " b",
        "-foo",
        "\\ No newline at end of file",
        "+foo",
        "+bar",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("splits a deletion turned context when lines follow it in the index", () => {
    // stage "+foo" only: the old unterminated foo stays, and gains a newline
    // because the staged foo now follows it
    expect(buildPatch(eof, keys([0, 3]), "stage")).toBe(
      [
        "diff --git a/eof.txt b/eof.txt",
        "--- a/eof.txt",
        "+++ b/eof.txt",
        "@@ -1,3 +1,4 @@",
        " a",
        " b",
        "-foo",
        "\\ No newline at end of file",
        "+foo",
        "+foo",
        "",
      ].join("\n"),
    );
  });

  it("stages a trailing addition after a line that lacked a newline", () => {
    // stage "+bar" only: old foo must gain a newline in the index
    expect(buildPatch(eof, keys([0, 4]), "stage")).toBe(
      [
        "diff --git a/eof.txt b/eof.txt",
        "--- a/eof.txt",
        "+++ b/eof.txt",
        "@@ -1,3 +1,4 @@",
        " a",
        " b",
        "-foo",
        "\\ No newline at end of file",
        "+foo",
        "+bar",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("keeps the marker on an addition turned context that stays last on both sides", () => {
    // discard "-foo" only: restores the old foo line and keeps foo + bar; bar
    // stays the unterminated last line on both sides
    expect(buildPatch(eof, keys([0, 2]), "reverse")).toBe(
      [
        "diff --git a/eof.txt b/eof.txt",
        "--- a/eof.txt",
        "+++ b/eof.txt",
        "@@ -1,5 +1,4 @@",
        " a",
        " b",
        "-foo",
        " foo",
        " bar",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("keeps a shared context marker as context", () => {
    const tail = file("t.txt", [{ old: [1, 3], new: [1, 3], lines: [" a", "-b", "+B", " c\\"] }]);
    expect(buildPatch(tail, keys([0, 2]), "stage")).toBe(
      [
        "diff --git a/t.txt b/t.txt",
        "--- a/t.txt",
        "+++ b/t.txt",
        "@@ -1,3 +1,4 @@",
        " a",
        " b",
        "+B",
        " c",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });
});

describe("buildPatch: new and deleted files", () => {
  const created = file("new.txt", [{ old: [0, 0], new: [1, 3], lines: ["+one", "+two", "+three"] }], "added");
  const removed = file("old.txt", [{ old: [1, 3], new: [0, 0], lines: ["-one", "-two", "-three"] }], "deleted");

  it("stages part of an untracked file as a creation", () => {
    expect(buildPatch(created, keys([0, 0], [0, 2]), "stage")).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+three",
        "",
      ].join("\n"),
    );
  });

  it("unstages a whole new file as a reversed creation", () => {
    expect(buildPatch(created, fileSelection(created), "reverse")).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,3 @@",
        "+one",
        "+two",
        "+three",
        "",
      ].join("\n"),
    );
  });

  it("turns a partial reverse of a new file into a modification", () => {
    expect(buildPatch(created, keys([0, 1]), "reverse")).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "--- a/new.txt",
        "+++ b/new.txt",
        "@@ -1,2 +1,3 @@",
        " one",
        "+two",
        " three",
        "",
      ].join("\n"),
    );
  });

  it("stages a whole deletion as a deletion", () => {
    expect(buildPatch(removed, hunkSelection(removed, 0), "stage")).toBe(
      [
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100644",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-one",
        "-two",
        "-three",
        "",
      ].join("\n"),
    );
  });

  it("turns a partial deletion into a modification", () => {
    expect(buildPatch(removed, keys([0, 1]), "stage")).toBe(
      [
        "diff --git a/old.txt b/old.txt",
        "--- a/old.txt",
        "+++ b/old.txt",
        "@@ -1,3 +1,2 @@",
        " one",
        "-two",
        " three",
        "",
      ].join("\n"),
    );
  });

  it("keeps a deleted file's marker", () => {
    const gone = file("g.txt", [{ old: [1, 2], new: [0, 0], lines: ["-one", "-two\\"] }], "deleted");
    expect(buildPatch(gone, fileSelection(gone), "reverse")).toBe(
      [
        "diff --git a/g.txt b/g.txt",
        "deleted file mode 100644",
        "--- a/g.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });
});

describe("buildPatch: path spelling", () => {
  it("adds git's TAB after a name with a space and C-quotes unprintable names", () => {
    const spaced = file("my file.txt", [{ old: [1, 1], new: [1, 1], lines: ["-a", "+b"] }]);
    expect(buildPatch(spaced, fileSelection(spaced), "stage")!.split("\n").slice(0, 3)).toEqual([
      "diff --git a/my file.txt b/my file.txt",
      "--- a/my file.txt\t",
      "+++ b/my file.txt\t",
    ]);
    const quoted = file('café "x".txt', [{ old: [1, 1], new: [1, 1], lines: ["-a", "+b"] }]);
    expect(buildPatch(quoted, fileSelection(quoted), "stage")!.split("\n").slice(0, 3)).toEqual([
      '"diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"'.slice(1),
      '--- "a/caf\\303\\251 \\"x\\".txt"',
      '+++ "b/caf\\303\\251 \\"x\\".txt"',
    ]);
  });

  it("writes a single-line range without a count, like git", () => {
    const one = file("one.txt", [{ old: [4, 1], new: [4, 1], lines: ["-x", "+y"] }]);
    expect(buildPatch(one, fileSelection(one), "stage")).toContain("@@ -4 +4 @@\n");
    // dropping the addition empties the new side: git writes it as the line before
    expect(buildPatch(one, keys([0, 0]), "stage")).toContain("@@ -4 +3,0 @@\n");
  });

  it("moves a zero-length side forward when it gains context", () => {
    const insert = file("i.txt", [{ old: [5, 0], new: [6, 2], lines: ["+p", "+q"] }]);
    expect(buildPatch(insert, keys([0, 1]), "reverse")).toContain("@@ -6 +6,2 @@\n p\n+q\n");
  });
});
