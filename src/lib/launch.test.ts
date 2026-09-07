// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { ProjectOption } from "../components/ProjectPicker";
import {
  extensionAddDirs,
  attemptLaunch,
  composePrompt,
  launchLiveness,
  launchReceipt,
  launchStillLive,
  nextBlocker,
  projectForDoc,
  resolveLaunchProject,
  restoreInto,
  staleBlocker,
  type DocProjectChoice,
  type ProjectChoice,
} from "./launch";
import type { ReadinessItem } from "./readiness";
import type { CombineSource } from "../types";

// The `launchStillLive` / `resolveLaunchProject` / `composePrompt` suites below
// moved here from `frontDoor.test.ts` unchanged — that is the proof the move
// was behaviour-free. The single edit is `lastDrafterProject` →
// `lastLaunchProject`: the field is no longer the Drafter's, because the last
// successful launch through ANY door is what should seed the next one.

describe("launchStillLive", () => {
  it("is dead only when a REPORTED set omits the terminal", () => {
    expect(launchStillLive("t1", ["t2", "t3"])).toBe(false);
    expect(launchStillLive("t1", [])).toBe(false);
  });

  it("stays alive while the terminal is still open", () => {
    expect(launchStillLive("t1", ["t1"])).toBe(true);
    expect(launchStillLive("t1", ["t2", "t1"])).toBe(true);
  });

  it("treats an unreported dock as ignorance, not death", () => {
    // The frames before the dock's first report would otherwise cancel every
    // launch the instant it started.
    expect(launchStillLive("t1", null)).toBe(true);
  });

  it("has nothing to track without a terminal id", () => {
    expect(launchStillLive(null, [])).toBe(true);
    expect(launchStillLive(null, null)).toBe(true);
  });

  it("a swap that keeps the count the same is still a death", () => {
    // The reason a tab COUNT can't answer this: close one, open another, and
    // the count never moved.
    expect(launchStillLive("t1", ["t9"])).toBe(false);
  });
});

describe("launchLiveness", () => {
  it("treats an absent id as ignorance until the dock has vouched for it", () => {
    // THE bug. A terminal id minted this tick is always absent from the report
    // the previous commit closed over, so `launchStillLive` alone read every
    // launch as dead on its first frame — cancelling it and handing the Front
    // Door's just-cleared sentence straight back.
    expect(launchLiveness("t1", ["t2"], false)).toEqual({
      alive: true,
      confirmed: false,
    });
  });

  it("is death once confirmed and then dropped", () => {
    expect(launchLiveness("t1", ["t2"], true)).toEqual({
      alive: false,
      confirmed: true,
    });
  });

  it("confirms on the first REPORT that contains the id", () => {
    expect(launchLiveness("t1", ["t2", "t1"], false)).toEqual({
      alive: true,
      confirmed: true,
    });
  });

  it("never confirms from a null report — that is absence of news, not news", () => {
    // Confirming here would arm the death branch off a report that never
    // happened, putting the original bug straight back.
    expect(launchLiveness("t1", null, false)).toEqual({
      alive: true,
      confirmed: false,
    });
    // And a null report is never death, confirmed or not.
    expect(launchLiveness("t1", null, true)).toEqual({
      alive: true,
      confirmed: true,
    });
  });

  it("keeps a confirmation once earned", () => {
    expect(launchLiveness("t1", ["t1"], true).confirmed).toBe(true);
  });

  it("has nothing to confirm without a terminal id", () => {
    expect(launchLiveness(null, ["t1"], false)).toEqual({
      alive: true,
      confirmed: false,
    });
  });

  // The call site's half of the contract: confirmation is keyed on the pending
  // launch's `startedAt`, so it is dropped the moment the launch changes
  // identity. Modelled here because nothing in this module can enforce it.
  it("confirmation does not carry across launches", () => {
    let seen: { startedAt: number; confirmed: boolean } | null = null;
    const step = (startedAt: number, id: string, report: string[] | null) => {
      if (seen?.startedAt !== startedAt) seen = { startedAt, confirmed: false };
      const r = launchLiveness(id, report, seen.confirmed);
      seen.confirmed = r.confirmed;
      return r.alive;
    };
    // Launch A is confirmed alive, then dies.
    expect(step(1, "t1", ["t1"])).toBe(true);
    expect(step(1, "t1", [])).toBe(false);
    // Launch B starts. A's confirmation must NOT make B's freshly minted id
    // read as dead on its first frame.
    expect(step(2, "t2", [])).toBe(true);
    expect(step(2, "t2", ["t2"])).toBe(true);
    expect(step(2, "t2", [])).toBe(false);
  });
});

describe("resolveLaunchProject", () => {
  const options: ProjectOption[] = [
    { path: "/Users/me/redline", name: "redline", source: "session" },
    { path: "/Users/me/qwallah", name: "qwallah", source: "folder" },
  ];
  const base = {
    projectOptions: options,
    openFolder: null as string | null,
    lastLaunchProject: null as string | null,
  };

  it("obeys an explicit chip over everything else", () => {
    const chip: ProjectChoice = { path: "/Users/me/other" };
    expect(
      resolveLaunchProject("fix a bug in redline", chip, {
        ...base,
        openFolder: "/Users/me/qwallah",
        lastLaunchProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/other");
  });

  it("treats an explicit Home pick as a real choice, not as 'unset'", () => {
    // The distinction that matters: {path:null} must NOT fall through to the
    // guess, or picking Home would snap back to a repo on the next keystroke.
    expect(
      resolveLaunchProject("fix a bug in redline", { path: null }, base),
    ).toBeNull();
  });

  it("guesses the repo named in the prompt when the chip is untouched", () => {
    expect(resolveLaunchProject("fix a bug in redline", null, base)).toBe(
      "/Users/me/redline",
    );
  });

  it("falls back to the open folder, then the last launch project", () => {
    expect(
      resolveLaunchProject("add a toggle", null, {
        ...base,
        openFolder: "/Users/me/folder",
        lastLaunchProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/folder");
    expect(
      resolveLaunchProject("add a toggle", null, {
        ...base,
        lastLaunchProject: "/Users/me/last",
      }),
    ).toBe("/Users/me/last");
  });

  it("ends at Home when nothing resolves", () => {
    expect(resolveLaunchProject("add a toggle", null, base)).toBeNull();
  });

  it("prefers the prompt's repo over the folder the user happens to browse", () => {
    expect(
      resolveLaunchProject("fix qwallah's login", null, {
        ...base,
        openFolder: "/Users/me/redline",
      }),
    ).toBe("/Users/me/qwallah");
  });
});

describe("composePrompt", () => {
  it("passes a bare prompt through, trimmed", () => {
    expect(composePrompt("  add a toggle  ", [])).toBe("add a toggle");
  });

  it("appends attachments as a Context path list", () => {
    expect(composePrompt("add a toggle", ["/a/b.ts", "/c/d.ts"])).toBe(
      "add a toggle\n\nContext:\n- /a/b.ts\n- /c/d.ts",
    );
  });

  it("dedupes and drops blank paths", () => {
    expect(composePrompt("x", ["/a.ts", " ", "/a.ts", "  /b.ts  "])).toBe(
      "x\n\nContext:\n- /a.ts\n- /b.ts",
    );
  });

  it("returns empty for an empty prompt — there is nothing to launch", () => {
    expect(composePrompt("   ", ["/a.ts"])).toBe("");
  });

  it("keeps multi-line prompts intact", () => {
    expect(composePrompt("one\ntwo", [])).toBe("one\ntwo");
  });
});

// ── New pure surface ────────────────────────────────────────────────────────

const item = (
  id: ReadinessItem["id"],
  state: ReadinessItem["state"] = "blocked",
): ReadinessItem => ({ id, state, label: id, detail: id });

describe("attemptLaunch", () => {
  it("goes when nothing is blocking", () => {
    expect(attemptLaunch([]).kind).toBe("go");
    expect(attemptLaunch([item("curl-old", "warn")]).kind).toBe("go");
  });

  it("blocks on the first blocker and hands it back to render", () => {
    const gate = attemptLaunch([item("no-project", "warn"), item("mode-paused")]);
    expect(gate).toEqual({ kind: "blocked", item: item("mode-paused") });
  });

  it("never blocks on a warning — a warning must not refuse ⏎", () => {
    // The asymmetry the whole strip is built on: `warn` informs, `blocked`
    // refuses. Collapsing them would make the door refuse to open over curl.
    expect(attemptLaunch([item("no-project", "warn"), item("curl-old", "warn")]).kind).toBe(
      "go",
    );
  });
});

describe("nextBlocker", () => {
  it("finds what is still in the way after a fix", () => {
    const r = [item("mode-paused"), item("claude-missing")];
    expect(nextBlocker(r, "mode-paused")?.id).toBe("claude-missing");
  });

  it("is null when the path is clear — which is what carries the held ⏎", () => {
    expect(nextBlocker([item("mode-paused")], "mode-paused")).toBeNull();
    // A remaining WARNING is not in the way.
    expect(
      nextBlocker([item("mode-paused"), item("curl-old", "warn")], "mode-paused"),
    ).toBeNull();
  });
});

describe("staleBlocker", () => {
  it("is false while the blocker is real", () => {
    expect(staleBlocker([item("mode-paused")], item("mode-paused"))).toBe(false);
  });

  it("is true once the fault was fixed elsewhere", () => {
    expect(staleBlocker([], item("mode-paused"))).toBe(true);
    // Downgraded to a warning also counts: it no longer refuses anything.
    expect(
      staleBlocker([item("mode-paused", "warn")], item("mode-paused")),
    ).toBe(true);
  });

  it("has nothing to be stale about when none is shown", () => {
    expect(staleBlocker([item("mode-paused")], null)).toBe(false);
  });
});

describe("projectForDoc", () => {
  it("answers only for the document the pick belongs to", () => {
    const pick: DocProjectChoice = { forId: "a", path: "/repo/x" };
    expect(projectForDoc(pick, "a")).toEqual({ path: "/repo/x" });
    expect(projectForDoc(pick, "b")).toBeNull();
  });

  it("makes the bleed unrepresentable: doc A's repo never answers for doc B", () => {
    // The bug this type exists to kill. Untagged, switching A (/repo/x) → B
    // (none) left /repo/x in place — permanently reassigning B and launching
    // its prompt into the wrong cwd.
    const a: DocProjectChoice = { forId: "a", path: "/repo/x" };
    expect(projectForDoc(a, "b")).toBeNull();
  });

  it("distinguishes an explicit Home from an unloaded document", () => {
    // Both used to be plain `null`, which is precisely why the persist had to
    // guard with `if (path)` and could never write a real Home choice.
    expect(projectForDoc({ forId: "a", path: null }, "a")).toEqual({ path: null });
    expect(projectForDoc(null, "a")).toBeNull();
  });

  it("has no answer without a document", () => {
    expect(projectForDoc({ forId: "a", path: "/repo/x" }, null)).toBeNull();
  });
});

describe("restoreInto", () => {
  const restore = {
    kind: "composer" as const,
    text: "add a toggle",
    attachments: ["/a.ts"],
  };

  const pill = (sessionId: string): CombineSource => ({
    sessionId,
    planTitle: `Plan ${sessionId}`,
    projectName: "redline",
    projectPath: "/repo",
    versionNumber: 1,
    status: "in_review",
    runState: null,
    pendingCount: 0,
    bytes: 100,
  });

  it("gives the sentence back when the composer is empty", () => {
    expect(restoreInto({ text: "", attachments: [] }, restore)).toEqual({
      text: "add a toggle",
      attachments: ["/a.ts"],
      combine: [],
    });
  });

  it("never clobbers newer typing", () => {
    expect(
      restoreInto({ text: "something newer", attachments: ["/b.ts"] }, restore),
    ).toEqual({ text: "something newer", attachments: ["/b.ts"], combine: [] });
  });

  it("gives the plans back too — a dead combine must not lose them", () => {
    // The sentence alone is not what a Combine launch took away.
    const withPills = { ...restore, combine: [pill("s1"), pill("s2")] };
    expect(restoreInto({ text: "", attachments: [] }, withPills).combine).toEqual([
      pill("s1"),
      pill("s2"),
    ]);
  });

  it("returns the plans only when the composer holds none", () => {
    const withPills = { ...restore, combine: [pill("s1")] };
    expect(
      restoreInto({ text: "", attachments: [], combine: [pill("s9")] }, withPills)
        .combine,
    ).toEqual([pill("s9")]);
  });

  it("owes nothing back for a surface that never took anything away", () => {
    // The Drafter's case: the document stayed on screen and editable, so there
    // is nothing to restore and restoring would be the wrong act entirely.
    const prev = { text: "", attachments: [] };
    expect(restoreInto(prev, { kind: "none" })).toBe(prev);
  });
});

describe("launchReceipt", () => {
  const para = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "paragraph",
    content: [{ type: "text", text, ...extra }],
  });

  it("counts words and top-level blocks", () => {
    const doc = { type: "doc", content: [para("one two three"), para("four")] };
    const r = launchReceipt(doc, "one two three\n\nfour");
    expect(r.words).toBe(4);
    expect(r.blocks).toBe(2);
  });

  it("reports no dropped aids for a plain document", () => {
    // Absence is what makes the claim credible when it IS present. A document
    // that lost nothing must not be told it lost something.
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
        para("ship auth"),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [para("one")] }],
        },
      ],
    };
    expect(launchReceipt(doc, "Goal ship auth one").aidsDropped).toBe(false);
  });

  it("sees a highlight", () => {
    const doc = {
      type: "doc",
      content: [para("hot", { marks: [{ type: "highlight", attrs: { color: "#ff0" } }] })],
    };
    expect(launchReceipt(doc, "hot").aidsDropped).toBe(true);
  });

  it("sees a colour or a font, but not a bare textStyle carrier", () => {
    const bare = {
      type: "doc",
      content: [para("x", { marks: [{ type: "textStyle", attrs: { color: null } }] })],
    };
    expect(launchReceipt(bare, "x").aidsDropped).toBe(false);
    const coloured = {
      type: "doc",
      content: [para("x", { marks: [{ type: "textStyle", attrs: { color: "#f00" } }] })],
    };
    expect(launchReceipt(coloured, "x").aidsDropped).toBe(true);
  });

  it("sees a non-default alignment and ignores the default one", () => {
    const left = {
      type: "doc",
      content: [{ ...para("x"), attrs: { textAlign: "left" } }],
    };
    expect(launchReceipt(left, "x").aidsDropped).toBe(false);
    const centred = {
      type: "doc",
      content: [{ ...para("x"), attrs: { textAlign: "center" } }],
    };
    expect(launchReceipt(centred, "x").aidsDropped).toBe(true);
  });

  it("finds an aid nested deep in a list", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [para("hot", { marks: [{ type: "highlight" }] })],
            },
          ],
        },
      ],
    };
    expect(launchReceipt(doc, "hot").aidsDropped).toBe(true);
  });

  it("survives an empty or malformed document", () => {
    expect(launchReceipt(null, "")).toEqual({ words: 0, blocks: 0, aidsDropped: false });
    expect(launchReceipt({ type: "doc" }, "  ")).toEqual({
      words: 0,
      blocks: 0,
      aidsDropped: false,
    });
  });
});

describe("extensionAddDirs", () => {
  const probe = {
    cargo: true,
    wasmTarget: true,
    abiDir: "/repo/src-tauri/crates/redline-extension-abi",
    sdkDir: "/repo/src-tauri/crates/redline-extension-sdk",
    templateDir: "/repo/marketplace/redline-extension-template",
  };

  it("grants the three staged dirs for an extension target", () => {
    expect(extensionAddDirs("extension", probe)).toEqual([
      probe.abiDir,
      probe.sdkDir,
      probe.templateDir,
    ]);
  });

  it("grants nothing for a plain project, whatever the probe says", () => {
    expect(extensionAddDirs(null, probe)).toEqual([]);
  });

  it("grants nothing for a harness pack — data needs no toolchain", () => {
    expect(extensionAddDirs("harness", probe)).toEqual([]);
  });

  it("grants nothing without a probe, and skips unresolved dirs", () => {
    expect(extensionAddDirs("extension", null)).toEqual([]);
    expect(extensionAddDirs("extension", undefined)).toEqual([]);
    // A moved checkout resolves nothing: fewer grants, never a failure.
    expect(
      extensionAddDirs("extension", {
        ...probe,
        abiDir: null,
        sdkDir: null,
        templateDir: null,
      }),
    ).toEqual([]);
    expect(
      extensionAddDirs("extension", { ...probe, templateDir: null }),
    ).toEqual([probe.abiDir, probe.sdkDir]);
  });
});
