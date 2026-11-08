/**
 * Browser-side entry for `memory-graph-gpu-bench.ts`.
 *
 * Runs the shipped WebGL2 renderer against the deterministic synthetic graph and reports
 * measured draw and frame times. Bundled by the Node harness with esbuild, so everything
 * here must be browser-safe: no Node built-ins, no `process`.
 *
 * Two clocks are reported, because they answer different questions:
 *
 * - `drawMs` — `performance.now()` around `draw()` followed by a 1-pixel `readPixels`
 *   on the *same* context. `readPixels` forces the driver to finish the queued commands,
 *   so this is real GPU work, not command submission. It is the only clock that stays
 *   meaningful when the browser clamps `requestAnimationFrame`.
 * - `frameMs` — `requestAnimationFrame` intervals. This is what a user perceives, but
 *   headless Chrome pins the frame scheduler near 30 fps (a page that draws nothing
 *   measures ~33.3 ms), so it is reported as an upper bound, next to that control value.
 *
 * The graph is built and laid out before the context exists: Chrome does not hand a fresh
 * context to a canvas that sat through a multi-second synchronous task.
 */
import { createMemoryGraphWebGL } from "../apps/web/src/features/memory-workspace/memory-3d-webgl.js";
import { buildWebGLGraphInput } from "../apps/web/src/features/memory-workspace/memory-3d-webgl-geometry.js";
import { buildSyntheticMemoryGraph } from "../apps/web/src/features/memory-workspace/memory-3d-synthetic.js";
import { layoutMemoryNetwork3D, DEFAULT_MEMORY_CAMERA } from "../apps/web/src/features/memory-workspace/memory-3d.js";

type Sizes = Record<string, { nodes: number; edges: number }>;

// Matches SYNTHETIC_GRAPH_SIZES: 2k/6k, 10k/30k, 50k/150k.
const SIZES: Sizes = {
  "2k": { nodes: 2_000, edges: 6_000 },
  "10k": { nodes: 10_000, edges: 30_000 },
  "50k": { nodes: 50_000, edges: 150_000 }
};

const WIDTH = 1280;
const HEIGHT = 800;
const DRAWS = 120;
const FRAMES = 120;
const WARMUP = 8;

declare global {
  interface Window {
    __benchReady: boolean;
    __bench: (label: string) => Promise<unknown>;
  }
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0;
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2));
}

function summarise(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    n: sorted.length
  };
}

/** Time draws with the GPU synchronised after each one. */
function measureDraws(
  draw: (camera: { yaw: number; pitch: number; zoom: number }) => boolean,
  sync: () => void
) {
  const camera = { ...DEFAULT_MEMORY_CAMERA };
  const samples: number[] = [];
  for (let index = 0; index < DRAWS; index++) {
    camera.yaw += 0.008;
    const start = performance.now();
    draw(camera);
    sync();
    samples.push(performance.now() - start);
  }
  return samples;
}

/** Time animation frames, unchanged: this is the perceived cadence. */
function measureFrames(draw: (camera: { yaw: number; pitch: number; zoom: number }) => boolean, frames: number) {
  const camera = { ...DEFAULT_MEMORY_CAMERA };
  return new Promise<number[]>(resolve => {
    const times: number[] = [];
    let previous = performance.now();
    let drawn = 0;
    const tick = () => {
      const now = performance.now();
      if (drawn > 0) times.push(now - previous);
      previous = now;
      camera.yaw += 0.008;
      draw(camera);
      drawn++;
      if (drawn >= frames) resolve(times);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

window.__bench = async (label: string) => {
  const size = SIZES[label];
  if (!size) throw new Error(`Unknown size: ${label}`);

  // Prepare before the context exists: build, layout, and pack the vertex data.
  const prepareStart = performance.now();
  const { nodes, edges } = buildSyntheticMemoryGraph(size.nodes, size.edges);
  const colors = new Map(nodes.map(node => [node.id, { color: "#5a7d9a" }]));
  const coordinates = layoutMemoryNetwork3D(nodes, edges, { steps: 6 });
  const input = buildWebGLGraphInput(nodes, edges, coordinates, colors, null);
  const prepareMs = Number((performance.now() - prepareStart).toFixed(1));

  const canvas = document.getElementById("c") as HTMLCanvasElement;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const renderer = createMemoryGraphWebGL(canvas);
  if (!renderer) throw new Error("WebGL2 context unavailable");

  const gl = canvas.getContext("webgl2")!;
  if (gl.isContextLost()) throw new Error("WebGL2 context was lost before the first draw");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  // A single-pixel read is the cheapest reliable way to wait for the GPU to finish.
  const pixel = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

  renderer.resize(WIDTH, HEIGHT, 1);
  renderer.setGraph(input);
  const uploadStart = performance.now();
  for (let index = 0; index < WARMUP; index++) renderer.draw({ ...DEFAULT_MEMORY_CAMERA, yaw: index * 0.05 });
  sync();
  const uploadMs = Number((performance.now() - uploadStart).toFixed(1));

  const drawSamples = measureDraws(camera => renderer.draw(camera), sync);
  const drawCalls = renderer.drawCalls;
  const frames = await measureFrames(camera => renderer.draw(camera), FRAMES);
  renderer.dispose();

  return {
    label,
    nodes: nodes.length,
    edges: edges.length,
    renderer: rendererName,
    drawCalls,
    prepareMs,
    uploadMs,
    drawMs: summarise(drawSamples),
    frameMs: summarise(frames)
  };
};

window.__benchReady = true;
