/**
 * Screen-space picking index for the 3D memory graph.
 *
 * The Canvas renderer hit-tested by scanning every projected node after each frame
 * (`[...points].reverse().find(...)`), which is O(n) per pointer move. This index
 * buckets projected nodes into a uniform screen grid so a hit test touches only the
 * few nodes near the cursor.
 *
 * The index is rebuilt only when the projection changes, never per pointer event.
 */

export type PickNode = { id: string; x: number; y: number; radius: number };

export type PickIndex = {
  /** Rebuild from the projected nodes for the current frame. */
  rebuild(nodes: readonly PickNode[]): void;
  /** Return the topmost node within its hit radius of `(x, y)`, or null. */
  pick(x: number, y: number): string | null;
  /** Number of nodes the last `pick` tested, for the demo's instrumentation. */
  readonly lastTested: number;
};

export function createPickIndex(cellSize = 48): PickIndex {
  let cells = new Map<number, PickNode[]>();
  let lastTested = 0;
  // Track draw order so the last-drawn node (topmost) wins, matching the Canvas scan.
  let order = new Map<string, number>();

  const key = (cx: number, cy: number) => cx * 100003 + cy;

  return {
    get lastTested() { return lastTested; },
    rebuild(nodes) {
      cells = new Map();
      order = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        order.set(node.id, i);
        // Insert into every cell the hit radius overlaps so edge-adjacent picks work.
        const reach = Math.max(7, node.radius + 3);
        const minX = Math.floor((node.x - reach) / cellSize);
        const maxX = Math.floor((node.x + reach) / cellSize);
        const minY = Math.floor((node.y - reach) / cellSize);
        const maxY = Math.floor((node.y + reach) / cellSize);
        for (let cx = minX; cx <= maxX; cx++) for (let cy = minY; cy <= maxY; cy++) {
          const cellKey = key(cx, cy);
          const bucket = cells.get(cellKey);
          if (bucket) bucket.push(node);
          else cells.set(cellKey, [node]);
        }
      }
    },
    pick(x, y) {
      lastTested = 0;
      const bucket = cells.get(key(Math.floor(x / cellSize), Math.floor(y / cellSize)));
      if (!bucket) return null;
      let best: PickNode | null = null;
      let bestOrder = -1;
      for (const node of bucket) {
        lastTested++;
        const dx = node.x - x, dy = node.y - y;
        if (Math.hypot(dx, dy) >= Math.max(7, node.radius + 3)) continue;
        const drawn = order.get(node.id) ?? -1;
        if (drawn > bestOrder) { best = node; bestOrder = drawn; }
      }
      return best?.id ?? null;
    }
  };
}
