/**
 * Measures real WebGL2 frame time in a browser, for the 50k memory graph.
 *
 * The Node benchmark (`scripts/memory-graph-bench.ts`) can only time CPU-side work: it has
 * no GPU. Issue #62's frame-time target therefore stayed unproven. This harness closes
 * that gap by driving an installed Chrome over the DevTools protocol, running the real
 * renderer from `memory-3d-webgl.ts`, and reading back measured frame intervals.
 *
 * Usage:
 *   npx tsx scripts/memory-graph-gpu-bench.ts [2k] [10k] [50k]
 *
 * Requirements:
 *   - Chrome or Edge installed (auto-detected; override with CHROME_PATH).
 *   - The browser must create a WebGL2 context. Headless Chrome on a machine without GPU
 *     access uses SwiftShader (software rasterisation); the report names the renderer, so
 *     a software figure is never presented as a GPU figure.
 *
 * Output: JSON with frame p50/p95 per size, the GL renderer string, and draw-call counts.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function findBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("No Chrome or Edge found. Set CHROME_PATH to a Chromium-based browser.");
}

/**
 * Bundle the real renderer plus the synthetic generator into browser scripts.
 *
 * `bundle: true` plus `format: "esm"` makes esbuild emit the layout worker that the entry
 * reaches through `new URL(..., import.meta.url)` as a separate chunk, so a probe exercises
 * the shipped worker rather than a stand-in. Every output is served, in order: the entry is
 * the first `.js`, and later chunks are served at their basename.
 */
async function buildBundle(): Promise<{ entry: string; assets: Map<string, string>; worker: string | null }> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(HERE, process.env.BENCH_ENTRY ?? "gpu-bench-entry.ts")],
    bundle: true,
    format: "iife",
    write: false,
    platform: "browser",
    target: "es2022"
  });
  const outputs = result.outputFiles ?? [];
  // With `write: false` esbuild labels the output `<stdout>`, so the entry cannot be found
  // by extension; it is simply the first JavaScript output.
  const entry = outputs[0]?.text ?? "";
  if (!entry) throw new Error("esbuild produced no entry bundle");
  const assets = new Map<string, string>(outputs.map(output => [`/${output.path.split(/[\\/]/).pop()!}`, output.text]));

  // The real layout worker, bundled on its own so a probe can run the shipped code
  // off-thread rather than a stand-in.
  const workerResult = await build({
    entryPoints: [join(HERE, "..", "apps", "web", "src", "features", "memory-workspace", "memory-network-layout.worker.ts")],
    bundle: true,
    format: "iife",
    write: false,
    platform: "browser",
    target: "es2022"
  });
  return { entry, assets, worker: workerResult.outputFiles[0]?.text ?? null };
}

function pageHtml(entry: string, workerSource: string | null): string {
  // The layout worker is bundled as its own IIFE and installed as a Blob URL. It is passed
  // through as base64: worker code can contain `</script`, `<!--`, or an escaped variant,
  // and any of them ends the surrounding element early and silently truncates the page.
  const workerSetup = workerSource
    ? `<script>
window.__layoutWorkerUrl = URL.createObjectURL(new Blob(
  [atob("${Buffer.from(workerSource, "utf8").toString("base64")}")],
  { type: "text/javascript" }
));
</script>`
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<title>memory graph gpu bench</title>
<canvas id="c" width="1280" height="800"></canvas>
${workerSetup}
<script>
${entry}
</script>`;
}

type Timing = { p50: number; p95: number; max: number; n: number };

type Sample = {
  label: string;
  nodes: number;
  edges: number;
  renderer: string;
  drawCalls: number;
  prepareMs: number;
  uploadMs: number;
  /** GPU-synchronised `draw()` time: the real per-draw cost. */
  drawMs: Timing;
  /** `requestAnimationFrame` cadence: perceived smoothness, pinned in headless Chrome. */
  frameMs: Timing;
  /** Present only when the size failed in-browser. */
  error?: string;
};

/**
 * Run `work` against a freshly launched headless browser.
 *
 * Uses the browser-level WebSocket and flat session mode: every command carries the
 * target's `sessionId`, which is the least error-prone CDP shape available.
 */
async function withChrome<T>(work: (
  send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  attachPage: () => Promise<{ targetId: string; sessionId: string }>,
  closePage: (page: { targetId: string }) => Promise<void>,
  pageErrors: string[]
) => Promise<T>): Promise<T> {
  const browserPath = findBrowser();
  const profile = await mkdtemp(join(tmpdir(), "space-gpu-bench-"));
  const child = spawn(browserPath, [
    // `BENCH_HEADFUL=1` runs with a real window. That matters for one question only: whether
    // the browser hands a WebGL context back after `WEBGL_lose_context`. Headless Chrome
    // delivers `webglcontextlost` but never `webglcontextrestored`, so the restore path can
    // only be verified headfully.
    ...(process.env.BENCH_HEADFUL ? [] : ["--headless=new"]),
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    // Keep WebGL available in headless mode; this is the difference between measuring
    // the renderer and measuring a "no context" error.
    "--enable-gpu",
    // A dropped GPU context during the long layout is the failure this benchmark must
    // survive, not hide: the watchdog kill would otherwise look like a shader bug.
    "--disable-gpu-watchdog",
    "--js-flags=--max-old-space-size=4096",
    "--use-angle=default",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: process.env.BENCH_VERBOSE ? "inherit" : "ignore" });

  try {
    let wsUrl: string | null = null;
    for (let attempt = 0; attempt < 80 && !wsUrl; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const response = await fetch("http://127.0.0.1:9222/json/version");
        wsUrl = (await response.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      } catch { /* browser still starting */ }
    }
    if (!wsUrl) throw new Error("Chrome did not expose a DevTools endpoint.");

    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
    });

    let nextId = 1;
    let sessionId: string | undefined;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    // Page-side failures are the only diagnosis available when a bundle never runs.
    const pageErrors: string[] = [];

    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: any;
        result?: unknown;
        error?: { message: string };
      };
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params?.exceptionDetails;
        pageErrors.push(detail?.exception?.description ?? detail?.text ?? "unknown exception");
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        pageErrors.push((message.params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" "));
        return;
      }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });

    const send = (method: string, params?: Record<string, unknown>, browserScope = false) => new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      // Flat mode: commands for a page carry its sessionId and are answered directly.
      // Browser-level commands must omit it or Chrome routes them to the wrong place.
      const scoped = !browserScope && sessionId ? { sessionId } : {};
      socket.send(JSON.stringify({ id, method, params, ...scoped }));
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 600_000);
    });

    const attachPage = async () => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const attached = await send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = attached.sessionId as string;
      await send("Page.enable");
      await send("Runtime.enable");
      return { targetId, sessionId };
    };

    const closePage = async (page: { targetId: string }) => {
      await send("Target.closeTarget", { targetId: page.targetId }, true).catch(() => undefined);
      // Closing the target tears down its session; clear the id so the next `attachPage`
      // does not send page commands into a dead session.
      sessionId = undefined;
    };

    try {
      return await work(send, attachPage, closePage, pageErrors);
    } finally {
      socket.close();
    }
  } finally {
    child.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const requested = process.argv.slice(2).filter(argument => /^\d+k$/i.test(argument));
  const sizes = requested.length ? requested : ["2k", "10k", "50k"];
  const bundle = await buildBundle();

  const samples = await withChrome(async (send, attachPage, closePage, pageErrors) => {
    const server = createServer((request, response) => {
      const url = request.url ?? "/";
      if (url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(pageHtml(bundle.entry, bundle.worker));
        return;
      }
      const asset = bundle.assets.get(url);
      if (asset !== undefined) {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(asset);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;

    try {
      const out: Sample[] = [];
      // One fresh tab per size. A canvas whose context was disposed, or that sat through a
      // multi-second synchronous build, is not given a new context by Chrome; reusing the
      // page made 10k and 50k report a lost context that had nothing to do with the graph.
      for (const label of sizes) {
        const page = await attachPage();
        try {
          await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });

          // Wait until the bundle has evaluated and exposed the entry point. BENCH_ENTRY
          // swaps in a diagnostic bundle that exposes `__ready` instead of `__benchReady`.
          const readyFlag = process.env.BENCH_ENTRY ? "window.__ready" : "window.__benchReady";
          let ready = false;
          for (let attempt = 0; attempt < 60 && !ready; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            const probe = await send("Runtime.evaluate", { expression: readyFlag, returnByValue: true });
            ready = probe?.result?.value === true;
          }
      if (!ready) {
        // A page that never exposes its entry point has already failed; read whatever the
        // document state and error log say instead of reporting only "not ready".
        const state = await send("Runtime.evaluate", {
          expression: "JSON.stringify({ stage: window.__stage, err: window.__probeErrors || null, readyType: typeof window.__ready, probeType: typeof window.__probe })",
          returnByValue: true
        }).catch(() => null);
        throw new Error(`Bench page did not become ready. ${state?.result?.value ?? ""}${pageErrors.length ? ` | errors: ${pageErrors.join(" ; ")}` : ""}`);
      }

          const call = process.env.BENCH_ENTRY ? "window.__probe" : "window.__bench";
          const response = await send("Runtime.evaluate", {
            expression: `${call}(${JSON.stringify(label)})`,
            awaitPromise: true,
            returnByValue: true
          });
          if (response?.exceptionDetails) {
            // One failing size must not hide the others; report it and keep going.
            const detail = response.exceptionDetails.exception?.description
              ?? response.exceptionDetails.text
              ?? JSON.stringify(response.exceptionDetails);
            out.push({
              label,
              nodes: 0,
              edges: 0,
              renderer: "unavailable",
              drawCalls: 0,
              prepareMs: 0,
              uploadMs: 0,
              drawMs: { p50: 0, p95: Number.POSITIVE_INFINITY, max: 0, n: 0 },
              frameMs: { p50: 0, p95: Number.POSITIVE_INFINITY, max: 0, n: 0 },
              error: String(detail)
            } as Sample);
            continue;
          }
          out.push(response.result.value as Sample);
        } finally {
          await closePage(page);
        }
      }
      return out;
    } finally {
      server.close();
    }
  });

  const report = {
    meta: {
      browser: findBrowser(),
      node: process.version,
      canvas: "1280x800",
      note: "Frame intervals measured with requestAnimationFrame over the real WebGL2 renderer."
    },
    results: samples.map(sample => (process.env.BENCH_ENTRY
      ? sample
      : {
          label: sample.label,
          nodes: sample.nodes,
          edges: sample.edges,
          renderer: sample.renderer,
          drawCalls: sample.drawCalls,
          prepareMs: sample.prepareMs,
          uploadMs: sample.uploadMs,
          drawMs: sample.drawMs,
          frameMs: sample.frameMs,
          ...(sample.error ? { error: sample.error } : {})
        }))
  };
  console.log(JSON.stringify(report, null, 2));

  // Issue #62 targets: 16.7 ms at 2k, 33 ms at 10k and 50k/150k.
  // The verdict uses the GPU-synchronised draw time: the rAF interval is pinned by
  // headless Chrome's scheduler and cannot show headroom at any graph size.
  const targets: Record<string, number> = { "2k": 16.7, "10k": 33, "50k": 33 };
  for (const result of report.results) {
    if (!result.drawMs) continue;
    const target = targets[result.label] ?? 33;
    const verdict = result.drawMs.p95 <= target ? "MET" : "NOT MET";
    const suffix = result.error ? ` (error: ${result.error})` : "";
    console.error(
      `${result.label} p95 draw ${result.drawMs.p95} ms / p95 frame ${result.frameMs.p95} ms ` +
      `(target <= ${target} ms) -> ${verdict}${suffix}`
    );
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
