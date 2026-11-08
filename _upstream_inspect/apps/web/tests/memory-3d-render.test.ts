import { describe, expect, it } from "vitest";
import { createPointGrid, relaxationSteps, suggestCellSize } from "../src/features/memory-workspace/memory-point-grid.js";
import { buildWebGLGraphInput } from "../src/features/memory-workspace/memory-3d-webgl-geometry.js";
import { buildSyntheticMemoryGraph, syntheticGraphSize, SYNTHETIC_GRAPH_SIZES } from "../src/features/memory-workspace/memory-3d-synthetic.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("spatial grid", () => {
  it("returns every point in the 3x3x3 neighbourhood and nothing further", () => {
    const grid = createPointGrid(10);
    const xs = new Float64Array([0, 5, 100, 0]);
    const ys = new Float64Array([0, 5, 100, 0]);
    const zs = new Float64Array([0, 5, 100, 0]);
    grid.buildFromArrays(xs, ys, zs, 4);
    const out = new Int32Array(grid.queryCapacity(4));
    const found = grid.neighbors(0, 0, 0, out);
    const ids = Array.from(out.slice(0, found)).sort((a, b) => a - b);
    // Points 0, 1, and 3 are near the origin; point 2 is 100 units away.
    expect(ids).toEqual([0, 1, 3]);
    expect(ids).not.toContain(2);
  });

  it("handles negative coordinates without losing points", () => {
    const grid = createPointGrid(10);
    const xs = new Float64Array([-500, -495, 500]);
    const ys = new Float64Array([-500, -495, 500]);
    const zs = new Float64Array([-500, -495, 500]);
    grid.buildFromArrays(xs, ys, zs, 3);
    const out = new Int32Array(grid.queryCapacity(3));
    const found = grid.neighbors(-500, -500, -500, out);
    const ids = Array.from(out.slice(0, found)).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1]);
  });

  it("keeps a flat (z-constant) graph from triple-counting its own layer", () => {
    const grid = createPointGrid(10);
    const count = 50;
    const xs = new Float64Array(count).map((_, i) => i % 5);
    const ys = new Float64Array(count).map((_, i) => Math.floor(i / 5));
    const zs = new Float64Array(count);
    grid.buildFromArrays(xs, ys, zs, count);
    const out = new Int32Array(grid.queryCapacity(count));
    const found = grid.neighbors(xs[0]!, ys[0]!, 0, out);
    // No index may be reported twice while the layer is scanned once.
    const ids = Array.from(out.slice(0, found));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("degrades step count only for graphs past the interactive size", () => {
    expect(relaxationSteps(2000, 180)).toBe(180);
    expect(relaxationSteps(5000, 180)).toBe(180);
    expect(relaxationSteps(50000, 180)).toBeLessThan(180);
    expect(relaxationSteps(50000, 180)).toBeGreaterThanOrEqual(48);
  });

  it("scales cell size with density within bounds", () => {
    expect(suggestCellSize(260, 2000, 24, 96)).toBeGreaterThanOrEqual(24);
    expect(suggestCellSize(260, 2000, 24, 96)).toBeLessThanOrEqual(96);
    expect(suggestCellSize(0, 0, 24, 96)).toBe(24);
  });
});

describe("WebGL geometry", () => {
  const fixture = () => {
    const nodes: MemoryGraphNode[] = [
      { id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/core/gemini.md", recordId: null },
      { id: "source-a", label: "a.md", type: "SOURCE", sourcePath: "/docs/a.md", recordId: null },
      { id: "memory-1", label: "one", type: "MEMORY", sourcePath: "/docs/a.md", recordId: "memory-1" }
    ];
    const edges: MemoryGraphEdge[] = [
      { id: "e1", type: "DERIVED_FROM", source: "root", target: "source-a" },
      { id: "e2", type: "CONTAINS", source: "source-a", target: "memory-1" }
    ];
    const coordinates = new Map([
      ["root", { x: 0, y: 0, z: 0 }],
      ["source-a", { x: 10, y: 0, z: 0 }],
      ["memory-1", { x: 12, y: 5, z: 1 }]
    ]);
    return { nodes, edges, coordinates };
  };

  it("packs one position, color, and size per visible node", () => {
    const { nodes, edges, coordinates } = fixture();
    const input = buildWebGLGraphInput(nodes, edges, coordinates, new Map(), null);
    expect(input.count).toBe(3);
    expect(input.positions.length).toBe(9);
    expect(input.colors.length).toBe(12);
    expect(input.sizes.length).toBe(3);
    // Two endpoint triples per edge.
    expect(input.edgeCount).toBe(2);
    expect(input.edges.length).toBe(12);
  });

  it("drops nodes with no layout position and the edges that reference them", () => {
    const { nodes, edges } = fixture();
    const partial = new Map([["root", { x: 0, y: 0, z: 0 }], ["source-a", { x: 5, y: 0, z: 0 }]]);
    const input = buildWebGLGraphInput(nodes, edges, partial, new Map(), null);
    expect(input.count).toBe(2);
    // Only the root -> source-a edge survives; the memory edge loses its target.
    expect(input.edgeCount).toBe(1);
  });

  it("dims non-neighbours when a node is focused", () => {
    const { nodes, edges, coordinates } = fixture();
    // Add a node with no edges so it is a true non-neighbour of the focused node.
    nodes.push({ id: "memory-2", label: "two", type: "MEMORY", sourcePath: "/docs/a.md", recordId: "memory-2" });
    coordinates.set("memory-2", { x: 40, y: 40, z: 40 });
    const input = buildWebGLGraphInput(nodes, edges, coordinates, new Map(), "source-a");
    // Sorted by id: memory-1, memory-2, root, source-a.
    const order = ["memory-1", "memory-2", "root", "source-a"];
    const focusIndex = order.indexOf("source-a");
    // root and memory-1 are connected to source-a, so they stay fully opaque.
    expect(input.colors[focusIndex * 4 + 3]).toBe(1);
    expect(input.colors[order.indexOf("root") * 4 + 3]).toBe(1);
    expect(input.colors[order.indexOf("memory-1") * 4 + 3]).toBe(1);
    // memory-2 has no edge to the focused node, so it is dimmed.
    expect(input.colors[order.indexOf("memory-2") * 4 + 3]).toBeLessThan(1);
  });

  it("is deterministic under input reordering", () => {
    const { nodes, edges, coordinates } = fixture();
    const forward = buildWebGLGraphInput(nodes, edges, coordinates, new Map(), null);
    const reversed = buildWebGLGraphInput([...nodes].reverse(), [...edges].reverse(), coordinates, new Map(), null);
    expect(reversed.positions).toEqual(forward.positions);
    expect(reversed.sizes).toEqual(forward.sizes);
  });
});

describe("synthetic graphs", () => {
  it("produces the requested node and edge counts deterministically", () => {
    const a = buildSyntheticMemoryGraph(500, 1500);
    const b = buildSyntheticMemoryGraph(500, 1500);
    expect(a.nodes.length).toBe(500);
    expect(a.edges.length).toBe(1500);
    expect(a.edges).toEqual(b.edges);
  });

  it("exposes the benchmark sizes the issue asks for", () => {
    expect(SYNTHETIC_GRAPH_SIZES.map(size => size.label)).toEqual(["2k", "10k", "50k"]);
    expect(syntheticGraphSize("50k").nodes).toBe(50000);
    expect(syntheticGraphSize("50k").edges).toBe(150000);
    // Unknown labels fall back to the smallest graph rather than throwing.
    expect(syntheticGraphSize("nope").label).toBe("2k");
  });
});
