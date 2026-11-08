/**
 * Binary columnar transport for the graph handed to the layout worker.
 *
 * **Status: measured and rejected. Not on the app's upload path.**
 *
 * It was written to remove a suspected structured-clone cost from the graph upload, and the
 * measurement disproved the premise. At 50k nodes / 150k edges, on the reference laptop:
 *
 *   | strategy                          | longest main-thread task |
 *   |-----------------------------------|--------------------------|
 *   | one `postMessage` of the graph    | 243 ms (one clone)       |
 *   | 4,000-object slices + yield       | **none** (worst slice 7.8 ms) |
 *   | this codec: encode + transfer     | 1,672 ms                 |
 *
 * The transfer really is free - `postMessage` with a transfer list costs 0.7 ms - but packing
 * the columns costs ~1,440 ms of main thread, so the codec removed a 243 ms clone and added a
 * 1,440 ms encode. The shipped path therefore stays on sliced structured clones. Evidence:
 * `scripts/upload-compare.ts`.
 *
 * The module is kept, and kept lossless and tested, because that comparison is the argument
 * for the shipped choice and has to stay reproducible. If the graph ever reaches the client as
 * bytes (a binary API body), the encode cost is already paid and this becomes the right
 * transport; the decoder would then run in the worker as it does now.
 *
 * Why not `SharedArrayBuffer`: it avoids the copy without the encode, but requires COOP/COEP
 * response headers - a deployment decision that cannot be made from this code.
 *
 * Layout, per array (offsets in elements):
 *   nodes: ids[u32 offsets][utf8 bytes]  types[u8]  labels[u32][utf8]
 *          sourcePaths[u32][utf8] (0 length = null)  recordIds[u32][utf8] (0 = null)
 *          clusterIds[u32][utf8] (bit 31 unused; absent column = undefined)
 *          cacheRecordIds[u32][utf8] (absent column = undefined)
 *          positions[f64 * 4] (clustered x/y then relations x/y)  presence[u8] (bit 0 = clusterId,
 *          bit 1 = cacheRecordId, bit 2 = position)
 *   edges: ids[u32][utf8]  types[u8]  sources[u32][utf8]  targets[u32][utf8]
 *          origins[u8] (0 = undefined)  confidences[f32] (NaN = undefined)
 *          evidence[u32][utf8] (0 = undefined)
 *
 * Optional fields are encoded as presence flags so `undefined` and `null` stay distinct,
 * because the contracts schema treats them differently and the atlas reads `position`.
 */
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

const NODE_TYPES = ["SOURCE", "SECTION", "MEMORY", "ROOM", "PROVENANCE", "TOPIC", "CACHE_RECORD"] as const;
const EDGE_TYPES = [
  "CONTAINS",
  "BELONGS_TO_ROOM",
  "DERIVED_FROM",
  "TAGGED_WITH",
  "SEMANTICALLY_RELATED",
  "CACHED_AS",
  "DUPLICATES",
  "SUPERSEDES",
  "CONFLICTS_WITH"
] as const;
// Index 0 means "undefined" so it can share the presence-free encoding.
const EDGE_ORIGINS = ["", "EXPLICIT_TAG", "DERIVED_TFIDF", "DETERMINISTIC_TFIDF", "EMBEDDING"] as const;

type NodeType = (typeof NODE_TYPES)[number];
type EdgeType = (typeof EDGE_TYPES)[number];
type EdgeOrigin = Exclude<(typeof EDGE_ORIGINS)[number], "">;

/**
 * Growable UTF-8 column: lengths plus a byte pool.
 *
 * Strings are written straight into one pool with `TextEncoder.encodeInto`, so a 50k-label
 * column is a single allocation and thousands of small writes, not 50k separate strings
 * crossing a structured clone.
 */
function createStringColumn() {
  let lengths = new Uint32Array(256);
  let bytes = new Uint8Array(1024);
  let count = 0;
  let used = 0;
  const encoder = new TextEncoder();

  const ensureLengths = () => {
    if (count < lengths.length) return;
    const grown = new Uint32Array(lengths.length * 2);
    grown.set(lengths);
    lengths = grown;
  };
  const ensureBytes = (extra: number) => {
    if (used + extra <= bytes.length) return;
    let size = bytes.length;
    while (size < used + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(bytes.subarray(0, used));
    bytes = grown;
  };

  return {
    push(value: string) {
      ensureLengths();
      // Ids and paths are ASCII in practice; the encoder reports the real length either way.
      ensureBytes(value.length * 3);
      const written = encoder.encodeInto(value, bytes.subarray(used, used + value.length * 3));
      lengths[count++] = written.written;
      used += written.written;
    },
    toWire() {
      return {
        lengths: lengths.slice(0, count),
        bytes: bytes.slice(0, used)
      };
    }
  };
}

function readStringColumn(lengths: Uint32Array, bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const out: string[] = new Array(lengths.length);
  let offset = 0;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!;
    out[index] = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}

/** Enum column. Unknown values are a contract violation, not something to skip. */
function enumIndex<T extends readonly string[]>(values: T, value: string, what: string) {
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`Unknown ${what} in graph: ${value}`);
  return index;
}

export type NodeColumns = {
  ids: string[];
  types: Uint8Array;
  labels: string[];
  sourcePaths: string[];
  recordIds: string[];
  /** Undefined entries mean the field was absent, as opposed to an explicit null. */
  clusterIds: (string | null | undefined)[];
  cacheRecordIds: (string | null | undefined)[];
  positions: Float64Array;
  presence: Uint8Array;
};

export type EdgeColumns = {
  ids: string[];
  types: Uint8Array;
  sources: string[];
  targets: string[];
  origins: Uint8Array;
  confidences: Float32Array;
  evidence: (string | undefined)[];
};

/** Columnar form of a graph, ready to transfer. Every buffer is transferable. */
export type GraphColumns = {
  nodeCount: number;
  edgeCount: number;
  nodes: {
    ids: { lengths: Uint32Array; bytes: Uint8Array };
    types: Uint8Array;
    labels: { lengths: Uint32Array; bytes: Uint8Array };
    sourcePaths: { lengths: Uint32Array; bytes: Uint8Array };
    recordIds: { lengths: Uint32Array; bytes: Uint8Array };
    clusterIds: { lengths: Uint32Array; bytes: Uint8Array };
    cacheRecordIds: { lengths: Uint32Array; bytes: Uint8Array };
    positions: Float64Array;
    presence: Uint8Array;
  };
  edges: {
    ids: { lengths: Uint32Array; bytes: Uint8Array };
    types: Uint8Array;
    sources: { lengths: Uint32Array; bytes: Uint8Array };
    targets: { lengths: Uint32Array; bytes: Uint8Array };
    origins: Uint8Array;
    confidences: Float32Array;
    evidence: { lengths: Uint32Array; bytes: Uint8Array };
  };
};

const PRESENCE_CLUSTER = 1;
const PRESENCE_CACHE = 2;
const PRESENCE_POSITION = 4;

/** Pack a graph into columns. The result's buffers are what `postMessage` transfers. */
export function encodeGraphColumns(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): GraphColumns {
  const nodeIds = createStringColumn();
  const nodeTypes = new Uint8Array(nodes.length);
  const labels = createStringColumn();
  const sourcePaths = createStringColumn();
  const recordIds = createStringColumn();
  const clusterIds = createStringColumn();
  const cacheRecordIds = createStringColumn();
  const positions = new Float64Array(nodes.length * 4);
  const presence = new Uint8Array(nodes.length);

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    nodeIds.push(node.id);
    nodeTypes[index] = enumIndex(NODE_TYPES, node.type, "node type");
    labels.push(node.label);
    // A zero-length entry reads back as null: paths and record ids are never legitimately "".
    sourcePaths.push(node.sourcePath ?? "");
    recordIds.push(node.recordId ?? "");
    if (node.clusterId !== undefined) {
      presence[index]! |= PRESENCE_CLUSTER;
      clusterIds.push(node.clusterId ?? "");
    } else {
      clusterIds.push("");
    }
    if (node.cacheRecordId !== undefined) {
      presence[index]! |= PRESENCE_CACHE;
      cacheRecordIds.push(node.cacheRecordId ?? "");
    } else {
      cacheRecordIds.push("");
    }
    if (node.position !== undefined) {
      presence[index]! |= PRESENCE_POSITION;
      // The contract carries two 2D layouts per node: the clustered view and the relations
      // view. Both are needed; the 2D renderer picks between them.
      positions[index * 4] = node.position.clustered.x;
      positions[index * 4 + 1] = node.position.clustered.y;
      positions[index * 4 + 2] = node.position.relations.x;
      positions[index * 4 + 3] = node.position.relations.y;
    }
  }

  const edgeIds = createStringColumn();
  const edgeTypes = new Uint8Array(edges.length);
  const sources = createStringColumn();
  const targets = createStringColumn();
  const origins = new Uint8Array(edges.length);
  const confidences = new Float32Array(edges.length);
  const evidence = createStringColumn();

  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]!;
    edgeIds.push(edge.id);
    edgeTypes[index] = enumIndex(EDGE_TYPES, edge.type, "edge type");
    sources.push(edge.source);
    targets.push(edge.target);
    // 0 is the "undefined" slot, so origins need no presence array.
    origins[index] = edge.origin === undefined ? 0 : enumIndex(EDGE_ORIGINS, edge.origin, "edge origin");
    // NaN is the "undefined" slot for confidence, matching how the contract leaves it optional.
    confidences[index] = edge.confidence === undefined ? Number.NaN : edge.confidence;
    evidence.push(edge.evidence ?? "");
  }

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: {
      ids: nodeIds.toWire(),
      types: nodeTypes,
      labels: labels.toWire(),
      sourcePaths: sourcePaths.toWire(),
      recordIds: recordIds.toWire(),
      clusterIds: clusterIds.toWire(),
      cacheRecordIds: cacheRecordIds.toWire(),
      positions,
      presence
    },
    edges: {
      ids: edgeIds.toWire(),
      types: edgeTypes,
      sources: sources.toWire(),
      targets: targets.toWire(),
      origins,
      confidences,
      evidence: evidence.toWire()
    }
  };
}

/** Rebuild columns into the contract's node/edge objects, inside the worker. */
export function decodeGraphColumns(columns: GraphColumns): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodeIds = readStringColumn(columns.nodes.ids.lengths, columns.nodes.ids.bytes);
  const labels = readStringColumn(columns.nodes.labels.lengths, columns.nodes.labels.bytes);
  const sourcePaths = readStringColumn(columns.nodes.sourcePaths.lengths, columns.nodes.sourcePaths.bytes);
  const recordIds = readStringColumn(columns.nodes.recordIds.lengths, columns.nodes.recordIds.bytes);
  const clusterIds = readStringColumn(columns.nodes.clusterIds.lengths, columns.nodes.clusterIds.bytes);
  const cacheRecordIds = readStringColumn(columns.nodes.cacheRecordIds.lengths, columns.nodes.cacheRecordIds.bytes);

  const nodes: MemoryGraphNode[] = new Array(columns.nodeCount);
  for (let index = 0; index < columns.nodeCount; index++) {
    const flags = columns.nodes.presence[index]!;
    const node: MemoryGraphNode = {
      id: nodeIds[index]!,
      type: NODE_TYPES[columns.nodes.types[index]!]! as NodeType,
      label: labels[index]!,
      sourcePath: sourcePaths[index] || null,
      recordId: recordIds[index] || null
    };
    if (flags & PRESENCE_CLUSTER) node.clusterId = clusterIds[index] || null;
    if (flags & PRESENCE_CACHE) node.cacheRecordId = cacheRecordIds[index] || null;
    if (flags & PRESENCE_POSITION) {
      node.position = {
        clustered: { x: columns.nodes.positions[index * 4]!, y: columns.nodes.positions[index * 4 + 1]! },
        relations: { x: columns.nodes.positions[index * 4 + 2]!, y: columns.nodes.positions[index * 4 + 3]! }
      };
    }
    nodes[index] = node;
  }

  const edgeIds = readStringColumn(columns.edges.ids.lengths, columns.edges.ids.bytes);
  const sources = readStringColumn(columns.edges.sources.lengths, columns.edges.sources.bytes);
  const targets = readStringColumn(columns.edges.targets.lengths, columns.edges.targets.bytes);
  const evidence = readStringColumn(columns.edges.evidence.lengths, columns.edges.evidence.bytes);

  const edges: MemoryGraphEdge[] = new Array(columns.edgeCount);
  for (let index = 0; index < columns.edgeCount; index++) {
    const originIndex = columns.edges.origins[index]!;
    const confidence = columns.edges.confidences[index]!;
    const edge: MemoryGraphEdge = {
      id: edgeIds[index]!,
      type: EDGE_TYPES[columns.edges.types[index]!]! as EdgeType,
      source: sources[index]!,
      target: targets[index]!
    };
    if (originIndex !== 0) edge.origin = EDGE_ORIGINS[originIndex]! as EdgeOrigin;
    if (!Number.isNaN(confidence)) edge.confidence = confidence;
    if (evidence[index]) edge.evidence = evidence[index];
    edges[index] = edge;
  }

  return { nodes, edges };
}

/**
 * Every `ArrayBuffer` in the encoding, deduplicated.
 *
 * Passed as `postMessage`'s transfer list so the buffers move instead of being copied. Two
 * columns never share a buffer, but collecting with a `Set` keeps this safe if they ever do.
 */
export function graphColumnBuffers(columns: GraphColumns): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView) => seen.add(view.buffer as ArrayBuffer);
  const addStringColumn = (column: { lengths: Uint32Array; bytes: Uint8Array }) => {
    add(column.lengths);
    add(column.bytes);
  };

  for (const column of [
    columns.nodes.ids, columns.nodes.labels, columns.nodes.sourcePaths,
    columns.nodes.recordIds, columns.nodes.clusterIds, columns.nodes.cacheRecordIds,
    columns.edges.ids, columns.edges.sources, columns.edges.targets, columns.edges.evidence
  ]) addStringColumn(column);

  add(columns.nodes.types);
  add(columns.nodes.positions);
  add(columns.nodes.presence);
  add(columns.edges.types);
  add(columns.edges.origins);
  add(columns.edges.confidences);

  return [...seen];
}
