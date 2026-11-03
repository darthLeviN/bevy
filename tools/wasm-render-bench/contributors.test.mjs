import { test, expect } from 'bun:test';
import { conversionContributors, contributorSummary } from './contributors.mjs';
import { cpuAccounting } from './cpu.mjs';

function fixture() {
  const labels = ['wasm_render_bench.wasm.wgpu[7671c6e8c24c6970]::backend::webgpu::map_wgt_features (http://localhost/pkg/bench.wasm:123)',
    '__wbg_has (http://localhost/pkg/bench.js:10)', 'native leaf',
    'wasm_render_bench.wasm.wgpu::backend::webgpu::map_wgt_limits (http://localhost/pkg/bench.wasm:456)'];
  const thread = { pid: 42, tid: 43, name: 'GeckoMain', processType: 'tab', stringTable: labels,
    markers: { schema: { data: 0, startTime: 1 }, data: [[{ name: 'benchmark-cpu-start' }, 10], [{ name: 'benchmark-cpu-end' }, 5010]] },
    samples: { schema: { time: 0, threadCPUDelta: 1, stack: 2 },
      data: [[0, 0, 2], [11, 999000000, 2], [1000, 2000000, 2], [2000, 8000000, 2], [5009, 4000000, 3], [5011, 999000000, 2]] },
    frameTable: { schema: { location: 0 }, data: labels.map((_, i) => [i]) },
    stackTable: { schema: { prefix: 0, frame: 1 }, data: [[null, 0], [0, 1], [1, 2], [null, 3]] } };
  return { meta: { sampleUnits: { threadCPUDelta: 'ns' } }, threads: [thread] };
}
const result = { frames: 2, measurement_ms: 5000, compute_workers: 0 };

test('contributors preserve native/JS leaf evidence and OS weights, excluding crossing intervals', () => {
  const profile = fixture();
  const rows = conversionContributors(profile, result, new Map());
  expect(rows).toHaveLength(2);
  expect(rows[0].samples).toBe(2);
  expect(rows[0].cpu_ms).toBe(10);
  expect(rows[0].cpu_ms_per_update).toBe(5);
  expect(rows[0].symbol).toContain('map_wgt_features');
  expect(rows[0].stack.map(frame => frame.raw)).toEqual(['native leaf', profile.threads[0].stringTable[1], profile.threads[0].stringTable[0]]);
  const summary = contributorSummary(rows);
  expect(summary.reduce((sum, row) => sum + row.samples, 0)).toBe(3);
  const parent = cpuAccounting(profile, result).application_cpu.breakdown.command_breakdown.rows.find(row => row.id === 'backend_conversion');
  expect(summary.reduce((sum, row) => sum + row.cpu_ms_per_update, 0)).toBe(parent.total_cpu_ms_per_update);
});

test('raw Wasm indexes use exact supplied names; an inner operation is not charged to an outer conversion', () => {
  const profile = fixture();
  profile.threads[0].stringTable[0] = 'wasm-function[7]';
  const names = new Map([[7, 'wgpu::backend::webgpu::map_wgt_features']]);
  expect(conversionContributors(profile, result, names)[0].symbol).toBe(names.get(7));
  profile.threads[0].stringTable[1] = 'wgpu::Device::create_bind_group';
  expect(conversionContributors(profile, result, names).every(row => !row.symbol.includes('map_wgt_features'))).toBe(true);
});

test('creation contributors use exclusive OS weights and retain material callers', () => {
  const profile = fixture();
  profile.threads[0].stringTable[0] = 'bevy_render::material_bind_groups::MaterialBindGroupAllocator::prepare_bind_groups';
  profile.threads[0].stringTable[1] = 'wgpu::Device::create_bind_group';
  const rows = conversionContributors(profile, result, new Map(), 'resource_creation');
  expect(rows).toHaveLength(1);
  expect(rows[0].samples).toBe(2);
  expect(rows[0].cpu_ms_per_update).toBe(5);
  expect(rows[0].symbol).toBe('wgpu::Device::create_bind_group');
  expect(rows[0].stack.at(-1).symbol).toContain('prepare_bind_groups');
});

test('preparation contributors match the exclusive parent and exclude inner GPU operations', () => {
  const profile = fixture();
  profile.threads[0].stringTable[0] = 'wasm_render_bench.wasm.bevy_pbr::mesh::prepare_meshes';
  profile.threads[0].stringTable[3] = 'wasm_render_bench.wasm.bevy_render::uniform::prepare_uniforms';
  const rows = conversionContributors(profile, result, new Map(), 'render_preparation');
  expect(rows).toHaveLength(2);
  expect(rows[0].stack[0].raw).toBe('native leaf');
  const parent = cpuAccounting(profile, result).application_cpu.breakdown.rows.find(row => row.id === 'render_preparation');
  expect(rows.reduce((sum, row) => sum + row.cpu_ms_per_update, 0)).toBe(parent.total_cpu_ms_per_update);
  profile.threads[0].stringTable[1] = 'wgpu::Device::create_bind_group';
  expect(conversionContributors(profile, result, new Map(), 'render_preparation')).toHaveLength(1);
});

test('unavailable accounting is rejected rather than reporting zero conversion CPU', () => {
  expect(() => conversionContributors({}, result, new Map())).toThrow('CPU window');
});
