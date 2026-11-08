import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/**
 * Deterministic synthetic memory graphs for demo mode and benchmarks.
 *
 * The generator is seeded purely by shape, so the same size always yields the same
 * graph. That is what makes the 2k/10k/50k benchmarks comparable across runs and
 * lets the renderer be developed without a backend or an embedding provider.
 */

export const SYNTHETIC_GRAPH_SIZES = [
  { label: "2k", nodes: 2000, edges: 6000 },
  { label: "10k", nodes: 10000, edges: 30000 },
  { label: "50k", nodes: 50000, edges: 150000 }
] as const;

export type SyntheticGraphSize = (typeof SYNTHETIC_GRAPH_SIZES)[number];

export function syntheticGraphSize(label: string): SyntheticGraphSize {
  return SYNTHETIC_GRAPH_SIZES.find(size => size.label === label) ?? SYNTHETIC_GRAPH_SIZES[0]!;
}

export function buildSyntheticMemoryGraph(nodeCount: number, edgeCount: number): {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
} {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  nodes.push({ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/core/gemini.md", recordId: null });
  // One source per 40 records keeps the source/memory ratio of a real workspace.
  const sources = Math.max(1, Math.min(Math.round(nodeCount / 40), nodeCount - 1));
  for (let source = 0; source < sources; source++) {
    const id = `source-${String(source).padStart(5, "0")}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/docs/${id}.md`, recordId: null });
    edges.push({ id: `e-file-${source}`, type: "DERIVED_FROM", source: "root", target: id });
  }
  let memory = 0;
  while (nodes.length < nodeCount) {
    const parent = `source-${String(memory % sources).padStart(5, "0")}`;
    const id = `memory-${String(memory).padStart(6, "0")}`;
    nodes.push({ id, label: `memory record ${memory}`, type: "MEMORY", sourcePath: `/docs/${parent}.md`, recordId: id });
    edges.push({ id: `e-c-${memory}`, type: "CONTAINS", source: parent, target: id });
    memory++;
  }
  // Pad to the requested edge count with cross-links, which is what makes layout and
  // edge batching expensive in a way pure tree graphs would hide.
  let link = 0;
  while (edges.length < edgeCount) {
    const a = nodes[1 + (link % (nodes.length - 1))]!;
    const b = nodes[1 + ((link * 7919 + 13) % (nodes.length - 1))]!;
    link++;
    if (a.id === b.id) continue;
    edges.push({ id: `e-d-${link}`, type: link % 3 === 0 ? "SEMANTICALLY_RELATED" : "DERIVED_FROM", source: a.id, target: b.id });
  }
  return { nodes, edges };
}
