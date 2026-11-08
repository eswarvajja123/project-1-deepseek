import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryGraphOverviewResponse } from "../../live-api.js";
import { buildSyntheticMemoryGraph, SYNTHETIC_GRAPH_SIZES, type SyntheticGraphSize } from "./memory-3d-synthetic.js";

/**
 * Demo mode for the 3D memory graph.
 *
 * The overview route is capped and depends on a live archive, so a reproducible 2k/10k/50k
 * demo cannot rely on it. This builds the same response envelope the API returns, from the
 * deterministic synthetic generator, so the renderer and the benchmark harness exercise
 * identical graphs.
 */

export const DEMO_GRAPH_LIMITS = SYNTHETIC_GRAPH_SIZES;

export type DemoGraphSize = SyntheticGraphSize["label"];

/** The server-side ceiling, mirrored here so demo mode cannot request more than the API would accept. */
export const DEMO_MAX_NODES = 50_000;

export function isDemoGraphSize(value: string): value is DemoGraphSize {
  return SYNTHETIC_GRAPH_SIZES.some(size => size.label === value);
}

/**
 * Next graph source in the cycle, ending back at the live archive.
 *
 * The workspace exposes demo mode as a single cycling button rather than a `<select>`:
 * the map view is specified to offer only search, its toggles, and the map itself.
 */
export function nextDemoGraphSize(current: DemoGraphSize | null): DemoGraphSize | null {
  if (current === null) return SYNTHETIC_GRAPH_SIZES[0]!.label as DemoGraphSize;
  const index = SYNTHETIC_GRAPH_SIZES.findIndex(size => size.label === current);
  const next = SYNTHETIC_GRAPH_SIZES[index + 1];
  return next ? (next.label as DemoGraphSize) : null;
}

/**
 * Build an overview response for the given demo size.
 *
 * `truncated` is false because demo mode returns the whole generated graph; the boundary
 * information (`totalMatchingNodes`/`totalMatchingEdges`) is still populated so the UI
 * reports the same away it does for live data.
 */
export function buildDemoOverview(limit: DemoGraphSize | number): MemoryGraphOverviewResponse {
  const size = resolveSize(limit);
  const { nodes, edges } = buildSyntheticMemoryGraph(size.nodes, size.edges);
  return {
    data: {
      version: 2,
      layoutVersion: 2,
      generatedAt: new Date(0).toISOString(),
      sourceHash: "0".repeat(64),
      isStale: false,
      summary: {
        sourceCount: Math.min(24, nodes.filter(node => node.type === "SOURCE").length),
        recordCount: nodes.filter(node => node.type === "MEMORY").length,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        issueCount: 0
      },
      nodes: nodes as MemoryGraphNode[],
      edges: edges as MemoryGraphEdge[],
      totalMatchingNodes: nodes.length,
      totalMatchingEdges: edges.length,
      truncated: false,
      filters: {
        q: null,
        nodeType: null,
        scope: null,
        roomId: null,
        sourcePath: null,
        lifecycleStatus: null,
        relationMode: "RELATIONS",
        month: null
      },
      months: []
    }
  } as MemoryGraphOverviewResponse;
}

function resolveSize(limit: DemoGraphSize | number): SyntheticGraphSize {
  if (typeof limit === "number") {
    // Match a numeric limit to the smallest demo size that covers it.
    return SYNTHETIC_GRAPH_SIZES.find(size => size.nodes >= limit) ?? SYNTHETIC_GRAPH_SIZES[SYNTHETIC_GRAPH_SIZES.length - 1]!;
  }
  return SYNTHETIC_GRAPH_SIZES.find(size => size.label === limit) ?? SYNTHETIC_GRAPH_SIZES[0]!;
}
