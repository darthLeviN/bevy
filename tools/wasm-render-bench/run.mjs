import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSharedBrowser } from '../../../../editor-benchmark/shared_browser.mjs';
import { watchSignals, withTimeout } from '../../../../editor-benchmark/lifecycle.mjs';
import { staticHandler, ownedCleanup } from '../wasm-ecs-bench/run.mjs';

export const variants = ['threaded', 'serial'];
export const browserOptions = {
  variants, env: process.env, dpr: '1', frameRate: 'unlimited', headless: true,
};

export function validateResult(value, mode, diagnostics = {}) {
  const fail = message => { throw Error(`Invalid rendering benchmark ${mode}: ${message}`); };
  if (diagnostics.fatal != null || value?.fatal != null || diagnostics.failed) fail(diagnostics.fatal ?? value?.fatal ?? 'page failed');
  if (!value || value.mode !== mode || !variants.includes(mode)) fail('mode');
  for (const [key, expected] of Object.entries({
    compute_workers: mode === 'serial' ? 0 : 4, cameras: 1, meshes: 2,
    unlit: true, msaa_samples: 1, optimization: '3', page_main_thread: true, gpu_thread: 'browser-main', graphics_ready: true,
  })) if (value[key] !== expected) fail(key);
  if (!Number.isSafeInteger(value.frames) || value.frames <= 0) fail('frames');
  for (const key of ['fps', 'measurement_ms', 'warmup_ms']) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) fail(key);
  }
  if (value.warmup_ms < 5000 || value.measurement_ms < 5000) fail('timing windows');
  const calculated = value.frames * 1000 / value.measurement_ms;
  if (Math.abs(value.fps - calculated) > Math.max(0.01, calculated * 0.001)) fail('aggregate FPS');
  for (const entry of diagnostics.console ?? []) {
    // Only the known unavailable-presentation-mode warning is benign. Errors never are.
    const fallback = entry.level === 'warn' && /present.?mode/i.test(entry.message) &&
      /(?:not supported|unsupported|unavailable|fallback|falling back)/i.test(entry.message);
    if (entry.level === 'error' || (!fallback && /panic|validation error|wgpu.*error|render(?:er|ing).*error|device lost/i.test(entry.message))) {
      fail(entry.message);
    }
  }
  return value;
}

export const collectScript = `const done = arguments[arguments.length - 1];
  const node = document.querySelector('#result');
  let observer;
  function check() {
    if (window.benchmarkFatal != null || node.dataset.failed === 'true') {
      observer?.disconnect(); done({fatal: window.benchmarkFatal ?? 'page failed', console: window.benchmarkConsole}); return true;
    }
    if (node.dataset.complete === 'true') {
      observer?.disconnect();
      try { done({result: JSON.parse(node.textContent), console: window.benchmarkConsole,
        width: document.querySelector('#scene').width, height: document.querySelector('#scene').height,
        isolated: crossOriginIsolated, dpr: devicePixelRatio}); }
      catch (error) { done({fatal: String(error)}); }
      return true;
    }
    return false;
  }
  observer = new MutationObserver(check);
  observer.observe(node, {attributes: true, childList: true, subtree: true, characterData: true});
  check();`;

export async function run({
  createBrowser = createSharedBrowser, serve = options => Bun.serve(options),
  save = saveReport, log = console.log, headless = true,
} = {}) {
  const signals = watchSignals();
  const controller = new AbortController();
  const interrupt = () => controller.abort(signals.signal.reason);
  signals.signal.addEventListener('abort', interrupt, { once: true });
  let server, browser, report;
  const results = [];
  const diagnostics = [];
  const workerErrors = [];
  const driverLogs = [];
  const cleanup = ownedCleanup({
    deleteSession: async () => {}, stopGroup: async () => { await browser?.close(); },
    stopServer: async () => { await server?.stop(true); },
  });
  try {
    report = await withTimeout(async () => {
      controller.signal.throwIfAborted();
      const staticFetch = staticHandler(fileURLToPath(new URL('.', import.meta.url)));
      server = serve({ hostname: '127.0.0.1', port: 0,
        async fetch(request) {
          if (request.method === 'POST' && new URL(request.url).pathname === '/worker-error') {
            workerErrors.push((await request.text()).slice(0, 65536));
            return new Response('Recorded');
          }
          return staticFetch(request);
        } });
      log('Using updated O3 artifact: ' + fileURLToPath(new URL('./pkg/wasm_render_bench_bg.wasm', import.meta.url)));
      for (const requestedMode of variants) {
        controller.signal.throwIfAborted();
        browser = createBrowser({ ...browserOptions, variants: [requestedMode], headless, signal: controller.signal });
        try {
          await browser.run(async (mode, client) => {
        try {
          await withTimeout(async () => {
            const path = `/session/${client.session}`;
            await client.request('POST', `${path}/timeouts`, { script: 43000, pageLoad: 15000, implicit: 0 });
            await client.request('POST', `${path}/url`, { url: `http://127.0.0.1:${server.port}/?mode=${mode}` });
            const captured = await client.request('POST', `${path}/execute/async`, { script: collectScript, args: [] });
            diagnostics.push({ mode, ...captured });
            const result = validateResult(captured.result, mode, captured);
            if (captured.width !== 1280 || captured.height !== 720 || captured.dpr !== 1 || captured.isolated !== true) {
              throw Error('Invalid canvas/DPR/cross-origin isolation');
            }
            results.push({ ...result, measuredFPS: result.fps, console: captured.console ?? [],
                          browser_session_id: client.session,
                          browser_process_id: client.created?.capabilities?.['moz:processID'] ?? null });
          }, 45000, { message: `${mode} deadline exceeded (45s); no retry` });
        } catch (error) { controller.abort(error); throw error; }
          });
        } finally {
          const completed = browser;
          try { await completed.close(); }
          finally {
            driverLogs.push({ mode: requestedMode, log: completed.log });
            browser = undefined;
          }
        }
      }
      if (results.length !== 2 || results.some((row, index) => row.mode !== variants[index])) throw Error('Expected threaded then serial exactly once');
      return { status: 'ok', metric: 'Application frame/update cadence, not physically displayed FPS',
        browser: headless ? 'Firefox headless' : 'Firefox visible',
        browser_session_strategy: 'fresh-browser-per-case',
        artifact_directory: fileURLToPath(new URL('./pkg/', import.meta.url)), firefoxPreferences: {
          'dom.webgpu.enabled': true, 'layout.frame_rate': 0, 'layout.css.devPixelsPerPx': '1',
        }, results };
    }, 110000, { message: 'Total deadline exceeded (110s); no retry' });
  } catch (error) {
    report = { status: 'failed', fatal: String(error?.stack ?? error), results, diagnostics, workerErrors };
  } finally {
    controller.abort(Error('Benchmark finished'));
    try { await cleanup(); }
    catch (error) { report = { ...report, status: 'failed', cleanupFatal: String(error) }; }
    signals.signal.removeEventListener('abort', interrupt);
    signals.dispose();
  }
  const reportPath = await save({ ...report, driverLogs });
  log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (report.status !== 'ok') throw Error(report.fatal ?? report.cleanupFatal);
  for (const row of results) log(`${row.mode === 'serial' ? 'SINGLE' : 'MULTITHREADED'} measuredFPS=${row.measuredFPS}`);
  return report;
}

async function saveReport(report) {
  const directory = new URL('../../../../.cache/bevy-web-ecs/render-results/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const path = new URL(`${new Date().toISOString().replaceAll(':', '-')}.json`, directory);
  await Bun.write(path, JSON.stringify(report, null, 2) + '\n');
  return fileURLToPath(path);
}

if (import.meta.main) {
  if (process.argv.length > 2) throw Error('No options supported; build explicitly before running');
  await run();
}
