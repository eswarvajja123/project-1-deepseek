/**
 * WebGL2 renderer for the 3D memory graph.
 *
 * The Canvas 2D path reprojects, sorts, and redraws every node on the CPU each frame,
 * which is why frame time grew with graph size. This path uploads node and edge
 * geometry once per layout change and then draws it with two instanced calls:
 *
 *   - nodes: one instanced quad per node, sized and shaded in the vertex shader
 *   - edges: one batched line strip over a flat position buffer
 *
 * The camera lives entirely in a uniform, so rotating and zooming upload no data and
 * never touch the CPU sort. Depth ordering is left to the GPU depth test.
 *
 * This module owns GPU resources and nothing else: no React, no DOM event wiring. The
 * caller supplies a canvas and a draw request, and calls `dispose()` when done.
 */

export type WebGLLayoutPoint = { x: number; y: number; z: number };

export type WebGLGraphInput = {
  /** Node order defines instance index; must match `colors` and `sizes`. */
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  /** Two endpoints per edge, packed as consecutive xyz triples. */
  edges: Float32Array;
  edgeColors: Float32Array;
  edgeWidths: Float32Array;
  count: number;
  edgeCount: number;
};

export type WebGLCamera = { yaw: number; pitch: number; zoom: number };

// Corner offsets for a 4-vertex TRIANGLE_STRIP quad, indexed by gl_VertexID.
const NODE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aSize;
uniform mat4 uProjection;
uniform mat4 uView;
uniform float uPixelRatio;
uniform vec2 uViewport;
out vec4 vColor;
out vec2 vCorner;
void main() {
  vec4 viewPosition = uView * vec4(aPosition, 1.0);
  vec4 clip = uProjection * viewPosition;
  // Perspective-correct radius: closer nodes draw larger, matching the Canvas renderer.
  float perspective = 650.0 / max(120.0, 650.0 + viewPosition.z);
  float radius = aSize * perspective * uPixelRatio;
  // Unit quad corner for the 4 vertices of a triangle strip.
  vec2 corner = vec2(
    gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : -1.0,
    gl_VertexID >= 2 ? 1.0 : -1.0
  );
  // Offset in clip space, scaled so a radius in pixels maps to screen pixels.
  vec2 offset = corner * radius * 2.0 / uViewport;
  clip.xy += offset * clip.w;
  gl_Position = clip;
  vColor = aColor;
  vCorner = corner;
}
`;

const NODE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vCorner;
out vec4 outColor;
void main() {
  // Round the quad: discard the corners outside the unit circle.
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}
`;

const EDGE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aColor;
uniform mat4 uProjection;
uniform mat4 uView;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

const EDGE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 0.85);
}
`;

/**
 * A lost context makes every GL call a no-op, so `createShader`/`getShaderParameter` fail
 * with a null log. Naming that cause keeps a driver reset from being misdiagnosed as a
 * shader-authoring bug.
 */
function assertContextAlive(gl: WebGL2RenderingContext, stage: string) {
  if (gl.isContextLost()) throw new Error(`WebGL context lost before ${stage}`);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  assertContextAlive(gl, "shader compilation");
  const shader = gl.createShader(type);
  if (!shader) {
    assertContextAlive(gl, "shader compilation");
    throw new Error("WebGL shader allocation failed");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const lost = gl.isContextLost();
    gl.deleteShader(shader);
    throw new Error(
      lost ? "WebGL context lost during shader compilation" : `WebGL shader compile failed: ${log ?? "unknown"}`
    );
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  assertContextAlive(gl, "program link");
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    assertContextAlive(gl, "program link");
    throw new Error("WebGL program allocation failed");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    const lost = gl.isContextLost();
    gl.deleteProgram(program);
    throw new Error(
      lost ? "WebGL context lost during program link" : `WebGL program link failed: ${log ?? "unknown"}`
    );
  }
  return program;
}

/** Column-major perspective projection. */
function perspective(out: Float32Array, fovRadians: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovRadians / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

/** View matrix built from orbit yaw/pitch and a zoom-derived distance. */
function orbitView(out: Float32Array, camera: WebGLCamera, distance: number) {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  // Rotate world by -yaw then -pitch, then translate along z.
  out.fill(0);
  out[0] = cy;
  out[2] = -sy;
  out[5] = cp;
  out[6] = sp;
  out[8] = sy * cp;
  out[9] = -cy * sp;
  out[10] = cy * cp;
  out[1] = -sy * cp;
  out[4] = sp;
  out[12] = 0;
  out[13] = 0;
  out[14] = distance;
  out[15] = 1;
}

export type MemoryGraphWebGL = {
  /** True when this renderer compiled and is drawing. */
  readonly active: boolean;
  /** Replace geometry; call only when nodes, edges, or layout positions change. */
  setGraph(graph: WebGLGraphInput): void;
  /** Resize the drawing buffer, in CSS pixels. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** Draw one frame. Returns false if the context is lost. */
  draw(camera: WebGLCamera): boolean;
  /** Release every GPU resource. Safe to call more than once. */
  dispose(): void;
  /** Number of draw calls in the last frame, for the demo's instrumentation. */
  readonly drawCalls: number;
};

export function createMemoryGraphWebGL(canvas: HTMLCanvasElement): MemoryGraphWebGL | null {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, depth: true, powerPreference: "high-performance" });
  if (!gl) return null;

  let nodeProgram: WebGLProgram | null = null;
  let edgeProgram: WebGLProgram | null = null;
  let nodeVao: WebGLVertexArrayObject | null = null;
  let edgeVao: WebGLVertexArrayObject | null = null;
  let positionBuffer: WebGLBuffer | null = null;
  let colorBuffer: WebGLBuffer | null = null;
  let sizeBuffer: WebGLBuffer | null = null;
  let edgeBuffer: WebGLBuffer | null = null;
  let edgeColorBuffer: WebGLBuffer | null = null;
  let nodeCount = 0;
  let edgeVertexCount = 0;
  let drawCalls = 0;
  let disposed = false;
  let lost = false;
  // Set on restore so the next frame re-uploads the graph it already holds: the buffers were
  // recreated empty, and the caller only guards against sending an unchanged graph.
  let pendingGraph: Parameters<MemoryGraphWebGL["setGraph"]>[0] | null = null;

  const projection = new Float32Array(16);
  const view = new Float32Array(16);

  try {
    nodeProgram = link(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
    edgeProgram = link(gl, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER);
    nodeVao = gl.createVertexArray();
    edgeVao = gl.createVertexArray();
    positionBuffer = gl.createBuffer();
    colorBuffer = gl.createBuffer();
    sizeBuffer = gl.createBuffer();
    edgeBuffer = gl.createBuffer();
    edgeColorBuffer = gl.createBuffer();
  } catch (error) {
    // A failed compile must release what was already allocated and let the caller fall back.
    disposePartial();
    throw error;
  }

  function disposePartial() {
    if (positionBuffer) gl!.deleteBuffer(positionBuffer);
    if (colorBuffer) gl!.deleteBuffer(colorBuffer);
    if (sizeBuffer) gl!.deleteBuffer(sizeBuffer);
    if (edgeBuffer) gl!.deleteBuffer(edgeBuffer);
    if (edgeColorBuffer) gl!.deleteBuffer(edgeColorBuffer);
    if (nodeVao) gl!.deleteVertexArray(nodeVao);
    if (edgeVao) gl!.deleteVertexArray(edgeVao);
    if (nodeProgram) gl!.deleteProgram(nodeProgram);
    if (edgeProgram) gl!.deleteProgram(edgeProgram);
    positionBuffer = colorBuffer = sizeBuffer = edgeBuffer = edgeColorBuffer = null;
    nodeVao = edgeVao = null;
    nodeProgram = edgeProgram = null;
  }

  function uploadGraph(graph: WebGLGraphInput) {
    nodeCount = graph.count;
    edgeVertexCount = graph.edgeCount * 2;

    gl!.bindVertexArray(nodeVao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, positionBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, graph.positions, gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, colorBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, graph.colors, gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 4, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, sizeBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, graph.sizes, gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(2);
    gl!.vertexAttribPointer(2, 1, gl!.FLOAT, false, 0, 0);

    gl!.bindVertexArray(edgeVao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, graph.edges, gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeColorBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, graph.edgeColors, gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 3, gl!.FLOAT, false, 0, 0);

    gl!.bindVertexArray(null);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, null);
  }

  canvas.addEventListener("webglcontextlost", onContextLost, false);
  canvas.addEventListener("webglcontextrestored", onContextRestored, false);

  function onContextLost(event: Event) {
    // Cancelling the default is what lets the browser deliver `webglcontextrestored` later;
    // without it the loss is permanent and the caller can never recover the view.
    event.preventDefault();
    lost = true;
    // The driver has already discarded every GL object. Null the handles so a restore never
    // tries to delete a dead name and a lost frame never binds one.
    positionBuffer = colorBuffer = sizeBuffer = edgeBuffer = edgeColorBuffer = null;
    nodeVao = edgeVao = null;
    nodeProgram = edgeProgram = null;
  }

  function onContextRestored() {
    // The browser restores the context object; all resources must be rebuilt.
    lost = false;
    // `disposePartial` is deliberately not called: the context is new, the old names are
    // already dead, and deleting them would only produce INVALID_OPERATION noise.
    try {
      nodeProgram = link(gl!, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
      edgeProgram = link(gl!, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER);
      nodeVao = gl!.createVertexArray();
      edgeVao = gl!.createVertexArray();
      positionBuffer = gl!.createBuffer();
      colorBuffer = gl!.createBuffer();
      sizeBuffer = gl!.createBuffer();
      edgeBuffer = gl!.createBuffer();
      edgeColorBuffer = gl!.createBuffer();
    } catch {
      lost = true;
      return;
    }
    // The new buffers are empty. Re-upload whatever graph was last handed to `setGraph`, or
    // the next frames would draw zero instances and look like a successful restore that
    // silently lost the data.
    if (pendingGraph) uploadGraph(pendingGraph);
  }

  return {
    active: true,
    get drawCalls() { return drawCalls; },
    setGraph(graph) {
      // Remember the graph even while lost: after a restore the buffers are empty and the
      // caller will not resend an unchanged graph, so the renderer must re-upload it itself.
      pendingGraph = graph;
      if (disposed || lost || !gl) return;
      uploadGraph(graph);
    },
    resize(width, height, pixelRatio) {
      if (disposed || !gl) return;
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(camera) {
      if (disposed || lost || !gl || !nodeProgram || !edgeProgram) return false;
      drawCalls = 0;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.CULL_FACE);

      const aspect = canvas.width / Math.max(1, canvas.height);
      perspective(projection, (45 * Math.PI) / 180, aspect, 1, 8000);
      // Zoom moves the camera in, matching the 2D renderer's zoom range.
      orbitView(view, camera, 700 / Math.max(0.35, Math.min(5, camera.zoom)));

      // Edges first so nodes draw over them.
      if (edgeVertexCount > 0) {
        gl.useProgram(edgeProgram);
        gl.uniformMatrix4fv(gl.getUniformLocation(edgeProgram, "uProjection"), false, projection);
        gl.uniformMatrix4fv(gl.getUniformLocation(edgeProgram, "uView"), false, view);
        gl.bindVertexArray(edgeVao);
        gl.drawArrays(gl.LINES, 0, edgeVertexCount);
        drawCalls++;
      }

      if (nodeCount > 0) {
        gl.useProgram(nodeProgram);
        gl.uniformMatrix4fv(gl.getUniformLocation(nodeProgram, "uProjection"), false, projection);
        gl.uniformMatrix4fv(gl.getUniformLocation(nodeProgram, "uView"), false, view);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uPixelRatio"), canvas.height / Math.max(1, canvas.clientHeight || canvas.height));
        gl.uniform2f(gl.getUniformLocation(nodeProgram, "uViewport"), canvas.width, canvas.height);
        gl.bindVertexArray(nodeVao);
        // Four vertices per node, instanced once per node.
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
        drawCalls++;
      }

      gl.bindVertexArray(null);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (gl) {
        const ext = gl.getExtension("WEBGL_lose_context");
        ext?.loseContext();
      }
      disposePartial();
    }
  };
}
