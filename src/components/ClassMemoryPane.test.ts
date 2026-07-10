// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import {
  buildTree,
  sortObservations,
  supersedeLabel,
  type ClassNode,
  type Observation,
} from "./ClassMemoryPane";

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

  it("floats pinned nodes above their siblings, then sorts by title", () => {
    const nodes = [
      node({ id: "root", title: "r" }),
      node({ id: "b", parentId: "root", title: "Beta" }),
      node({ id: "a", parentId: "root", title: "Alpha" }),
      node({ id: "z", parentId: "root", title: "Zeta", pinned: true }),
    ];
    const root = buildTree(nodes)[0];
    expect(root.children.map((c) => c.title)).toEqual(["Zeta", "Alpha", "Beta"]);
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

  it("floats pinned first, then newest first", () => {
    const sorted = sortObservations([
      obs({ id: 1, createdAt: 100 }),
      obs({ id: 2, createdAt: 300 }),
      obs({ id: 3, createdAt: 200, pinned: true }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual([3, 2, 1]);
  });

  it("filters dismissed observations and leaves the input untouched", () => {
    const input = [obs({ id: 1 }), obs({ id: 2, dismissed: true })];
    const sorted = sortObservations(input);
    expect(sorted.map((o) => o.id)).toEqual([1]);
    expect(input).toHaveLength(2);
  });
});
