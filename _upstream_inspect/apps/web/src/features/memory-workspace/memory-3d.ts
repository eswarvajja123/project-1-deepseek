import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  applyBarnesHutRepulsion,
  barnesHutCapacity,
  buildBarnesHutTree,
  createBarnesHutTree
} from "./memory-barnes-hut.js";
import { relaxationSteps } from "./memory-point-grid.js";

export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

/**
 * Barnes-Hut accuracy parameter.
 *
 * `half / distance < theta` accepts a cell as one aggregate. Lower is more exact and
 * slower. Measured against the exact O(n^2) sum on the 2k synthetic graph: theta 0.5
 * gives 0.989 mean direction cosine and 13% magnitude error, while theta 0.9 drops to
 * 0.67 cosine - too coarse to preserve the layout's shape. 0.5 is used everywhere.
 */
export const BARNES_HUT_THETA = 0.5;

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export type MemoryLayout3DOptions = {
  /** Override the step budget; defaults to `relaxationSteps(count, 180)`. */
  steps?: number;
  /** Coordinates from a previous layout of the same graph, used as the starting point. */
  initial?: ReadonlyMap<string, MemoryPoint3D>;
};

/**
 * Resumable 3D relaxation.
 *
 * Yields `{ step, steps }` after each relaxation step so the caller can hand control
 * back to the event loop between chunks; the return value is the final coordinate map.
 */
export function* memoryLayout3DSteps(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: MemoryLayout3DOptions = {}
): Generator<{ step: number; steps: number }, Map<string, MemoryPoint3D>> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  if (count === 0) return new Map();
  // Positions live in flat typed arrays: the relaxation loop touches every coordinate
  // on every step, so object indirection there dominated the cost at larger sizes.
  // The initial cube scales with cbrt(count) so per-node density stays constant;
  // otherwise the fixed 260-unit box turns large graphs into one dense blob.
  const spread = 260 * Math.max(1, Math.cbrt(count / 2000));
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const id = ordered[i]!.id;
    // A warm start reuses the previous coordinates so an incremental relayout moves
    // points as little as possible; unseen nodes fall back to the deterministic seed.
    const previous = options.initial?.get(id);
    px[i] = previous ? previous.x : (unit(`${id}:x`) - 0.5) * spread;
    py[i] = previous ? previous.y : (unit(`${id}:y`) - 0.5) * spread;
    pz[i] = previous ? previous.z : (unit(`${id}:z`) - 0.5) * spread;
  }
  if (root >= 0) { px[root] = 0; py[root] = 0; pz[root] = 0; }
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  if (!options.initial) {
    for (const edge of edges) {
      const a = index.get(edge.source), b = index.get(edge.target);
      if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
      const id = ordered[b]!.id;
      px[b] = px[a]! + (unit(`${id}:dx`) - 0.5) * 70;
      py[b] = py[a]! + (unit(`${id}:dy`) - 0.5) * 70;
      pz[b] = pz[a]! + (unit(`${id}:dz`) - 0.5) * 70;
    }
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) isSource[i] = ordered[i]!.type === "SOURCE" ? 1 : 0;
  // Spring endpoints as flat arrays so the link pass allocates nothing per step.
  const linkA = new Int32Array(links.length), linkB = new Int32Array(links.length);
  const linkLength = new Float64Array(links.length), linkStrength = new Float64Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    linkA[i] = link.a; linkB[i] = link.b; linkLength[i] = link.length; linkStrength[i] = link.strength;
  }
  const tree = createBarnesHutTree(barnesHutCapacity(count));
  const steps = options.steps ?? relaxationSteps(count, 180);
  for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    // The octree replaces the grid pair scan: 28 applies to pairs involving a source
    // node and 12 to memory-memory pairs, matching the previous constants.
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, BARNES_HUT_THETA, 28, 12, 1);
    for (let i = 0; i < linkA.length; i++) {
      const a = linkA[i]!, b = linkB[i]!;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!, dz = pz[b]! - pz[a]!;
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const spring = ((distance - linkLength[i]!) * linkStrength[i]!) / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - px[i]! * 0.0005, dy = fy[i]! - py[i]! * 0.0005, dz = fz[i]! - pz[i]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz))) * cooling;
      px[i]! += dx * stepScale; py[i]! += dy * stepScale; pz[i]! += dz * stepScale;
    }
    yield { step, steps };
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i]!, y: py[i]!, z: pz[i]! }]));
}

/** Synchronous 3D layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: MemoryLayout3DOptions = {}
): Map<string, MemoryPoint3D> {
  const iterator = memoryLayout3DSteps(nodes, edges, options);
  for (;;) {
    const next = iterator.next();
    if (next.done) return next.value;
  }
}
export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
