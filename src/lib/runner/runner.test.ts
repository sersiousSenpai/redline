// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/basic.json";
import editOps from "./fixtures/edit_ops.json";
import { normalizeGraph, validateGraph, type RunGraph } from "./schema";
import { applyOps, type RunOp } from "./ops";
import { layoutRunGraph } from "./layout";
import { changedNodeIds, measuredSummary, mergeNodeOps, splitNodeOps } from "./view";
import { appendStream, type NodeStream, type RunStreamEvent } from "./stream";
import { emptyMeter } from "../turnMeter";

const graph = () => normalizeGraph(fixture as unknown as RunGraph);
describe("the shared native run graph contract", () => {
  it("reads the same fixture and op batch as runner_graph.rs", () => {
    const before = graph();
    expect(validateGraph(before)).toBeNull();
    const result = applyOps(before, 0, editOps as RunOp[]);
    expect(result.doc.rev).toBe(1);
    expect(result.doc.maxWriteParallel).toBe(2);
    expect(result.doc.nodes[0].title).toBe("Implement typed API");
    expect(result.doc.nodes[result.doc.nodes.length - 1]?.id).toBe("n-release");
    expect(result.doc.edges[result.doc.edges.length - 1]?.to).toBe("n-release");
    const restored = applyOps(result.doc, 1, result.inverses).doc;
    expect({ ...restored, rev: 0 }).toEqual(before);
  });
  it("rejects stale revisions, identity patches, cycles and edits while running atomically", () => {
    const before = graph(), original = JSON.stringify(before);
    expect(() => applyOps(before, 3, [{ op: "set_parallelism", value: 2 }])).toThrow("409");
    expect(() => applyOps(before, 0, [{ op: "update_node", id: "n-api", set: { id: "renamed" } } as unknown as RunOp])).toThrow(/immutable/i);
    expect(() => applyOps(before, 0, [{ op: "set_parallelism", value: 2 }, { op: "add_edge", edge: { id: "e-cycle", from: "n-check", to: "n-api", type: "blocks" } }])).toThrow("cycle");
    expect(() => applyOps({ ...before, status: "running" }, 0, [{ op: "set_parallelism", value: 1 }])).toThrow("Pause");
    expect(JSON.stringify(before)).toBe(original);
  });
  it("keeps edge endpoints immutable and refuses null required fields", () => {
    expect(() => applyOps(graph(), 0, [{ op: "update_edge", id: "e-api-check", set: { from: "n-ui" } } as unknown as RunOp])).toThrow();
    expect(() => applyOps(graph(), 0, [{ op: "update_node", id: "n-api", set: { title: null } } as unknown as RunOp])).toThrow();
  });
  it("reorders scheduler priority independently of the deterministic layout", () => {
    const before = graph(), moved = applyOps(before, 0, [{ op: "move_node", id: "n-ui", beforeId: "n-api" }]);
    expect(moved.doc.nodes.map((node) => node.id)).toEqual(["n-ui", "n-api", "n-check"]);
    expect(layoutRunGraph(moved.doc)).toEqual(layoutRunGraph(before));
    expect(applyOps(moved.doc, 1, moved.inverses).doc.nodes).toEqual(before.nodes);
  });
  it("lays out deterministically and preserves human positions", () => {
    const before = graph();
    expect(layoutRunGraph(before)).toEqual(layoutRunGraph({ ...before, nodes: [...before.nodes].reverse(), edges: [...before.edges].reverse() }));
    before.nodes[0].position = { x: 17, y: 81 };
    expect(layoutRunGraph(before).positions["n-api"]).toEqual({ x: 17, y: 81 });
  });
  it("splits a task before its downstream check and merges without losing dependencies", () => {
    const before = graph(); before.nodes[0].brief = "First half\n\nSecond half";
    const split = applyOps(before, 0, splitNodeOps(before, "n-api", "n-api-followup")).doc;
    expect(split.edges.find((edge) => edge.id === "e-api-check")?.from).toBe("n-api-followup");
    expect(split.nodes.find((node) => node.id === "n-api-followup")?.brief).toBe("Second half");
    const merged = applyOps(split, 1, mergeNodeOps(split, "n-api-followup", "n-api")).doc;
    expect(merged.nodes).toHaveLength(3);
    expect(merged.edges.find((edge) => edge.id === "e-api-check")?.from).toBe("n-api");
    expect(merged.nodes[0].brief).toBe("First half\n\nSecond half");
  });
  it("recognizes brief changes, but not token updates or dragging", () => {
    const before = graph(), after = graph();
    after.nodes[0].position = { x: 0, y: 0 }; after.nodes[0].meter = emptyMeter();
    expect(changedNodeIds(before, after).size).toBe(0);
    after.nodes[1].brief = "Revised UI";
    expect([...changedNodeIds(before, after)]).toEqual(["n-ui"]);
  });
  it("counts every attempt once and never calls a skipped check a pass", () => {
    const doc = graph(), meter = { ...emptyMeter(), outputTokens: 100, costUsd: 0.2 };
    doc.nodes[0].status = "passed"; doc.nodes[0].meter = meter; doc.nodes[0].attemptMeters = [meter, meter];
    doc.nodes[1].status = "running"; doc.nodes[1].attemptMeters = [meter];
    doc.nodes[2].status = "skipped"; doc.nodes[2].exitCode = 0;
    const summary = measuredSummary(doc, { "n-ui": { ...meter, outputTokens: 50 } });
    expect(summary.outputTokens).toBe(350);
    expect(summary.checks).toBe(0);
    expect(summary.costUsd).toBeCloseTo(0.8);
  });
});
describe("keyed run stream recovery", () => {
  const baseline = (): NodeStream => ({ streaming: true, partial: "A", seq: 1, attempt: 2, meter: null, activity: null });
  const delta = (seq: number, attempt = 2): RunStreamEvent => ({ kind: "delta", runId: "r", nodeId: "n", seq, attempt, text: "B" });
  it("drops duplicated deltas and late events from an earlier attempt", () => {
    const before = baseline();
    expect(appendStream(before, delta(1))).toBe(before);
    expect(appendStream(before, delta(40, 1))).toBe(before);
    expect(appendStream(before, delta(1, 3))).toBe(before);
    expect(appendStream(before, delta(2)).partial).toBe("AB");
  });
  it("replaces meter snapshots without adding token counters", () => {
    const event: RunStreamEvent = { kind: "meter", runId: "r", nodeId: "n", attempt: 2, rev: 5, meter: { ...emptyMeter(), rev: 5, outputTokens: 7 }, activity: null };
    const next = appendStream(baseline(), event);
    expect(appendStream(next, event)).toBe(next);
    expect(next.meter?.outputTokens).toBe(7);
  });
});
