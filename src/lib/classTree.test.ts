// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import {
  buildTree,
  catalogHealthFields,
  countDescendants,
  proposalSubject,
  queueLine,
  sortObservations,
  supersedeLabel,
  type CatalogHealth,
  type ClassNode,
  type Observation,
  type ProposalView,
} from "./classTree";

function node(partial: Partial<ClassNode> & { id: string }): ClassNode {
  return {
    parentId: null,
    kind: "node",
    title: partial.id,
    summary: null,
    projectPath: null,
    ipName: null,
    status: "accepted",
    pinned: false,
    curatedBy: null,
    createdAt: 0,
    updatedAt: 0,
    linkCount: 0,
    ...partial,
  };
}

describe("buildTree", () => {
  it("nests children under their parents and returns roots", () => {
    const nodes = [
      node({ id: "root", title: "redline" }),
      node({ id: "topic", parentId: "root", title: "Loop Engineering" }),
      node({ id: "sub", parentId: "topic", title: "Executor" }),
      node({ id: "root2", title: "muslimlegalconnect" }),
    ];
    const tree = buildTree(nodes);
    expect(tree.map((n) => n.id).sort()).toEqual(["root", "root2"]);
    const root = tree.find((n) => n.id === "root")!;
    expect(root.children.map((c) => c.id)).toEqual(["topic"]);
    expect(root.children[0].children.map((c) => c.id)).toEqual(["sub"]);
  });

  it("surfaces a node with a missing parent as a root (nothing is lost)", () => {
    const tree = buildTree([node({ id: "orphan", parentId: "ghost" })]);
    expect(tree.map((n) => n.id)).toEqual(["orphan"]);
  });

  it("sorts siblings by title — a legacy pin no longer floats anything (B3)", () => {
    const nodes = [
      node({ id: "root", title: "r" }),
      node({ id: "b", parentId: "root", title: "Beta" }),
      node({ id: "a", parentId: "root", title: "Alpha" }),
      node({ id: "z", parentId: "root", title: "Zeta", pinned: true }),
    ];
    const root = buildTree(nodes)[0];
    expect(root.children.map((c) => c.title)).toEqual(["Alpha", "Beta", "Zeta"]);
  });

  it("does not mutate the input nodes", () => {
    const input = [node({ id: "root" }), node({ id: "c", parentId: "root" })];
    buildTree(input);
    expect(input.every((n) => !("children" in n))).toBe(true);
  });
});

describe("supersedeLabel", () => {
  it("renders '#old → #new' from a supersede proposal's extraJson", () => {
    expect(supersedeLabel('{"old_seq":5,"new_seq":12}')).toBe("#5 → #12");
  });

  it("is null on missing or malformed payloads", () => {
    expect(supersedeLabel(null)).toBeNull();
    expect(supersedeLabel("not json")).toBeNull();
    expect(supersedeLabel('{"old_seq":5}')).toBeNull();
    expect(supersedeLabel('{"old_seq":"5","new_seq":"12"}')).toBeNull();
  });
});

describe("sortObservations", () => {
  function obs(partial: Partial<Observation> & { id: number }): Observation {
    return {
      nodeId: "n",
      summary: `o${partial.id}`,
      citeSeqs: [1],
      createdSeq: null,
      pinned: false,
      dismissed: false,
      createdAt: 0,
      ...partial,
    };
  }

  it("orders newest first — a legacy pin no longer floats anything (B3)", () => {
    const sorted = sortObservations([
      obs({ id: 1, createdAt: 100 }),
      obs({ id: 2, createdAt: 300 }),
      obs({ id: 3, createdAt: 200, pinned: true }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual([2, 3, 1]);
  });

  it("filters dismissed observations and leaves the input untouched", () => {
    const input = [obs({ id: 1 }), obs({ id: 2, dismissed: true })];
    const sorted = sortObservations(input);
    expect(sorted.map((o) => o.id)).toEqual([1]);
    expect(input).toHaveLength(2);
  });
});

describe("countDescendants", () => {
  it("counts the whole subtree, not just direct children", () => {
    const tree = buildTree([
      node({ id: "root" }),
      node({ id: "a", parentId: "root" }),
      node({ id: "b", parentId: "root" }),
      node({ id: "a1", parentId: "a" }),
    ]);
    expect(countDescendants(tree[0])).toBe(3);
    expect(countDescendants(tree[0].children.find((c) => c.id === "a")!)).toBe(1);
    expect(countDescendants(tree[0].children.find((c) => c.id === "b")!)).toBe(0);
  });
});

describe("proposalSubject", () => {
  function prop(partial: Partial<ProposalView> & { id: number; op: string }): ProposalView {
    return {
      nodeId: null,
      parentId: null,
      title: null,
      summary: null,
      extraJson: null,
      rationale: null,
      status: "pending",
      createdAt: 0,
      attempts: 0,
      nextAfterRun: null,
      expiresLakeTs: null,
      nodeTitle: null,
      citations: [],
      ...partial,
    };
  }

  it("prefers the subject node's resolved title", () => {
    const p = prop({ id: 1, op: "collapse", nodeTitle: "Loop Engineering", title: "ignored" });
    expect(proposalSubject(p)).toBe("Loop Engineering");
  });

  it("falls back to the proposed title, then the supersede seq pair", () => {
    expect(proposalSubject(prop({ id: 2, op: "promote", title: "New topic" }))).toBe("New topic");
    expect(
      proposalSubject(prop({ id: 3, op: "supersede", extraJson: '{"old_seq":5,"new_seq":12}' })),
    ).toBe("#5 → #12");
  });

  it("never renders blank — the row id is the last resort", () => {
    expect(proposalSubject(prop({ id: 4, op: "merge" }))).toBe("proposal #4");
  });
});

describe("queueLine", () => {
  const row = (partial: Partial<Pick<ProposalView, "status" | "attempts" | "nextAfterRun">>) => ({
    status: "pending",
    attempts: 0,
    nextAfterRun: null,
    ...partial,
  });

  it("reads as a fact about the gardener's queue — never a verdict to give (B3)", () => {
    expect(queueLine(row({}))).toBe("waiting for the next run");
    expect(queueLine(row({ nextAfterRun: 12 }))).toBe("due after run #12");
  });

  it("shows the backoff after a failed verify: attempts so far and the run it waits for", () => {
    expect(queueLine(row({ attempts: 1, nextAfterRun: 14 }))).toBe(
      "due after run #14 · attempt 1 of 3 failed to verify",
    );
    expect(queueLine(row({ attempts: 2 }))).toBe(
      "waiting for the next run · attempt 2 of 3 failed to verify",
    );
  });

  it("falls back to the status word for a row that is no longer pending", () => {
    expect(queueLine(row({ status: "expired", attempts: 3 }))).toBe("expired");
  });
});

describe("catalogHealthFields", () => {
  const health: CatalogHealth = {
    runsConsidered: 20,
    organizeP50Ms: 1200,
    organizeP90Ms: 4100,
    errorRate: 0.05,
    canaryReverts: 1,
    canaryTrend: [0, 0.02, 0.1],
    canaryAlert: false,
    maxFanOut: 140,
    nodesOver150: 0,
    nodesOver120: 2,
    digestRatio: 0.25,
    orphanRate: 0.01,
    depthHistogram: [3, 12, 40],
    duplicateTitleRate: 0,
    provenanceViolations: 4,
    noModelShare: 0.3,
    unacknowledgedRedactions: 0,
    queueDepth: 2,
    liveObservations: 7,
  };

  it("renders every §6.3 number as a label/value row, in the report's order", () => {
    const rows = catalogHealthFields(health);
    expect(rows.map((r) => r.label)).toEqual([
      "Runs", "Errors", "Canary", "Fan-out", "Shape", "Depth",
      "Provenance", "Lineage", "Redactions", "Queue", "Patterns",
    ]);
    expect(rows[0].value).toBe("20 considered · organize p50 1,200ms · p90 4,100ms");
    expect(rows[1].value).toBe("5.0% of runs");
    expect(rows[2].value).toBe("1 revert · regressions 0.0% 2.0% 10.0%");
    expect(rows[3].value).toBe("max 140 · 0 over 150 · 2 over 120");
    expect(rows[5].value).toBe("d0:3 d1:12 d2:40");
    expect(rows[9].value).toBe("2 waiting for a run");
  });

  it("names the canary alert in words — the one row that must not read as a neutral number", () => {
    const rows = catalogHealthFields({ ...health, canaryAlert: true, canaryReverts: 3 });
    expect(rows[2].value).toContain("3 reverts");
    expect(rows[2].value).toContain("ALERT");
  });

  it("copes with an empty catalog: no runs, no depths, no trend", () => {
    const rows = catalogHealthFields({
      ...health, runsConsidered: 0, organizeP50Ms: null, organizeP90Ms: null,
      canaryTrend: [], depthHistogram: [], canaryReverts: 0,
    });
    expect(rows[0].value).toBe("0 considered · organize p50 — · p90 —");
    expect(rows[2].value).toBe("0 reverts");
    expect(rows[5].value).toBe("—");
  });
});
