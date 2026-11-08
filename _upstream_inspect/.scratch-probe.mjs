var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// apps/web/src/features/memory-workspace/memory-3d-synthetic.ts
var memory_3d_synthetic_exports = {};
__export(memory_3d_synthetic_exports, {
  SYNTHETIC_GRAPH_SIZES: () => SYNTHETIC_GRAPH_SIZES,
  buildSyntheticMemoryGraph: () => buildSyntheticMemoryGraph,
  syntheticGraphSize: () => syntheticGraphSize
});
function syntheticGraphSize(label) {
  return SYNTHETIC_GRAPH_SIZES.find((size) => size.label === label) ?? SYNTHETIC_GRAPH_SIZES[0];
}
function buildSyntheticMemoryGraph(nodeCount, edgeCount) {
  const nodes = [];
  const edges = [];
  nodes.push({ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/core/gemini.md", recordId: null });
  const sources = Math.max(1, Math.min(Math.round(nodeCount / 40), nodeCount - 1));
  for (let source = 0; source < sources; source++) {
    const id = `source-${String(source).padStart(5, "0")}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/docs/${id}.md`, recordId: null });
    edges.push({ id: `e-file-${source}`, type: "DERIVED_FROM", source: "root", target: id });
  }
  let memory = 0;
  while (nodes.length < nodeCount) {
    const parent = `source-${String(memory % sources).padStart(5, "0")}`;
    const id = `memory-${String(memory).padStart(6, "0")}`;
    nodes.push({ id, label: `memory record ${memory}`, type: "MEMORY", sourcePath: `/docs/${parent}.md`, recordId: id });
    edges.push({ id: `e-c-${memory}`, type: "CONTAINS", source: parent, target: id });
    memory++;
  }
  let link = 0;
  while (edges.length < edgeCount) {
    const a = nodes[1 + link % (nodes.length - 1)];
    const b = nodes[1 + (link * 7919 + 13) % (nodes.length - 1)];
    link++;
    if (a.id === b.id) continue;
    edges.push({ id: `e-d-${link}`, type: link % 3 === 0 ? "SEMANTICALLY_RELATED" : "DERIVED_FROM", source: a.id, target: b.id });
  }
  return { nodes, edges };
}
var SYNTHETIC_GRAPH_SIZES;
var init_memory_3d_synthetic = __esm({
  "apps/web/src/features/memory-workspace/memory-3d-synthetic.ts"() {
    "use strict";
    SYNTHETIC_GRAPH_SIZES = [
      { label: "2k", nodes: 2e3, edges: 6e3 },
      { label: "10k", nodes: 1e4, edges: 3e4 },
      { label: "50k", nodes: 5e4, edges: 15e4 }
    ];
  }
});

// apps/web/src/features/memory-workspace/memory-graph-visuals.ts
function isMemoryCoreLabel(label) {
  return /^(?:space|gemini)\.md$/.test(label);
}
function isMemoryIndexLabel(label) {
  return /^(?:space_memory|gemini_history)\.md$/.test(label ?? "");
}
var init_memory_graph_visuals = __esm({
  "apps/web/src/features/memory-workspace/memory-graph-visuals.ts"() {
    "use strict";
  }
});

// apps/web/src/features/memory-workspace/memory-barnes-hut.ts
function barnesHutCapacity(count) {
  return Math.max(64, Math.ceil(count * 15 / 7) + 16);
}
function createBarnesHutTree(capacityHint = 1024) {
  const size = Math.max(64, capacityHint);
  return {
    weight: new Float64Array(size),
    massCount: new Int32Array(size),
    cx: new Float64Array(size),
    cy: new Float64Array(size),
    cz: new Float64Array(size),
    half: new Float64Array(size),
    mx: new Float64Array(size),
    my: new Float64Array(size),
    mz: new Float64Array(size),
    sourceShare: new Float64Array(size),
    child: new Int32Array(size).fill(-1),
    used: 0,
    root: 0
  };
}
function grow(tree, needed) {
  if (tree.weight.length >= needed) return;
  let size = tree.weight.length;
  while (size < needed) size *= 2;
  const ints = (source, fill) => {
    const next = new Int32Array(size);
    if (fill !== null) next.fill(fill);
    next.set(source);
    return next;
  };
  const floats = (source) => {
    const next = new Float64Array(size);
    next.set(source);
    return next;
  };
  tree.weight = floats(tree.weight);
  tree.massCount = ints(tree.massCount, 0);
  tree.cx = floats(tree.cx);
  tree.cy = floats(tree.cy);
  tree.cz = floats(tree.cz);
  tree.half = floats(tree.half);
  tree.mx = floats(tree.mx);
  tree.my = floats(tree.my);
  tree.mz = floats(tree.mz);
  tree.sourceShare = floats(tree.sourceShare);
  tree.child = ints(tree.child, -1);
}
function allocCell(tree, cx, cy, cz, half) {
  if (tree.used >= tree.weight.length) grow(tree, tree.used + CHILDREN);
  const index = tree.used++;
  tree.weight[index] = 0;
  tree.massCount[index] = 0;
  tree.cx[index] = cx;
  tree.cy[index] = cy;
  tree.cz[index] = cz;
  tree.half[index] = half;
  tree.mx[index] = 0;
  tree.my[index] = 0;
  tree.mz[index] = 0;
  tree.sourceShare[index] = 0;
  tree.child[index] = -1;
  return index;
}
function octant(px, py, pz, cx, cy, cz) {
  return (px >= cx ? 1 : 0) | (py >= cy ? 2 : 0) | (pz >= cz ? 4 : 0);
}
function buildBarnesHutTree(tree, px, py, pz, isSource, count, maxDepth = 0) {
  const depthCap = maxDepth > 0 ? maxDepth : Math.max(6, Math.ceil(Math.log(Math.max(2, count)) / Math.log(8)) + 4);
  tree.used = 0;
  tree.weight.fill(0);
  tree.massCount.fill(0);
  tree.child.fill(-1);
  tree.sourceShare.fill(0);
  if (count === 0) {
    tree.root = allocCell(tree, 0, 0, 0, 1);
    return tree;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = px[i], y = py[i], z = pz[i];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const half = Math.max(1, (maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2) * 1.0001;
  const root = allocCell(tree, centerX, centerY, centerZ, half);
  tree.root = root;
  for (let i = 0; i < count; i++) {
    const x = px[i], y = py[i], z = pz[i];
    let cell = root;
    let depth = 0;
    for (; ; ) {
      const current = tree.massCount[cell];
      const next = current + 1;
      tree.massCount[cell] = next;
      tree.weight[cell] = next;
      tree.sourceShare[cell] = tree.sourceShare[cell] + isSource[i];
      if (current === 0) {
        tree.mx[cell] = x;
        tree.my[cell] = y;
        tree.mz[cell] = z;
      } else {
        tree.mx[cell] = (tree.mx[cell] * current + x) / next;
        tree.my[cell] = (tree.my[cell] * current + y) / next;
        tree.mz[cell] = (tree.mz[cell] * current + z) / next;
      }
      if (depth >= depthCap) break;
      if (tree.child[cell] === -1) {
        const h = tree.half[cell] / 2;
        const base = tree.used;
        if (base + CHILDREN > tree.weight.length) grow(tree, base + CHILDREN);
        for (let k = 0; k < CHILDREN; k++) {
          allocCell(
            tree,
            tree.cx[cell] + (k & 1 ? h : -h),
            tree.cy[cell] + (k & 2 ? h : -h),
            tree.cz[cell] + (k & 4 ? h : -h),
            h
          );
        }
        tree.child[cell] = base;
      }
      cell = tree.child[cell] + octant(x, y, z, tree.cx[cell], tree.cy[cell], tree.cz[cell]);
      depth++;
    }
  }
  return tree;
}
function applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, theta, strongForce, weakForce, minDistanceSquared, scratch) {
  const root = tree.root;
  const weight = tree.weight, mx = tree.mx, my = tree.my, mz = tree.mz;
  const half = tree.half, child = tree.child, sourceShare = tree.sourceShare;
  const thetaSquared = theta * theta;
  const strengthRange = strongForce - weakForce;
  const stack = scratch && scratch.length >= 1024 ? scratch : new Int32Array(1024);
  for (let i = 0; i < count; i++) {
    const x = px[i], y = py[i], z = pz[i];
    let ax = 0, ay = 0, az = 0;
    let top = 0;
    stack[top++] = root;
    while (top > 0) {
      const cell = stack[--top];
      const cellWeight = weight[cell];
      if (cellWeight === 0) continue;
      const dx = x - mx[cell];
      const dy = y - my[cell];
      const dz = z - mz[cell];
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const size = half[cell];
      const kids = child[cell];
      if (kids === -1 || size * size < thetaSquared * distanceSquared) {
        if (distanceSquared === 0) continue;
        const blended = weakForce + strengthRange * (sourceShare[cell] / cellWeight);
        const magnitude = cellWeight * blended / (distanceSquared < minDistanceSquared ? minDistanceSquared : distanceSquared);
        ax += dx * magnitude;
        ay += dy * magnitude;
        az += dz * magnitude;
        continue;
      }
      for (let k = 0; k < CHILDREN; k++) {
        if (weight[kids + k] > 0) stack[top++] = kids + k;
      }
    }
    fx[i] += ax;
    fy[i] += ay;
    fz[i] += az;
  }
}
var CHILDREN;
var init_memory_barnes_hut = __esm({
  "apps/web/src/features/memory-workspace/memory-barnes-hut.ts"() {
    "use strict";
    CHILDREN = 8;
  }
});

// apps/web/src/features/memory-workspace/memory-point-grid.ts
function relaxationSteps(count, maximum) {
  const FREE_NODES = 5e3;
  if (count <= FREE_NODES) return maximum;
  const scale = Math.log2(count / FREE_NODES) + 1;
  return Math.max(48, Math.round(maximum / scale));
}
var AXIS_BITS, AXIS_MASK;
var init_memory_point_grid = __esm({
  "apps/web/src/features/memory-workspace/memory-point-grid.ts"() {
    "use strict";
    AXIS_BITS = 10;
    AXIS_MASK = (1 << AXIS_BITS) - 1;
  }
});

// apps/web/src/features/memory-workspace/memory-3d.ts
var memory_3d_exports = {};
__export(memory_3d_exports, {
  BARNES_HUT_THETA: () => BARNES_HUT_THETA,
  DEFAULT_MEMORY_CAMERA: () => DEFAULT_MEMORY_CAMERA,
  layoutMemoryNetwork3D: () => layoutMemoryNetwork3D,
  memory3DVolumeRatio: () => memory3DVolumeRatio,
  memoryLayout3DSteps: () => memoryLayout3DSteps,
  projectMemoryPoint: () => projectMemoryPoint
});
function* memoryLayout3DSteps(nodes, edges, options = {}) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex((node) => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  if (count === 0) return /* @__PURE__ */ new Map();
  const spread = 260 * Math.max(1, Math.cbrt(count / 2e3));
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const id = ordered[i].id;
    const previous = options.initial?.get(id);
    px[i] = previous ? previous.x : (unit(`${id}:x`) - 0.5) * spread;
    py[i] = previous ? previous.y : (unit(`${id}:y`) - 0.5) * spread;
    pz[i] = previous ? previous.z : (unit(`${id}:z`) - 0.5) * spread;
  }
  if (root >= 0) {
    px[root] = 0;
    py[root] = 0;
    pz[root] = 0;
  }
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap((edge) => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === void 0 || b === void 0 || a === b) return [];
    const fileLink = ordered[a].type === "SOURCE" && ordered[b].type === "SOURCE";
    return [{
      a,
      b,
      length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 4e-3
    }];
  });
  if (!options.initial) {
    for (const edge of edges) {
      const a = index.get(edge.source), b = index.get(edge.target);
      if (edge.type !== "CONTAINS" || a === void 0 || b === void 0 || ordered[a].type !== "SOURCE" || ordered[b].type !== "MEMORY") continue;
      const id = ordered[b].id;
      px[b] = px[a] + (unit(`${id}:dx`) - 0.5) * 70;
      py[b] = py[a] + (unit(`${id}:dy`) - 0.5) * 70;
      pz[b] = pz[a] + (unit(`${id}:dz`) - 0.5) * 70;
    }
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) isSource[i] = ordered[i].type === "SOURCE" ? 1 : 0;
  const linkA = new Int32Array(links.length), linkB = new Int32Array(links.length);
  const linkLength = new Float64Array(links.length), linkStrength = new Float64Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    linkA[i] = link.a;
    linkB[i] = link.b;
    linkLength[i] = link.length;
    linkStrength[i] = link.strength;
  }
  const tree = createBarnesHutTree(barnesHutCapacity(count));
  const steps = options.steps ?? relaxationSteps(count, 180);
  for (let step = 0; step < steps; step++) {
    fx.fill(0);
    fy.fill(0);
    fz.fill(0);
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, fz, count, BARNES_HUT_THETA, 28, 12, 1);
    for (let i = 0; i < linkA.length; i++) {
      const a = linkA[i], b = linkB[i];
      const dx = px[b] - px[a], dy = py[b] - py[a], dz = pz[b] - pz[a];
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const spring = (distance - linkLength[i]) * linkStrength[i] / distance;
      fx[a] += dx * spring;
      fy[a] += dy * spring;
      fz[a] += dz * spring;
      fx[b] -= dx * spring;
      fy[b] -= dy * spring;
      fz[b] -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i] - px[i] * 5e-4, dy = fy[i] - py[i] * 5e-4, dz = fz[i] - pz[i] * 5e-4;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz))) * cooling;
      px[i] += dx * stepScale;
      py[i] += dy * stepScale;
      pz[i] += dz * stepScale;
    }
    yield { step, steps };
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i], y: py[i], z: pz[i] }]));
}
function layoutMemoryNetwork3D(nodes, edges, options = {}) {
  const iterator = memoryLayout3DSteps(nodes, edges, options);
  for (; ; ) {
    const next = iterator.next();
    if (next.done) return next.value;
  }
}
function projectMemoryPoint(point, camera, scale, width, height) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}
function memory3DVolumeRatio(points) {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x;
    yy += y * y;
    zz += z * z;
    xy += x * y;
    xz += x * z;
    yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
var DEFAULT_MEMORY_CAMERA, BARNES_HUT_THETA, unit;
var init_memory_3d = __esm({
  "apps/web/src/features/memory-workspace/memory-3d.ts"() {
    "use strict";
    init_memory_graph_visuals();
    init_memory_barnes_hut();
    init_memory_point_grid();
    DEFAULT_MEMORY_CAMERA = { yaw: 0.3, pitch: -0.15, zoom: 1 };
    BARNES_HUT_THETA = 0.5;
    unit = (seed) => {
      let hash = 2166136261;
      for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      hash = Math.imul(hash ^ hash >>> 16, 2146121005);
      hash = Math.imul(hash ^ hash >>> 15, 2221713035);
      return ((hash ^ hash >>> 16) >>> 0) / 4294967295;
    };
  }
});

// apps/web/src/features/memory-workspace/memory-network-layout.ts
function* memoryLayoutSteps(nodes, edges, options = {}) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const sources = ordered.filter((node) => node.type === "SOURCE");
  const root = sources.find((node) => isMemoryCoreLabel(node.label)) ?? sources.find((node) => isMemoryIndexLabel(node.label));
  const rootIndex = root ? index.get(root.id) : -1;
  const sourceIndex = new Map(sources.map((node) => [node.sourcePath, index.get(node.id)]));
  const spread = 240 * Math.max(1, Math.sqrt(ordered.length / 2e3));
  const points = ordered.map((node) => ({ x: (unit2(node.id) - 0.5) * spread, y: (unit2(`${node.id}:y`) - 0.5) * (spread * 0.833) }));
  ordered.forEach((node, i) => {
    const parent = sourceIndex.get(node.sourcePath);
    if (node.type === "MEMORY" && parent !== void 0) {
      points[i] = { x: points[parent].x + (unit2(`${node.id}:dx`) - 0.5) * 45, y: points[parent].y + (unit2(`${node.id}:dy`) - 0.5) * 45 };
    }
  });
  if (rootIndex >= 0) points[rootIndex] = { x: 0, y: 0 };
  const links = edges.flatMap((edge) => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === void 0 || b === void 0 || a === b) return [];
    const fileLink = ordered[a].type === "SOURCE" && ordered[b].type === "SOURCE";
    return [{ a, b, length: fileLink ? 85 : edge.type === "CONTAINS" ? 28 : 45, strength: fileLink ? 0.026 : edge.type === "CONTAINS" ? 0.017 : 25e-4 }];
  });
  const count = points.length;
  const fx = new Float64Array(count), fy = new Float64Array(count);
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) isSource[i] = ordered[i].type === "SOURCE" ? 1 : 0;
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = points[i].x;
    py[i] = points[i].y;
  }
  const linkA = new Int32Array(links.length), linkB = new Int32Array(links.length);
  const linkLength = new Float64Array(links.length), linkStrength = new Float64Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    linkA[i] = link.a;
    linkB[i] = link.b;
    linkLength[i] = link.length;
    linkStrength[i] = link.strength;
  }
  const tree = createBarnesHutTree(barnesHutCapacity(count));
  const steps = options.steps ?? relaxationSteps(count, 150);
  for (let step = 0; step < steps; step++) {
    fx.fill(0);
    fy.fill(0);
    buildBarnesHutTree(tree, px, py, pz, isSource, count);
    applyBarnesHutRepulsion(tree, px, py, pz, isSource, fx, fy, pz, count, BARNES_HUT_THETA, 14, 5, 4);
    for (let i = 0; i < linkA.length; i++) {
      const a = linkA[i], b = linkB[i];
      const dx = px[b] - px[a], dy = py[b] - py[a];
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const spring = (distance - linkLength[i]) * linkStrength[i] / distance;
      fx[a] += dx * spring;
      fy[a] += dy * spring;
      fx[b] -= dx * spring;
      fy[b] -= dy * spring;
    }
    const cooling = 1 - step / 190;
    for (let i = 0; i < count; i++) {
      if (i === rootIndex) continue;
      px[i] += Math.max(-4, Math.min(4, fx[i] - px[i] * 4e-4)) * cooling;
      py[i] += Math.max(-4, Math.min(4, fy[i] - py[i] * 4e-4)) * cooling;
    }
    yield { step, steps };
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i], y: py[i] }]));
}
function layoutMemoryNetwork(nodes, edges, options = {}) {
  const iterator = memoryLayoutSteps(nodes, edges, options);
  for (; ; ) {
    const next = iterator.next();
    if (next.done) return next.value;
  }
}
var unit2;
var init_memory_network_layout = __esm({
  "apps/web/src/features/memory-workspace/memory-network-layout.ts"() {
    "use strict";
    init_memory_graph_visuals();
    init_memory_barnes_hut();
    init_memory_3d();
    init_memory_point_grid();
    unit2 = (value) => {
      let hash = 2166136261;
      for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      return (hash >>> 0) / 4294967295;
    };
  }
});

// apps/web/src/features/memory-workspace/memory-atlas.ts
var memory_atlas_exports = {};
__export(memory_atlas_exports, {
  ATLAS_COLORS: () => ATLAS_COLORS,
  MIN_ATLAS_TAG_COUNT: () => MIN_ATLAS_TAG_COUNT,
  createMemoryAtlas: () => createMemoryAtlas,
  memoryMonthLabel: () => memoryMonthLabel,
  memorySourceMonth: () => memorySourceMonth
});
function createMemoryAtlas(nodes, edges, computeLayout = true, minTagCount = MIN_ATLAS_TAG_COUNT) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const topicMembers = /* @__PURE__ */ new Map();
  const explicit = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    if (edge.type !== "TAGGED_WITH" || byId.get(edge.target)?.type !== "TOPIC" || byId.get(edge.source)?.type !== "MEMORY") continue;
    if (edge.origin === "EXPLICIT_TAG") explicit.add(edge.target);
    if (!topicMembers.has(edge.target)) topicMembers.set(edge.target, /* @__PURE__ */ new Set());
    topicMembers.get(edge.target).add(edge.source);
  }
  const topics = nodes.filter((node) => node.type === "TOPIC" && (explicit.has(node.id) ? (topicMembers.get(node.id)?.size ?? 0) >= minTagCount : (topicMembers.get(node.id)?.size ?? 0) >= 2)).sort((a, b) => Number(explicit.has(b.id)) - Number(explicit.has(a.id)) || (topicMembers.get(b.id)?.size ?? 0) - (topicMembers.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  const anchors = [];
  for (const topic of topics) {
    const members = topicMembers.get(topic.id);
    const duplicate = anchors.some((anchor) => {
      const previous = topicMembers.get(anchor.id);
      const intersection = [...members].filter((id) => previous.has(id)).length;
      return intersection / (members.size + previous.size - intersection) > 0.82;
    });
    if (!duplicate) anchors.push(topic);
    if (anchors.length === 6) break;
  }
  const assignments = /* @__PURE__ */ new Map();
  anchors.forEach((topic) => {
    assignments.set(topic.id, topic.id);
    for (const id of topicMembers.get(topic.id)) {
      const previous = assignments.get(id);
      if (!previous || topicMembers.get(previous).size > topicMembers.get(topic.id).size) assignments.set(id, topic.id);
    }
  });
  for (const topic of topics) {
    if (assignments.has(topic.id)) continue;
    const votes = /* @__PURE__ */ new Map();
    for (const id of topicMembers.get(topic.id)) {
      const group = assignments.get(id);
      if (group) votes.set(group, (votes.get(group) ?? 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) assignments.set(topic.id, best[0]);
  }
  const topicIds = new Set(topics.map((node) => node.id));
  let visibleNodes = nodes.filter((node) => node.type === "MEMORY" || node.type === "SOURCE" || node.type === "ROOM" || topicIds.has(node.id));
  if (!visibleNodes.length) visibleNodes = nodes;
  const ids = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const residualMonths = /* @__PURE__ */ new Map();
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    if (month) residualMonths.set(month, (residualMonths.get(month) ?? 0) + 1);
  }
  const monthSlots = 8;
  const monthKeys = [...residualMonths].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, monthSlots).map(([month]) => month).sort();
  const groupInfo = new Map(anchors.map((topic) => [topic.id, { label: topic.label, kind: explicit.has(topic.id) ? "tag" : "topic" }]));
  for (const month of monthKeys) groupInfo.set(`month:${month}`, { label: memoryMonthLabel(month), kind: "month" });
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    const group = month && monthKeys.includes(month) ? `month:${month}` : "archive:other";
    assignments.set(node.id, group);
    if (!groupInfo.has(group)) groupInfo.set(group, { label: month ? "Other months" : "Other knowledge", kind: "archive" });
  }
  const buckets = /* @__PURE__ */ new Map();
  for (const node of [...visibleNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = assignments.get(node.id);
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(node);
  }
  const positions = /* @__PURE__ */ new Map();
  const groups = [];
  const activeGroups = [...groupInfo].filter(([id]) => buckets.has(id));
  const networkPositions = computeLayout ? layoutMemoryNetwork(visibleNodes, visibleEdges) : new Map(visibleNodes.map((node, index) => [node.id, node.position?.relations ?? { x: index % 40, y: Math.floor(index / 40) }]));
  activeGroups.forEach(([groupId, info], groupIndex) => {
    const members = buckets.get(groupId);
    const color = info.kind === "archive" ? "#7395ad" : ATLAS_COLORS[groupIndex % ATLAS_COLORS.length];
    groups.push({ id: groupId, ...info, color, count: members.filter((node) => node.type === "MEMORY").length });
    members.forEach((node) => {
      const hub = node.type === "SOURCE" || anchors.some((anchor) => anchor.id === node.id);
      const position = networkPositions.get(node.id);
      const month = memorySourceMonth(node);
      positions.set(node.id, { ...position, color: isMemoryCoreLabel(node.label) ? "#fff0b0" : color, hub, groupId, ...month ? { monthLabel: memoryMonthLabel(month) } : {} });
    });
  });
  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    positions,
    groups,
    topics: anchors.map((node) => ({ ...node, color: groups.find((group) => group.id === node.id).color, count: topicMembers.get(node.id).size, explicit: explicit.has(node.id) })),
    explicitCount: explicit.size,
    semanticCount: visibleEdges.filter((edge) => edge.type === "SEMANTICALLY_RELATED").length
  };
}
var ATLAS_COLORS, memorySourceMonth, memoryMonthLabel, MIN_ATLAS_TAG_COUNT;
var init_memory_atlas = __esm({
  "apps/web/src/features/memory-workspace/memory-atlas.ts"() {
    "use strict";
    init_memory_network_layout();
    init_memory_graph_visuals();
    ATLAS_COLORS = ["#57ccff", "#ff79bc", "#ab95ff", "#53e2ba", "#ffc56c", "#fa887e", "#a0df73", "#8caaff"];
    memorySourceMonth = (node) => node.sourcePath?.match(/(?:^|[_/-])(20\d{2}-(?:0[1-9]|1[0-2]))(?:[_. /-]|$)/)?.[1] ?? null;
    memoryMonthLabel = (month) => (/* @__PURE__ */ new Date(`${month}-01T00:00:00Z`)).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });
    MIN_ATLAS_TAG_COUNT = 10;
  }
});

// scripts/main-thread-probe.ts
function watchLongTasks() {
  const tasks = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ name: entry.name, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    observer = null;
  }
  return { tasks, supported: Boolean(observer), stop: () => observer?.disconnect() };
}
window.__probe = async (label) => {
  const modules = await Promise.all([
    Promise.resolve().then(() => (init_memory_3d_synthetic(), memory_3d_synthetic_exports)),
    Promise.resolve().then(() => (init_memory_atlas(), memory_atlas_exports)),
    Promise.resolve().then(() => (init_memory_3d(), memory_3d_exports))
  ]);
  const [{ buildSyntheticMemoryGraph: buildSyntheticMemoryGraph2 }, { createMemoryAtlas: createMemoryAtlas2 }, { layoutMemoryNetwork3D: layoutMemoryNetwork3D2 }] = modules;
  const size = Number(label.replace("k", "")) * 1e3;
  const { nodes, edges } = buildSyntheticMemoryGraph2(size, size * 3);
  const payload = JSON.stringify({ nodes, edges });
  const payloadMB = +(new Blob([payload]).size / 1024 ** 2).toFixed(1);
  const result = { label, nodes: nodes.length, edges: edges.length, payloadMB };
  {
    const watch = watchLongTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = performance.now();
    const parsed = JSON.parse(payload);
    const parseMs = performance.now() - start;
    const atlasStart = performance.now();
    const atlas = createMemoryAtlas2(parsed.nodes, parsed.edges, false);
    const atlasMs = performance.now() - atlasStart;
    const layoutStart = performance.now();
    layoutMemoryNetwork3D2(atlas.nodes, atlas.edges, { steps: 6 });
    const layoutMs = performance.now() - layoutStart;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  {
    const watch = watchLongTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = new Worker(window.__layoutWorkerUrl, { type: "module" });
    const start = performance.now();
    const done = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        if (event.data?.type === "done" || event.data?.type === "atlas") {
          if (event.data.type === "done") resolve();
        }
      };
      worker.onerror = (error) => reject(new Error(error.message || "worker failed"));
    });
    const stringifyStart = performance.now();
    const outgoing = JSON.stringify({ nodes, edges });
    const stringifyMs = performance.now() - stringifyStart;
    worker.postMessage({ payload: outgoing, requestId: 1 });
    await done;
    const wallMs = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 50));
    watch.stop();
    worker.terminate();
    const longest = watch.tasks.reduce((max, task) => Math.max(max, task.duration), 0);
    result.worker = {
      supported: watch.supported,
      stringifyMs: +stringifyMs.toFixed(1),
      totalMs: +wallMs.toFixed(1),
      longTasks: watch.tasks.length,
      longestTaskMs: +longest.toFixed(1)
    };
  }
  return result;
};
window.__ready = true;
