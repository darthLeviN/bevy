import { cpuAccounting } from './cpu.mjs';
import { wasmFunctionNames } from './breakdown.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { cliOptions, configuration, htmlDefaults, usage } from './options.mjs';
import { fileURLToPath } from 'node:url';
import { createSharedBrowser } from '../../../../editor-benchmark/shared_browser.mjs';
import { watchSignals, withTimeout } from '../../../../editor-benchmark/lifecycle.mjs';
import { staticHandler, ownedCleanup } from '../wasm-ecs-bench/run.mjs';

export function formatSummary(report) {
  const number = value => Number.isFinite(value) ? value.toFixed(2) : 'unavailable';
  const headers = ['Mode', 'Workers', 'Main CPU ms/update', 'Workers CPU ms/update', 'Total CPU ms/update', 'GPU ms/frame', 'Updates/sec'];
  const reasons = [];
  const rows = report.results.map(row => {
    const cpu = row.cpu_execution;
    const keys = ['main_cpu_ms_per_update', 'workers_cpu_ms_per_update', 'total_cpu_ms_per_update'];
    const values = keys.map(key => number(cpu?.supported || cpu?.partial ? cpu[key] : undefined));
    if (values.includes('unavailable')) {
      const reason = String(cpu?.reason || 'CPU samples unavailable').split(/[\r\n]/, 1)[0].trim();
      reasons.push(`${row.mode}/${row.requested_workers}: ${reason.length > 100 ? reason.slice(0, 97) + '...' : reason}`);
    }
    return [row.mode, String(row.requested_workers), ...values, number(row.gpu_timing?.supported ? row.gpu_timing.mean_ms : undefined), number(row.measuredFPS)];
  });
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = row => row.map((cell, index) => index < 2 ? cell.padEnd(widths[index]) : cell.padStart(widths[index])).join('  ').trimEnd();
  return [
    `Bevy benchmark — moving meshes: ${report.configuration.movingMeshes}; CPU work: ${report.configuration.cpuWork}`,
    line(headers),
    ...rows.map(line),
    'CPU is sampled Wasm attribution, not frame time; profiling affects update cadence.',
    'GPU is timestamped disjoint instrumented passes per sampled render frame; excludes copies and uninstrumented passes. See JSON for sample coverage.',
    ...reasons.map(reason => 'CPU unavailable — ' + reason),
        ...report.results.flatMap(result => {
          const breakdown = result.cpu_execution?.breakdown;
          if (!breakdown) return [];
          return [`\n${result.mode}/${result.requested_workers} — exclusive sampled CPU ms/update`,
            'Operation                         Main   Workers     Total  Samples',
            ...breakdown.rows.map(row => `${row.label.padEnd(32)} ${number(row.main_cpu_ms_per_update).padStart(7)} ${number(row.workers_cpu_ms_per_update).padStart(9)} ${number(row.total_cpu_ms_per_update).padStart(9)} ${String(row.samples).padStart(8)}`),
            ...(breakdown.command_breakdown ? [
              '  Command encoding / submission detail (children only; do not add to broad rows)',
              'Operation                                      Main   Workers     Total  Samples',
              ...breakdown.command_breakdown.rows.map(row => `${row.label.padEnd(43)} ${row.main_cpu_ms_per_update.toFixed(4).padStart(8)} ${row.workers_cpu_ms_per_update.toFixed(4).padStart(9)} ${row.total_cpu_ms_per_update.toFixed(4).padStart(9)} ${String(row.samples).padStart(8)}`),
            ] : []),
            `Unresolved Wasm-index samples before attribution: ${result.cpu_execution.coverage?.unresolved_symbol_samples ?? 'unavailable'}`,
            breakdown.limitation];
        }),
  ].join('\n');
}

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
  /* Optional legacy wall diagnostics are not CPU execution accounting. */
  if (value.schedule_timings !== undefined && !Array.isArray(value.schedule_timings)) fail('invalid legacy diagnostics');
  const scopes = new Set();
  for (const row of value.schedule_timings ?? []) {
    if (typeof row.schedule !== 'string' || scopes.has(row.schedule)) fail('CPU timing scope duplicate/missing');
    scopes.add(row.schedule);
    if (!Number.isSafeInteger(row.calls) || row.calls <= 0) fail('CPU timing calls');
    for (const key of ['mean_ms', 'p50_ms', 'p95_ms']) {
      if (!Number.isFinite(row[key]) || row[key] < 0) fail('CPU timing ' + key);
    }
    if (row.p95_ms < row.p50_ms) fail('CPU timing percentiles');
  }

  const gpu = value.gpu_timing;
  if (!gpu) fail('GPU timing missing');
  if (gpu.supported === true) {
    if (gpu.source !== 'timestamp-query' || gpu.scope !== 'sum_disjoint_instrumented_passes' ||
        !Number.isSafeInteger(gpu.samples) || gpu.samples <= 0 || gpu.samples > value.frames ||
        gpu.expected_samples !== value.frames || gpu.missing_samples !== value.frames - gpu.samples) fail('GPU sample attribution');
    for (const key of ['mean_ms', 'p50_ms', 'p95_ms']) {
      if (!Number.isFinite(gpu[key]) || gpu[key] < 0) fail('GPU timing ' + key);
    }
    if (gpu.p95_ms < gpu.p50_ms) fail('GPU percentiles');
  } else if (gpu.supported !== false || gpu.samples !== 0 ||
      gpu.mean_ms !== null || gpu.p50_ms !== null || gpu.p95_ms !== null ||
      typeof gpu.reason !== 'string' || !gpu.reason.includes('WebGPU')) fail('GPU unavailable contract');
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

// Keep total periodic samples roughly constant as worker counts grow. Firefox
// filters also include the benchmark's two auxiliary DOM workers.
export function captureSettings(workers) {
  return { entries: 16777216, interval: Math.max(10, Math.ceil((workers + 3) * 10 / 7)),
    features: ['js', 'stackwalk', 'nomarkerstacks'], threads: ['GeckoMain', 'DOM Worker'] };
}

export async function profileCommand(client, script, args = []) {
  const path = `/session/${client.session}`;
  await client.request('POST', `${path}/moz/context`, { context: 'chrome' });
  try {
    const response = await client.request('POST', `${path}/execute/async`, {
      script: `const done = arguments[arguments.length - 1];
        (async () => { ${script} })().then(value => done({value}), error => done({error: String(error)}));`, args,
    });
    if (response?.error) throw Error('Firefox profiler: ' + response.error);
    return response?.value;
  } finally {
    await client.request('POST', `${path}/moz/context`, { context: 'content' });
  }
}

export const startProfileScript = `const settings = arguments[0];
  const features = Services.profiler.GetFeatures();
  if (!settings.features.every(feature => features.includes(feature))) throw Error('Required profiler features unavailable');
  await Services.profiler.StartProfiler(settings.entries, settings.interval, settings.features, settings.threads);
  await Services.profiler.waitOnePeriodicSampling();
  return Services.profiler.activeConfiguration;`;

export const finishProfileScript = `await Services.profiler.waitOnePeriodicSampling();
  await Services.profiler.Pause();
  await Services.profiler.dumpProfileToFileAsync(arguments[0]);
  return true;`;

export const collectScript = `const done = arguments[arguments.length - 1];
  const profileSaved = arguments[0] === true;
  const node = document.querySelector('#result');
  let observer, marks;
  let finished = false;
  function finish(value) {
    if (finished) return true;
    finished = true;
    observer?.disconnect(); marks?.disconnect(); done(value); return true;
  }
  function check() {
    if (finished) return true;
    if (window.benchmarkFatal != null || node.dataset.failed === 'true') {
      return finish({fatal: window.benchmarkFatal ?? 'page failed', console: window.benchmarkConsole});
    }
    const epoch = node.getAttribute('data-profile-request');
    if (epoch && epoch !== node.getAttribute('data-profile-ready')) return finish({captureRequest: epoch});
    if (!profileSaved && performance.getEntriesByName('benchmark-cpu-end').length) return finish({cpuEnd: true});
    if (node.dataset.complete === 'true') {
      observer?.disconnect();
      try {
        const result = JSON.parse(node.textContent);
        performance.mark('benchmark-measurement-end:' + result.mode);
        finish({result, console: window.benchmarkConsole,
        width: document.querySelector('#scene').width, height: document.querySelector('#scene').height,
        isolated: crossOriginIsolated, dpr: devicePixelRatio}); }
      catch (error) { finish({fatal: String(error)}); }
      return true;
    }
    return false;
  }
  marks = new PerformanceObserver(check);
  marks.observe({type: 'mark', buffered: true});
  observer = new MutationObserver(check);
  observer.observe(node, {attributes: true, childList: true, subtree: true, characterData: true});
  check();`;

export async function run({
  createBrowser = createSharedBrowser, serve = options => Bun.serve(options),
  save = saveReport, log = console.log, headless = true, movingMeshes, workers, cpuWork,
  prepareProfile = async () => {
    const directory = new URL('../../../../.cache/bevy-web-ecs/render-results/', import.meta.url);
    await mkdir(directory, { recursive: true });
    return fileURLToPath(new URL(crypto.randomUUID() + '-cpu-profile.json', directory));
  },
  readProfile = async path => JSON.parse(await readFile(path, 'utf8')),
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
        const profilePath = await prepareProfile();
        browser = createBrowser({ ...browserOptions, variants: [requestedMode], headless, signal: controller.signal,
          profilePath, profileControlled: true });
        try {
          await browser.run(async (mode, client) => {
        try {
          await withTimeout(async () => {
            const path = `/session/${client.session}`;
            await client.request('POST', `${path}/timeouts`, { script: 43000, pageLoad: 15000, implicit: 0 });
            await client.request('POST', `${path}/url`, { url: `http://127.0.0.1:${server.port}/?mode=${mode}&workers=${requested.workers}&meshes=${config.movingMeshes}&cpu-work=${config.cpuWork}&profile-controlled=1` });
            let captured, profileSaved = false, capture;
            for (;;) {
              captured = await client.request('POST', `${path}/execute/async`, { script: collectScript, args: [profileSaved] });
              if (captured.captureRequest) {
                const settings = captureSettings(requested.workers);
                const active = await profileCommand(client, startProfileScript, [settings]);
                capture = { settings, active, epoch: captured.captureRequest };
                await client.request('POST', `${path}/execute/sync`, {
                  script: `document.querySelector('#result').setAttribute('data-profile-ready', arguments[0]);`,
                  args: [captured.captureRequest],
                });
              } else if (captured.cpuEnd) {
                if (!capture) throw Error('CPU measurement ended without a fresh capture handshake; stale artifact');
                await profileCommand(client, finishProfileScript, [profilePath]);
                profileSaved = true;
              } else break;
            }
            if (!profileSaved) throw Error('CPU profile was not saved at the measurement boundary; stale artifact');
            diagnostics.push({ ...captured, mode, ...caseMetadata });
            const result = validateResult(captured.result, { ...requested, movingMeshes: config.movingMeshes, cpuWork: config.cpuWork }, captured);
            if (captured.width !== 1280 || captured.height !== 720 || captured.dpr !== 1 || captured.isolated !== true) {
              throw Error('Invalid canvas/DPR/cross-origin isolation');
            }
            results.push({ ...result, ...caseMetadata, measuredFPS: result.fps, console: captured.console ?? [],
                          cpu_capture: capture,
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
        const row = results.at(-1);
        row.cpu_profile_path = profilePath;
        try {
                  let names = new Map(), symbolError;
                  try { names = wasmFunctionNames(await readFile(new URL('./pkg/wasm_render_bench_bg.wasm', import.meta.url))); }
                  catch (error) { symbolError = String(error); }
                  row.browser_thread_cpu = cpuAccounting(await readProfile(profilePath), row, names);
                  if (row.browser_thread_cpu.application_cpu?.breakdown) {
                    Object.assign(row.browser_thread_cpu.application_cpu.breakdown, { function_names: names.size, symbol_error: symbolError });
                  }
                }
        catch (error) { row.browser_thread_cpu = { supported: false, reason: 'CPU profile unavailable: ' + String(error) }; }
        row.cpu_execution = row.browser_thread_cpu.application_cpu ?? {
          supported: false, reason: row.browser_thread_cpu.reason,
        };
      }
      if (results.length !== 2 || results.some((row, index) => row.case_id !== config.cases[index].id)) throw Error('Expected exactly the two requested cases');
      return { status: 'ok', metric: 'Application frame/update cadence, not physically displayed FPS',
        browser: headless ? 'Firefox headless' : 'Firefox visible',
        browser_session_strategy: 'fresh-browser-per-case', configuration: config,
        profiling: { enabled: true, lifecycle: 'fresh-after-warmup; pause-and-save-after-end-before-GPU-drain',
          features: 'js,stackwalk,nomarkerstacks',
          threads: 'GeckoMain,DOM Worker',
          note: 'Profiler overhead affects cadence; application CPU is sampled Wasm-stack attribution of OS CPU deltas, not exact app-only execution; enclosed intervals only'  },
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
  if (report.status !== 'ok') log(JSON.stringify({ ...report, reportPath }, null, 2));
  else log('Full benchmark report: ' + reportPath);
  if (report.status !== 'ok') throw Error(report.fatal ?? report.cleanupFatal);
  log(formatSummary(report));
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
