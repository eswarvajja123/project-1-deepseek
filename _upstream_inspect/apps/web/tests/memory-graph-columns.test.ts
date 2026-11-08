/**
 * Binary columnar transport tests - a **measured, rejected** alternative.
 *
 * This encoding was built to remove the structured clone of the graph upload, measured, and
 * dropped: the transfer itself costs 0.7 ms, but packing the columns costs ~1,440 ms of main
 * thread at 50k, against 243 ms for one clone and 7.8 ms for the worst 4k slice of the
 * shipped path. Measurements are in `scripts/upload-compare.ts`.
 *
 * The module is kept because the comparison is the evidence for choosing slices, and it must
 * keep working for that comparison to stay reproducible. These tests pin it as lossless so a
 * future transport change can adopt it if the encode cost is ever paid elsewhere - the worker
 * could encode, for instance, if the graph ever arrives there as bytes.
 */
import { describe, expect, it } from "vitest";
import { decodeGraphColumns, encodeGraphColumns, graphColumnBuffers } from "../src/features/memory-workspace/memory-graph-columns.js";
import { buildSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-3d-synthetic.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

function node(overrides: Partial<MemoryGraphNode> & { id: string }): MemoryGraphNode {
  return {
    type: "MEMORY",
    label: overrides.id,
    sourcePath: null,
    recordId: null,
    ...overrides
  } as MemoryGraphNode;
}

function edge(overrides: Partial<MemoryGraphEdge> & { id: string; source: string; target: string }): MemoryGraphEdge {
  return { type: "CONTAINS", ...overrides } as MemoryGraphEdge;
}

describe("graph column transport", () => {
  it("round-trips a synthetic 2k graph exactly", () => {
    const { nodes, edges } = buildSyntheticMemoryGraph(2_000, 6_000);
    const decoded = decodeGraphColumns(encodeGraphColumns(nodes, edges));

    expect(decoded.nodes.length).toBe(nodes.length);
    expect(decoded.edges.length).toBe(edges.length);
    // Deep equality covers every field, including the ones the renderer depends on.
    expect(decoded.nodes).toEqual(nodes);
    expect(decoded.edges).toEqual(edges);
  });

  it("preserves the distinction between absent and null optional fields", () => {
    const nodes: MemoryGraphNode[] = [
      node({ id: "a", clusterId: undefined, cacheRecordId: undefined, position: undefined }),
      node({ id: "b", clusterId: null, cacheRecordId: null, position: undefined }),
      node({ id: "c", clusterId: "cluster-1", cacheRecordId: "cache-1", position: { clustered: { x: 1.5, y: -2.5 }, relations: { x: 0.25, y: 9.75 } } })
    ];
    const decoded = decodeGraphColumns(encodeGraphColumns(nodes, []));

    // `undefined` must stay undefined, not become null: the contract treats them differently.
    expect("clusterId" in decoded.nodes[0]!).toBe(false);
    expect("cacheRecordId" in decoded.nodes[0]!).toBe(false);
    expect("position" in decoded.nodes[0]!).toBe(false);
    // An explicit null must stay null.
    expect(decoded.nodes[1]!.clusterId).toBeNull();
    expect(decoded.nodes[1]!.cacheRecordId).toBeNull();
    // Present values survive bit-exact, in both position views.
    expect(decoded.nodes[2]!.clusterId).toBe("cluster-1");
    expect(decoded.nodes[2]!.position).toEqual({ clustered: { x: 1.5, y: -2.5 }, relations: { x: 0.25, y: 9.75 } });
  });

  it("preserves optional edge origin, confidence, and evidence", () => {
    const edges: MemoryGraphEdge[] = [
      edge({ id: "e1", source: "a", target: "b" }),
      edge({ id: "e2", source: "a", target: "b", type: "TAGGED_WITH", origin: "DERIVED_TFIDF", confidence: 0.75, evidence: "shared tokens" }),
      edge({ id: "e3", source: "a", target: "b", type: "SEMANTICALLY_RELATED", origin: "EMBEDDING", confidence: 0, evidence: "cosine 0.9" })
    ];
    const decoded = decodeGraphColumns(encodeGraphColumns([], edges));
    expect(decoded.edges).toEqual(edges);
    // Confidence 0 is a real value, not an absent one.
    expect(decoded.edges[2]!.confidence).toBe(0);
  });

  it("survives non-ASCII labels without corrupting the byte column", () => {
    const nodes = [
      node({ id: "u1", label: "café — naïve résumé" }),
      node({ id: "u2", label: "日本語のラベル" }),
      node({ id: "u3", label: "emoji 🚀 memory" }),
      node({ id: "u4", label: "ascii after wide" })
    ];
    const decoded = decodeGraphColumns(encodeGraphColumns(nodes, []));
    expect(decoded.nodes.map(entry => entry.label)).toEqual(nodes.map(entry => entry.label));
    expect(decoded.nodes.map(entry => entry.id)).toEqual(nodes.map(entry => entry.id));
  });

  it("exposes only typed-array buffers, so they can be transferred", () => {
    const { nodes, edges } = buildSyntheticMemoryGraph(500, 1_500);
    const columns = encodeGraphColumns(nodes, edges);
    const buffers = graphColumnBuffers(columns);

    expect(buffers.length).toBeGreaterThan(10);
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const buffer of buffers) expect(buffer).toBeInstanceOf(ArrayBuffer);
    // Nothing left as a plain object array that would need walking at clone time.
    expect(columns.nodes.ids.lengths).toBeInstanceOf(Uint32Array);
    expect(columns.nodes.presence).toBeInstanceOf(Uint8Array);
    expect(columns.nodes.positions).toBeInstanceOf(Float64Array);
    expect(columns.edges.types).toBeInstanceOf(Uint8Array);
    expect(columns.edges.confidences).toBeInstanceOf(Float32Array);
  });

  it("rejects an unknown enum value instead of silently mislabelling it", () => {
    const bad = [node({ id: "x", type: "NOT_A_TYPE" as MemoryGraphNode["type"] })];
    expect(() => encodeGraphColumns(bad, [])).toThrow(/Unknown node type/);
  });

  it("handles an empty graph", () => {
    const decoded = decodeGraphColumns(encodeGraphColumns([], []));
    expect(decoded.nodes).toEqual([]);
    expect(decoded.edges).toEqual([]);
  });
});
