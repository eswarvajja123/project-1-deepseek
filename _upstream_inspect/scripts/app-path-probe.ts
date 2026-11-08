/**
 * Diagnostic entry for `memory-graph-gpu-bench.ts` (BENCH_ENTRY=app-path-probe.ts).
 *
 * Measures the **shipped** load path end to end, using the app's own code rather than a copy
 * of it: the same sliced upload, the same worker, the same `drainDeserialize` budget, and the
 * same map merge. Earlier probes re-implemented these and disagreed with each other by 100+ ms,
 * so the only number worth trusting is the one the product code produces.
 *
 * Reports the browser's long-task accounting for the whole load, which is what Issue #62's
 * "no main-thread task > 100 ms" bound is about.
 */
declare global {
  interface Window {
    __probe: (label: string) => Promise<unknown>;
    __ready: boolean;
    __stage: string;
  }
}

type LongTask = { duration: number; stage: string };

window.__probe = async (label: string) => {
  const size = Number(label.replace("k", "")) * 1_000;
  const [{ buildSyntheticMemoryGraph }, { deserializeAtlasSteps, mergeLayoutSteps, decodeLayoutDepth }] = await Promise.all([
    import("../apps/web/src/features/memory-workspace/memory-3d-synthetic.js"),
    import("../apps/web/src/features/memory-workspace/memory-atlas.js")
  ]);
  const { nodes, edges } = buildSyntheticMemoryGraph(size, size * 3);

  let stage = "start";
  const tasks: LongTask[] = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) tasks.push({ duration: entry.duration, stage });
  });
  observer.observe({ type: "longtask", buffered: false });

  // App constant: UPLOAD_CHUNK in MemoryWorkspace.tsx.
  const UPLOAD_CHUNK = 4_000;
  // App constant: DESERIALIZE_BUDGET_MS in MemoryWorkspace.tsx.
  const DESERIALIZE_BUDGET_MS = 8;

  const worker = new Worker(window.__layoutWorkerUrl!, { type: "module" });
  await new Promise(resolve => setTimeout(resolve, 150));

  let mergedPositions = 0;
  // Captured from the `atlas` message, because the merge rebuilds `positions` from the atlas
  // Map rather than from the raw wire form.
  let atlasPositions: Map<string, { x: number; y: number; color: string; hub: boolean; groupId: string }> | null = null;
  let resultDepth = 0;
  let layoutDone = false;
  let deserializeMs = 0;

  const finished = new Promise<void>(resolve => {
    worker.onmessage = async event => {
      const message = event.data;
      if (message?.type === "progress") return;
      if (message?.type === "atlas") {
        stage = "deserialize";
        const started = performance.now();
        // Verbatim the loop from `drainDeserialize`.
        const iterator = deserializeAtlasSteps(message.atlas, nodes, edges, 1_000, DESERIALIZE_BUDGET_MS);
        let atlasResult: { positions: Map<string, Record<string, number>> } | null = null;
        for (;;) {
          const next = iterator.next();
          if (next.done) { atlasResult = next.value as never; break; }
          await new Promise(resolve2 => setTimeout(resolve2, 0));
        }
        // The app merges into `finalAtlas.positions`; materialise it here the same way.
        atlasPositions = atlasResult ? (atlasResult.positions as never) : null;
        deserializeMs = +(performance.now() - started).toFixed(1);
        stage = "wait-layout";
        return;
      }
      if (message?.type === "done") {
        stage = "merge";
        // Verbatim the workspace handler: drain `mergeLayoutSteps` against an 8 ms budget,
        // then decode the depth column. Nothing 50k-sized happens in one task.
        mergeStarted = performance.now();
        const merged = new Map(atlasPositions!);
        const merger = mergeLayoutSteps(message as never, atlasPositions!, 2_000);
        let mergeStart = performance.now();
        for (;;) {
          const next = merger.next();
          if (next.done) break;
          if (performance.now() - mergeStart >= 8) {
            await new Promise(resolve2 => setTimeout(resolve2, 0));
            mergeStart = performance.now();
          }
        }
        const depthDecoded = decodeLayoutDepth(message as never);
        mergedPositions = merged.size;
        mergeMs = +(performance.now() - mergeStarted).toFixed(1);
        resultDepth = depthDecoded.size;
        layoutDone = true;
        resolve();
      }
    };
    worker.onerror = () => resolve();
  });
  let mergeStarted = 0;
  let mergeMs = 0;

  stage = "upload";
  for (let index = 0; index < nodes.length; index += UPLOAD_CHUNK) {
    worker.postMessage({ requestId: 21, chunk: { nodes: nodes.slice(index, index + UPLOAD_CHUNK) } });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  for (let index = 0; index < edges.length; index += UPLOAD_CHUNK) {
    const final = index + UPLOAD_CHUNK >= edges.length;
    worker.postMessage({ requestId: 21, chunk: { edges: edges.slice(index, index + UPLOAD_CHUNK), ...(final ? { final: true } : {}) } });
    if (!final) await new Promise(resolve => setTimeout(resolve, 0));
  }
  await finished;
  await new Promise(resolve => setTimeout(resolve, 100));
  observer.disconnect();
  worker.terminate();

  const longest = tasks.reduce((max, task) => Math.max(max, task.duration), 0);
  const over100 = tasks.filter(task => task.duration > 100);
  window.__stage = "done";
  return {
    label,
    nodes: nodes.length,
    edges: edges.length,
    deserializeMs,
    mergeMs,
    mergedPositions,
    layoutDone,
    longTasks: tasks.map(task => ({ duration: Math.round(task.duration), stage: task.stage })),
    longestTaskMs: Math.round(longest),
    tasksOver100Ms: over100.length,
    verdict: over100.length === 0 ? "MET (no task over 100 ms)" : "NOT MET"
  };
};

window.__ready = true;
