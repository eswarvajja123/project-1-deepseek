import { describe, expect, it } from "vitest";
import {
  createMemoryAtlas,
  deserializeAtlasSteps,
  serializeAtlas,
  type MemoryAtlas
} from "../src/features/memory-workspace/memory-atlas.js";
import { buildSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-3d-synthetic.js";

/** Drain a deserializer that yields between steps, exactly as the workspace does. */
function drain(
  wire: ReturnType<typeof serializeAtlas>,
  nodes: Parameters<typeof deserializeAtlasSteps>[1],
  edges: Parameters<typeof deserializeAtlasSteps>[2],
  yieldEvery?: number
): { atlas: MemoryAtlas; steps: number } {
  const iterator = deserializeAtlasSteps(wire, nodes, edges, yieldEvery);
  let steps = 0;
  for (;;) {
    const next = iterator.next();
    if (next.done) return { atlas: next.value, steps };
    steps++;
  }
}

describe("atlas wire format", () => {
  const { nodes, edges } = buildSyntheticMemoryGraph(600, 1800);
  const original = createMemoryAtlas(nodes, edges, false);

  it("round-trips positions, groups, and counts", () => {
    const wire = serializeAtlas(original);
    const { atlas } = drain(wire, nodes, edges);

    expect(atlas.positions.size).toBe(original.positions.size);
    for (const [id, position] of original.positions) expect(atlas.positions.get(id)).toEqual(position);
    expect(atlas.groups).toEqual(original.groups);
    expect(atlas.explicitCount).toBe(original.explicitCount);
    expect(atlas.semanticCount).toBe(original.semanticCount);
  });

  it("reattaches the caller's own node objects instead of copying them", () => {
    const { atlas } = drain(serializeAtlas(original), nodes, edges);
    const byId = new Map(nodes.map(node => [node.id, node]));
    // Identity, not deep equality: the whole point is that nodes never cross the thread.
    for (const node of atlas.nodes) expect(node).toBe(byId.get(node.id));
    expect(atlas.nodes.map(node => node.id)).toEqual(original.nodes.map(node => node.id));
  });

  it("does not send node or edge bodies over the wire", () => {
    const wire = serializeAtlas(original) as unknown as Record<string, unknown>;
    // The visible set is derivable from the position columns, so no id lists or objects travel.
    expect(wire.nodes).toBeUndefined();
    expect(wire.edges).toBeUndefined();
    expect(wire.nodeIds).toBeUndefined();
    expect(wire.edgeIds).toBeUndefined();
    // Columnar, not an array of tuples: a 50k array of [id, position] pairs cost 269 ms to
    // deserialise on the main thread, which was the largest remaining long task.
    expect(Array.isArray(wire.positions)).toBe(false);
    expect(wire.positionIds).toBeTypeOf("string");
    expect(wire.positionMeta).toBeTypeOf("string");
    expect(wire.positionXY).toBeInstanceOf(Float64Array);
  });

  it("spreads the rebuild over bounded steps", () => {
    const wire = serializeAtlas(original);
    const { steps } = drain(wire, nodes, edges, 25);
    // Positions, then the node and edge filters, each advance in slices of `yieldEvery`,
    // so no single task can grow with the graph. The step count comes from the id column.
    const slices = (length: number) => Math.ceil(length / 25);
    const positionCount = wire.positionIds.length ? wire.positionIds.split("\u001f").length : 0;
    const expected = Math.max(0, slices(positionCount)) + slices(nodes.length) + slices(edges.length);
    expect(steps).toBe(expected);
  });

  it("still completes a single step for a graph that fits one chunk", () => {
    const small = buildSyntheticMemoryGraph(10, 20);
    const smallAtlas = createMemoryAtlas(small.nodes, small.edges, false);
    const { steps, atlas } = drain(serializeAtlas(smallAtlas), small.nodes, small.edges, 100_000);
    // One bounded pass per phase: the node filter and the edge filter, plus the positions
    // pass when the graph produced any.
    expect(steps).toBeGreaterThanOrEqual(2);
    expect(steps).toBeLessThanOrEqual(3);
    expect(atlas.positions.size).toBe(smallAtlas.positions.size);
  });
});
