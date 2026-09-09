// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Thin controlled adapter harvested from feature/app-map's DiagramCanvas.
// Layout and the document remain upstream; this directory alone imports xyflow.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Node, type NodeProps, type NodeChange, type Edge, type Connection } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./runner.css";
import { layoutRunGraph } from "../../lib/runner/layout";
import { editableGraph, type RunGraph, type RunNode, type XY } from "../../lib/runner/schema";
import type { NodeStream } from "../../lib/runner/stream";

type CardData = { node: RunNode; stream?: NodeStream; next: boolean; onOpenPlanBlock?: (blockId: string) => void };
type FlowNode = Node<CardData>;
const RunCard = memo(function RunCard({ data, selected }: NodeProps<FlowNode>) {
  const { node, stream, next, onOpenPlanBlock } = data;
  const meter = stream?.meter ?? node.meter;
  const excerpt = (stream?.partial ?? node.output).trim().split("\n").filter(Boolean).slice(-1)[0];
  return <article className={`rl-run-node rl-run-${node.status}${selected ? " is-selected" : ""}`} aria-label={`${node.title}, ${node.status}`}>
    <Handle type="target" position={Position.Left} />
    <div className="rl-run-node-meta"><span>{node.kind}</span><span>{next ? "Next up" : node.status.replace(/_/g, " ")}</span></div>
    <strong>{node.title}</strong>
    <div className="rl-run-node-detail">{node.kind === "check" ? node.verifyCmd : node.kind === "gate" ? "Waiting for your decision" : meter?.model ?? node.model ?? node.seat ?? "Agent Seats default"}</div>
    <div className="rl-run-node-meta"><span>{node.attempt ? `Attempt ${node.attempt}/${node.maxAttempts}` : "Not started"}</span><span>{node.exitCode != null ? `Exit ${node.exitCode}` : meter ? `${meter.outputTokens.toLocaleString()} output tokens` : ""}</span></div>
    {excerpt && <p className="rl-run-excerpt">{excerpt.slice(-110)}</p>}
    {node.planBlockId && onOpenPlanBlock && <button className="nodrag nopan rl-run-plan-link" onClick={(event) => { event.stopPropagation(); onOpenPlanBlock(node.planBlockId!); }}>Plan ↗</button>}
    <Handle type="source" position={Position.Right} />
  </article>;
}, (a, b) => a.selected === b.selected && a.data.node === b.data.node && a.data.stream === b.data.stream && a.data.next === b.data.next && a.data.onOpenPlanBlock === b.data.onOpenPlanBlock);
const NODE_TYPES = { run: RunCard };

export interface RunCanvasProps {
  graph: RunGraph; streams: Record<string, NodeStream>; nextIds: string[]; selectedId: string | null;
  onSelect: (id: string | null) => void; onMove: (id: string, point: XY) => void;
  onConnect: (from: string, to: string) => void; onOpenPlanBlock?: (blockId: string) => void;
}
export function RunCanvas(props: RunCanvasProps) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
function Canvas({ graph, streams, nextIds, selectedId, onSelect, onMove, onConnect, onOpenPlanBlock }: RunCanvasProps) {
  const { fitView } = useReactFlow();
  const [drag, setDrag] = useState<Record<string, XY>>({});
  const humanCamera = useRef(false);
  const positions = useMemo(() => layoutRunGraph(graph).positions, [graph]);
  const editable = editableGraph(graph);
  const nodes: FlowNode[] = graph.nodes.map((node) => {
    const next = nextIds.includes(node.id), ghost = next && graph.status === "running";
    return { id: node.id, type: "run", position: drag[node.id] ?? node.position ?? positions[node.id],
      data: { node, stream: streams[node.id], next, onOpenPlanBlock }, selected: node.id === selectedId,
      draggable: editable && !ghost, selectable: !ghost, className: ghost ? "rl-run-ghost" : undefined };
  });
  const edges: Edge[] = graph.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to,
    label: edge.type === "parent-child" ? "contains" : undefined, markerEnd: { type: MarkerType.ArrowClosed },
    animated: graph.nodes.some((n) => n.id === edge.to && n.status === "running"),
    style: { stroke: "var(--color-rule-strong, #7d858d)", strokeDasharray: edge.type === "parent-child" ? "5 5" : undefined } }));
  useEffect(() => { if (!humanCamera.current) void fitView({ duration: 250, padding: 0.18 }); }, [graph.nodes.length, fitView]);
  const changes = (updates: NodeChange<FlowNode>[]) => setDrag((previous) => {
    let next = previous;
    for (const update of updates) if (update.type === "position" && update.position && update.dragging) next = { ...next, [update.id]: update.position };
    return next;
  });
  return <ReactFlow<FlowNode> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={changes}
    onNodeClick={(_, node) => { if (node.selectable !== false) onSelect(node.id); }} onPaneClick={() => onSelect(null)}
    onNodeDragStart={() => { humanCamera.current = true; }}
    onNodeDragStop={(_, node) => { setDrag((previous) => { const next = { ...previous }; delete next[node.id]; return next; }); onMove(node.id, node.position); }}
    onMoveStart={(event) => { if (event) humanCamera.current = true; }}
    onConnect={(connection: Connection) => { if (connection.source && connection.target) onConnect(connection.source, connection.target); }}
    nodesDraggable={editable} nodesConnectable={editable} deleteKeyCode={null} minZoom={0.2} maxZoom={2} fitView>
    <Background gap={24} size={1} /><Controls showInteractive={false} />
  </ReactFlow>;
}
