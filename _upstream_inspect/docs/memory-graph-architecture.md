# Memory Graph 50k - Architecture

Two paths share one contract. WebGL2 draws when available; Canvas 2D remains the
reference fallback.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ DATA PATH (Phase 2)                                                          │
│                                                                              │
│  live archive ──► GET /api/admin/memory/graph/overview?limit=N               │
│                     • default 2,000 · max 50,000 nodes / 150,000 edges       │
│                     • admin-only · redactedNode/redactedEdge                 │
│                     • reports truncated + totalMatchingNodes                 │
│                     • selectOverviewNodes scales reserved taxonomy slots     │
│                                                                              │
│  demo mode  ──► buildDemoOverview("2k" | "10k" | "50k")                      │
│                     • deterministic synthetic generator (memory-3d-synthetic)│
│                     • returns the same response envelope as the API          │
│                                                                              │
│            └──► createMemoryAtlas()  (no cap; linear in nodes)               │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ LAYOUT (off main thread)                                                     │
│                                                                              │
│  memory-network-layout.worker.ts     requestId echoed; progress per chunk    │
│      ├─ memoryLayoutSteps()    2D generator      ┐                           │
│      └─ memoryLayout3DSteps()  3D generator      ├─ yield once per step      │
│                                                  ┘  drained until 12 ms     │
│  memory-barnes-hut.ts                                                        │
│      • octree in flat typed arrays, no per-cell objects                      │
│      • theta 0.5: 0.989 mean direction cosine vs exact O(n^2)                │
│      • replaces O(n x neighbours) pair scan: 1650 ms -> ~310-420 ms at 50k   │
│                                                                              │
│  memory-point-grid.ts   step budget + cell sizing helpers                    │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────┬──────────────────────────────────────────┐
│ PRIMARY: WebGL2 (Phase 3)         │ FALLBACK: Canvas 2D                      │
│                                   │                                          │
│ memory-3d-webgl-geometry.ts       │ per-frame: project → depth sort → draw   │
│   graph → flat buffers            │ labels via bounded LOD                   │
│                                   │                                          │
│ memory-3d-webgl.ts                │                                          │
│   • instanced node quads          │                                          │
│   • batched LINES edges           │                                          │
│   • GPU depth (no CPU sort)       │                                          │
│   • camera = uniforms only        │                                          │
│   • uploads only via setGraph     │                                          │
│   • loss: nulls handles, cancels  │                                          │
│     the event so a restore works  │                                          │
│   • restore: rebuilds programs,   │                                          │
│     VAOs, buffers, then re-uploads│                                          │
│     the graph it retained         │                                          │
│   • dispose() frees all GPU state │                                          │
└───────────────────────────────────┴──────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ INTERACTION (Phase 4)                                                        │
│                                                                              │
│  memory-3d-picking.ts   screen-space grid   rebuilt on geometry change only   │
│                         verified equal to the old linear scan               │
│  memory-3d-labels.ts    ranked + capped     64 measured / 48 drawn          │
│  MemoryGraph3D.tsx      pointer, wheel, keyboard, DPR, resize               │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Cost model (the part that decides whether 50k is feasible)

| Stage | Scales as | 50k measured | On main thread? |
|---|---|---|---|
| Parse (`JSON.parse`) | O(n + e) | 101-211 ms | worker (demo path never pays it) |
| Atlas | O(n + e) | 474-892 ms | **no** - worker |
| Layout, one step | O(n log n) | ~310-420 ms + ~85-150 ms build | **no** - worker |
| Layout, whole run | steps x one step | 45-57 s in 12 ms chunks | **no** - worker |
| Atlas wire (ids + `Float64Array` XY) | O(n) bytes, transferred | ~1 ms per slice | yes, but bounded |
| Layout `done` wire (ids + depth + XY) | O(n) bytes, transferred | ~1 ms per slice | yes, but bounded |
| Geometry build | O(n + e), once | 207-253 ms | yes, sliced |
| WebGL frame | O(1) CPU | 3.5-5.3 ms GPU-synced at 2k-50k | yes |
| Canvas frame | O(n log n) | 410-660 ms | yes |
| Picking | O(nodes in one cell) | 0.54-0.59 ms | yes |

**Layout no longer holds one task.** The Barnes-Hut step is ~6x cheaper than the pair
scan it replaced, and the remaining cost is spread across bounded worker chunks, so no
single layout task exceeds ~100 ms regardless of graph size.

**Parse and atlas no longer block the main thread as they did.** Both moved into the
layout worker: parse of the response body, atlas construction, and the deserialize step
that rebuilds the visible sets, which runs in bounded slices. Measured on the browser's own
long-task accounting, the worst main-thread task at 50k fell from **10,796 ms to 70-90 ms**,
with zero tasks over 100 ms across three consecutive runs.

**The last cost was the wire format, not the transport - this corrects an earlier claim.**
A previous revision of this document said the residual 150 ms was `postMessage` structured
clone and could only be closed with `SharedArrayBuffer`. That was **wrong**, and the
measurement that disproved it is kept in `scripts/upload-compare.ts`:

| Candidate cause | Measured | Verdict |
|---|---|---|
| Cloning the graph in `postMessage` | whole graph in one message = 243 ms task, but shipped 4,000-object slices produce **no** long task (worst slice 7.8 ms) | not the cause |
| Codes not using typed arrays (`memory-graph-columns.ts`) | transfer is free (0.7 ms) but packing columns costs ~1,440 ms of main thread | worse - built, measured, **not on the app path** |
| Arrays of tuples on the wire | `serializeAtlas` sent 50k `[id, pos]` tuples; the worker `done` sent 100k more. Each deserialises as one uninterruptible task before any handler runs | **the cause** |

Both messages are now columnar: ids are one separator-joined string, coordinates are
`Float64Array`s in the **transfer list**, and the receiver rebuilds against an 8 ms
wall-clock budget. That removed the peak; no `SharedArrayBuffer` or COOP/COEP headers are
needed. The 269 ms (`atlas-received`) and 268 ms (`merge`) long tasks were the proof.

**Canvas frame remains over budget.** 410-660 ms per frame at 50k is why WebGL2 is the
primary path rather than an optimisation; the Canvas renderer is retained as the fallback
the issue requires, at its documented 2k cap.

## Invariants preserved

- Admin-only route, `redactedNode`/`redactedEdge`, `truncated`, `totalMatchingNodes`.
- Default overview is still 2,000 nodes with a 6,000-edge budget.
- ARIA role, label, `aria-busy`, tabIndex, and every `data-*` attribute on the canvas.
- Keyboard rotate, Enter-to-select, `showTitles`, label collision avoidance.
