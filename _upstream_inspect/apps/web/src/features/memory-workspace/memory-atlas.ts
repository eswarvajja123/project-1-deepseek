import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const ATLAS_COLORS = ["#57ccff", "#ff79bc", "#ab95ff", "#53e2ba", "#ffc56c", "#fa887e", "#a0df73", "#8caaff"];
export type MemoryAtlasPosition = { x: number; y: number; color: string; hub: boolean; groupId: string; monthLabel?: string };
export type MemoryAtlasGroup = { id: string; label: string; color: string; count: number; kind: "tag" | "topic" | "month" | "archive" };
export const memorySourceMonth = (node: MemoryGraphNode) => node.sourcePath?.match(/(?:^|[_/-])(20\d{2}-(?:0[1-9]|1[0-2]))(?:[_. /-]|$)/)?.[1] ?? null;
export const memoryMonthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });

export const MIN_ATLAS_TAG_COUNT = 10;

export type MemoryAtlas = ReturnType<typeof createMemoryAtlas>;

/**
 * The cross-thread wire form of an atlas.
 *
 * Only computed data travels. The visible node set is exactly the key set of `positions`,
 * and the visible edges are the caller's own edges whose endpoints are both in that set,
 * so no id arrays and no node/edge bodies are sent: copying those back was the dominant
 * main-thread cost at 50k.
 *
 * `positions` is columnar, not `Array<[id, position]>`. Sending an array of 50,000
 * two-element arrays made the browser's structured-clone *deserialisation* of the message a
 * **269 ms** main-thread task - measured with long-task attribution, arriving before any of
 * our code could run, so no amount of yielding inside the handler could help. Flat columns
 * (one `Float64Array` of coordinates, one joined id string, one packed attribute string)
 * transfer instead of clone, and the rebuild becomes a cheap decode.
 */
export type SerializedAtlas = {
  /**
   * Node ids, joined by `UNIT_SEPARATOR`. Ids cannot contain the separator, so the split is
   * lossless without per-entry length prefixes.
   */
  positionIds: string;
  /** `x, y` pairs, two per node, in `positionIds` order. */
  positionXY: Float64Array;
  /**
   * Per-node attributes, packed as `color|hub|groupId|monthLabel` per node, joined by
   * `RECORD_SEPARATOR`. `monthLabel` is empty when absent.
   */
  positionMeta: string;
  groups: MemoryAtlasGroup[];
  topics: MemoryAtlas["topics"];
  explicitCount: number;
  semanticCount: number;
};

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

/**
 * The layout result in columnar form.
 *
 * `positions` is the 2D relaxation, `depth` the 3D one. Sending them as `[...map]` meant
 * 100,000 two-element tuples crossing the thread, and the browser clones those into a single
 * **268 ms** main-thread task before the caller's handler can run - measured with long-task
 * attribution. Columnar ids plus transferred `Float64Array`s remove it.
 */
export type SerializedLayoutResult = {
  layoutIds: string;
  /** `x, y` per entry, in `layoutIds` order. */
  positionXY: Float64Array;
  /** `x, y, z` per entry, in `layoutIds` order. */
  depthXYZ: Float64Array;
};

export function serializeLayoutResult(
  positions: Map<string, { x: number; y: number }>,
  depth: Map<string, { x: number; y: number; z: number }>
): SerializedLayoutResult {
  const ids: string[] = new Array(positions.size);
  const xy = new Float64Array(positions.size * 2);
  const xyz = new Float64Array(positions.size * 3);
  let index = 0;
  for (const [id, position] of positions) {
    ids[index] = id;
    xy[index * 2] = position.x;
    xy[index * 2 + 1] = position.y;
    const point = depth.get(id);
    xyz[index * 3] = point?.x ?? 0;
    xyz[index * 3 + 1] = point?.y ?? 0;
    xyz[index * 3 + 2] = point?.z ?? 0;
    index++;
  }
  // A depth entry with no matching position cannot occur, but if it ever did it would be
  // dropped here rather than producing a node with no 2D position.
  return { layoutIds: ids.join(UNIT_SEPARATOR), positionXY: xy, depthXYZ: xyz };
}

export function serializeAtlas(atlas: MemoryAtlas): SerializedAtlas {
  const count = atlas.positions.size;
  const ids: string[] = new Array(count);
  const meta: string[] = new Array(count);
  const xy = new Float64Array(count * 2);
  let index = 0;
  for (const [id, position] of atlas.positions) {
    ids[index] = id;
    meta[index] = `${position.color}|${position.hub ? 1 : 0}|${position.groupId}|${position.monthLabel ?? ""}`;
    xy[index * 2] = position.x;
    xy[index * 2 + 1] = position.y;
    index++;
  }
  return {
    positionIds: ids.join(UNIT_SEPARATOR),
    positionXY: xy,
    positionMeta: meta.join(RECORD_SEPARATOR),
    groups: atlas.groups,
    topics: atlas.topics,
    explicitCount: atlas.explicitCount,
    semanticCount: atlas.semanticCount
  };
}

/**
 * Rebuild the `Map`s from the columnar wire form, reattaching the caller's own objects.
 *
 * Steps are sized by entry count and drained against `timeBudgetMs` by the caller, so each
 * task stays short without a `setTimeout` clamp per small step. Decoding is now genuinely
 * cheap: the ids arrive as one string to `split`, and the coordinates as a `Float64Array`
 * that was transferred rather than cloned. The earlier array-of-tuples form cost 269 ms in
 * the browser's own message deserialisation, before this function could even run.
 */
export function* deserializeAtlasSteps(
  wire: SerializedAtlas,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  yieldEvery = 1_000,
  timeBudgetMs = 0
): Generator<{ step: number; steps: number }, MemoryAtlas> {
  // One split, then cheap per-entry work. Ids cannot contain the separator.
  const ids = wire.positionIds.length ? wire.positionIds.split(UNIT_SEPARATOR) : [];
  const meta = wire.positionMeta.length ? wire.positionMeta.split(RECORD_SEPARATOR) : [];
  const xy = wire.positionXY;
  const positions = new Map<string, MemoryAtlasPosition>();
  const positionSteps = Math.max(1, Math.ceil(ids.length / yieldEvery));
  let positionStep = 0;
  let budgetStart = performance.now();
  for (let index = 0; index < ids.length; index += yieldEvery) {
    const end = Math.min(index + yieldEvery, ids.length);
    for (let cursor = index; cursor < end; cursor++) {
      // Parse the packed meta in place. `split("|")` allocated a throwaway array per node,
      // which measured as the dominant part of a 58 ms rebuild at 50k.
      const record = meta[cursor]!;
      let bar = record.indexOf("|");
      const color = record.slice(0, bar);
      const hubEnd = record.indexOf("|", bar + 1);
      const hub = record.charCodeAt(bar + 1) === 49;
      bar = hubEnd;
      const groupEnd = record.indexOf("|", bar + 1);
      const groupId = record.slice(bar + 1, groupEnd);
      const month = record.slice(groupEnd + 1);
      positions.set(ids[cursor]!, {
        x: xy[cursor * 2]!,
        y: xy[cursor * 2 + 1]!,
        color,
        hub,
        groupId,
        ...(month ? { monthLabel: month } : {})
      });
    }
    positionStep++;
    if (timeBudgetMs > 0 && performance.now() - budgetStart < timeBudgetMs) continue;
    yield { step: positionStep, steps: positionSteps };
    budgetStart = performance.now();
  }

  // The visible node set is the key set of `positions`; keep the caller's input order so
  // draw order and neighbour highlighting stay identical to the main-thread build.
  const rebuiltNodes: MemoryGraphNode[] = [];
  const rebuiltEdges: MemoryGraphEdge[] = [];
  const total = Math.ceil(nodes.length / yieldEvery) + Math.ceil(edges.length / yieldEvery);
  let step = 0;
  budgetStart = performance.now();
  for (let index = 0; index < nodes.length; index += yieldEvery) {
    for (let cursor = index; cursor < Math.min(index + yieldEvery, nodes.length); cursor++) {
      const node = nodes[cursor]!;
      if (positions.has(node.id)) rebuiltNodes.push(node);
    }
    if (timeBudgetMs > 0 && performance.now() - budgetStart < timeBudgetMs) continue;
    yield { step: ++step, steps: total };
    budgetStart = performance.now();
  }
  for (let index = 0; index < edges.length; index += yieldEvery) {
    for (let cursor = index; cursor < Math.min(index + yieldEvery, edges.length); cursor++) {
      const edge = edges[cursor]!;
      if (positions.has(edge.source) && positions.has(edge.target)) rebuiltEdges.push(edge);
    }
    if (timeBudgetMs > 0 && performance.now() - budgetStart < timeBudgetMs) continue;
    yield { step: ++step, steps: total };
    budgetStart = performance.now();
  }
  if (!step) yield { step: 0, steps: 1 };
  return {
    nodes: rebuiltNodes,
    edges: rebuiltEdges,
    positions,
    groups: wire.groups,
    topics: wire.topics,
    explicitCount: wire.explicitCount,
    semanticCount: wire.semanticCount
  };
}

/** Colors and labels describe real taxonomy or canonical source months; links are never invented. */
/**
 * Merge the layout coordinates into the atlas positions, in bounded steps.
 *
 * Yields per slice so the caller can drain against a wall-clock budget; the merged `Map` is
 * returned by the generator rather than published early, so an interrupted load never leaves a
 * half-merged layout on screen.
 */
export function* mergeLayoutSteps(
  wire: SerializedLayoutResult,
  base: Map<string, MemoryAtlasPosition>,
  yieldEvery = 2_000
): Generator<{ step: number; steps: number }, Map<string, MemoryAtlasPosition>> {
  const ids = wire.layoutIds.length ? wire.layoutIds.split(UNIT_SEPARATOR) : [];
  const total = Math.max(1, Math.ceil(ids.length / yieldEvery));
  const merged = new Map<string, MemoryAtlasPosition>();
  let step = 0;
  for (let index = 0; index < ids.length; index += yieldEvery) {
    const end = Math.min(index + yieldEvery, ids.length);
    for (let cursor = index; cursor < end; cursor++) {
      const id = ids[cursor]!;
      const position = base.get(id);
      // Only nodes the atlas knows about are merged; the layout cannot add nodes.
      if (!position) continue;
      merged.set(id, {
        ...position,
        x: wire.positionXY[cursor * 2]!,
        y: wire.positionXY[cursor * 2 + 1]!
      });
    }
    yield { step: ++step, steps: total };
  }
  return merged;
}

/** 3D depth per node, decoded in one pass: small objects, no tuple arrays. */
export function decodeLayoutDepth(wire: SerializedLayoutResult): Map<string, MemoryPoint3DLike> {
  const ids = wire.layoutIds.length ? wire.layoutIds.split(UNIT_SEPARATOR) : [];
  const depth = new Map<string, MemoryPoint3DLike>();
  for (let index = 0; index < ids.length; index++) {
    depth.set(ids[index]!, {
      x: wire.depthXYZ[index * 3]!,
      y: wire.depthXYZ[index * 3 + 1]!,
      z: wire.depthXYZ[index * 3 + 2]!
    });
  }
  return depth;
}

type MemoryPoint3DLike = { x: number; y: number; z: number };

export function createMemoryAtlas(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], computeLayout = true, minTagCount = MIN_ATLAS_TAG_COUNT) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const topicMembers = new Map<string, Set<string>>();
  const explicit = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== "TAGGED_WITH" || byId.get(edge.target)?.type !== "TOPIC" || byId.get(edge.source)?.type !== "MEMORY") continue;
    if (edge.origin === "EXPLICIT_TAG") explicit.add(edge.target);
    if (!topicMembers.has(edge.target)) topicMembers.set(edge.target, new Set());
    topicMembers.get(edge.target)!.add(edge.source);
  }
  const topics = nodes.filter(node => node.type === "TOPIC" && (explicit.has(node.id) ? (topicMembers.get(node.id)?.size ?? 0) >= minTagCount : (topicMembers.get(node.id)?.size ?? 0) >= 2))
    .sort((a, b) => Number(explicit.has(b.id)) - Number(explicit.has(a.id)) || (topicMembers.get(b.id)?.size ?? 0) - (topicMembers.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  // Near-identical tags should not consume every color in the overview.
  const anchors: MemoryGraphNode[] = [];
  for (const topic of topics) {
    const members = topicMembers.get(topic.id)!;
    const duplicate = anchors.some(anchor => {
      const previous = topicMembers.get(anchor.id)!;
      const intersection = [...members].filter(id => previous.has(id)).length;
      return intersection / (members.size + previous.size - intersection) > 0.82;
    });
    if (!duplicate) anchors.push(topic);
    if (anchors.length === 6) break;
  }
  const assignments = new Map<string, string>();
  anchors.forEach(topic => {
    assignments.set(topic.id, topic.id);
    for (const id of topicMembers.get(topic.id)!) {
      const previous = assignments.get(id);
      if (!previous || topicMembers.get(previous)!.size > topicMembers.get(topic.id)!.size) assignments.set(id, topic.id);
    }
  });
  // Assign remaining themes by their real members, rather than by the first edge encountered.
  for (const topic of topics) {
    if (assignments.has(topic.id)) continue;
    const votes = new Map<string, number>();
    for (const id of topicMembers.get(topic.id)!) {
      const group = assignments.get(id);
      if (group) votes.set(group, (votes.get(group) ?? 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) assignments.set(topic.id, best[0]);
  }
  const topicIds = new Set(topics.map(node => node.id));
  let visibleNodes = nodes.filter(node => node.type === "MEMORY" || node.type === "SOURCE" || node.type === "ROOM" || topicIds.has(node.id));
  if (!visibleNodes.length) visibleNodes = nodes;
  const ids = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  const residualMonths = new Map<string, number>();
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    if (month) residualMonths.set(month, (residualMonths.get(month) ?? 0) + 1);
  }
  const monthSlots = 8;
  const monthKeys = [...residualMonths].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, monthSlots).map(([month]) => month).sort();
  const groupInfo = new Map<string, Pick<MemoryAtlasGroup, "label" | "kind">>(anchors.map(topic => [topic.id, { label: topic.label, kind: explicit.has(topic.id) ? "tag" : "topic" }]));
  for (const month of monthKeys) groupInfo.set(`month:${month}`, { label: memoryMonthLabel(month), kind: "month" });
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    const group = month && monthKeys.includes(month) ? `month:${month}` : "archive:other";
    assignments.set(node.id, group);
    if (!groupInfo.has(group)) groupInfo.set(group, { label: month ? "Other months" : "Other knowledge", kind: "archive" });
  }
  const buckets = new Map<string, MemoryGraphNode[]>();
  for (const node of [...visibleNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = assignments.get(node.id)!;
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group)!.push(node);
  }
  const positions = new Map<string, MemoryAtlasPosition>();
  const groups: MemoryAtlasGroup[] = [];
  const activeGroups = [...groupInfo].filter(([id]) => buckets.has(id));
  const networkPositions = computeLayout ? layoutMemoryNetwork(visibleNodes, visibleEdges) : new Map(visibleNodes.map((node, index) => [node.id, node.position?.relations ?? { x: index % 40, y: Math.floor(index / 40) }]));
  activeGroups.forEach(([groupId, info], groupIndex) => {
    const members = buckets.get(groupId)!;
    const color = info.kind === "archive" ? "#7395ad" : ATLAS_COLORS[groupIndex % ATLAS_COLORS.length]!;
    groups.push({ id: groupId, ...info, color, count: members.filter(node => node.type === "MEMORY").length });
    members.forEach(node => {
      const hub = node.type === "SOURCE" || anchors.some(anchor => anchor.id === node.id);
      const position = networkPositions.get(node.id)!;
      const month = memorySourceMonth(node);
      positions.set(node.id, { ...position, color: isMemoryCoreLabel(node.label) ? "#fff0b0" : color, hub, groupId, ...(month ? { monthLabel: memoryMonthLabel(month) } : {}) });
    });
  });
  return {
    nodes: visibleNodes, edges: visibleEdges, positions, groups,
    topics: anchors.map(node => ({ ...node, color: groups.find(group => group.id === node.id)!.color, count: topicMembers.get(node.id)!.size, explicit: explicit.has(node.id) })),
    explicitCount: explicit.size,
    semanticCount: visibleEdges.filter(edge => edge.type === "SEMANTICALLY_RELATED").length
  };
}
