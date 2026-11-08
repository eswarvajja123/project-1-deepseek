# SpaceApp Memory Graph - Hackathon Pitch and Implementation Plan

**Project:** Scale the SpaceApp 3D memory graph to 50,000 nodes and 150,000 edges.  
**Source issue:** [SpaceApp #62](https://github.com/oll4com/spaceapp/issues/62)  
**Plan shape:** Five phases, sized as proportions of the event schedule so the plan can fit a 24-hour or 48-hour hackathon.  
**Status:** Proposal; confirm the latest issue and repository state before implementation.

## Executive pitch

### The problem

As an AI workspace accumulates project files, decisions, and memories, its visual map stops showing the full picture. SpaceApp currently caps the 3D overview at 2,000 nodes, and the existing view does more drawing and hit-testing work on the CPU as the graph grows. Users can lose the relationships and context that make a large memory store useful.

### The proposal

Make the full memory graph fast to explore as it grows: load a reproducible 50,000-node graph, render it smoothly, and let users search its relationships through responsive zoom, hover, selection, and labels. The demo will show the same graph before and after, with measured performance on the test machine.

### Why executives should care

The business hypothesis is that AI workspaces become more useful when accumulated context remains visible and navigable instead of becoming a black box. This project tests whether a responsive graph can help users understand what the system remembers and find relevant context sooner. We do not yet have customer research or ROI data to claim a quantified business return; validating that value should be part of the next product step.

### What we will show

1. The current graph and its 2,000-node limit.
2. A 50,000-node graph loading into the new view.
3. A user rotating, zooming, hovering, selecting a node, and focusing labels.
4. A side-by-side benchmark on the same hardware, with the baseline and new measurements clearly labeled.
5. The fallback behavior and the remaining work needed for production.

### 60-second pitch draft

> AI workspaces gain context over time, but today SpaceApp's 3D memory map stops at 2,000 nodes and becomes expensive to interact with as it grows. We're building a version that can load and explore a 50,000-node memory graph. In this demo, you'll see the same graph before and after, test the interaction yourself, and see frame-time and load measurements from the same machine. The value we want to test is simple: can people keep understanding and using their workspace memory as it grows, instead of losing visibility into it?

### Business validation after the hackathon

- Test the demo with representative users and record whether they can find a requested memory or relationship faster than with the current view.
- Measure task completion time and success rate; compare against the current graph on the same tasks.
- Ask whether the graph changes trust, comprehension, or day-to-day use. Treat these as research questions, not established outcomes.
- Use the results to decide whether to invest in productization and broader rollout.

## Technical implementation summary

The project improves the full path from loading and layout to rendering and interaction. The implementation phases below support the executive demo, but they are not the pitch itself.

## Why this approach

The issue calls for WebGL2 rendering, bounded-cost picking and labels, incremental layout, larger graph responses, a Canvas fallback, accessibility, and reproducible benchmarks. Recent issue activity also reports that graph preparation can block the main thread even when rendering is fast. The hackathon differentiator is therefore **responsive end-to-end at 50k**, not only a faster draw loop. Reproduce all reported figures on the hackathon checkout and hardware before using them as results.

There are already competing submissions on the issue. Review the current issue and pull requests at the start, then choose a distinct scope and describe how our work differs. This plan is for the hackathon deliverable; it does not assume a bounty award or that this work will be the first merged solution.

## MVP and success measures

By the end of the event, deliver a demo that:

- Loads a deterministic synthetic graph at 2k, 10k, and 50k nodes, with up to 150k edges.
- Renders the 50k graph through WebGL2 with no per-frame CPU sort of every node.
- Supports rotate, zoom, hover, click, selection, and bounded label display.
- Shows the current Canvas renderer when WebGL2 is unavailable; retain the existing 2k fallback cap.
- Preserves keyboard interaction, focus, accessible naming/loading state, and the existing data attributes.
- Reports repeatable frame-time, picking-time, load-time, and peak-memory measurements with browser, OS, GPU, canvas size, and graph size recorded.

**Target metrics from the issue:** p95 frame time <= 16.7 ms at 2k and <= 33 ms at 50k/150k; picking <= 4 ms at 50k; no main-thread task > 100 ms during load/layout. Treat these as measured targets, not promised results. Keep the admin-only route and existing node redaction if the live API is extended beyond 2k.

## Five phases

### Phase 1 - Scope, inspect, and baseline (about 10% of event time)

- Check the latest issue status, open PRs, and the current `main` branch. Identify work that is already implemented or under review.
- Build and run the current project in an owned checkout; confirm the current renderer, worker, API cap, and demo path before changing them.
- Capture baseline results at 2k and 10k; attempt 50k if the existing data path allows it. Measure draw p95, picking, load/atlas/layout time, main-thread long tasks, and peak memory.
- Fix the hackathon MVP and divide ownership. With three contributors: assign renderer, data/worker, and integration/demo; agree shared interfaces before parallel edits.

**Gate:** A short baseline and an explicit list of unimplemented MVP requirements. If the available event time or hardware cannot support the full target, preserve the 50k demo and end-to-end responsiveness goal, then clearly label any lower metric.

### Phase 2 - Make large graph data usable (about 20%)

- Add a bounded way for the 3D view to request up to 50k nodes while leaving the existing default unchanged.
- Preserve admin authorization, redaction, response contracts, and truncation information.
- Generate deterministic 2k/10k/50k synthetic graphs in demo mode so rendering can be developed without a backend or embedding provider.
- Profile JSON parsing and atlas construction. Move or batch expensive work off the main thread where it helps, while controlling memory copies and measuring peak memory.

**Gate:** Demo mode can feed 50k nodes and 150k edges into the view; a live API request, if included in the event scope, observes its hard cap and redaction rules.

### Phase 3 - Build the WebGL2 rendering vertical slice (about 35%)

- Implement a dependency-free WebGL2 path with instanced nodes and batched edges.
- Keep camera transforms, depth, colors, sizes, focus, and neighbor highlighting consistent with the existing graph.
- Avoid sorting all nodes on the CPU each frame; update GPU buffers only when graph data or layout positions change.
- Retain Canvas 2D as the no-WebGL fallback and keep GPU resource cleanup explicit.

**Gate:** A user can open the synthetic 50k graph, rotate and zoom it, and the benchmark reports actual p95 frame times on named hardware.

### Phase 4 - Finish interaction and resilience (about 20%)

- Replace the linear hit scan with a spatial index or GPU picking and measure it at 50k.
- Keep selection, hover, keyboard controls, and focus behavior working.
- Add label level-of-detail: prioritize core/source labels, preserve collision avoidance and `showTitles`, and cap labels measured/drawn per frame.
- Handle resize/device pixel ratio and test the Canvas fallback. Add context-loss recovery if time permits; otherwise document it as unfinished rather than claiming support.

**Gate:** Hover/click remain responsive, label work stays bounded, and the demo has a working fallback or a clearly disclosed remaining limitation.

### Phase 5 - Verify, demo, and present (about 15%)

- Run focused tests for camera/projection, picking, label selection, API limit/redaction, and graph integration.
- Benchmark at 2k, 10k, and 50k on the available machine; report actual hardware and results, including misses against targets.
- Prepare a short demo: current baseline, select 50k nodes, rotate/zoom, hover/select, toggle labels, show fallback, then show the benchmark table.
- Prepare a concise architecture diagram and note tradeoffs, memory limits, and work remaining after the hackathon.

**Gate:** The demo is reproducible from documented commands; the presentation distinguishes measured results from estimates and unfinished acceptance criteria.

## Suggested demo narrative

1. Show why the current graph becomes costly: CPU work and capped overview data.
2. Load the same deterministic 50k-node graph in the new view.
3. Rotate, zoom, hover, select, and toggle labels to demonstrate responsiveness.
4. Show benchmark results side by side with the baseline and name the test hardware.
5. Disable WebGL2 or show the fallback path, then state remaining production-hardening work.

## Risks and scope control

- **Large scope:** The full issue spans API, worker, renderer, input handling, accessibility, and tests. Protect the demo path first; defer polish that does not support the MVP.
- **Memory pressure:** A 50k graph payload can be tens of MiB. Measure worker transfer/copy behavior and peak memory before introducing duplicate representations.
- **Hardware variation:** Report GPU/browser details and do not generalize a single benchmark to all machines.
- **Existing submissions:** Recheck the issue and open PRs on day one; do not duplicate a solution that is already complete or under maintainer review.
- **Fallback and accessibility:** Keep the current behavior as the reference and include these in the demo checklist, not only the GPU benchmark.

## Post-hackathon production work

The hackathon demo is not automatically a complete upstream solution. Before a production PR, close every remaining Issue #62 requirement: API and contract tests, deterministic incremental layout, no main-thread task over 100 ms, WebGL context loss/restoration, full accessibility behavior, focused unit/integration tests, and performance evidence on integrated graphics.

## Code pointers

- `apps/web/src/features/memory-workspace/MemoryGraph3D.tsx`
- `apps/web/src/features/memory-workspace/memory-3d.ts`
- `apps/web/src/features/memory-workspace/memory-network-layout.worker.ts`
- `apps/web/src/features/memory-workspace/MemoryWorkspace.tsx`
- `apps/api/src/memory-graph-routes.ts`
- `packages/contracts/src/schemas.ts`
- `apps/web/tests/memory-3d.test.ts`
- `apps/api/tests/memory-graph-api.test.ts`
