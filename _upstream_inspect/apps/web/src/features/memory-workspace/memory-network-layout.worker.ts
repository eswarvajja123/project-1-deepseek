import { memoryLayout3DSteps } from "./memory-3d.js";
import { memoryLayoutSteps } from "./memory-network-layout.js";
import { createMemoryAtlas, serializeAtlas, serializeLayoutResult } from "./memory-atlas.js";

import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/**
 * Graph preparation worker.
 *
 * Covers the whole path from raw graph data to render-ready geometry: atlas
 * construction, then the 2D and 3D relaxations. Issue #62 asks for no main-thread task
 * over 100 ms during load/layout; on the 50k synthetic graph, atlas construction alone
 * measured 474-892 ms and parsing 517-862 ms on the reference laptop, so both had to
 * leave the main thread alongside layout.
 *
 * Every phase runs incrementally. Layout passes are generators that yield once per
 * relaxation step, and this worker drains them until a wall-clock chunk budget is spent
 * before yielding to the event loop. That bounds each task regardless of graph size: a
 * single blocking call would still monopolise the worker for tens of seconds.
 *
 * Messages out:
 * - `{ type: "progress", phase, step, steps }` after every layout chunk.
 * - `{ type: "atlas", atlas }` as soon as the atlas is ready, so the 2D view can paint
 *   while the 3D layout finishes.
 * - `{ type: "done", positions, depth }` when the layout completes.
 *
 * `requestId` is echoed so the caller can drop results for a superseded graph.
 */

/** Wall-clock budget for one synchronous chunk, in milliseconds. */
export const LAYOUT_CHUNK_BUDGET_MS = 12;

type WorkerRequest = {
  /** Raw nodes/edges, or a JSON string when the caller wants parsing moved here too. */
  nodes?: MemoryGraphNode[];
  edges?: MemoryGraphEdge[];
  payload?: string;
  /**
   * Slice upload: the caller sends `nodes`, then `edges`, 4,000 at a time and marks the last
   * one `final`. This is the app's path; slicing is what keeps the main thread free, since a
   * single clone of the whole graph measured 243 ms at 50k.
   */
  chunk?: {
    nodes?: MemoryGraphNode[];
    edges?: MemoryGraphEdge[];
    final?: boolean;
  };
  requestId?: number;
  /** Override the chunk budget; tests use a large value to finish in one chunk. */
  chunkBudgetMs?: number;
  /** Override step budgets; tests use a small value to keep runtimes short. */
  steps?: { flat?: number; depth?: number };
};

/**
 * Drain `iterator` in time-bounded chunks.
 *
 * The `await` of `setTimeout(0)` between chunks is what actually yields: draining the
 * generator in a plain `while` loop would still run the whole layout in one task.
 */
async function drainInChunks<T>(
  iterator: Generator<{ step: number; steps: number }, T>,
  phase: "flat" | "depth",
  requestId: number | undefined,
  budgetMs: number
): Promise<T> {
  for (;;) {
    const chunkStart = Date.now();
    let last: { step: number; steps: number } | undefined;
    // At least one step always runs, so a step longer than the budget cannot stall.
    do {
      const next = iterator.next();
      if (next.done) return next.value;
      last = next.value;
    } while (Date.now() - chunkStart < budgetMs);
    self.postMessage({ type: "progress", requestId, phase, step: last!.step, steps: last!.steps });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Input accumulated across `chunk` messages, keyed by request id. */
const uploads = new Map<number, { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, chunkBudgetMs, steps } = event.data;

  // Chunked upload: accumulate until the caller marks the last slice. Nothing is built
  // until the graph is complete, so partial input never produces a partial atlas.
  if (event.data.chunk) {
    const key = requestId ?? 0;
    const pending = uploads.get(key) ?? { nodes: [], edges: [] };
    // Appended by loop, not `push(...slice)`: spreading 40k+ arguments overflows the stack.
    const incomingNodes = event.data.chunk.nodes;
    if (incomingNodes) for (const node of incomingNodes) pending.nodes.push(node);
    const incomingEdges = event.data.chunk.edges;
    if (incomingEdges) for (const edge of incomingEdges) pending.edges.push(edge);
    uploads.set(key, pending);
    if (!event.data.chunk.final) return;
    uploads.delete(key);
    void start(pending.nodes, pending.edges, requestId, chunkBudgetMs, steps);
    return;
  }

  void (async () => {
    // Parsing runs here when the caller hands over the raw JSON text, which keeps the
    // 50k deserialisation (517-862 ms) off the main thread.
    const parsed = event.data.payload
      ? (JSON.parse(event.data.payload) as { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] })
      : { nodes: event.data.nodes ?? [], edges: event.data.edges ?? [] };
    await start(parsed.nodes, parsed.edges, requestId, chunkBudgetMs, steps);
  })();
};

async function start(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  requestId: number | undefined,
  chunkBudgetMs: number | undefined,
  steps: WorkerRequest["steps"]
) {
  const budget = chunkBudgetMs ?? LAYOUT_CHUNK_BUDGET_MS;
  const atlas = createMemoryAtlas(nodes, edges, false);
  // Sent columnar: the coordinate column is a `Float64Array` transferred rather than cloned,
  // because an array of 50k id/position tuples cost 269 ms to deserialise on the main thread.
  const wire = serializeAtlas(atlas);
  (self as unknown as Worker).postMessage({ type: "atlas", requestId, atlas: wire }, [wire.positionXY.buffer as ArrayBuffer]);

  const positions = await drainInChunks(
    memoryLayoutSteps(atlas.nodes, atlas.edges, { steps: steps?.flat }),
    "flat",
    requestId,
    budget
  );
  const depth = await drainInChunks(
    memoryLayout3DSteps(atlas.nodes, atlas.edges, { steps: steps?.depth }),
    "depth",
    requestId,
    budget
  );
  // Columnar, for the same reason as the atlas: sending `[...positions]` and `[...depth]`
  // meant 100,000 two-element tuples crossing the thread, which the browser deserialises as a
  // single 268 ms main-thread task before the caller's handler runs. Ids travel as one string
  // and coordinates as transferred `Float64Array`s.
  const done = serializeLayoutResult(positions, depth);
  (self as unknown as Worker).postMessage(
    { type: "done", requestId, ...done },
    [done.positionXY.buffer as ArrayBuffer, done.depthXYZ.buffer as ArrayBuffer]
  );
}
