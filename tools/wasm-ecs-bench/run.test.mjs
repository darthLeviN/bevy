import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { firefoxCapabilities, staticHandler, validateResult, ownedCleanup } from './run.mjs';
import { ownProcessGroup } from '../../../../editor-benchmark/lifecycle.mjs';

function fixture() {
  return { workers: 4, visuals: false, atomics: true, main_thread: true, local_task_verified: true, page_event_loop_ticks: 100,
    results: ['serial', 'parallel-systems', 'parallel-query'].map((name, index) => ({
      name, entities: 100, systems: 4, ticks: 1000, page_owner_checks: 1000, samples: 1000,
      warmup_ms: 5000, sample_ms: 5000, updates_per_second: 200,
      mean_ms: 5, p50_ms: 4, p95_ms: 7,
      participating_threads_preflight: index === 0 ? 1 : 4,
      overlapping_systems_preflight: index === 1 ? 4 : 1,
      all_entity_values_verified: true, checksum: '12345678901234567890',
    })) };
}

test('Firefox requests only headless, no preferences', () => {
  expect(firefoxCapabilities()).toEqual({ capabilities: { alwaysMatch: {
    browserName: 'firefox', 'moz:firefoxOptions': { args: ['--headless'] },
  } } });
});

describe('real static handler without a listening server', () => {
  const handler = staticHandler();
  test('serves inert HTML with shared-memory isolation', async () => {
    const response = await handler(new Request('http://127.0.0.1/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    const html = await response.text();
    expect(html).not.toMatch(/<canvas|requestAnimationFrame|WebGL|WebGPU/);
    expect(html.indexOf("new BroadcastChannel(")).toBeLessThan(html.indexOf('await init()'));
    expect(html).toContain("new URL('./pkg/wasm_ecs_bench.js', location.href).href");
    expect(html).toContain("new URL('./pool-worker.mjs', location.href).href, 4");
    expect(html).toContain('window.ecsBenchmarkResult');
    expect(html).toContain('window.ecsBenchmarkFatal');
  });
  test.each([
    ['/%2e%2e%2fCargo.toml', 403],
    ['/..%5cCargo.toml', 403],
    ['/%ZZ', 400],
    ['/missing-file.wasm', 404],
  ])('rejects %s', async (path, status) => {
    const response = await handler(new Request(`http://127.0.0.1${path}`));
    expect(response.status).toBe(status);
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
  test('rejects writes', async () => {
    expect((await handler(new Request('http://127.0.0.1/', { method: 'POST' }))).status).toBe(405);
  });
});

describe('result contract (fixtures are not benchmark evidence)', () => {
  test('accepts complete evidence and preserves exact checksum strings', () => {
    const value = fixture();
    expect(validateResult(value)).toBe(value);
  });
  test.each([
    value => { value.fatal = 'worker crashed'; },
    value => { value.workers = 1; },
    value => { value.visuals = true; },
    value => { value.atomics = false; },
    value => { value.main_thread = false; },
    value => { value.local_task_verified = false; },
    value => { value.page_event_loop_ticks = 0; },
    value => { value.results[1].page_owner_checks--; },
    value => { value.results.pop(); },
    value => { value.results[1].name = 'serial'; },
    value => { value.results[0].warmup_ms = 4999; },
    value => { value.results[0].sample_ms = 4999; },
    value => { value.results[0].checksum = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.results[0].all_entity_values_verified = false; },
    value => { value.results[0].ticks = 0; },
    value => { value.results[0].updates_per_second = Infinity; },
    value => { value.results[0].p95_ms = 1; },
    value => { value.results[0].participating_threads_preflight = 2; },
    value => { value.results[1].participating_threads_preflight = 1; },
    value => { value.results[1].overlapping_systems_preflight = 1; },
    value => { value.results[2].participating_threads_preflight = 1; },
  ])('rejects invalid evidence %#', mutate => {
    const value = fixture(); mutate(value);
    expect(() => validateResult(value)).toThrow('Invalid ECS benchmark');
  });
});

test('worker awaits shared-memory initialization before entry and closes', async () => {
  const source = await Bun.file(new URL('./pool-worker.mjs', import.meta.url)).text();
  expect(source).toContain("await import('./pkg/wasm_ecs_bench.js')");
  expect(source).toContain('const [module, memory, work] = event.data');
  expect(source.indexOf('await init({ module_or_path: module, memory })')).toBeLessThan(source.indexOf('wasm_thread_entry_point(work)'));
  expect(source).toContain("new BroadcastChannel('bevy-ecs-benchmark')");
  expect(source).toContain('channel.postMessage({ fatal:');
  expect(source).toContain('self.close()');
});

test.each([false, true])('cleanup attempts server and group after DELETE (failure=%s), once', async fails => {
  const calls = [];
  const cleanup = ownedCleanup({
    deleteSession: async () => { calls.push('delete'); if (fails) throw Error('delete failed'); },
    stopGroup: async () => { calls.push('group'); },
    stopServer: async () => { calls.push('server'); },
  });
  if (fails) await expect(cleanup()).rejects.toThrow('Benchmark cleanup failed');
  else await cleanup();
  await cleanup().catch(() => {});
  expect(calls.filter(call => call === 'delete')).toHaveLength(1);
  expect(calls.filter(call => call === 'group')).toHaveLength(1);
  expect(calls.filter(call => call === 'server')).toHaveLength(1);
  expect(calls.indexOf('delete')).toBeLessThan(calls.indexOf('group'));
});

test('owned process cleanup signals only its group, including descendants after leader exit', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: 0, signalCode: null });
  const calls = [];
  const group = ownProcessGroup(child, { kill: (pid, signal) => calls.push([pid, signal]) });
  await group.stop(); await group.stop();
  expect(calls).toEqual([[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
});
