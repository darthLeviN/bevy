import { test, expect } from 'bun:test';
import { captureSettings, collectScript, profileCommand, startProfileScript, finishProfileScript } from './run.mjs';
import { cpuAccounting } from './cpu.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('supported profiler lifecycle awaits every subprocess and bracketing sample before acknowledgement/save', async () => {
  const events = [];
  const settings = captureSettings(4);
  const profiler = {
    GetFeatures: () => settings.features,
    StartProfiler: async (...args) => { events.push(['start', ...args]); },
    waitOnePeriodicSampling: async () => { events.push('sample'); },
    Pause: async () => { events.push('pause'); },
    dumpProfileToFileAsync: async path => { events.push(['save', path]); },
    activeConfiguration: { interval: 10 },
  };
  expect(await new AsyncFunction('Services', 'settings', startProfileScript.replace('const settings = arguments[0];', ''))({profiler}, settings)).toEqual({interval: 10});
  await new AsyncFunction('Services', 'path', finishProfileScript.replace('arguments[0]', 'path'))({profiler}, '/owned/profile.json');
  expect(events).toEqual([
    ['start', 16777216, 10, ['js', 'stackwalk', 'nomarkerstacks'], ['GeckoMain', 'DOM Worker']],
    'sample', 'sample', 'pause', ['save', '/owned/profile.json'],
  ]);
});

test('chrome-context command errors restore content context and never acknowledge a failed start', async () => {
  const calls = [];
  const client = {session: 'owned', request: async (method, path, body) => {
    calls.push([path, body]);
    if (path.endsWith('/execute/async')) return {error: 'capture failed'};
  }};
  await expect(profileCommand(client, startProfileScript, [captureSettings(4)])).rejects.toThrow('capture failed');
  expect(calls.map(([path, body]) => path.endsWith('/moz/context') ? body.context : 'command')).toEqual(['chrome', 'command', 'content']);
});

function collector({epoch = '1', ready = '0', ended = false, complete = false, saved = false} = {}) {
  const observers = [], results = [];
  const node = {dataset: {complete: String(complete)}, textContent: '{"mode":"threaded"}',
    getAttribute: key => key === 'data-profile-request' ? epoch : ready};
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const performance = {getEntriesByName: () => ended ? [{}] : [], mark() {}};
  new Function('document', 'window', 'performance', 'MutationObserver', 'PerformanceObserver', 'crossOriginIsolated', 'devicePixelRatio',
    `return function() { ${collectScript} }`)(
    {querySelector: selector => selector === '#result' ? node : {width: 1280, height: 720}},
    {benchmarkConsole: []}, performance, Observer, Observer, true, 1)(saved, value => results.push(value));
  for (const observer of observers) observer.callback();
  return {results, observers};
}

test('actual collector handshakes without polling, catches already-emitted end before GPU drain, disconnects once', () => {
  for (const [state, expected] of [
    [{}, {captureRequest: '1'}],
    [{ready: '1', ended: true}, {cpuEnd: true}],
    [{ready: '1', ended: true, complete: true}, {cpuEnd: true}],
    [{epoch: '2', ready: '1'}, {captureRequest: '2'}],
  ]) {
    const observed = collector(state);
    expect(observed.results).toEqual([expected]);
    expect(observed.observers.every(observer => observer.disconnected)).toBe(true);
  }
  const waiting = collector({ready: '1'});
  expect(waiting.results).toEqual([]);
  const complete = collector({ready: '1', ended: true, complete: true, saved: true});
  expect(complete.results[0].result).toEqual({mode: 'threaded'});
});

// Deliberately variable-size ring records, not a fixed number-of-samples mock.
// Stress assumptions: up to 1200 updates/s, 60 128-byte markers/update,
// 16 KiB per thread sample, and a six-second recording including boundary slack.
function stressCapture({workers, interval, loading = 0, fps = 1200}) {
  const capacity = captureSettings(workers).entries * 8;
  const threads = Array.from({length: workers + 3}, (_, index) => ({
    name: index ? 'DOM Worker' : 'GeckoMain', processType: 'tab', pid: 42, tid: index + 1,
    markers: {schema: {data: 0, startTime: 1}, data: []},
    stringTable: ['wasm-function[123]'], frameTable: {schema: {location: 0}, data: [[0]]},
    stackTable: {schema: {prefix: 0, frame: 1}, data: [[null, 0]]},
    samples: {schema: {time: 0, stack: 1, threadCPUDelta: 2}, data: []},
  }));
  const ring = [];
  let bytes = 0, first = 0;
  function append(record, size) {
    ring.push({record, size}); bytes += size;
    while (bytes > capacity) bytes -= ring[first++].size;
  }
  const start = loading + 100;
  const end = start + 5000;
  for (let time = 0; time <= loading + 6000; time++) {
    if (time === start) append({marker: 'benchmark-cpu-start', time}, 128);
    if (time === end) append({marker: 'benchmark-cpu-end', time}, 128);
    if (time % interval === 0) for (let thread = 0; thread < threads.length; thread++) {
      append({thread, time}, 16384);
    }
    append(null, Math.ceil(fps * 60 * 128 / 1000));
  }
  for (const {record} of ring.slice(first)) {
    if (!record) continue;
    if (record.marker) threads[0].markers.data.push([{name: record.marker}, record.time]);
    else threads[record.thread].samples.data.push([record.time, 0, interval * 500000]);
  }
  const profile = {meta: {sampleUnits: {threadCPUDelta: 'ns'}}, threads, processes: []};
  return cpuAccounting(profile, {frames: 1941, measurement_ms: 5000, compute_workers: workers});
}

test('high-rate one-mesh/four-worker CPU-work shape reproduces old truncation and retains fresh bounded capture', () => {
  const old = stressCapture({workers: 4, interval: 1, loading: 10000});
  expect(old.supported).toBe(false);
  expect(old.reason).toContain('profiler retention');
  const fresh = stressCapture({workers: 4, interval: captureSettings(4).interval});
  expect(fresh.supported).toBe(true);
  expect(fresh.application_cpu.supported).toBe(true);
  expect(fresh.application_cpu.total_cpu_ms_per_update).toBeGreaterThan(0);
  expect(fresh.threads).toHaveLength(7);
});

test('sample budget scales with all supported worker counts; overflow remains unavailable, never a CPU proxy', () => {
  for (const workers of [0, 1, 4, 8, 16, 32]) {
    const settings = captureSettings(workers);
    expect((workers + 3) * (Math.ceil(6000 / settings.interval) + 1)).toBeLessThan(4250);
    expect(stressCapture({workers, interval: settings.interval}).application_cpu.supported).toBe(true);
  }
  expect(stressCapture({workers: 4, interval: 10, fps: 10000}).supported).toBe(false);
});
