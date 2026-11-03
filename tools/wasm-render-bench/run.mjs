import { mkdir, readFile } from 'node:fs/promises';
import { cliOptions, configuration, htmlDefaults, usage } from './options.mjs';
import { fileURLToPath } from 'node:url';
import { createSharedBrowser } from '../../../../editor-benchmark/shared_browser.mjs';
import { watchSignals, withTimeout } from '../../../../editor-benchmark/lifecycle.mjs';
import { staticHandler, ownedCleanup } from '../wasm-ecs-bench/run.mjs';

export const variants = ['threaded', 'serial'];
export const browserOptions = {
  variants, env: process.env, dpr: '1', frameRate: 'unlimited', headless: true,
};

export function validateResult(value, requested, diagnostics = {}) {
  const { mode, workers, movingMeshes, cpuWork = 0 } = requested;
  const fail = message => { throw Error(`Invalid rendering benchmark ${mode}: ${message}`); };
  if (diagnostics.fatal != null || value?.fatal != null || diagnostics.failed) fail(diagnostics.fatal ?? value?.fatal ?? 'page failed');
  if (!value || value.mode !== mode || !variants.includes(mode)) fail('mode');
  for (const [key, expected] of Object.entries({
    cpu_work: cpuWork, cpu_systems: cpuWork > 0 ? 32 : 0, cpu_verified: true,
    compute_workers: workers, cameras: 1, meshes: movingMeshes + 1,
        moving_meshes: movingMeshes, unique_materials: movingMeshes + 1, motion_verified: true,
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
      try {
        const result = JSON.parse(node.textContent);
        performance.mark('benchmark-measurement-end:' + result.mode);
        done({result, console: window.benchmarkConsole,
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
  save = saveReport, log = console.log, headless = true, movingMeshes, workers, cpuWork,
    loadDefaults = async () => htmlDefaults(await readFile(new URL('./index.html', import.meta.url), 'utf8')),
} = {}) {
  const config = configuration({ movingMeshes, workers, cpuWork }, await loadDefaults());
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
      for (const requested of config.cases) {
              const requestedMode = requested.mode;
              const caseMetadata = { case_id: requested.id, requested_workers: requested.workers, moving_meshes: config.movingMeshes, cpu_work: config.cpuWork };
        controller.signal.throwIfAborted();
        browser = createBrowser({ ...browserOptions, variants: [requestedMode], headless, signal: controller.signal });
        try {
          await browser.run(async (mode, client) => {
        try {
          await withTimeout(async () => {
            const path = `/session/${client.session}`;
            await client.request('POST', `${path}/timeouts`, { script: 43000, pageLoad: 15000, implicit: 0 });
            await client.request('POST', `${path}/url`, { url: `http://127.0.0.1:${server.port}/?mode=${mode}&workers=${requested.workers}&meshes=${config.movingMeshes}&cpu-work=${config.cpuWork}` });
            const captured = await client.request('POST', `${path}/execute/async`, { script: collectScript, args: [] });
            diagnostics.push({ ...captured, mode, ...caseMetadata });
            const result = validateResult(captured.result, { ...requested, movingMeshes: config.movingMeshes, cpuWork: config.cpuWork }, captured);
            if (captured.width !== 1280 || captured.height !== 720 || captured.dpr !== 1 || captured.isolated !== true) {
              throw Error('Invalid canvas/DPR/cross-origin isolation');
            }
            results.push({ ...result, ...caseMetadata, measuredFPS: result.fps, console: captured.console ?? [],
                          browser_session_id: client.session,
                          browser_process_id: client.created?.capabilities?.['moz:processID'] ?? null });
          }, 45000, { message: `${requested.id} ${mode} workers=${requested.workers} deadline exceeded (45s); no retry` });
        } catch (error) { controller.abort(error); throw error; }
          });
        } finally {
          const completed = browser;
          try { await completed.close(); }
          finally {
            driverLogs.push({ mode: requestedMode, ...caseMetadata, log: completed.log });
            browser = undefined;
          }
        }
      }
      if (results.length !== 2 || results.some((row, index) => row.case_id !== config.cases[index].id)) throw Error('Expected exactly the two requested cases');
      return { status: 'ok', metric: 'Application frame/update cadence, not physically displayed FPS',
        browser: headless ? 'Firefox headless' : 'Firefox visible',
        browser_session_strategy: 'fresh-browser-per-case', configuration: config,
        artifact_directory: fileURLToPath(new URL('./pkg/', import.meta.url)), firefoxPreferences: {
          'dom.webgpu.enabled': true, 'layout.frame_rate': 0, 'layout.css.devPixelsPerPx': '1',
        }, results };
    }, 110000, { message: 'Total deadline exceeded (110s); no retry' });
  } catch (error) {
    report = { status: 'failed', fatal: String(error?.stack ?? error), results, diagnostics, workerErrors, configuration: config };
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
  for (const row of results) log(`${row.case_id} ${row.mode === 'serial' ? 'SINGLE' : 'MULTITHREADED'} workers=${row.requested_workers} meshes=${row.moving_meshes} measuredFPS=${row.measuredFPS}`);
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
  const options = cliOptions(process.argv.slice(2), true);
  if (options.help) console.log(usage);
  else await run(options);
}
