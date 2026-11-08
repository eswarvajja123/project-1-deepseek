/**
 * Measures the **main-thread** cost of preparing a large graph, in a browser (BENCH_ENTRY).
 *
 * Issue #62 requires that no main-thread task exceeds 100 ms while a graph loads.
 *
 *   - `main-thread`: the original path - JSON.parse + createMemoryAtlas + layout, inline.
 *   - `worker`: the shipped path - parse, atlas, and layout all run in
 *     `memory-network-layout.worker.ts`, the graph uploads in 4,000-object slices, and the
 *     results are merged back against a wall-clock budget.
 *
 * Long tasks come from a `PerformanceObserver("longtask")`, which is the browser's own
 * accounting of uninterrupted main-thread blocks. This is the comparison that motivates the
 * worker; `app-path-probe.ts` is the one that measures the shipped path end to end.
 */
declare global {
  interface Window {
    __probe: (label: string) => Promise<unknown>;
    __ready: boolean;
    __probeErrors?: string[];
    /** Object URL for the separately bundled layout worker, set by the harness page. */
    __layoutWorkerUrl: string;
  }
}

type LongTask = { name: string; duration: number };

function watchLongTasks() {
  const tasks: LongTask[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) tasks.push({ name: entry.name, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    // longtask is Chromium-only; absent observers leave `tasks` empty and are reported as such.
    observer = null;
  }
  return { tasks, supported: Boolean(observer), stop: () => observer?.disconnect() };
}

window.__stage = "pre-probe";
window.__probe = async (label: string) => {
  try {
  const modules = await Promise.all([
    import("../apps/web/src/features/memory-workspace/memory-3d-synthetic.js"),
    import("../apps/web/src/features/memory-workspace/memory-atlas.js"),
    
    import("../apps/web/src/features/memory-workspace/memory-3d.js")
  ]);
  const [{ buildSyntheticMemoryGraph }, { createMemoryAtlas, deserializeAtlasSteps }, { layoutMemoryNetwork3D }] = modules;

  const size = Number(label.replace("k", "")) * 1_000;
  const { nodes, edges } = buildSyntheticMemoryGraph(size, size * 3);
  // Approximates the API response body the workspace receives and then re-serialises.
  const payload = JSON.stringify({ nodes, edges });
  const payloadMB = +(new Blob([payload]).size / 1024 ** 2).toFixed(1);

  const result: Record<string, unknown> = { label, nodes: nodes.length, edges: edges.length, payloadMB };

  // --- Old path: everything on the main thread -----------------------------------------
  {
    const watch = watchLongTasks();
    await new Promise(resolve => setTimeout(resolve, 0));
    const start = performance.now();
    const parsed = JSON.parse(payload) as { nodes: typeof nodes; edges: typeof edges };
    const parseMs = performance.now() - start;
    const atlasStart = performance.now();
    const atlas = createMemoryAtlas(parsed.nodes, parsed.edges, false);
    const atlasMs = performance.now() - atlasStart;
    const layoutStart = performance.now();
    layoutMemoryNetwork3D(atlas.nodes, atlas.edges, { steps: 6 });
    const layoutMs = performance.now() - layoutStart;
    await new Promise(resolve => setTimeout(resolve, 50));
    watch.stop();
    const longest = watch.tasks.reduce((max, task) => Math.max(max, task.duration), 0);
    result["main-thread"] = {
      supported: watch.supported,
      parseMs: +parseMs.toFixed(1),
      atlasMs: +atlasMs.toFixed(1),
      layoutMs: +layoutMs.toFixed(1),
      totalMs: +(parseMs + atlasMs + layoutMs).toFixed(1),
      longTasks: watch.tasks.length,
      longestTaskMs: +longest.toFixed(1)
    };
  }

  // --- Current path: raw payload to the worker ----------------------------------------
  {
    const watch = watchLongTasks();
    await new Promise(resolve => setTimeout(resolve, 0));
    // The worker is bundled separately by the harness and exposed as `__layoutWorkerUrl`,
    // because esbuild cannot resolve `new URL(..., import.meta.url)` from a bundler-supplied
    // path without also emitting a chunk the harness would have to serve.
    const worker = new Worker(window.__layoutWorkerUrl, { type: "module" });
    const start = performance.now();
    // Mirror the workspace exactly: rebuild the atlas Maps from the wire form in bounded
    // steps as soon as it arrives, then wait for the layout to finish.
    let deserializeMs = 0;
    const done = new Promise<void>((resolve, reject) => {
      const finish = () => resolve();
      worker.onmessage = event => {
        const message = event.data;
        if (message?.type === "atlas") {
          const started = performance.now();
          void (async () => {
            // Mirror `drainDeserialize` exactly: a wall-clock budget per task, not one step
            // per task. Yielding per small step costs a clamped `setTimeout` each time and
            // changed the result by 100 ms in either direction.
            const iterator = deserializeAtlasSteps(message.atlas, nodes, edges, 1_000, 8);
            for (;;) {
              const next = iterator.next();
              if (next.done) break;
              await new Promise(r => setTimeout(r, 0));
            }
            deserializeMs = performance.now() - started;
          })();
          return;
        }
        if (message?.type === "done") finish();
      };
      worker.onerror = error => reject(new Error(error.message || "worker failed"));
    });
    // Measure the shipped strategy. See `scripts/upload-compare.ts` for the head-to-head
    // that chose it: slices of 4,000 objects with a yield between them produce no long task
    // at 50k, while one clone of the whole graph is a single 243 ms task.
    const uploadStart = performance.now();
    const CHUNK = 4_000;
    let worstSlice = 0;
    for (let index = 0; index < nodes.length; index += CHUNK) {
      const sliceStart = performance.now();
      worker.postMessage({ requestId: 2, chunk: { nodes: nodes.slice(index, index + CHUNK) } });
      worstSlice = Math.max(worstSlice, performance.now() - sliceStart);
      await new Promise(r => setTimeout(r, 0));
    }
    for (let index = 0; index < edges.length; index += CHUNK) {
      const final = index + CHUNK >= edges.length;
      const sliceStart = performance.now();
      worker.postMessage({ requestId: 2, chunk: { edges: edges.slice(index, index + CHUNK), ...(final ? { final: true } : {}) } });
      worstSlice = Math.max(worstSlice, performance.now() - sliceStart);
      if (!final) await new Promise(r => setTimeout(r, 0));
    }
    const transferMs = performance.now() - uploadStart;
    const worstSliceMs = worstSlice;
    await done;
    const wallMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 50));
    watch.stop();
    worker.terminate();
    const longest = watch.tasks.reduce((max, task) => Math.max(max, task.duration), 0);
    result.worker = {
      supported: watch.supported,
      transferMs: +transferMs.toFixed(1),
      worstSliceMs: +worstSliceMs.toFixed(1),
      deserializeMs: +deserializeMs.toFixed(1),
      totalMs: +wallMs.toFixed(1),
      longTasks: watch.tasks.length,
      longestTaskMs: +longest.toFixed(1)
    };
  }

  return result;
  } catch (error) {
    return { label, failed: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
  }
};

window.__stage = "pre-onerror";
window.onerror = (message, _source, line) => {
  (window.__probeErrors ??= []).push(`${String(message)} @${line}`);
};

window.__ready = true;
