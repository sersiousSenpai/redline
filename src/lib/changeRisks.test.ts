import { expect, it } from "vitest";
import type { DiffFile } from "../types";
import { changeRisks } from "./changeRisks";
const file = (
  path: string,
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  oldPath: path,
  newPath: path,
  status,
  binary: false,
  hunks: [],
});
it.each([
  ["deleted", "old.txt", "deleted"],
  ["dependency", "package-lock.json", "modified"],
  ["secret", ".env.production", "modified"],
  ["secret", "keys/server.pem", "added"],
  ["migration", "db/migrations/001.sql", "added"],
  ["automation", ".github/workflows/test.yml", "modified"],
] as const)("flags %s changes", (kind, path, status) => {
  expect(changeRisks([file(path, status)]).map((r) => r.kind)).toContain(kind);
});
it("normal source edits don't imply danger", () => {
  expect(changeRisks([file("src/app.ts")])).toEqual([]);
});
it("flags large changes and credential content without exposing a secret", () => {
  const f = file("src/config.ts");
  f.hunks = [
    {
      header: "",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1001,
      lines: Array.from({ length: 1001 }, (_, i) => ({
        kind: "add",
        text: i ? "line" : 'api_key = "very-private-token"',
        oldLine: null,
        newLine: i + 1,
      })),
    },
  ];
  const flags = changeRisks([f]);
  expect(flags.map((r) => r.kind)).toEqual(["secret", "large"]);
  expect(JSON.stringify(flags)).not.toContain("very-private-token");
});
