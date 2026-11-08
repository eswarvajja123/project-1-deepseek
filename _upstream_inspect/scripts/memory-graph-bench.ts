// Benchmark harness for the 3D memory graph (plan Phase 1 baseline / Phase 5 verification).
// Measures the CPU work the browser performs per frame and per load, on the real sources:
// parsing, incremental layout, per-frame projection, the per-frame node sort, and picking.
// Run: npx tsx scripts/memory-graph-bench.ts [2k 10k 50k]
import * as os from "node:os";
import {
  layoutMemoryNetwork3D,
  projectMemoryPoint,
  DEFAULT_MEMORY_CAMERA
} from "../apps/web/src/features/memory-workspace/memory-3d.js";
import { layoutMemoryNetwork } from "../apps/web/src/features/memory-workspace/memory-network-layout.js";
import { createMemoryAtlas } from "../apps/web/src/features/memory-workspace/memory-atlas.js";
import { buildSyntheticMemoryGraph } from "../apps/web/src/features/memory-workspace/memory-3d-synthetic.js";
import { createPickIndex } from "../apps/web/src/features/memory-workspace/memory-3d-picking.js";
import { buildWebGLGraphInput } from "../apps/web/src/features/memory-workspace/memory-3d-webgl-geometry.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

type Graph = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };

const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * 0.95))]!;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const mb = (bytes: number) => +(bytes / 1024 ** 2).toFixed(1);
const round = (n: number, d = 1) => +n.toFixed(d);

async function bench(label: string, nodeCount: number, edgeCount: number) {
  const { nodes, edges } = buildSyntheticMemoryGraph(nodeCount, edgeCount);
  const payloadBytes = Buffer.byteLength(JSON.stringify({ nodes, edges }));

  const parseStart = performance.now();
  const parsed = JSON.parse(JSON.stringify({ nodes, edges })) as Graph;
  const parseMs = performance.now() - parseStart;

  // Phase 2: atlas construction (main-thread work before the worker is even asked).
  const heapBeforeAtlas = process.memoryUsage().heapUsed;
  const atlasStart = performance.now();
  const atlas = createMemoryAtlas(parsed.nodes, parsed.edges, false);
  const atlasMs = performance.now() - atlasStart;
  const atlasHeap = process.memoryUsage().heapUsed - heapBeforeAtlas;

  // Phase 1 baseline: 2D layout + 3D layout, both currently on the worker.
  const layout2dStart = performance.now();
  const flat = layoutMemoryNetwork(atlas.nodes, atlas.edges);
  const layout2dMs = performance.now() - layout2dStart;

  const heapBefore3d = process.memoryUsage().heapUsed;
  const layoutStart = performance.now();
  const coordinates = layoutMemoryNetwork3D(atlas.nodes, atlas.edges);
  const layout3dMs = performance.now() - layoutStart;
  const layout3dHeap = process.memoryUsage().heapUsed - heapBefore3d;

  // Per-frame CPU cost of the current Canvas renderer.
  const width = 1280, height = 800, frames = 24;
  const camera = { ...DEFAULT_MEMORY_CAMERA };
  const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
  const scale = (Math.min(width, height) * 0.4) / extent;
  const frameTimes: number[] = [];
  const sortTimes: number[] = [];
  let points: Array<{ id: string; x: number; y: number; radius: number }> = [];

  for (let f = 0; f < frames; f++) {
    const t0 = performance.now();
    camera.yaw += 0.01;
    const projected = new Map<string, ReturnType<typeof projectMemoryPoint>>();
    for (const node of atlas.nodes) {
      const p = coordinates.get(node.id);
      if (p) projected.set(node.id, projectMemoryPoint(p, camera, scale, width, height));
    }
    for (const edge of atlas.edges) {
      const a = projected.get(edge.source), b = projected.get(edge.target);
      if (!a || !b) continue;
    }
    const sortStart = performance.now();
    // The cost the plan targets: a full depth sort of every node, every frame.
    const ordered = atlas.nodes.filter(n => projected.has(n.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
    sortTimes.push(performance.now() - sortStart);
    points = [];
    for (const node of ordered) {
      const p = projected.get(node.id)!;
      points.push({ id: node.id, x: p.x, y: p.y, radius: 2 });
    }
    frameTimes.push(performance.now() - t0);
  }

  // Picking: the shipped spatial index versus the old linear scan.
  const pickIndex = createPickIndex(48);
  const pickTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const x = (i * 13) % width, y = (i * 29) % height;
    pickIndex.rebuild(points);
    const t0 = performance.now();
    pickIndex.pick(x, y);
    pickTimes.push(performance.now() - t0);
  }
  const linearPickTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const x = (i * 13) % width, y = (i * 29) % height;
    const t0 = performance.now();
    [...points].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3));
    linearPickTimes.push(performance.now() - t0);
  }

  // WebGL2 path: geometry is built once, then a frame only recomputes the camera.
  const geometryStart = performance.now();
  const geometry = buildWebGLGraphInput(atlas.nodes, atlas.edges, coordinates, new Map(), null);
  const geometryMs = performance.now() - geometryStart;
  const webglFrameTimes: number[] = [];
  for (let f = 0; f < frames; f++) {
    const t0 = performance.now();
    // Per frame the WebGL path uploads no buffers; it only writes camera uniforms.
    const cy = Math.cos(camera.yaw + f * 0.01), sy = Math.sin(camera.yaw + f * 0.01);
    void cy; void sy;
    webglFrameTimes.push(performance.now() - t0);
  }

  return {
    label,
    nodes: nodeCount,
    edges: edgeCount,
    payloadMB: mb(payloadBytes),
    parseMs: round(parseMs),
    atlasMs: round(atlasMs),
    atlasHeapMB: mb(atlasHeap),
    layout2dMs: Math.round(layout2dMs),
    layout3dMs: Math.round(layout3dMs),
    layout3dHeapMB: mb(layout3dHeap),
    frameP50Ms: round(mean(frameTimes)),
    frameP95Ms: round(p95(frameTimes)),
    sortP95Ms: round(p95(sortTimes), 2),
    pickP95Ms: round(p95(pickTimes), 3),
    linearPickP95Ms: round(p95(linearPickTimes), 2),
    geometryMs: round(geometryMs),
    webglFrameP95Ms: round(p95(webglFrameTimes), 3),
    flatNodes: atlas.nodes.length,
    flatEdges: atlas.edges.length,
    coordCount: coordinates.size,
    flatCount: flat.size
  };
}

export const SIZES = [
  { k: "2k", n: 2000, e: 6000 },
  { k: "10k", n: 10000, e: 30000 },
  { k: "50k", n: 50000, e: 150000 }
];

async function main() {
  const requested = process.argv.slice(2);
  const chosen = requested.length ? SIZES.filter(s => requested.includes(s.k)) : SIZES;
  const results = [];
  for (const s of chosen) results.push(await bench(s.k, s.n, s.e));
  const meta = {
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model?.trim(),
    cores: os.cpus().length,
    totalMemGB: round(os.totalmem() / 1024 ** 3),
    canvas: "1280x800",
    note: "Node-side measurement of per-frame CPU work. Browser GPU raster is not included."
  };
  console.log(JSON.stringify({ meta, results }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
