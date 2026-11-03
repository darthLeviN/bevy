import { test, expect } from 'bun:test';
import { stackCategory, cpuBreakdown, wasmFunctionNames } from './breakdown.mjs';

function thread(labels) {
  return { stringTable: labels, frameTable: { schema: { location: 0 }, data: labels.map((_, i) => [i]) },
    stackTable: { schema: { frame: 1, prefix: 0 }, data: labels.map((_, i) => [i ? i - 1 : null, i]) } };
}

test('exclusive innermost operation wins over enclosing ECS executor and render stages', () => {
  const t = thread(['bevy_ecs::schedule::executor', 'bevy_render::prepare_assets', 'wasm-function[7]', '0x1234']);
  expect(stackCategory(t, 3, new Map([[7, 'wasm_render_bench::heavy::work']]))).toBe('ecs_workload');
  expect(stackCategory(t, 1)).toBe('assets_materials');
  expect(stackCategory(t, 0)).toBe('ecs_scheduling');
  expect(stackCategory(thread(['wasm-function[999]']), 0)).toBe('unclassified');
});

test('cyclic and missing stack tables terminate without invented attribution', () => {
  const t = thread(['wasm-function[999]']); t.stackTable.data[0][0] = 0;
  expect(stackCategory(t, 0)).toBe('unclassified');
  expect(stackCategory({}, 100)).toBe('unclassified');
});

test('CPU breakdown conserves exclusive role totals including unclassified and sample counts', () => {
  const result = cpuBreakdown([
    { role: 'main', categories: { ecs_workload: { cpu_ms: 20, samples: 2 }, unclassified: { cpu_ms: 5, samples: 1 } } },
    { role: 'worker', categories: { ecs_scheduling: { cpu_ms: 10, samples: 4 } } },
  ], 5);
  expect(result.rows.reduce((s, r) => s + r.total_cpu_ms_per_update, 0)).toBe(7);
  expect(result.rows.reduce((s, r) => s + r.main_cpu_ms_per_update, 0)).toBe(5);
  expect(result.rows.reduce((s, r) => s + r.workers_cpu_ms_per_update, 0)).toBe(2);
  expect(result.rows.reduce((s, r) => s + r.samples, 0)).toBe(7);
});

test('reads function indexes from Wasm custom name section without executing module', () => {
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,0,13,4,110,97,109,101,1,6,1,7,3,102,111,111]);
  expect(wasmFunctionNames(bytes).get(7)).toBe('foo');
  expect(wasmFunctionNames(Uint8Array.from([0,97,115,109,1,0,0,0])).size).toBe(0);
});
