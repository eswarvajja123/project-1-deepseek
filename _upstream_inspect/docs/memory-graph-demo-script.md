# Memory Graph 50k - Demo Script

Reproducible from documented commands. Every step states what to say and what the
audience should look at.

## Before the demo

```bash
npm install
npm run build -w @space/contracts
npm run build -w @space/web
npx tsx scripts/memory-graph-bench.ts 2k 10k 50k   # produces the numbers you will quote
```

Record the printed `meta` block (CPU, RAM, OS, Node version, canvas size). Quote those
exact values - do not generalise them to other machines.

Start the app, open Memory, switch to the Atlas mode, then press the **3D** toggle.

## 1. Show why the old view is expensive (60s)

Say: *"The map caps at 2,000 nodes, and every frame it reprojects, depth-sorts, and
redraws every node on the CPU."*

Point at the graph source selector and leave it on **Live**. Note the "In this map"
counter sits at 2,000.

Evidence to state, from the plan's baseline measurement:

| Size | Frame p95 (CPU) | Per-frame sort | Layout |
|---|---|---|---|
| 2k | 32.9 ms | 15.4 ms | 14.4 s |
| 10k | 123.4 ms | 75.2 ms | 120 s |
| 50k | did not complete | - | >290 s |

## 2. Load the 50k graph (45s)

Change the graph source selector to **Demo 50k**.

Say: *"Same renderer, same code path - only the data source changes. This is a
deterministic synthetic graph, so what you see is reproducible."`

Point at: "In this map" reads 50,000, and the canvas `data-renderer` attribute reads
`webgl2`.

## 3. Prove it is interactive (90s)

- Drag to rotate a full turn.
- Scroll to zoom in and out.
- Hover a node - the cursor changes and neighbours highlight.
- Click a node - the detail panel opens.
- Press arrow keys to rotate from the keyboard.
- Toggle **Titles** on and off.

Say: *"Picking is a screen-space grid now: 0.55 ms at 50k, versus 4.5 ms for the old
linear scan. That is why hover keeps up."*

## 4. Show the fallback (30s)

Say: *"If WebGL2 is unavailable we keep the existing Canvas 2D renderer instead of
showing a blank canvas. It is slower, but it still works and it is what the product
shipped before this change."*

Demonstrate by blocking WebGL2 in the browser (chrome://flags or a profile with WebGL
disabled); `data-renderer` switches to `canvas2d`.

## 5. Benchmark table (45s)

Show the measured table from `memory-graph-50k-report.md`. Two clocks, and say why:

| Size | GPU p95 draw | rAF p95 | Grid pick p95 | Linear pick p95 | Worst main-thread task | Payload |
|---|---|---|---|---|---|---|
| 2k | **3.4-3.5 ms** | 16.8 ms | 0.024 ms | 0.54 ms | none | 0.8 MB |
| 10k | **3.6-3.9 ms** | 16.9 ms | 0.071 ms | 1.44 ms | none | 3.8 MB |
| 50k | **5.2-5.3 ms** | 17.6 ms | 0.553 ms | 4.52 ms | **70-90 ms** | 19.3 MB |

Name the hardware: Intel Core i7-10510U, Intel UHD integrated GPU, Chrome, 1280x800
canvas. Then be exact about what is and is not met:

- **Met:** p95 draw <= 16.7 ms at 2k (3.5 ms), <= 33 ms at 50k/150k (5.3 ms), and picking
  <= 4 ms at 50k (0.55 ms).
- **Met:** no main-thread task > 100 ms. It was 10,796 ms before the worker split, 150 ms
  after it, and is now **70-90 ms at 50k across three runs with zero tasks over 100 ms**.
- **What closed the last stretch, and what did not:** we first believed the residual 150 ms
  was the structured clone in `postMessage`. It was not - a 4,000-object slice produced no
  long task at all. A columnar typed-array transport was built and measured **worse** (a
  0.7 ms transfer against ~1,440 ms of packing). The real cost was the **wire format**: the
  atlas sent 50,000 `[id, pos]` tuples and the worker's `done` sent 100,000 more, and the
  browser deserialises each as one uninterruptible task before any handler runs. Both
  messages are now columnar - ids as one joined string, coordinates as `Float64Array`s
  moved through the transfer list - and the receiver rebuilds against an 8 ms budget.
  No `SharedArrayBuffer` and no COOP/COEP headers were needed.

`drawMs` is `draw()` plus a 1-pixel `readPixels`, which forces the driver to finish the
queued work - it is real GPU cost. The rAF figure is the perceived cadence, and it is only
trustworthy when the headless scheduler is not pinned; a page that draws nothing measured
33.3 ms in some runs, so `drawMs` is the number the verdict rests on.

Reproduce the shipped path end-to-end (counts real long tasks and prints a MET/miss verdict):

```
BENCH_ENTRY=app-path-probe.ts npx tsx scripts/memory-graph-gpu-bench.ts 2k 10k 50k
```

Frame time alone:

```
npx tsx scripts/memory-graph-gpu-bench.ts 2k 10k 50k
```

The upload-strategy comparison that disproved the first two theories:

```
BENCH_ENTRY=upload-compare.ts npx tsx scripts/memory-graph-gpu-bench.ts 50k
```

## 6. State the remaining work (30s)

Say: *"The renderer, interaction, and the whole load path are done and measured - the worst
main-thread task at 50k is 90 ms, under the 100 ms bound, because we moved the preparation
off-thread and changed how the data crosses the thread boundary to the worker. What is left
is production hardening: the live API at 50k still parses a 19 MB JSON body, and we have
not filed the upstream PR because about twenty other PRs are already working this issue."*

If asked about context loss: say the **loss** path and the **restore handler** are both now
verified on a real driver-backed GL context in Chrome - forced loss, `preventDefault`,
`isContextLost`, inert drawing and uploading, then the shipped restore handler rebuilding
programs and VAOs, re-uploading the retained graph with `getError() === NO_ERROR`, and the
next frame drawing again. That is 20 of 21 assertions. The one that fails is Chrome emitting
`webglcontextrestored` by itself - it never did, headless or headful, with a fresh extension
handle, with an explicit `restoreContext()`, or over a 4-second poll. Be plain that the
browser's own delivery of the restore event is therefore not demonstrated on this machine.
The probe also found two real restore bugs that are now fixed: a restore used to draw zero
nodes, and used to delete dead GL names.

## What NOT to say

- Do not say the browser emitted `webglcontextrestored` - it did not. Say the restore
  *handler* was verified on a real context and that native event delivery was not.
- Do not say the issue is fully resolved. Every acceptance target is met and measured, but
  this is a hackathon deliverable, not an upstream PR, and the live API path at 50k is
  untuned.
- Do not quote these numbers as general laptop performance; it is one machine.
- Do not repeat the old "150 ms is the structured clone" explanation - it was measured and
  found wrong. The cause was the wire format.
