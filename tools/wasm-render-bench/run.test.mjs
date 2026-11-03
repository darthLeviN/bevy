import { test, expect } from 'bun:test';
import { browserOptions, run, validateResult } from './run.mjs';
import { staticHandler } from '../wasm-ecs-bench/run.mjs';
import { fileURLToPath } from 'node:url';

const result = mode => ({ mode, fps: 100, frames: 500, measurement_ms: 5000, warmup_ms: 5000,
  compute_workers: mode === 'serial' ? 0 : 4, cameras: 1, meshes: 2, unlit: true,
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
    expect(validateResult(result(mode), mode)).toEqual(result(mode));
    for (const patch of [{compute_workers: 2}, {warmup_ms: 4999}, {measurement_ms: 4999},
      {meshes: 3}, {cameras: 2}, {fps: NaN}, {fps: 200}, {frames: 0},
      {optimization: '2'}, {graphics_ready: false}, {page_main_thread: false}, {gpu_thread: 'worker'}, {unlit: false}, {msaa_samples: 4}]) {
      expect(() => validateResult({...result(mode), ...patch}, mode)).toThrow();
    }
  }
});

test('fatal and renderer errors fail; known present-mode fallback warning is allowed', () => {
  const warning = {level: 'warn', message: 'PresentMode Immediate is not supported; falling back to Fifo'};
  expect(validateResult(result('serial'), 'serial', {console: [warning]})).toBeTruthy();
  for (const diagnostics of [{fatal: 'panic'}, {failed: true},
    {console: [{...warning, level: 'error'}]},
    {console: [{level: 'warn', message: 'wgpu validation error'}]}]) {
    expect(() => validateResult(result('serial'), 'serial', diagnostics)).toThrow();
  }
});

function fixture(fail = false, closeFailure = false) {
  const events = [], saved = [], creations = [];
  let options;
  const dependencies = {
    serve: () => ({port: 1234, stop: async () => { events.push('server-close'); }}),
    createBrowser: received => {
      options = received;
      const id = creations.length + 1;
      const mode = received.variants[0];
      creations.push(received);
      events.push('browser-create:' + mode);
      return {log: 'fake driver ' + id, close: async () => {
        events.push('browser-close:' + mode);
        if (closeFailure) throw Error('browser cleanup failed');
      },
        run: async visit => {
          for (const mode of received.variants) {
            await visit(mode, {session: 'session-' + id, created: { capabilities: { 'moz:processID': 100 + id } }, request: async (method, path, body) => {
              if (path.endsWith('/url')) events.push(body.url);
              if (path.endsWith('/execute/async')) {
                if (fail === true || fail === mode) throw Error('renderer failed');
                return {result: result(mode), console: [], width: 1280, height: 720, dpr: 1, isolated: true};
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
    'browser-create:threaded', 'http://127.0.0.1:1234/?mode=threaded', 'browser-close:threaded',
    'browser-create:serial', 'http://127.0.0.1:1234/?mode=serial', 'browser-close:serial', 'server-close',
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
  expect(fake.events).toEqual(['browser-create:threaded', 'http://127.0.0.1:1234/?mode=threaded',
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
