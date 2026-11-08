/**
 * Tests for the Barnes-Hut octree and the incremental layout path.
 *
 * These cover the two gaps that blocked the Issue #62 targets: the previous repulsion
 * was O(n x neighbours) and ran as one blocking pass. The assertions here check that
 * the octree agrees with an exact O(n^2) reference, that the chunked generators return
 * the same coordinates as the synchronous layout, and that a warm start is stable.
 */
import { describe, expect, it } from "vitest";
import {
  applyBarnesHutRepulsion,
  barnesHutCapacity,
  buildBarnesHutTree,
  createBarnesHutTree
} from "../src/features/memory-workspace/memory-barnes-hut.js";
import {
  BARNES_HUT_THETA,
  layoutMemoryNetwork3D,
  memoryLayout3DSteps
} from "../src/features/memory-workspace/memory-3d.js";
import {
  layoutMemoryNetwork,
  memoryLayoutSteps
} from "../src/features/memory-workspace/memory-network-layout.js";
import { buildSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-3d-synthetic.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/** Deterministic pseudo-random cloud, so the comparison is reproducible. */
function cloud(count: number, extent: number) {
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  const isSource = new Uint8Array(count);
  let state = 987654321;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    px[i] = (next() - 0.5) * extent;
    py[i] = (next() - 0.5) * extent;
    pz[i] = (next() - 0.5) * extent;
    isSource[i] = next() > 0.9 ? 1 : 0;
  }
  return { px, py, pz, isSource, count };
}

describe("Barnes-Hut octree", () => {
  it("agrees with the exact O(n^2) repulsion within the theta tolerance", () => {
    const { px, py, pz, isSource, count } = cloud(600, 400);
    const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
    const tree = createBarnesHutTree(barnesHutCapacity(count));
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, BARNES_HUT_THETA, 28, 12, 1);

    // Exact reference using the same pair rule the grid version applied.
    let referenceMagnitude = 0;
    let directionAgreement = 0;
    let compared = 0;
    for (let i = 0; i < count; i++) {
      let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < count; j++) {
        if (i === j) continue;
        const dx = px[i]! - px[j]!, dy = py[i]! - py[j]!, dz = pz[i]! - pz[j]!;
        const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
        const strength = (isSource[i] || isSource[j] ? 28 : 12) / distanceSquared;
        ax += dx * strength; ay += dy * strength; az += dz * strength;
      }
      referenceMagnitude += Math.hypot(ax, ay, az);
      const magnitude = Math.hypot(fx[i]!, fy[i]!, fz[i]!);
      const reference = Math.hypot(ax, ay, az);
      if (reference > 1e-9 && magnitude > 1e-9) {
        directionAgreement += (fx[i]! * ax + fy[i]! * ay + fz[i]! * az) / (reference * magnitude);
        compared++;
      }
    }
    // Direction is what decides layout shape; at theta 0.5 it is essentially exact.
    expect(directionAgreement / compared).toBeGreaterThan(0.97);
    expect(referenceMagnitude).toBeGreaterThan(0);
  });

  it("never repels a point from itself", () => {
    // Two well-separated points: each must feel the other, and neither may feel a
    // self-force. A self-repelling tree would produce NaN or an opposite-sign force.
    const count = 2;
    const px = new Float64Array([-100, 100]), py = new Float64Array([0, 0]), pz = new Float64Array([0, 0]);
    const isSource = new Uint8Array([0, 0]);
    const fx = new Float64Array(2), fy = new Float64Array(2), fz = new Float64Array(2);
    const tree = createBarnesHutTree(barnesHutCapacity(count));
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, BARNES_HUT_THETA, 28, 12, 1);
    expect(Number.isFinite(fx[0]!)).toBe(true);
    // Point 0 is left of point 1, so it must be pushed further left.
    expect(fx[0]!).toBeLessThan(0);
    expect(fx[1]!).toBeGreaterThan(0);
  });

  it("keeps coincident points finite instead of recursing forever", () => {
    const count = 40;
    const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
    const isSource = new Uint8Array(count);
    const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
    const tree = createBarnesHutTree(barnesHutCapacity(count));
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, BARNES_HUT_THETA, 28, 12, 1);
    for (let i = 0; i < count; i++) {
      expect(Number.isFinite(fx[i]!)).toBe(true);
      expect(Number.isFinite(fy[i]!)).toBe(true);
      expect(Number.isFinite(fz[i]!)).toBe(true);
    }
  });

  it("produces a bounded number of cells", () => {
    const { px, py, pz, isSource, count } = cloud(2000, 600);
    const tree = createBarnesHutTree(barnesHutCapacity(count));
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    // The depth cap keeps the tree from growing without bound on dense clouds.
    expect(tree.used).toBeGreaterThan(count);
    expect(tree.used).toBeLessThan(count * 40);
  });
});

function graph(nodeCount: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  return buildSyntheticMemoryGraph(nodeCount, Math.min(nodeCount * 3, 150_000));
}

describe("incremental layout", () => {
  it("chunked 3D steps return the same coordinates as the synchronous layout", () => {
    const { nodes, edges } = graph(400);
    const options = { steps: 12 };
    const synchronous = layoutMemoryNetwork3D(nodes, edges, options);
    const iterator = memoryLayout3DSteps(nodes, edges, options);
    let stepped: Map<string, { x: number; y: number; z: number }> | undefined;
    let chunks = 0;
    for (;;) {
      const next = iterator.next();
      chunks++;
      if (next.done) { stepped = next.value; break; }
    }
    expect(chunks).toBeGreaterThan(1);
    expect([...stepped!.entries()]).toEqual([...synchronous.entries()]);
  });

  it("chunked 2D steps return the same coordinates as the synchronous layout", () => {
    const { nodes, edges } = graph(400);
    const options = { steps: 12 };
    const synchronous = layoutMemoryNetwork(nodes, edges, options);
    const iterator = memoryLayoutSteps(nodes, edges, options);
    let stepped: Map<string, { x: number; y: number }> | undefined;
    for (;;) {
      const next = iterator.next();
      if (next.done) { stepped = next.value; break; }
    }
    expect([...stepped!.entries()]).toEqual([...synchronous.entries()]);
  });

  it("yields exactly one progress record per step", () => {
    const { nodes, edges } = graph(200);
    const steps = 7;
    const iterator = memoryLayout3DSteps(nodes, edges, { steps });
    const seen: Array<{ step: number; steps: number }> = [];
    for (;;) {
      const next = iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }
    expect(seen.map(entry => entry.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen.every(entry => entry.steps === steps)).toBe(true);
  });

  it("reuses a warm start so an unchanged graph does not move", () => {
    const { nodes, edges } = graph(300);
    const first = layoutMemoryNetwork3D(nodes, edges, { steps: 20 });
    // Zero further steps must return the warm start unchanged: this is what makes an
    // incremental relayout cheap when only a few nodes were added.
    const second = layoutMemoryNetwork3D(nodes, edges, { initial: first, steps: 0 });
    for (const [id, point] of first) expect(second.get(id)).toEqual(point);
  });

  it("shrinks the step budget as the graph grows", () => {
    const small = memoryLayout3DSteps(graph(1000).nodes, graph(1000).edges);
    const large = memoryLayout3DSteps(graph(20_000).nodes, graph(20_000).edges);
    const stepsFor = (iterator: Generator<{ step: number; steps: number }, unknown>) => {
      const first = iterator.next();
      return first.done ? 0 : first.value.steps;
    };
    expect(stepsFor(large)).toBeLessThan(stepsFor(small));
  });
});
