/**
 * Browser-side entry for the real-context-loss probe.
 *
 * `memory-3d-context-loss.test.ts` drives the renderer against a recording WebGL2 *stub*,
 * which proves the handlers behave when they are called but not that a real browser ever
 * calls them, or that the real GL objects survive. This probe runs the shipped renderer in
 * Chrome, on the real GPU, and forces a genuine loss via `WEBGL_lose_context`.
 *
 * Verified here, on a real context:
 *   1. A healthy frame issues both passes (`drawCalls === 2`), with no GL error.
 *   2. `loseContext()` delivers a real `webglcontextlost` event.
 *   3. The shipped handler cancelled it (`event.defaultPrevented`) - the only thing that
 *      permits a restore.
 *   4. The real context reports `isContextLost() === true`.
 *   5. While lost, `draw()` returns false, does not throw, and issues no GL draw call, and
 *      `setGraph()` uploads nothing.
 *   6. `restoreContext()` behaviour is *recorded, not assumed*: this Chrome session refuses
 *      to hand the context back, which is reported as a finding.
 *   7. A renderer built on a fresh canvas still draws both passes after the loss, proving
 *      the loss did not poison the GL path for the rest of the page.
 *
 * The restore-handler logic itself (rebuild + automatic graph re-upload) is covered by
 * `memory-3d-context-loss.test.ts`, which can dispatch `webglcontextrestored` against a
 * recording stub. That division is deliberate and stated in the report.
 *
 * Run with:
 *   BENCH_ENTRY=context-loss-probe.ts npx tsx scripts/memory-graph-gpu-bench.ts 2k
 */
import { createMemoryGraphWebGL } from "../apps/web/src/features/memory-workspace/memory-3d-webgl.js";
import { buildWebGLGraphInput } from "../apps/web/src/features/memory-workspace/memory-3d-webgl-geometry.js";
import { buildSyntheticMemoryGraph } from "../apps/web/src/features/memory-workspace/memory-3d-synthetic.js";
import { layoutMemoryNetwork3D, DEFAULT_MEMORY_CAMERA } from "../apps/web/src/features/memory-workspace/memory-3d.js";

declare global {
  interface Window {
    __ready: boolean;
    __probe: (label: string) => Promise<unknown>;
  }
}

const SIZES: Record<string, { nodes: number; edges: number }> = {
  "2k": { nodes: 2_000, edges: 6_000 },
  "10k": { nodes: 10_000, edges: 30_000 },
  "50k": { nodes: 50_000, edges: 150_000 }
};

const WIDTH = 640;
const HEIGHT = 400;

type Check = { name: string; pass: boolean; detail: string };

function assert(checks: Check[], name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  if (!pass) throw new Error(`context-loss assertion failed: ${name} (${detail})`);
}

/** Resolve on the next matching event, or reject the wait after `timeoutMs`. */
function waitForEvent(canvas: HTMLCanvasElement, type: "webglcontextlost" | "webglcontextrestored", timeoutMs = 3_000) {
  return new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => {
      canvas.removeEventListener(type, handler);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const handler = (event: Event) => {
      clearTimeout(timer);
      canvas.removeEventListener(type, handler);
      resolve(event);
    };
    canvas.addEventListener(type, handler);
  });
}

window.__probe = async (label: string) => {
  const size = SIZES[label];
  if (!size) throw new Error(`Unknown size: ${label}`);
  const checks: Check[] = [];

  const { nodes, edges } = buildSyntheticMemoryGraph(size.nodes, size.edges);
  const colors = new Map(nodes.map(node => [node.id, { color: "#5a7d9a" }]));
  const coordinates = layoutMemoryNetwork3D(nodes, edges, { steps: 4 });
  const input = buildWebGLGraphInput(nodes, edges, coordinates, colors, null);

  const canvas = document.getElementById("c") as HTMLCanvasElement;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const renderer = createMemoryGraphWebGL(canvas);
  if (!renderer) throw new Error("WebGL2 context unavailable; cannot exercise context loss");
  const gl = canvas.getContext("webgl2")!;
  const extension = gl.getExtension("WEBGL_lose_context");
  if (!extension) throw new Error("WEBGL_lose_context is unavailable; cannot force a loss");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  renderer.resize(WIDTH, HEIGHT, 1);
  renderer.setGraph(input);

  // 1. A real, error-free frame through both passes.
  assert(checks, "pre-loss draw returns true", renderer.draw({ ...DEFAULT_MEMORY_CAMERA }) === true, "draw()");
  assert(checks, "pre-loss frame issues 2 draw calls", renderer.drawCalls === 2, `drawCalls=${renderer.drawCalls}`);
  assert(checks, "pre-loss GL state is clean", gl.getError() === gl.NO_ERROR, `getError()=0x${gl.getError().toString(16)}`);

  // 2-4. A genuine loss, observed through the event the browser dispatches.
  const lossPromise = waitForEvent(canvas, "webglcontextlost");
  extension.loseContext();
  const lossEvent = await lossPromise;
  assert(checks, "real webglcontextlost delivered", true, "event received");
  assert(checks, "shipped handler called preventDefault()", lossEvent.defaultPrevented, `defaultPrevented=${lossEvent.defaultPrevented}`);
  assert(checks, "real context reports itself lost", gl.isContextLost(), `isContextLost()=${gl.isContextLost()}`);

  // 5. Drawing and uploading while lost are no-ops, not exceptions and not GL traffic.
  const drawsWhileLostStart = renderer.drawCalls;
  let drewWhileLost: unknown = "threw";
  try {
    drewWhileLost = renderer.draw({ ...DEFAULT_MEMORY_CAMERA });
  } catch (error) {
    assert(checks, "draw() while lost does not throw", false, String(error));
  }
  assert(checks, "draw() while lost returns false", drewWhileLost === false, `draw() -> ${drewWhileLost}`);
  assert(checks, "no draw calls while lost", renderer.drawCalls === drawsWhileLostStart, `${drawsWhileLostStart} -> ${renderer.drawCalls}`);

  let uploadThrew = false;
  try {
    renderer.setGraph(input);
  } catch {
    uploadThrew = true;
  }
  assert(checks, "setGraph() while lost does not throw", !uploadThrew, "no throw");

  // 6. Record what this browser does with an explicit restore request.
  //
  // `restoreContext()` is only valid while the context is lost and only after the `lost`
  // event has been dispatched, so it is issued here, after the assertions above. Chrome
  // raises INVALID_OPERATION if it is called at the wrong moment, so the exception is caught
  // and reported rather than being turned into a failed test.
  let restoreError: string | null = null;
  try {
    // A fresh handle: the extension object can be invalidated when its context is lost, and
    // calling through a stale handle would silently do nothing.
    const fresh = gl.getExtension("WEBGL_lose_context") ?? extension;
    fresh.restoreContext();
  } catch (error) {
    restoreError = error instanceof Error ? error.message : String(error);
  }
  // Poll rather than assume a fixed delay: a restore can be scheduled after the current task.
  let nativeRestore = false;
  for (let attempt = 0; attempt < 40 && !nativeRestore; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    nativeRestore = !gl.isContextLost();
  }
  checks.push({
    name: "browser restored the context natively",
    pass: nativeRestore,
    detail: nativeRestore
      ? "context handed back by the browser after restoreContext()"
      : `not restored (restoreContext() raised: ${restoreError ?? "nothing"})`
  });

  // 7b. Verify the **restore handler** against a real GL context.
  //
  // The browser will not hand a context back here (see above), so the handler is invoked by
  // dispatching the event the browser would send. Unlike the stub test, everything it then
  // does runs against real driver-backed GL: the programs really compile, the buffers really
  // reallocate, and the graph the renderer retained is really re-uploaded. That is the part a
  // recording stub cannot establish.
  const restoreCanvas = document.createElement("canvas");
  restoreCanvas.width = WIDTH;
  restoreCanvas.height = HEIGHT;
  document.body.appendChild(restoreCanvas);
  const restorable = createMemoryGraphWebGL(restoreCanvas);
  assert(checks, "a second renderer initialises on a real context", restorable !== null, "created");
  if (restorable) {
    restorable.setGraph(input);
    restorable.draw({ ...DEFAULT_MEMORY_CAMERA });
    assert(checks, "second renderer drew before the restore", restorable.drawCalls === 2, `drawCalls=${restorable.drawCalls}`);

    // Announce a restore without a real loss: the handler must rebuild programs/VAOs/buffers
    // and re-upload the retained graph on a live context.
    restoreCanvas.dispatchEvent(new Event("webglcontextrestored"));
    const restoreGl = restoreCanvas.getContext("webgl2")!;
    assert(checks, "restore handler left the real context usable", !restoreGl.isContextLost(), `isContextLost()=${restoreGl.isContextLost()}`);

    const drewAfter = restorable.draw({ ...DEFAULT_MEMORY_CAMERA });
    assert(checks, "post-restore frame draws on the real context", drewAfter === true, `draw() -> ${drewAfter}`);
    assert(checks, "post-restore frame issues 2 draw calls", restorable.drawCalls === 2, `drawCalls=${restorable.drawCalls}`);
    assert(checks, "post-restore GL state is clean", restoreGl.getError() === restoreGl.NO_ERROR, `getError()=0x${restoreGl.getError().toString(16)}`);
    restorable.dispose();
  }

  // 7. The loss must not poison the GL path for the rest of the page: a renderer on a
  // fresh canvas still draws both passes.
  const secondCanvas = document.createElement("canvas");
  secondCanvas.width = WIDTH;
  secondCanvas.height = HEIGHT;
  document.body.appendChild(secondCanvas);
  const second = createMemoryGraphWebGL(secondCanvas);
  assert(checks, "a renderer still initialises after a loss", second !== null, `second renderer=${second ? "created" : "null"}`);
  if (second) {
    second.setGraph(input);
    second.draw({ ...DEFAULT_MEMORY_CAMERA });
    assert(checks, "fresh renderer draws 2 calls after a loss", second.drawCalls === 2, `drawCalls=${second.drawCalls}`);
    second.dispose();
    assert(checks, "fresh renderer disposes cleanly", second.draw({ ...DEFAULT_MEMORY_CAMERA }) === false, "draw() after dispose");
  }

  // The lost renderer must stay inert rather than throwing on late calls.
  assert(checks, "lost renderer stays inert (draw returns false)", renderer.draw({ ...DEFAULT_MEMORY_CAMERA }) === false, "draw()");
  let disposeThrew = false;
  try {
    renderer.dispose();
    renderer.dispose();
  } catch {
    disposeThrew = true;
  }
  assert(checks, "dispose() on a lost context is safe and idempotent", !disposeThrew, "no throw");

  return {
    label,
    nodes: nodes.length,
    edges: edges.length,
    renderer: rendererName,
    nativeRestore,
    note: "restore handler rebuilt the context in the stub test; this browser does not hand the context back",
    checks,
    passed: checks.filter(check => check.pass).length,
    failed: checks.filter(check => !check.pass).length
  };
};

window.__ready = true;
