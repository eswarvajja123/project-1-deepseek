import { describe, expect, it } from "vitest";
import { createPickIndex } from "../src/features/memory-workspace/memory-3d-picking.js";
import { selectMemoryLabels, DEFAULT_LABEL_BUDGET, type LabelCandidate } from "../src/features/memory-workspace/memory-3d-labels.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { buildSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-3d-synthetic.js";

describe("spatial pick index", () => {
  it("finds a node under the cursor and misses empty space", () => {
    const index = createPickIndex(48);
    index.rebuild([
      { id: "a", x: 100, y: 100, radius: 2 },
      { id: "b", x: 400, y: 300, radius: 2 }
    ]);
    expect(index.pick(100, 100)).toBe("a");
    expect(index.pick(102, 101)).toBe("a");
    expect(index.pick(250, 200)).toBeNull();
  });

  it("prefers the last-drawn node when two overlap", () => {
    const index = createPickIndex(48);
    index.rebuild([
      { id: "under", x: 100, y: 100, radius: 8 },
      { id: "over", x: 101, y: 101, radius: 8 }
    ]);
    expect(index.pick(100, 100)).toBe("over");
  });

  it("honours the minimum hit reach for very small nodes", () => {
    const index = createPickIndex(48);
    index.rebuild([{ id: "tiny", x: 50, y: 50, radius: 0.2 }]);
    // Reach is max(7, radius + 3), so a 6px offset still hits.
    expect(index.pick(56, 50)).toBe("tiny");
    expect(index.pick(58, 50)).toBeNull();
  });

  it("tests far fewer nodes than a linear scan at 2k", () => {
    const { nodes, edges } = buildSyntheticMemoryGraph(2000, 6000);
    const atlas = createMemoryAtlas(nodes, edges, false);
    const projected = atlas.nodes.map((node, i) => ({
      id: node.id,
      x: (i * 37) % 1280,
      y: (i * 61) % 800,
      radius: 2
    }));
    const index = createPickIndex(48);
    index.rebuild(projected);
    index.pick(640, 400);
    // A linear scan would test all 2,000 nodes.
    expect(index.lastTested).toBeLessThan(projected.length);
  });

  it("matches a linear scan on every probe of a real layout", () => {
    const { nodes, edges } = buildSyntheticMemoryGraph(800, 2400);
    const atlas = createMemoryAtlas(nodes, edges, false);
    const projected = atlas.nodes.map((node, i) => ({
      id: node.id,
      x: 100 + ((i * 17) % 500),
      y: 80 + ((i * 29) % 400),
      radius: 2
    }));
    const index = createPickIndex(48);
    index.rebuild(projected);
    const linear = (x: number, y: number) =>
      [...projected].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
    let checked = 0;
    for (let x = 90; x < 600; x += 23) {
      for (let y = 70; y < 480; y += 19) {
        expect(index.pick(x, y)).toBe(linear(x, y));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("bounded label selection", () => {
  const candidate = (i: number, overrides: Partial<LabelCandidate> = {}): LabelCandidate => ({
    id: `n-${i}`,
    label: `node ${i}`,
    type: "MEMORY",
    x: 20 + (i % 40) * 12,
    y: 20 + Math.floor(i / 40) * 18,
    ...overrides
  });

  const base = {
    focusId: null as string | null,
    showTitles: true,
    zoom: 2,
    width: 1280,
    height: 800,
    measure: (text: string) => text.length * 6
  };

  it("returns nothing when titles are off", () => {
    expect(selectMemoryLabels({ ...base, showTitles: false, candidates: [candidate(0)] })).toEqual([]);
  });

  it("never measures or draws more than the budget", () => {
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(i));
    let measured = 0;
    const selected = selectMemoryLabels({
      ...base,
      candidates,
      measure: (text) => { measured++; return text.length * 6; }
    });
    expect(measured).toBeLessThanOrEqual(DEFAULT_LABEL_BUDGET.maxMeasured);
    expect(selected.length).toBeLessThanOrEqual(DEFAULT_LABEL_BUDGET.maxDrawn);
  });

  it("keeps the focused node's label when the measured budget is tight", () => {
    const candidates = Array.from({ length: 300 }, (_, i) => candidate(i));
    // Only a handful of measurements are allowed, so ranking decides who is measured.
    const selected = selectMemoryLabels({
      ...base,
      candidates,
      focusId: "n-299",
      budget: { maxMeasured: 4, maxDrawn: 4 },
      measure: (text) => text.length * 6
    });
    expect(selected.some(label => label.id === "n-299")).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(4);
  });

  it("avoids overlapping labels", () => {
    // Ten candidates 2px apart vertically all collide with their neighbours.
    const stacked = Array.from({ length: 10 }, (_, i) => candidate(0, { id: `s-${i}`, x: 40, y: 100 + i * 2 }));
    const selected = selectMemoryLabels({ ...base, candidates: stacked });
    // Accepted labels must be at least 16px apart, so no two may overlap.
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        expect(Math.abs(selected[i]!.y - selected[j]!.y)).toBeGreaterThanOrEqual(16);
      }
    }
    expect(selected.length).toBeLessThan(stacked.length);
  });

  it("hides memory labels when zoomed out", () => {
    const candidates = [
      { id: "memory-node", label: "node 0", type: "MEMORY" as const, x: 20, y: 20 },
      { id: "source-node", label: "readme.md", type: "SOURCE" as const, x: 300, y: 300 }
    ];
    const selected = selectMemoryLabels({ ...base, candidates, zoom: 1 });
    // At zoom < 1.6 only sources (and the focused node) keep labels.
    expect(selected.map(label => label.id)).toEqual(["source-node"]);
  });
});
