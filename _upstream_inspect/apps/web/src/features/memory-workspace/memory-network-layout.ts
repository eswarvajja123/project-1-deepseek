import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel, isMemoryIndexLabel } from "./memory-graph-visuals.js";
import {
  applyBarnesHutRepulsion,
  barnesHutCapacity,
  buildBarnesHutTree,
  createBarnesHutTree
} from "./memory-barnes-hut.js";
import { BARNES_HUT_THETA } from "./memory-3d.js";
import { relaxationSteps } from "./memory-point-grid.js";

export type MemoryLayoutOptions = {
  /** Override the step budget; defaults to `relaxationSteps(count, 150)`. */
  steps?: number;
};

const unit = (value: string) => {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
};

/**
 * Resumable 2D relaxation, mirroring `memoryLayout3DSteps`.
 *
 * Yields after every step so a caller can spread the work across tasks; the return
 * value is the final coordinate map. Bounded force relaxation driven by actual edges;
 * color never affects geometry.
 */
export function* memoryLayoutSteps(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: MemoryLayoutOptions = {}
): Generator<{ step: number; steps: number }, Map<string, { x: number; y: number }>> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const sources = ordered.filter(node => node.type === "SOURCE");
  const root = sources.find(node => isMemoryCoreLabel(node.label)) ?? sources.find(node => isMemoryIndexLabel(node.label));
  const rootIndex = root ? index.get(root.id)! : -1;
  const sourceIndex = new Map(sources.map(node => [node.sourcePath, index.get(node.id)!]));
  // The original box was sized for ~2k nodes. Once a graph is larger the same box makes
  // every node a neighbour of every other one, so the relaxation degrades to O(n^2).
  // Scaling the box with sqrt(count) holds the per-node area constant.
  const spread = 240 * Math.max(1, Math.sqrt(ordered.length / 2000));
  const points = ordered.map(node => ({ x: (unit(node.id) - 0.5) * spread, y: (unit(`${node.id}:y`) - 0.5) * (spread * 0.833) }));
  // Start records close to their true source. The force simulation then resolves local relationships.
  ordered.forEach((node, i) => {
    const parent = sourceIndex.get(node.sourcePath);
    if (node.type === "MEMORY" && parent !== undefined) {
      points[i] = { x: points[parent]!.x + (unit(`${node.id}:dx`) - 0.5) * 45, y: points[parent]!.y + (unit(`${node.id}:dy`) - 0.5) * 45 };
    }
  });
  if (rootIndex >= 0) points[rootIndex] = { x: 0, y: 0 };
  const links = edges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 85 : edge.type === "CONTAINS" ? 28 : 45, strength: fileLink ? 0.026 : edge.type === "CONTAINS" ? 0.017 : 0.0025 }];
  });
  const count = points.length;
  const fx = new Float64Array(count), fy = new Float64Array(count);
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) isSource[i] = ordered[i]!.type === "SOURCE" ? 1 : 0;
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  for (let i = 0; i < count; i++) { px[i] = points[i]!.x; py[i] = points[i]!.y; }
  const linkA = new Int32Array(links.length), linkB = new Int32Array(links.length);
  const linkLength = new Float64Array(links.length), linkStrength = new Float64Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    linkA[i] = link.a; linkB[i] = link.b; linkLength[i] = link.length; linkStrength[i] = link.strength;
  }
  // Barnes-Hut on the same flat arrays; z is always 0 for the 2D map, which the
  // octree handles by giving the third axis zero extent.
  const tree = createBarnesHutTree(barnesHutCapacity(count));
  const steps = options.steps ?? relaxationSteps(count, 150);
  for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0);
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    // 14 applies to pairs involving a source node and 5 to memory-memory pairs,
    // matching the constants the grid version used.
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, pz, count, BARNES_HUT_THETA, 14, 5, 4);
    for (let i = 0; i < linkA.length; i++) {
      const a = linkA[i]!, b = linkB[i]!;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!;
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const spring = ((distance - linkLength[i]!) * linkStrength[i]!) / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring;
    }
    const cooling = 1 - step / 190;
    for (let i = 0; i < count; i++) {
      if (i === rootIndex) continue;
      px[i]! += Math.max(-4, Math.min(4, fx[i]! - px[i]! * 0.0004)) * cooling;
      py[i]! += Math.max(-4, Math.min(4, fy[i]! - py[i]! * 0.0004)) * cooling;
    }
    yield { step, steps };
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i]!, y: py[i]! }]));
}

/** Synchronous 2D layout used by tests and non-browser callers. */
export function layoutMemoryNetwork(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: MemoryLayoutOptions = {}
) {
  const iterator = memoryLayoutSteps(nodes, edges, options);
  for (;;) {
    const next = iterator.next();
    if (next.done) return next.value;
  }
}
