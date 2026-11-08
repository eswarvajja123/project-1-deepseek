import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, ClipboardCheck, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, decodeLayoutDepth, deserializeAtlasSteps, mergeLayoutSteps, type MemoryAtlas, type MemoryAtlasPosition, type SerializedAtlas } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

import { MemoryGraph3D } from "./MemoryGraph3D.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import { buildDemoOverview, nextDemoGraphSize, type DemoGraphSize } from "./memory-3d-demo.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import { MemoryReviewView } from "./MemoryReviewView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

/**
 * Above this node count the synchronous first-paint atlas is truncated: building it for
 * 50k nodes costs 474-892 ms on the main thread, which breaks Issue #62's 100 ms budget.
 * The worker immediately replaces it with the complete atlas, so the truncation is only
 * ever visible for a frame.
 */
const SYNC_ATLAS_NODE_LIMIT = 2_000;

/**
 * Upload the graph to the worker in slices, yielding between them.
 *
 * Measured at 50k: one `postMessage` of the whole graph is a single 243 ms main-thread task,
 * while 4,000-object slices with a yield between them produce **no** long task at all (worst
 * slice 7.8 ms). A columnar typed-array encoding was also built and measured - the transfer
 * itself costs 0.7 ms, but packing the columns costs ~1,440 ms on the main thread, so it was
 * rejected: it removed a 243 ms clone and added a 1,440 ms encode. Structured-clone slicing
 * of objects is the cheapest correct strategy here.
 *
 * `workers/../memory-graph-columns.ts` is retained as the measured alternative and is
 * exercised by `tests/memory-graph-columns.test.ts`; it is not on the app's path.
 */
const UPLOAD_CHUNK = 4_000;

async function uploadGraphInChunks(
  worker: Worker,
  nodes: Parameters<typeof deserializeAtlasSteps>[1],
  edges: Parameters<typeof deserializeAtlasSteps>[2],
  requestId: number,
  isCancelled: () => boolean
) {
  for (let index = 0; index < nodes.length; index += UPLOAD_CHUNK) {
    if (isCancelled()) return;
    worker.postMessage({ requestId, chunk: { nodes: nodes.slice(index, index + UPLOAD_CHUNK) } });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  for (let index = 0; index < edges.length; index += UPLOAD_CHUNK) {
    if (isCancelled()) return;
    const final = index + UPLOAD_CHUNK >= edges.length;
    worker.postMessage({
      requestId,
      chunk: { edges: edges.slice(index, index + UPLOAD_CHUNK), ...(final ? { final: true } : {}) }
    });
    if (!final) await new Promise(resolve => setTimeout(resolve, 0));
  }
  // A graph with no edges still needs its terminator.
  if (!edges.length) worker.postMessage({ requestId, chunk: { final: true } });
}

/**
 * Rebuild the atlas `Map`s from the worker's wire form, one bounded step per macrotask.
 *
 * `deserializeAtlasSteps` already yields in slices; the `setTimeout(0)` between slices is
 * what actually returns control to the browser, so a 50k atlas becomes ~13 short tasks
 * instead of one long one. `isCancelled` stops the drain when the effect tears down.
 */
/**
 * Drain the atlas rebuild, yielding only when a wall-clock budget is spent.
 *
 * Yielding after every small step was the wrong shape: each `setTimeout(0)` is clamped and
 * costs a few ms, so a 1,000-entry step made the rebuild slower in total and push the longest
 * task around unpredictably. Draining against a budget keeps one task bounded (~8-16 ms) and
 * the task count low, which is what the worker already does for layout.
 */
const DESERIALIZE_BUDGET_MS = 8;

async function drainDeserialize(
  wire: SerializedAtlas,
  nodes: Parameters<typeof deserializeAtlasSteps>[1],
  edges: Parameters<typeof deserializeAtlasSteps>[2],
  isCancelled: () => boolean,
  onDone: (atlas: MemoryAtlas) => void,
  onError: (message: string) => void
) {
  const iterator = deserializeAtlasSteps(wire, nodes, edges, 1_000, DESERIALIZE_BUDGET_MS);
  try {
    for (;;) {
      const next = iterator.next();
      if (next.done) {
        if (!isCancelled()) onDone(next.value);
        return;
      }
      if (isCancelled()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (!isCancelled()) onError(error instanceof Error ? error.message : "The memory atlas could not be prepared.");
  }
}

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar" | "review";
}) {
  const [selectedMode, setWorkspaceMode] = useState<"atlas" | "calendar" | "review">(initialMode);
  // Mobile shows the Calendar list only: no graph canvas (ADR-006) and no review panels.
  const workspaceMode = shellMode === "mobile" ? "calendar" : selectedMode;
  const [view3D, setView3D] = useState(false);
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | null>(null);
  // Demo mode swaps the live overview for a deterministic 2k/10k/50k graph, so the 3D
  // view can be demonstrated and benchmarked without an archive that large.
  const [demoSize, setDemoSize] = useState<DemoGraphSize | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryGraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setSelectedNodeId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (selectedNodeId) closeDetail();
        else if (queryDraft) { setQueryDraft(""); setQuery(""); }
        else onClose();
      }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLElement && event.target.isContentEditable)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDetail, onClose, queryDraft, selectedNodeId]);

  useEffect(() => {
    if (workspaceMode !== "atlas") return;
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    // Demo mode bypasses the archive so a reproducible 50k graph can be shown.
    if (demoSize) {
      setGraph(buildDemoOverview(demoSize));
      setLoading(false);
      return () => { active = false; };
    }
    // Search covers the entire archive; removing the month picker must not hide old memories.
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS" })
      .then(payload => { if (active) setGraph(payload); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, closeDetail, demoSize]);

  useEffect(() => () => { detailRequest.current++; }, []);
  const selectNode = useCallback((nodeId: string) => {
    const request = ++detailRequest.current;
    setSelectedNodeId(nodeId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void api.memoryGraphNode(nodeId)
      .then(payload => { if (request === detailRequest.current) setDetail(payload); })
      .catch(caught => { if (request === detailRequest.current) setDetailError(caught instanceof Error ? caught.message : "This memory could not be opened."); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  }, []);

  // The atlas and the JSON parse are normally done in the worker: on the 50k graph
  // atlas construction alone measured 474-892 ms and `JSON.parse` of the response
  // another 517-862 ms, both over the 100 ms main-thread budget. The synchronous atlas
  // below is a first-paint placeholder, so it is capped: a large graph would blow the
  // budget on the main thread, and it is replaced by the worker result moments later.
  const fallbackInput = useMemo(() => {
    const allNodes = graph?.data.nodes ?? [];
    const allEdges = graph?.data.edges ?? [];
    if (allNodes.length <= SYNC_ATLAS_NODE_LIMIT) return { nodes: allNodes, edges: allEdges };
    const nodes = allNodes.slice(0, SYNC_ATLAS_NODE_LIMIT);
    const kept = new Set(nodes.map(node => node.id));
    return { nodes, edges: allEdges.filter(edge => kept.has(edge.source) && kept.has(edge.target)) };
  }, [graph]);
  const fallbackAtlas = useMemo(() => createMemoryAtlas(fallbackInput.nodes, fallbackInput.edges, false), [fallbackInput]);
  const [workerAtlas, setWorkerAtlas] = useState<{ source: typeof fallbackAtlas; atlas: typeof fallbackAtlas } | null>(null);
  const atlas = workerAtlas && workerAtlas.source === fallbackAtlas ? workerAtlas.atlas : fallbackAtlas;
  const [layoutProgress, setLayoutProgress] = useState<{ phase: "flat" | "depth"; step: number; steps: number } | null>(null);
  const [layout, setLayout] = useState<{ atlas: typeof atlas; positions: Map<string, MemoryAtlasPosition>; depth: Map<string, MemoryPoint3D> } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || !graph?.data.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    // Echo the request id so a result for a superseded graph is discarded instead of
    // overwriting a newer layout.
    const requestId = Date.now();
    // Set on teardown so a chunked atlas rebuild stops touching state after unmount.
    let cancelled = false;
    const fail = (reason: string) => setError(`Memory layout could not be calculated: ${reason}`);
    type LayoutMessage =
      | { type: "progress"; requestId?: number; phase: "flat" | "depth"; step: number; steps: number }
      | { type: "atlas"; requestId?: number; atlas: SerializedAtlas }
      | { type: "done"; requestId?: number; layoutIds: string; positionXY: Float64Array; depthXYZ: Float64Array };
    let builtAtlas: typeof fallbackAtlas | null = null;
    worker.onmessage = async (event: MessageEvent<LayoutMessage>) => {
      const message = event.data;
      if (message.requestId !== undefined && message.requestId !== requestId) { worker.terminate(); return; }
      if (message.type === "progress") {
        // The worker reports every bounded chunk so the view can show real progress
        // instead of an indefinite spinner during a 50k layout.
        setLayoutProgress({ phase: message.phase, step: message.step + 1, steps: message.steps });
        return;
      }
      if (message.type === "atlas") {
        // Paint the 2D map as soon as the atlas exists, rather than waiting for the
        // 3D relaxation, which takes seconds on a large graph. Rebuilding the position
        // Map runs in bounded steps so this handler cannot become a long task.
        void drainDeserialize(message.atlas, graph!.data.nodes, graph!.data.edges, () => cancelled, atlasBuilt => {
          builtAtlas = atlasBuilt;
          setWorkerAtlas({ source: fallbackAtlas, atlas: atlasBuilt });
        }, setError);
        return;
      }
      const finalAtlas = builtAtlas ?? fallbackAtlas;
      setLayoutProgress(null);
      // The layout result arrives columnar (ids + transferred coordinate arrays), because an
      // array of 100,000 id/tuple pairs was a single 268 ms clone on the main thread. Merge it
      // into the atlas positions in bounded steps, then publish once.
      const merged = new Map(finalAtlas.positions);
      const merger = mergeLayoutSteps(message, finalAtlas.positions, 2_000);
      const MERGE_BUDGET_MS = 8;
      let mergeStart = performance.now();
      for (;;) {
        if (cancelled) return;
        const next = merger.next();
        if (next.done) break;
        if (performance.now() - mergeStart >= MERGE_BUDGET_MS) {
          await new Promise(resolve => setTimeout(resolve, 0));
          mergeStart = performance.now();
        }
      }
      if (cancelled) return;
      setLayout({ atlas: finalAtlas, depth: decodeLayoutDepth(message), positions: merged });
      worker.terminate();
    };
    worker.onerror = event => { fail(event.message || "worker unavailable"); worker.terminate(); };
    setLayoutProgress(null);
    // Sliced upload: one `postMessage` of the whole graph is a single 243 ms task at 50k,
    // while 4k slices with a yield between them produce no long task (worst slice 7.8 ms).
    // The worker builds nothing until `final` arrives.
    void uploadGraphInChunks(worker, graph!.data.nodes, graph!.data.edges, requestId, () => cancelled);
    return () => { cancelled = true; worker.terminate(); };
  }, [workspaceMode, graph]);
  const layoutPending = typeof Worker !== "undefined" && atlas.nodes.length > 0 && layout?.atlas !== atlas;
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const summary = graph?.data.summary;
  const memoryCount = atlas.nodes.filter(node => node.type === "MEMORY").length;
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={layout?.atlas === atlas} data-layout-root-x={atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size} data-demo-size={demoSize ?? "live"}>
      <header className="memory-atlas-header memory-workspace-header">
        <div className="memory-atlas-brand">
          {workspaceMode === "calendar" ? <CalendarIcon aria-hidden="true" /> : workspaceMode === "review" ? <ClipboardCheck aria-hidden="true" /> : <Network aria-hidden="true" />}
          <h2>Memory</h2>
          <span>{workspaceMode.toUpperCase()}</span>
        </div>
        <form className="memory-workspace-controls memory-workspace-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); }}>
          <label className="memory-search-input">
            <Search aria-hidden="true" />
            <input ref={searchRef} type="search" name="memoryQuery" aria-label="Search canonical memory" placeholder="Search your memory…" value={queryDraft} onChange={event => setQueryDraft(event.currentTarget.value)} />
            {queryDraft ? <button type="button" aria-label="Clear memory search" onClick={() => { setQueryDraft(""); setQuery(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></button> : <kbd>/</kbd>}
          </label>
        </form>
        <div className="memory-atlas-actions">
          {shellMode === "mobile" ? null : <div className="memory-workspace-mode-selector" role="group" aria-label="Memory mode switcher">
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "atlas" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "atlas"}
              onClick={() => { setWorkspaceMode("atlas"); closeDetail(); }}
            >
              <Network aria-hidden="true" /> Atlas
            </button>
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "calendar" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "calendar"}
              onClick={() => { setWorkspaceMode("calendar"); closeDetail(); }}
            >
              <CalendarIcon aria-hidden="true" /> Calendar
            </button>
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "review" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "review"}
              onClick={() => { setWorkspaceMode("review"); closeDetail(); }}
            >
              <ClipboardCheck aria-hidden="true" /> Review
            </button>
          </div>}
          {workspaceMode === "atlas" ? (
            <div className="memory-atlas-view-controls" aria-label="Memory view controls">
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => setView3D(value => !value)}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <button type="button" aria-label="Reset 3D memory view" onClick={() => setReset3D(value => value + 1)}>↺</button> : null}
              {/* Deterministic graphs for the 50k demo. A cycling button rather than a
                  select: the map view offers only search, toggles and the map itself. */}
              <button
                type="button"
                aria-label={demoSize ? `Graph source: demo ${demoSize}. Activate to switch.` : "Graph source: live archive. Activate to switch."}
                data-demo-size={demoSize ?? "live"}
                onClick={() => setDemoSize(nextDemoGraphSize(demoSize))}
              >
                <span aria-hidden="true">◎</span> {demoSize ? `Demo ${demoSize}` : "Live"}
              </button>
            </div>
          ) : null}
          <button type="button" className="icon-button memory-atlas-close" aria-label="Close memory workspace" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>
      <div className="memory-atlas-stage memory-workspace-body">
        {workspaceMode === "calendar" ? (
          <MemoryCalendarView
            onSelectNode={selectNode}
            selectedNodeId={selectedNodeId}
            onCloseDetail={closeDetail}
          />
        ) : workspaceMode === "review" ? (
          <MemoryReviewView onOpenRecord={selectNode} />
        ) : (
          <>
            <div className="memory-atlas-intro" aria-label="Memory overview">
              <span className="memory-atlas-eyebrow"><i /> YOUR KNOWLEDGE, CONNECTED</span>
              <h3>Everything you know.<br /><em>Connected.</em></h3>
              <p>Your files, memories and<br />their real connections.</p>
              <dl className="memory-atlas-stats">
                <div><dt>Memories</dt><dd>{summary?.recordCount.toLocaleString() ?? "—"}</dd></div>
                <div><dt>In this map</dt><dd>{memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{atlas.edges.length.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlas.nodes.filter(node => node.type === "SOURCE").length} data-source-link-count={atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length} data-root-visible={atlas.nodes.some(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))} data-raw-node-count={graph?.data.nodes.length ?? 0} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={atlas.edges.length}>
              <div className="memory-atlas-2d" hidden={view3D}><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div>
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={layout?.atlas === atlas ? layout.depth : new Map()} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} layoutProgress={layoutProgress} resetToken={reset3D} /> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{atlas.semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {graph?.data.isStale ? <div className="memory-atlas-stale" role="status"><AlertTriangle aria-hidden="true" /> Snapshot awaiting refresh</div> : null}
            {query && !loading && !error ? <div className="memory-atlas-search-status" role="status">{atlas.nodes.length ? `${atlas.nodes.length.toLocaleString()} matching nodes` : "No memories found. Try another search."}</div> : null}
          </>
        )}
        {selectedNodeId ? <div className="memory-atlas-detail">
          {detailError ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{detailError}</span><button onClick={closeDetail}>Close</button></div> : <MemoryNodeDetail detail={detail} loading={detailLoading} onClose={closeDetail} onSelectNode={selectNode} backLabel={workspaceMode === "calendar" ? "Back to day memories" : undefined} />}
        </div> : null}
      </div>
    </section>
  );
}
