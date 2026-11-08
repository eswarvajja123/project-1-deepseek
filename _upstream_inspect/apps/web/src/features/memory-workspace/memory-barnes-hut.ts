/**
 * Barnes-Hut octree for force-directed layout.
 *
 * The grid-based repulsion this replaces visited every node in the 27 surrounding
 * cells, so its cost tracked local density. Micro-benchmarks on the 50k synthetic
 * graph showed the force arithmetic for ~41 neighbours per node costing roughly
 * 30 ms per pass, while the full pair loop cost ~1,650 ms. The index was never the
 * bottleneck: the pair count was, at O(n x neighbours) with a large constant.
 *
 * Barnes-Hut replaces the per-neighbour sum with one traversal per node. Distant
 * groups of points collapse into a single aggregate whose centre of mass stands in
 * for the group, so each node touches O(log n) aggregates instead of O(neighbours)
 * points. Nearby points are still compared exactly, because the traversal descends
 * until a cell is small relative to the node's distance.
 *
 * Storage is flat typed arrays allocated once and reused across relaxation steps:
 * no per-cell objects, no per-query allocation, and no Map. The tree tolerates
 * coincident points, which a warm-started layout can produce, by capping depth and
 * keeping an explicit weight per cell.
 */

/** A Barnes-Hut aggregate over one spatial cell, in flat typed arrays. */
export type BarnesHutTree = {
  /** Number of points aggregated by the cell; 0 means empty. */
  weight: Float64Array;
  /** Integer point count per cell, used to weight the centre-of-mass combine. */
  massCount: Int32Array;
  /** Cell centre coordinates. */
  cx: Float64Array;
  cy: Float64Array;
  cz: Float64Array;
  /** Half-width of the cell. */
  half: Float64Array;
  /** Centre of mass, valid when `weight > 0`. */
  mx: Float64Array;
  my: Float64Array;
  mz: Float64Array;
  /** Number of source nodes aggregated by the cell, for force blending. */
  sourceShare: Float64Array;
  /** First of eight contiguous children, or -1 for a leaf. */
  child: Int32Array;
  /** Number of aggregate cells in use. */
  used: number;
  /** Index of the root cell. */
  root: number;
};

const CHILDREN = 8;


/**
 * Number of tree cells to allocate for `count` points.
 *
 * A full octree over n points has at most n leaves plus 8/7 extra internal cells
 * (every split allocates eight children). The constant term covers the root and a
 * short coincident-point chain. Allocating on demand instead doubled the build cost
 * through repeated array copies, so this over-allocates deliberately.
 */
export function barnesHutCapacity(count: number): number {
  return Math.max(64, Math.ceil((count * 15) / 7) + 16);
}

/** Allocate reusable tree storage. */
export function createBarnesHutTree(capacityHint = 1024): BarnesHutTree {
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

function grow(tree: BarnesHutTree, needed: number) {
  if (tree.weight.length >= needed) return;
  let size = tree.weight.length;
  while (size < needed) size *= 2;
  const ints = (source: Int32Array, fill: number | null) => {
    const next = new Int32Array(size);
    if (fill !== null) next.fill(fill);
    next.set(source);
    return next;
  };
  const floats = (source: Float64Array) => {
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

/** Allocate one aggregate cell, growing storage if the build outgrew it. */
function allocCell(tree: BarnesHutTree, cx: number, cy: number, cz: number, half: number): number {
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

/**
 * Quantises a coordinate into an octant 0-7.
 *
 * The split tests `>=` against the cell centre, so a point exactly on the centre
 * plane always goes to the upper octant. A fixed bias is required: with an arbitrary
 * choice two coincident points could keep landing in the same child forever.
 */
function octant(px: number, py: number, pz: number, cx: number, cy: number, cz: number) {
  return (px >= cx ? 1 : 0) | (py >= cy ? 2 : 0) | (pz >= cz ? 4 : 0);
}

/**
 * Build the octree over `count` points in flat arrays.
 *
 * Bounds are recomputed here rather than supplied, because a warm-started layout
 * moves points between steps and a stale root box would drop points.
 * `maxDepth` bounds recursion for coincident points; the deepest cell accumulates
 * them as a single weight so a degenerate cluster cannot blow up the tree.
 */
export function buildBarnesHutTree(
  tree: BarnesHutTree,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  isSource: Uint8Array,
  count: number,
  maxDepth = 0
): BarnesHutTree {
  // Depth only needs to reach the point where cells hold a handful of points, so it
  // scales with log8(count). Beyond that the tree just pays for extra splitting:
  // 20 levels at 2k points produced 187k cells for 2k points. Same coordinates are
  // never separated by more levels anyway, and coincident points stop at the cap.
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
    const x = px[i]!, y = py[i]!, z = pz[i]!;
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
  // A flat or single-point cloud has zero extent on some axis; the floor of 1 and the
  // 1.0001 margin keep `half` positive and every point strictly inside the root box.
  const half = Math.max(1, (maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2) * 1.0001;
  const root = allocCell(tree, centerX, centerY, centerZ, half);
  tree.root = root;

  for (let i = 0; i < count; i++) {
    const x = px[i]!, y = py[i]!, z = pz[i]!;
    let cell = root;
    let depth = 0;
    for (;;) {
      // Accumulate this point into the cell's running centre of mass.
      //
      // The running mean is combined as `(mean * n + x) / (n + 1)` rather than by
      // summing coordinates. Summing looks cheaper but the accumulators are repeated
      // `Float64Array` reads and writes plus a division in the hottest loop, which
      // measured slower than the multiply-add form once the counts are integers.
      const current = tree.massCount[cell]!;
      const next = current + 1;
      tree.massCount[cell] = next;
      tree.weight[cell] = next;
      tree.sourceShare[cell] = tree.sourceShare[cell]! + isSource[i]!;
      if (current === 0) {
        tree.mx[cell] = x; tree.my[cell] = y; tree.mz[cell] = z;
      } else {
        tree.mx[cell] = (tree.mx[cell]! * current + x) / next;
        tree.my[cell] = (tree.my[cell]! * current + y) / next;
        tree.mz[cell] = (tree.mz[cell]! * current + z) / next;
      }
      if (depth >= depthCap) break; // coincident cluster: keep it in one aggregate
      if (tree.child[cell] === -1) {
        // Promote this leaf. Splitting on the first point through a cell (rather than
        // waiting for a second) keeps leaves at depth: deferring the split left long
        // chains of 2-point cells near the root, which raised traversal visits and
        // made the force pass 60% slower despite a smaller tree.
        // Promote this leaf: allocate eight contiguous children and descend into the
        // one this point belongs to. Remaining points widen the tree naturally.
        const h = tree.half[cell]! / 2;
        const base = tree.used;
        if (base + CHILDREN > tree.weight.length) grow(tree, base + CHILDREN);
        for (let k = 0; k < CHILDREN; k++) {
          allocCell(
            tree,
            tree.cx[cell]! + ((k & 1) ? h : -h),
            tree.cy[cell]! + ((k & 2) ? h : -h),
            tree.cz[cell]! + ((k & 4) ? h : -h),
            h
          );
        }
        tree.child[cell] = base;
      }
      cell = tree.child[cell]! + octant(x, y, z, tree.cx[cell]!, tree.cy[cell]!, tree.cz[cell]!);
      depth++;
    }
  }
  return tree;
}

/**
 * Accumulate repulsion on flat force arrays using the tree.
 *
 * For each point the tree is traversed; a cell is accepted as a single aggregate when
 * `half / distance < theta`, otherwise the traversal continues into its children.
 * `theta` therefore controls the accuracy/cost trade: 0 degenerates to the exact
 * O(n^2) sum, and 0.8-1.0 gives the usual near-logarithmic cost.
 *
 * `strength` mirrors the grid version's pair rule: a pair involving a source node
 * repels more strongly than two memory nodes. Because a cell aggregates a mix of
 * types, the aggregate's source share is tracked in `sourceWeight` and blended
 * linearly, which keeps the direction of the force identical while approximating the
 * magnitude of distant groups.
 */
export function applyBarnesHutRepulsion(
  tree: BarnesHutTree,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  isSource: Uint8Array,
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
  count: number,
  theta: number,
  strongForce: number,
  weakForce: number,
  minDistanceSquared: number,
  scratch?: Int32Array
) {
  const root = tree.root;
  // Hoist the tree arrays into locals. Each access through  is two
  // property loads plus a bounds check on the hot path, and this loop runs about
  // 4.5 million times per step at 50k points.
  const weight = tree.weight, mx = tree.mx, my = tree.my, mz = tree.mz;
  const half = tree.half, child = tree.child, sourceShare = tree.sourceShare;
  const thetaSquared = theta * theta;
  const strengthRange = strongForce - weakForce;
  // One traversal stack reused by every query: a per-node array would allocate once
  // per point per step. It is a parameter rather than module state because a captured
  //  in the hot loop forced a global lookup per push and measured slower.
  // Depth is bounded by the build cap, so a fixed buffer cannot overflow.
  const stack = scratch && scratch.length >= 1024 ? scratch : new Int32Array(1024);
  for (let i = 0; i < count; i++) {
    const x = px[i]!, y = py[i]!, z = pz[i]!;
    let ax = 0, ay = 0, az = 0;
    let top = 0;
    stack[top++] = root;
    while (top > 0) {
      const cell = stack[--top]!;
      const cellWeight = weight[cell]!;
      if (cellWeight === 0) continue;
      const dx = x - mx[cell]!;
      const dy = y - my[cell]!;
      const dz = z - mz[cell]!;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const size = half[cell]!;
      // Accept the aggregate when it subtends a small enough angle, or when the cell
      // is a leaf. The self cell always descends so a point never repels itself.
      const kids = child[cell]!;
      if (kids === -1 || size * size < thetaSquared * distanceSquared) {
        if (distanceSquared === 0) continue;
        // A pair is "strong" when either endpoint is a source. Blending by source
        // share reproduces the grid rule in both limits: share 0 -> weak, 1 -> strong.
        const blended = weakForce + strengthRange * (sourceShare[cell]! / cellWeight);
        const magnitude = (cellWeight * blended) / (distanceSquared < minDistanceSquared ? minDistanceSquared : distanceSquared);
        ax += dx * magnitude; ay += dy * magnitude; az += dz * magnitude;
        continue;
      }
      for (let k = 0; k < CHILDREN; k++) {
        if (weight[kids + k]! > 0) stack[top++] = kids + k;
      }
    }
    fx[i]! += ax; fy[i]! += ay; fz[i]! += az;
  }
}
