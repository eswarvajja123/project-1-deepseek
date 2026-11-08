/**
 * WebGL2 context-loss and fallback tests.
 *
 * The plan listed context-loss recovery as "written but never exercised". These tests
 * drive the real `createMemoryGraphWebGL` code path against a minimal recording stub of
 * `WebGL2RenderingContext` and a synthetic canvas, so the lost/restored handlers, the
 * resource rebuild, and the fallback decision are actually executed.
 *
 * What this does **not** establish: that a real browser preserves the same guarantees.
 * A real context loss may also invalidate the `WebGLRenderingContext` object itself
 * and the browser controls when `webglcontextrestored` fires. The stub proves the
 * handlers do the right thing when called, not that the browser calls them.
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryGraphWebGL } from "../src/features/memory-workspace/memory-3d-webgl.js";
import { buildWebGLGraphInput } from "../src/features/memory-workspace/memory-3d-webgl-geometry.js";
import { buildSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-3d-synthetic.js";
import { layoutMemoryNetwork3D, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";

type Call = { name: string; args: unknown[] };

/** Minimal WebGL2 stand-in: records calls, hands out opaque handles. */
function createStubGl() {
  const calls: Call[] = [];
  let handle = 1;
  let lost = false;
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
    return handle++;
  };
  const constants: Record<string, number> = {
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLE_STRIP: 0x0005,
    LINES: 0x0001, DEPTH_TEST: 0x0b71, BLEND: 0x0be2, SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303, CULL_FACE: 0x0b44, COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82
  };
  const gl = {
    ...constants,
    // Real WebGL2 exposes this; the renderer consults it so a lost context is reported as
    // loss rather than as a shader failure. Marking the stub lost mirrors the real state.
    isContextLost: () => lost,
    markLost: () => { lost = true; },
    createShader: record("createShader"),
    shaderSource: record("shaderSource"),
    compileShader: record("compileShader"),
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: record("deleteShader"),
    createProgram: record("createProgram"),
    attachShader: record("attachShader"),
    linkProgram: record("linkProgram"),
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: record("deleteProgram"),
    createVertexArray: record("createVertexArray"),
    deleteVertexArray: record("deleteVertexArray"),
    bindVertexArray: record("bindVertexArray"),
    createBuffer: record("createBuffer"),
    deleteBuffer: record("deleteBuffer"),
    bindBuffer: record("bindBuffer"),
    bufferData: record("bufferData"),
    enableVertexAttribArray: record("enableVertexAttribArray"),
    vertexAttribPointer: record("vertexAttribPointer"),
    useProgram: record("useProgram"),
    getUniformLocation: record("getUniformLocation"),
    uniformMatrix4fv: record("uniformMatrix4fv"),
    uniform1f: record("uniform1f"),
    uniform2f: record("uniform2f"),
    viewport: record("viewport"),
    clearColor: record("clearColor"),
    clear: record("clear"),
    enable: record("enable"),
    disable: record("disable"),
    blendFunc: record("blendFunc"),
    drawArrays: record("drawArrays"),
    drawArraysInstanced: record("drawArraysInstanced"),
    getExtension: () => null
  };
  return { gl, calls };
}

/** Canvas stand-in that implements the small surface the renderer touches. */
function createStubCanvas(glResult: unknown) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  return {
    width: 0,
    height: 0,
    clientHeight: 800,
    style: {} as CSSStyleDeclaration,
    getContext: () => glResult,
    addEventListener: (type: string, handler: (event: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: (event: Event) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(existing => existing !== handler));
    },
    dispatch: (type: string, event: Event) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    listenerCount: (type: string) => (listeners.get(type) ?? []).length
  } as unknown as HTMLCanvasElement & {
    dispatch: (type: string, event: Event) => void;
    listenerCount: (type: string) => number;
  };
}

function fakeEvent() {
  return { preventDefault: vi.fn(), defaultPrevented: false } as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> };
}

async function graphInput(count = 200) {
  const { nodes, edges } = buildSyntheticMemoryGraph(count, count * 2);
  const layout = layoutMemoryNetwork3D(nodes, edges, { steps: 4 });
  const positions = new Map(nodes.map(node => [node.id, { color: "#5a7d9a" }]));
  return buildWebGLGraphInput(nodes, edges, layout, positions, null);
}

function counts(calls: Call[], name: string) {
  return calls.filter(call => call.name === name).length;
}

describe("WebGL2 renderer", () => {
  it("returns null when webgl2 is unavailable so the caller can fall back to Canvas", () => {
    const canvas = createStubCanvas(null);
    expect(createMemoryGraphWebGL(canvas)).toBeNull();
  });

  it("sets up programs, buffers and VAOs, then draws edges before nodes", async () => {
    const { gl, calls } = createStubGl();
    const canvas = createStubCanvas(gl);
    const renderer = createMemoryGraphWebGL(canvas)!;
    expect(renderer).not.toBeNull();
    renderer.resize(1280, 800, 2);
    renderer.setGraph(await graphInput());
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(true);
    expect(renderer.drawCalls).toBe(2);
    const names = calls.map(call => call.name);
    expect(names.indexOf("drawArrays")).toBeLessThan(names.indexOf("drawArraysInstanced"));
    // One instanced call for every node: no per-node draw loop.
    const instanced = calls.find(call => call.name === "drawArraysInstanced")!;
    expect(instanced.args[3]).toBe(200);
  });

  it("stops drawing while the context is lost and restores resources afterwards", async () => {
    const { gl, calls } = createStubGl();
    const canvas = createStubCanvas(gl);
    const renderer = createMemoryGraphWebGL(canvas)!;
    renderer.setGraph(await graphInput());
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(true);

    const programsBefore = counts(calls, "createProgram");
    const buffersBefore = counts(calls, "createBuffer");
    const lost = fakeEvent();
    canvas.dispatch("webglcontextlost", lost);
    // A lost context must not be drawn into, and the default must be prevented so the
    // browser knows to attempt a restore.
    expect(lost.preventDefault).toHaveBeenCalled();
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(false);
    // Buffer writes are also suppressed: uploading to a lost context is invalid.
    renderer.setGraph(await graphInput(50));

    canvas.dispatch("webglcontextrestored", fakeEvent());
    // Every GPU resource is rebuilt from scratch after a restore.
    expect(counts(calls, "createProgram")).toBeGreaterThan(programsBefore);
    expect(counts(calls, "createBuffer")).toBeGreaterThan(buffersBefore);
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(true);
  });

  it("re-uploads the graph it already holds after a restore, without the caller resending it", async () => {
    // A restore recreates empty buffers. The caller guards against resending an unchanged
    // graph, so if the renderer does not re-upload its own last graph, every frame after a
    // restore draws zero instances - a "successful" restore that silently lost the data.
    const { gl, calls } = createStubGl();
    const canvas = createStubCanvas(gl);
    const renderer = createMemoryGraphWebGL(canvas)!;
    renderer.setGraph(await graphInput());
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(true);

    const uploadsBefore = counts(calls, "bufferData");
    canvas.dispatch("webglcontextlost", fakeEvent());
    canvas.dispatch("webglcontextrestored", fakeEvent());

    // Five buffers are re-filled (3 node + 2 edge attributes) with no `setGraph` call.
    expect(counts(calls, "bufferData") - uploadsBefore).toBe(5);
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(true);
    const instanced = [...calls].reverse().find(call => call.name === "drawArraysInstanced")!;
    expect(instanced.args[3]).toBe(200);
  });

  it("does not delete the previous context's handles while restoring", async () => {
    // After a real loss the old GL names are dead. Calling deleteBuffer/deleteProgram on them
    // only produces INVALID_OPERATION noise against the new context.
    const { gl, calls } = createStubGl();
    const canvas = createStubCanvas(gl);
    const renderer = createMemoryGraphWebGL(canvas)!;
    renderer.setGraph(await graphInput());
    canvas.dispatch("webglcontextlost", fakeEvent());

    // The handles must already be released by the loss handler, so the restore deletes none.
    const deletesBefore = counts(calls, "deleteBuffer") + counts(calls, "deleteProgram") + counts(calls, "deleteVertexArray");
    canvas.dispatch("webglcontextrestored", fakeEvent());
    const deletesAfter = counts(calls, "deleteBuffer") + counts(calls, "deleteProgram") + counts(calls, "deleteVertexArray");
    expect(deletesAfter).toBe(deletesBefore);
  });

  it("removes its listeners and deletes GPU resources on dispose", async () => {
    const { gl, calls } = createStubGl();
    const canvas = createStubCanvas(gl);
    const renderer = createMemoryGraphWebGL(canvas)!;
    renderer.setGraph(await graphInput());
    expect(canvas.listenerCount("webglcontextlost")).toBe(1);
    renderer.dispose();
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);
    expect(counts(calls, "deleteBuffer")).toBeGreaterThan(0);
    expect(counts(calls, "deleteProgram")).toBeGreaterThan(0);
    expect(counts(calls, "deleteVertexArray")).toBeGreaterThan(0);
    // A disposed renderer must be inert rather than throwing on late calls.
    expect(renderer.draw({ ...DEFAULT_MEMORY_CAMERA })).toBe(false);
    renderer.dispose();
  });
});
