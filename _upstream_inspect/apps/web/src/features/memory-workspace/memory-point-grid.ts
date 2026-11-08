/**
 * Reusable uniform spatial hash for force layout.
 *
 * The layout inner loop rebuilds its neighbour grid on every relaxation step. Doing
 * that with `Map<template-string, array>` allocated one map entry, one string, and one
 * array per occupied cell per step, which dominated layout time.
 *
 * This version keeps a counting-sort layout in flat typed arrays: two integer passes
 * per step, no per-cell allocation, and no string keys. Cell identity is a packed
 * integer, collisions are resolved by linear probing with an exact key comparison, and
 * the neighbour result set is identical to the map-based version.
 */

export type GridPoint = { x: number; y: number; z: number };

export type PointGrid = {
  /** Rebuild the cell index from object positions. */
  build(points: readonly GridPoint[]): void;
  /** Rebuild the cell index from flat coordinate arrays, avoiding an object pass. */
  buildFromArrays(xs: Float64Array, ys: Float64Array, zs: Float64Array, count: number): void;
  /**
   * Fill `out` with every index sharing a cell with `(x, y, z)` or one of its 26
   * neighbours, and return the number written. `out` is reused between queries so
   * callers avoid a per-query allocation.
   */
  neighbors(x: number, y: number, z: number, out: Int32Array): number;
  /** Worst-case output length for `neighbors`, given the point count. */
  queryCapacity(count: number): number;
};

// 10 bits per axis keeps a packed cell inside a signed 32-bit integer, which is what
// `Int32Array` stores without truncation. Coordinates are biased so negatives pack too.
const AXIS_BITS = 10;
const AXIS_MASK = (1 << AXIS_BITS) - 1;
const AXIS_BIAS = 512;
const pack = (x: number, y: number, z: number) =>
  (((x + AXIS_BIAS) & AXIS_MASK) << (AXIS_BITS * 2)) |
  (((y + AXIS_BIAS) & AXIS_MASK) << AXIS_BITS) |
  ((z + AXIS_BIAS) & AXIS_MASK);

function nextPow2(value: number) {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

/**
 * Cell size that puts roughly one point per cell for the occupied volume.
 *
 * A fixed cell size silently becomes quadratic as a graph grows: at 10k points in the
 * same volume a 25-unit cell yielded ~1,400 neighbour visits per query. Scaling the
 * cell keeps the visit count bounded, which is what keeps layout near-linear.
 */
export function suggestCellSize(extent: number, count: number, minimum: number, maximum: number): number {
  if (count < 2 || !Number.isFinite(extent) || extent <= 0) return minimum;
  // Target ~1 point per cell: cells per axis = cbrt(count).
  const ideal = extent / Math.cbrt(count);
  return Math.min(maximum, Math.max(minimum, ideal));
}

/**
 * Relaxation step budget for a graph of `count` nodes.
 *
 * Repulsion cost grows with local density, so a fixed 150-180 step budget means the
 * largest graphs pay the most. Fitting the layout inside a long-task budget matters
 * more than a few extra steps: step count shrinks logarithmically once a graph passes
 * the interactive size, and the minimum keeps small graphs as converged as before.
 */
export function relaxationSteps(count: number, maximum: number): number {
  const FREE_NODES = 5000;
  if (count <= FREE_NODES) return maximum;
  const scale = Math.log2(count / FREE_NODES) + 1;
  return Math.max(48, Math.round(maximum / scale));
}

export function createPointGrid(cellSize: number): PointGrid {
  let capacity = 0;
  let cells = new Int32Array(0);
  let cellStart = new Int32Array(0);
  let keys = new Int32Array(0);
  let entries = new Int32Array(0);
  let cursor = new Int32Array(0);
  let scratchX = new Float64Array(0);
  let scratchY = new Float64Array(0);
  let scratchZ = new Float64Array(0);
  let slots = 0;
  let ox = 0, oy = 0, oz = 0;
  let dimY = 1, dimZ = 1;

  const ensureCapacity = (count: number) => {
    if (capacity >= count) return;
    capacity = count;
    cells = new Int32Array(capacity);
    entries = new Int32Array(capacity);
    scratchX = new Float64Array(capacity);
    scratchY = new Float64Array(capacity);
    scratchZ = new Float64Array(capacity);
  };

  const indexArrays = (xs: Float64Array, ys: Float64Array, zs: Float64Array, count: number) => {
    if (count === 0) { slots = 0; return; }
    ensureCapacity(count);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = xs[i]!, y = ys[i]!, z = zs[i]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    ox = Math.floor(minX / cellSize);
    oy = Math.floor(minY / cellSize);
    oz = Math.floor(minZ / cellSize);
    const dimX = Math.floor(maxX / cellSize) - ox + 1;
    dimY = Math.floor(maxY / cellSize) - oy + 1;
    dimZ = Math.floor(maxZ / cellSize) - oz + 1;
    // The table is keyed by occupied cell, not by point, so size it from the grid and
    // keep the load factor low. Sizing it from the point count under-allocated whenever
    // the grid was small, which collapsed probing into long linear scans.
    slots = nextPow2(Math.max(8, Math.min(dimX * dimY * dimZ * 2, count * 4)));
    if (keys.length < slots) keys = new Int32Array(slots);
    if (cellStart.length < slots + 2) cellStart = new Int32Array(slots + 2);
    if (cursor.length < slots) cursor = new Int32Array(slots);
    keys.fill(-1, 0, slots);
    cellStart.fill(0, 0, slots + 2);
    for (let i = 0; i < count; i++) {
      cells[i] = pack(
        Math.floor(xs[i]! / cellSize) - ox,
        Math.floor(ys[i]! / cellSize) - oy,
        Math.floor(zs[i]! / cellSize) - oz
      );
    }
    // Pass 1: register each occupied cell in its slot and count its members.
    for (let i = 0; i < count; i++) {
      const cell = cells[i]!;
      let slot = cell & (slots - 1);
      while (keys[slot] !== -1 && keys[slot] !== cell) slot = (slot + 1) & (slots - 1);
      keys[slot] = cell;
      cellStart[slot + 1]! += 1;
    }
    for (let slot = 0; slot < slots; slot++) cellStart[slot + 1]! += cellStart[slot]!;
    // Pass 2: scatter indices into each cell's contiguous range.
    cursor.fill(0, 0, slots);
    for (let i = 0; i < count; i++) {
      const cell = cells[i]!;
      let slot = cell & (slots - 1);
      while (keys[slot] !== cell) slot = (slot + 1) & (slots - 1);
      entries[cellStart[slot]! + cursor[slot]!] = i;
      cursor[slot]! += 1;
    }
  };

  return {
    build(points) {
      const count = points.length;
      ensureCapacity(count);
      for (let i = 0; i < count; i++) {
        const p = points[i]!;
        scratchX[i] = p.x; scratchY[i] = p.y; scratchZ[i] = p.z;
      }
      indexArrays(scratchX, scratchY, scratchZ, count);
    },
    buildFromArrays(xs, ys, zs, count) {
      indexArrays(xs, ys, zs, count);
    },
    neighbors(x, y, z, out) {
      if (slots === 0) return 0;
      let written = 0;
      const baseX = Math.floor(x / cellSize) - ox;
      const baseY = Math.floor(y / cellSize) - oy;
      const baseZ = Math.floor(z / cellSize) - oz;
      // A flat graph keeps every point in one z-layer, so only that layer can contribute.
      const flat = dimZ === 1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (flat && dz !== 0) continue;
        const cx = baseX + dx, cy = baseY + dy, cz = baseZ + dz;
        if (cx < 0 || cy < 0 || cz < 0) continue;
        if (cy >= dimY || cz >= dimZ) continue;
        const cell = pack(cx, cy, cz);
        let slot = cell & (slots - 1);
        while (keys[slot] !== -1 && keys[slot] !== cell) slot = (slot + 1) & (slots - 1);
        if (keys[slot] === -1) continue;
        const start = cellStart[slot]!, end = cellStart[slot + 1]!;
        // Never write past the caller's buffer; `queryCapacity` covers the dense case.
        if (written + (end - start) > out.length) break;
        for (let e = start; e < end; e++) out[written++] = entries[e]!;
      }
      return written;
    },
    queryCapacity(count) {
      // A single occupied cell can hold every point; that is the true worst case.
      return Math.max(1, count);
    }
  };
}
