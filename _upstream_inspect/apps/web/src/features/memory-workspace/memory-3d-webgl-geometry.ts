import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryPoint3D } from "./memory-3d.js";
import type { WebGLGraphInput } from "./memory-3d-webgl.js";

/**
 * Convert a memory graph into the flat buffers the WebGL2 renderer uploads.
 *
 * This is the only place that walks the graph, and it runs when nodes, edges, or
 * layout positions change - never per frame. Node order is sorted by id so the
 * instance index is stable and the output is reproducible between runs.
 */

const DEFAULT_NODE_COLOR: [number, number, number] = [0.451, 0.584, 0.678];
const FOCUS_COLOR: [number, number, number] = [1, 1, 1];
const NEIGHBOR_EDGE_COLOR: [number, number, number] = [0.596, 0.855, 0.980];
const SOURCE_EDGE_COLOR: [number, number, number] = [0.125, 0.2, 0.255];
const DIM_EDGE_COLOR: [number, number, number] = [0.078, 0.125, 0.169];

function hexToRgb(value: string | undefined): [number, number, number] {
  if (!value) return DEFAULT_NODE_COLOR;
  const hex = value.replace("#", "");
  if (hex.length !== 6) return DEFAULT_NODE_COLOR;
  const parsed = Number.parseInt(hex, 16);
  if (Number.isNaN(parsed)) return DEFAULT_NODE_COLOR;
  return [((parsed >> 16) & 255) / 255, ((parsed >> 8) & 255) / 255, (parsed & 255) / 255];
}

/** Node radius in world units, mirroring the Canvas renderer's per-type sizes. */
function nodeRadius(node: MemoryGraphNode, isCoreSource: boolean): number {
  if (isCoreSource) return 10;
  return node.type === "SOURCE" ? 4.6 : 2.1;
}

export function buildWebGLGraphInput(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  coordinates: Map<string, MemoryPoint3D>,
  positions: Map<string, { color?: string }>,
  focusId: string | null
): WebGLGraphInput {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map<string, number>();
  const visible: MemoryGraphNode[] = [];
  for (const node of ordered) {
    if (!coordinates.has(node.id)) continue;
    index.set(node.id, visible.length);
    visible.push(node);
  }

  const neighborIds = new Set<string>();
  if (focusId) {
    for (const edge of edges) {
      if (edge.source === focusId) neighborIds.add(edge.target);
      if (edge.target === focusId) neighborIds.add(edge.source);
    }
  }

  const count = visible.length;
  const outPositions = new Float32Array(count * 3);
  const outColors = new Float32Array(count * 4);
  const outSizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const node = visible[i]!;
    const point = coordinates.get(node.id)!;
    outPositions[i * 3] = point.x;
    outPositions[i * 3 + 1] = point.y;
    outPositions[i * 3 + 2] = point.z;
    const isFocus = node.id === focusId;
    const [r, g, b] = isFocus ? FOCUS_COLOR : hexToRgb(positions.get(node.id)?.color);
    // Dim non-neighbors while a node is focused, matching the Canvas renderer.
    const alpha = focusId && !isFocus && !neighborIds.has(node.id) ? 0.2 : 1;
    outColors[i * 4] = r;
    outColors[i * 4 + 1] = g;
    outColors[i * 4 + 2] = b;
    outColors[i * 4 + 3] = alpha;
    const coreSource = node.type === "SOURCE" && node.label === "gemini.md";
    outSizes[i] = nodeRadius(node, coreSource) * (isFocus ? 1.5 : 1);
  }

  // Edges are emitted as consecutive endpoint pairs (LINES primitives).
  const visibleEdges: Array<[number, number, MemoryGraphEdge]> = [];
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    visibleEdges.push([a, b, edge]);
  }
  const outEdges = new Float32Array(visibleEdges.length * 6);
  const outEdgeColors = new Float32Array(visibleEdges.length * 6);
  const outEdgeWidths = new Float32Array(visibleEdges.length);
  for (let i = 0; i < visibleEdges.length; i++) {
    const [a, b, edge] = visibleEdges[i]!;
    const pa = a * 3, pb = b * 3;
    outEdges[i * 6] = outPositions[pa]!;
    outEdges[i * 6 + 1] = outPositions[pa + 1]!;
    outEdges[i * 6 + 2] = outPositions[pa + 2]!;
    outEdges[i * 6 + 3] = outPositions[pb]!;
    outEdges[i * 6 + 4] = outPositions[pb + 1]!;
    outEdges[i * 6 + 5] = outPositions[pb + 2]!;
    const incident = focusId !== null && (edge.source === focusId || edge.target === focusId);
    const [r, g, b_] = incident
      ? NEIGHBOR_EDGE_COLOR
      : focusId
        ? DIM_EDGE_COLOR
        : edge.type === "DERIVED_FROM"
          ? SOURCE_EDGE_COLOR
          : SOURCE_EDGE_COLOR;
    outEdgeColors[i * 6] = r; outEdgeColors[i * 6 + 1] = g; outEdgeColors[i * 6 + 2] = b_;
    outEdgeColors[i * 6 + 3] = r; outEdgeColors[i * 6 + 4] = g; outEdgeColors[i * 6 + 5] = b_;
    outEdgeWidths[i] = incident ? 1.15 : 0.55;
  }

  return {
    positions: outPositions,
    colors: outColors,
    sizes: outSizes,
    edges: outEdges,
    edgeColors: outEdgeColors,
    edgeWidths: outEdgeWidths,
    count,
    edgeCount: visibleEdges.length
  };
}
