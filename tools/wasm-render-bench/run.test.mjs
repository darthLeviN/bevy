import { test, expect } from 'bun:test';
import { browserOptions, run, validateResult } from './run.mjs';
import { staticHandler } from '../wasm-ecs-bench/run.mjs';
import { fileURLToPath } from 'node:url';
import { htmlDefaults, pageConfiguration } from './options.mjs';

const requested = (mode, workers = mode === 'serial' ? 0 : 4, movingMeshes = 1) => ({ mode, workers, movingMeshes });
const result = (mode, workers = mode === 'serial' ? 0 : 4, movingMeshes = 1, cpuWork = 0) => ({ mode, fps: 100, frames: 500, measurement_ms: 5000, warmup_ms: 5000,
  cpu_work: cpuWork, cpu_systems: cpuWork > 0 ? 32 : 0, cpu_verified: true,
  compute_workers: workers, cameras: 1, meshes: movingMeshes + 1, moving_meshes: movingMeshes,
    unique_materials: movingMeshes + 1, motion_verified: true, unlit: true,
  msaa_samples: 1, optimization: '3', page_main_thread: true, gpu_thread: 'browser-main', graphics_ready: true });

test('actual page scripts parse and required markup is intact', async () => {
  const html = await Bun.file(new URL('./index.html', import.meta.url)).text();
  expect(html).toContain('</head>');
  expect(html).toContain('<pre id="result"></pre>');
  const scripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
  expect(scripts.length).toBe(2);
  for (const [, source] of scripts) {
    expect(() => new Function(`return (async () => {${source}\n})`)).not.toThrow();
  }
});

test('page passes resolved configuration to the six-argument Wasm start', async () => {
  const html = await Bun.file(new URL('./index.html', import.meta.url)).text();
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace("import('./options.mjs')", 'loadOptions()')
    .replace("import('./pkg/wasm_render_bench.js')", 'loadWasm()');
  for (const query of ['', '?mode=threaded&workers=7&meshes=12&cpu-work=9', '?mode=serial&workers=0&meshes=3']) {
    const calls = [];
    const location = { href: 'http://localhost/' + query };
    const defaults = htmlDefaults(html);
    const execute = new Function('loadOptions', 'loadWasm', 'document', 'location', 'window',
      `return (async () => {${source}\n})()`);
    await execute(async () => ({ pageConfiguration }), async () => ({
      default: async () => { calls.push('init'); }, start: async (...args) => calls.push(args),
    }), { querySelector: () => ({ textContent: JSON.stringify(defaults) }) }, location,
    { benchmarkFail: error => { throw error; } });
    const config = pageConfiguration(new URL(location.href).searchParams, defaults);
    expect(calls).toEqual(['init', [config.threaded, 'http://localhost/pkg/wasm_render_bench.js',
      'http://localhost/pool-worker.mjs', config.workers, config.movingMeshes, config.cpuWork]]);
  }
});

test('worker traps signal shared memory before posting to the page event loop', async () => {
  const workerSource = await Bun.file(new URL('./pool-worker.mjs', import.meta.url)).text();
  const source = workerSource.replace("await import('./pkg/wasm_render_bench.js')", 'await loadModule()');
  const calls = [];
  const self = { close() { calls.push('close'); }, addEventListener() {} };
  class Channel {
    postMessage(value) { calls.push('broadcast'); expect(value.fatal).toContain('GPU owner mismatch'); }
    close() {}
  }
  const loadModule = async () => ({ default: async () => {},
    report_worker_failure: message => { calls.push('shared'); expect(message).toContain('GPU owner mismatch'); },
    wasm_thread_entry_point: () => { throw Error('GPU owner mismatch'); },
  });
  new Function('self', 'BroadcastChannel', 'loadModule', 'console', 'fetch', source)(self, Channel, loadModule,
    { error() {}, warn() {}, log() {} }, async () => ({}));
  await self.onmessage({ data: [{}, {}, 1] });
  expect(calls).toEqual(['shared', 'broadcast', 'close']);
});

test('main-world skin and morph GPU queries declare browser-thread affinity', async () => {
  for (const kind of ['skin', 'morph']) {
    const source = await Bun.file(new URL('../../crates/bevy_pbr/src/render/' + kind + '.rs', import.meta.url)).text();
    const start = source.indexOf('pub fn no_automatic_' + kind + '_batching(');
    const signature = source.slice(start, source.indexOf(') {', start));
    expect(signature).toContain('#[cfg(target_arch = "wasm32")] _gpu_thread: bevy_ecs::system::NonSendMarker');
  }
});

test('accepts exactly the requested scene and timing contracts', () => {
  for (const mode of ['serial', 'threaded']) {
    expect(validateResult(result(mode), requested(mode))).toEqual(result(mode));
    for (const patch of [{compute_workers: 2}, {warmup_ms: 4999}, {measurement_ms: 4999},
      {meshes: 3}, {moving_meshes: 2}, {unique_materials: 1}, {motion_verified: false}, {cameras: 2}, {fps: NaN}, {fps: 200}, {frames: 0},
      {optimization: '2'}, {graphics_ready: false}, {page_main_thread: false}, {gpu_thread: 'worker'}, {unlit: false}, {msaa_samples: 4}]) {
      expect(() => validateResult({...result(mode), ...patch}, requested(mode))).toThrow();
    }
  }
});

test('heavy results must report the exact work and all 32 verified systems', () => {
  const expected = { ...requested('threaded'), cpuWork: 13 };
  const value = result('threaded', 4, 1, 13);
  expect(validateResult(value, expected)).toBe(value);
  for (const patch of [{ cpu_work: 0 }, { cpu_work: 12 }, { cpu_systems: 31 }, { cpu_verified: false }]) {
    expect(() => validateResult({ ...value, ...patch }, expected)).toThrow();
  }
});

test('workload source registers 32 disjoint lanes and a dependent visual consumer', async () => {
  const source = await Bun.file(new URL('./src/heavy.rs', import.meta.url)).text();
  const lanes = [...source.matchAll(/l\d\d: (\d+)/g)].map(match => Number(match[1]));
  expect(lanes).toEqual(Array.from({ length: 32 }, (_, index) => index));
  expect(source).toContain('Query<(&Moving, &mut Lane<I>)>');
  expect(source).toContain('compute_lane::<$index>.in_set(ComputeLanes)');
  expect(source).toContain('apply.after(ComputeLanes)');
  const compute = source.slice(source.indexOf('fn compute_lane'), source.indexOf('macro_rules!'));
  expect(compute).not.toContain('ResMut');
  expect(compute).not.toContain('Transform');
  expect(compute).not.toContain('Assets');
  expect(source).toContain('workload::reference(moving.index, step, config.cpu_work)');
});

test('measurement verification uses explicit read-only components instead of broad EntityRef access', async () => {
  const main = await Bun.file(new URL('./src/lib.rs', import.meta.url)).text();
  const heavy = await Bun.file(new URL('./src/heavy.rs', import.meta.url)).text();
  expect(main).toContain('entities: Query<heavy::OutputsReadOnly>');
  expect(heavy).toContain('entities: &Query<OutputsReadOnly>');
  expect(main).not.toContain('Query<EntityRef');
  expect(heavy).not.toContain('Query<EntityRef');
  expect(heavy).toContain('let lane = entity.$field');
  expect(heavy).toContain('assert_eq!(count, config.moving_meshes)');
});

test('fatal and renderer errors fail; known present-mode fallback warning is allowed', () => {
  const warning = {level: 'warn', message: 'PresentMode Immediate is not supported; falling back to Fifo'};
  expect(validateResult(result('serial'), requested('serial'), {console: [warning]})).toBeTruthy();
  for (const diagnostics of [{fatal: 'panic'}, {failed: true},
    {console: [{...warning, level: 'error'}]},
    {console: [{level: 'warn', message: 'wgpu validation error'}]}]) {
    expect(() => validateResult(result('serial'), requested('serial'), diagnostics)).toThrow();
  }
});

function fixture(fail = false, closeFailure = false) {
  const events = [], saved = [], creations = [];
  let options;
  const dependencies = {
    loadDefaults: async () => ({ movingMeshes: 1, workers: 4 }),
    serve: () => ({port: 1234, stop: async () => { events.push('server-close'); }}),
    createBrowser: received => {
      options = received;
      const id = creations.length + 1;
      const mode = received.variants[0];
      let params;
      creations.push(received);
      events.push('browser-create:' + mode);
      return {log: 'fake driver ' + id, close: async () => {
        events.push('browser-close:' + mode);
        if (closeFailure) throw Error('browser cleanup failed');
      },
        run: async visit => {
          for (const mode of received.variants) {
            await visit(mode, {session: 'session-' + id, created: { capabilities: { 'moz:processID': 100 + id } }, request: async (method, path, body) => {
              if (path.endsWith('/url')) { events.push(body.url); params = new URL(body.url).searchParams; }
              if (path.endsWith('/execute/async')) {
                if (fail === true || fail === mode) throw Error('renderer failed');
                return {result: result(mode, Number(params.get('workers')), Number(params.get('meshes')), Number(params.get('cpu-work'))), console: [], width: 1280, height: 720, dpr: 1, isolated: true};
              }
            }});
          }
        }};
    },
    save: async report => {saved.push(report); return 'fake.json';}, log: () => {},
  };
  return {dependencies, events, saved, creations, get options() {return options;}};
}

test('each case gets a fresh browser closed before the next starts', async () => {
  const fake = fixture();
  const report = await run(fake.dependencies);
  expect(report.results.map(row => row.measuredFPS)).toEqual([100, 100]);
  expect(fake.events).toEqual([
    'browser-create:threaded', 'http://127.0.0.1:1234/?mode=threaded&workers=4&meshes=1&cpu-work=0', 'browser-close:threaded',
    'browser-create:serial', 'http://127.0.0.1:1234/?mode=serial&workers=0&meshes=1&cpu-work=0', 'browser-close:serial', 'server-close',
  ]);
  expect(fake.creations.map(options => options.variants)).toEqual([['threaded'], ['serial']]);
  expect(report.results.map(row => row.browser_session_id)).toEqual(['session-1', 'session-2']);
  expect(report.results.map(row => row.browser_process_id)).toEqual([101, 102]);
  expect(report.browser_session_strategy).toBe('fresh-browser-per-case');
  expect(fake.saved[0].driverLogs.map(entry => entry.mode)).toEqual(['threaded', 'serial']);
  expect(fake.options.headless).toBe(true);
  expect(fake.options.frameRate).toBe('unlimited');
  expect(fake.options.dpr).toBe('1');
  expect(fake.options.env).toBe(process.env);
  expect(fake.saved[0].status).toBe('ok');
  expect(browserOptions.variants).toEqual(['threaded', 'serial']);
});

test('custom worker pairs and scene counts retain independent cases and metadata', async () => {
  for (const workers of ['2,8', '0,3', '0,0', '4,4', '6']) {
    const fake = fixture();
    const report = await run({ ...fake.dependencies, movingMeshes: 15, workers, cpuWork: 7 });
    expect(report.configuration.cpuWork).toBe(7);
    expect(report.results.map(row => row.cpu_work)).toEqual([7, 7]);
    expect(report.results.map(row => row.cpu_systems)).toEqual([32, 32]);
    const counts = workers.includes(',') ? workers.split(',').map(Number) : [6, 0];
    expect(report.results.map(row => row.compute_workers)).toEqual(counts);
    expect(report.results.map(row => row.case_id)).toEqual(['case-1', 'case-2']);
    expect(report.results.map(row => row.requested_workers)).toEqual(counts);
    expect(report.results.map(row => row.unique_materials)).toEqual([16, 16]);
    expect(fake.saved[0].driverLogs.map(row => row.case_id)).toEqual(['case-1', 'case-2']);
    expect(report.results.map(row => row.browser_process_id)).toEqual([101, 102]);
    expect(fake.events.indexOf('browser-close:' + report.results[0].mode))
      .toBeLessThan(fake.events.lastIndexOf('browser-create:' + report.results[1].mode));
  }
});

test('runner consumes editable HTML defaults through its dependency seam', async () => {
  const fake = fixture();
  const report = await run({ ...fake.dependencies,
    loadDefaults: async () => htmlDefaults('<script id="benchmark-config" type="application/json">{"movingMeshes":9,"workers":3}</script>') });
  expect(report.results.map(row => row.compute_workers)).toEqual([3, 0]);
  expect(report.results.map(row => row.moving_meshes)).toEqual([9, 9]);
});

test('per-case validation rejects stale defaults and unverified motion', () => {
  const expected = requested('threaded', 8, 20);
  expect(validateResult(result('threaded', 8, 20), expected)).toBeTruthy();
  for (const patch of [{ compute_workers: 4 }, { moving_meshes: 1 }, { meshes: 2 },
    { unique_materials: 2 }, { motion_verified: false }, { mode: 'serial' }]) {
    expect(() => validateResult({ ...result('threaded', 8, 20), ...patch }, expected)).toThrow();
  }
});

test('visible launcher uses the same updated artifacts and uncapped two-case runner', async () => {
  const fake = fixture();
  const report = await run({ ...fake.dependencies, headless: false });
  expect(fake.options.headless).toBe(false);
  expect(fake.options.frameRate).toBe('unlimited');
  expect(report.browser).toBe('Firefox visible');
  expect(report.artifact_directory).toBe(fileURLToPath(new URL('./pkg/', import.meta.url)));
  expect(report.results.map(row => row.mode)).toEqual(['threaded', 'serial']);
});

test('failure cleans up, saves diagnostics and never retries', async () => {
  const fake = fixture(true);
  await expect(run(fake.dependencies)).rejects.toThrow('renderer failed');
  expect(fake.events).toEqual(['browser-create:threaded', 'http://127.0.0.1:1234/?mode=threaded&workers=4&meshes=1&cpu-work=0',
    'browser-close:threaded', 'server-close']);
  expect(fake.creations).toHaveLength(1);
  expect(fake.options.signal.aborted).toBe(true);
  expect(fake.saved[0].status).toBe('failed');
});

test('second-case failure closes its separate browser and preserves first result', async () => {
  const fake = fixture('serial');
  await expect(run(fake.dependencies)).rejects.toThrow('renderer failed');
  expect(fake.creations).toHaveLength(2);
  expect(fake.saved[0].results.map(row => row.mode)).toEqual(['threaded']);
  expect(fake.events.slice(-2)).toEqual(['browser-close:serial', 'server-close']);
});

test('failed browser shutdown prevents starting another case', async () => {
  const fake = fixture(false, true);
  await expect(run(fake.dependencies)).rejects.toThrow('browser cleanup failed');
  expect(fake.creations).toHaveLength(1);
  expect(fake.events.at(-1)).toBe('server-close');
});

test('static responses including errors carry isolation headers', async () => {
  const handler = staticHandler(fileURLToPath(new URL('.', import.meta.url)));
  for (const path of ['/', '/pool-worker.mjs', '/missing.wasm']) {
    const response = await handler(new Request(`http://localhost${path}`));
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  }
});
