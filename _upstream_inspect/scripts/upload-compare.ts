/**
 * Diagnostic entry for `memory-graph-gpu-bench.ts` (BENCH_ENTRY=upload-compare.ts).
 *
 * Decides the upload strategy with one measurement instead of two assumptions. Three
 * candidates, each measured with the browser's own `PerformanceObserver("longtask")` while
 * talking to the real layout worker:
 *
 *   A. one structured clone of the whole graph (the original code)
 *   B. slices of 4,000 objects with a yield between them (the intermediate code)
 *   C. columnar encode + buffer transfer (candidate)
 *
 * The result decides which strategy ships: whichever keeps the longest single main-thread
 * task smallest. `encodeMs` is reported separately because it is main-thread work too.
 */
declare global {
  interface Window {
    __probe: (label: string) => Promise<unknown>;
    __ready: boolean;
    __stage: string;
  }
}

type LongTask = { duration: number };

function watchLongTasks() {
  const tasks: LongTask[] = [];
  let supported = true;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) tasks.push({ duration: entry.duration });
  });
  try {
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    supported = false;
  }
  return {
    stop() { if (supported) observer.disconnect(); },
    get supported() { return supported; },
    get tasks() { return tasks; }
  };
}

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

window.__probe = async (label: string) => {
  const size = Number(label.replace("k", "")) * 1_000;
  const [{ buildSyntheticMemoryGraph }, { encodeGraphColumns, graphColumnBuffers }] = await Promise.all([
    import("../apps/web/src/features/memory-workspace/memory-3d-synthetic.js"),
    import("../apps/web/src/features/memory-workspace/memory-graph-columns.js")
  ]);
  const { nodes, edges } = buildSyntheticMemoryGraph(size, size * 3);

  const out: Record<string, unknown> = { label, nodes: nodes.length, edges: edges.length };
  const longestOf = (watch: ReturnType<typeof watchLongTasks>) =>
    watch.tasks.reduce((max, task) => Math.max(max, task.duration), 0);

  const measure = async (name: string, run: (worker: Worker) => Promise<void>) => {
    const worker = new Worker(window.__layoutWorkerUrl!, { type: "module" });
    // Wait for the worker to install its handler so the timer measures the send, not startup.
    await new Promise(resolve => setTimeout(resolve, 120));
    const watch = watchLongTasks();
    await yieldTask();
    const start = performance.now();
    await run(worker);
    const elapsed = performance.now() - start;
    await yieldTask();
    watch.stop();
    const longest = longestOf(watch);
    worker.terminate();
    out[name] = {
      elapsedMs: +elapsed.toFixed(1),
      longTasks: watch.tasks.length,
      longestTaskMs: +longest.toFixed(1),
      supported: watch.supported
    };
  };

  // A: one clone of everything.
  await measure("singleClone", async worker => {
    worker.postMessage({ requestId: 1, nodes, edges });
    await yieldTask();
  });

  // B: 4k slices of objects.
  await measure("slicedClone", async worker => {
    const CHUNK = 4_000;
    for (let index = 0; index < nodes.length; index += CHUNK) {
      worker.postMessage({ requestId: 2, chunk: { nodes: nodes.slice(index, index + CHUNK) } });
      await yieldTask();
    }
    for (let index = 0; index < edges.length; index += CHUNK) {
      const final = index + CHUNK >= edges.length;
      worker.postMessage({ requestId: 2, chunk: { edges: edges.slice(index, index + CHUNK), ...(final ? { final: true } : {}) } });
      if (!final) await yieldTask();
    }
  });

  // C: columnar encode then transfer.
  await measure("columnar", async worker => {
    const columns = encodeGraphColumns(nodes, edges);
    worker.postMessage({ requestId: 3, columns }, graphColumnBuffers(columns));
    await yieldTask();
  });

  // Encoding cost on its own, since it is main-thread work regardless of transport.
  const encodeSamples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = performance.now();
    encodeGraphColumns(nodes, edges);
    encodeSamples.push(+(performance.now() - start).toFixed(1));
  }
  out.encodeMs = encodeSamples;

  window.__stage = "done";
  return out;
};

window.__ready = true;
