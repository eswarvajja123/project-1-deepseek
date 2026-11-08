import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { createMemoryGraphWebGL } from "./memory-3d-webgl.js";
import { buildWebGLGraphInput } from "./memory-3d-webgl-geometry.js";
import { createPickIndex } from "./memory-3d-picking.js";
import { selectMemoryLabels } from "./memory-3d-labels.js";

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, layoutProgress, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
  /** Layout chunk progress reported by the worker, shown while the graph is prepared. */
  layoutProgress?: { phase: "flat" | "depth"; step: number; steps: number } | null;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // WebGL2 is the fast path. If it is unavailable the existing Canvas 2D renderer
    // below stays the reference implementation, including its 2k-friendly behavior.
    const gl = createMemoryGraphWebGL(canvas) ?? null;
    const context = gl ? null : canvas.getContext("2d");
    if (!gl && !context) return;
    const pickIndex = createPickIndex(48);
    const measureContext = document.createElement("canvas").getContext("2d");
    let frame = 0, width = 1, height = 1;
    let hover: string | null = null;
    let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    // --- WebGL path ---------------------------------------------------------
    const uploadGraph = () => {
      if (!gl) return;
      const { nodes, edges, positions, coordinates } = current.current;
      const focus = hover ?? current.current.selectedNodeId;
      const input = buildWebGLGraphInput(nodes, edges, coordinates, positions as Map<string, { color?: string }>, focus);
      gl.setGraph(input);
      // Keep a screen-space projection for picking, rebuilt only with the geometry.
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;
      points = [];
      for (const node of nodes) {
        const point = coordinates.get(node.id);
        if (!point) continue;
        const projected = projectMemoryPoint(point, cameraRef.current, scale, width, height);
        points.push({ id: node.id, x: projected.x, y: projected.y, z: projected.z, radius: 2 });
      }
      points.sort((a, b) => a.z - b.z);
      pickIndex.rebuild(points);
    };

    const renderWebGL = () => {
      frame = 0;
      if (!gl) return;
      if (!gl.draw(cameraRef.current)) {
        // Context lost: fall back to drawing a static frame on the 2D path if possible.
        canvas.dataset.renderer = "webgl2-lost";
        return;
      }
      if (Math.abs(cameraRef.current.yaw - lastYaw) > 1e-6 || Math.abs(cameraRef.current.pitch - lastPitch) > 1e-6) {
        lastYaw = cameraRef.current.yaw;
        lastPitch = cameraRef.current.pitch;
        uploadGraph();
      }
      canvas.dataset.renderer = "webgl2";
      canvas.dataset.drawCalls = String(gl.drawCalls);
    };
    let lastYaw = cameraRef.current.yaw;
    let lastPitch = cameraRef.current.pitch;

    // --- Canvas 2D fallback -------------------------------------------------
    const renderCanvas = () => {
      frame = 0;
      if (!context) return;
      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      context.clearRect(0, 0, width, height);
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = Math.min(width, height) * 0.4 / extent;
      const projected = new Map(nodes.flatMap(node => {
        const p = coordinates.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
      }));
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) for (const edge of edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      context.lineWidth = 0.55;
      for (const edge of edges) {
        const a = projected.get(edge.source), b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        context.lineWidth = incident ? 1.15 : 0.55;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      points = [];
      const ordered = nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        points.push({ id: node.id, ...p, radius });
        context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
      pickIndex.rebuild(points);
      if (showTitles && measureContext) {
        // Label work is capped per frame instead of measured for every node.
        const candidates = ordered
          .filter(node => projected.has(node.id))
          .map(node => {
            const p = projected.get(node.id)!;
            return { id: node.id, label: node.label, type: node.type, x: p.x, y: p.y };
          });
        measureContext.font = "11px system-ui, sans-serif";
        const labels = selectMemoryLabels({
          candidates,
          focusId: focus,
          showTitles,
          zoom: cameraRef.current.zoom,
          width,
          height,
          measure: text => measureContext.measureText(text).width
        });
        for (const label of labels) {
          context.fillStyle = "#09111bea"; context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          context.fillStyle = isMemoryCoreLabel(label.text) ? "#fff0b0" : "#c6dfed";
          context.fillText(label.text, label.x, label.y + 1);
        }
        canvas.dataset.labelsDrawn = String(labels.length);
      }
      canvas.dataset.renderer = "canvas2d";
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const render = gl ? renderWebGL : renderCanvas;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (gl) {
        gl.resize(width, height, dpr);
        uploadGraph();
      } else if (context) {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };

    // Picking is a grid lookup now, so a pointer move no longer scans every node.
    const hit = (x: number, y: number) => pickIndex.pick(x, y);
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else {
          cameraRef.current.yaw += (p.x - previous.x) * 0.009;
          cameraRef.current.pitch += (p.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, p);
      } else {
        hover = hit(p.x, p.y);
        canvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {};
      gl?.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-layout-phase={layoutProgress?.phase} data-layout-step={layoutProgress?.step} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><span className="memory-3d-hint" role={layoutProgress ? "status" : undefined}>{layoutProgress ? `Preparing layout · ${layoutProgress.phase} ${layoutProgress.step}/${layoutProgress.steps}` : "Drag to rotate 360° · Scroll or pinch to zoom · Click to explore"}</span></div>;
}
