import { test, expect } from 'bun:test';
import { stackCategory, stackAttribution, commandCategory, cpuBreakdown, wasmFunctionNames } from './breakdown.mjs';

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

test('captured Firefox demangled and legacy Rust operations classify by receiver and method', () => {
  const cases = [
    ['<wgpu[7671c6e8c24c6970]::backend::webgpu::WebDevice as wgpu[7671c6e8c24c6970]::dispatch::DeviceInterface>::create_bind_group', 'resource_creation'],
    ['<wgpu::api::device::Device as wgpu::util::device::DeviceExt>::create_buffer_init', 'resource_creation'],
    ['<wgpu::backend::webgpu::webgpu_sys::gen_GpuQueue::GpuQueue>::write_buffer_with_f64_and_u8_slice_and_f64_and_f64::__wbg_writeBuffer_8b5bd251a89198bc externref shim', 'uploads_copies'],
    ['<wgpu::backend::webgpu::WebCommandEncoder as wgpu::dispatch::CommandEncoderInterface>::begin_render_pass::{closure#0}', 'pass_boundaries'],
    ['<wgpu::backend::webgpu::WebComputePassEncoder as wgpu::dispatch::ComputePassInterface>::end', 'pass_boundaries'],
    ['<wgpu::api::render_pass::RenderPass>::draw', 'draw_dispatch_state'],
    ['<wgpu::backend::webgpu::WebRenderPassEncoder as wgpu::dispatch::RenderPassInterface>::set_bind_group', 'draw_dispatch_state'],
    ['<wgpu::api::command_encoder::CommandEncoder>::finish', 'encoder_lifecycle'],
    ['<wgpu::backend::webgpu::webgpu_sys::gen_GpuDevice::GpuDevice>::create_command_encoder_with_descriptor', 'encoder_lifecycle'],
    ['GPUQueue.submit', 'queue_submission'],
    ['_ZN4wgpu3api5queue5Queue6submit17h0123456789abcdefE', 'queue_submission'],
    ['<wgpu::api::command_encoder::CommandEncoder>::map_buffer_on_submit', 'buffer_mapping'],
    ['wgpu[7671c6e8c24c6970]::backend::webgpu::map_wgt_features', 'backend_conversion'],
    ['wgpu::backend::webgpu::register_then_closures', 'encoding_other'],
    ['PWebGPU::Msg_Messages', 'encoding_other'],
    ['other::Queue::submit', 'encoding_other'],
    ['other::Thing<wgpu::Buffer>::create_buffer', 'encoding_other'],
    ['other::Queue<wgpu::Buffer>::submit', 'encoding_other'],
    ['wgpu::Device::finish', 'encoding_other'],
    ['wgpu::Buffer::end', 'encoding_other'],
    ['wgpu::Queue::submit_pending', 'encoding_other'],
    ['wgpu::CommandEncoder::finish_frame', 'encoding_other'],
  ];
  for (const [symbol, expected] of cases) expect(commandCategory(symbol)).toBe(expected);
});

test('children never steal another broad category or replace an innermost generic backend with submission', () => {
  const t = thread(['wgpu::Queue::submit', 'wgpu::backend::webgpu::register_then_closures']);
  expect(stackAttribution(t, 1)).toMatchObject({ category: 'render_commands', command: 'encoding_other' });
  const preparation = thread(['wgpu::Queue::submit', 'bevy_render::prepare_bind_group']);
  expect(stackAttribution(preparation, 1)).toMatchObject({ category: 'render_preparation', command: undefined });
  const unresolved = thread(['wgpu::Queue::submit', 'wasm-function[999]']);
  expect(stackAttribution(unresolved, 1)).toMatchObject({ category: 'render_commands', command: 'queue_submission', unresolved: true });
});

test('function names retain absolute indexes including imported functions', () => {
  // One imported function (index 0) and one defined function (index 1).
  const bytes = Uint8Array.from([
    0,97,115,109,1,0,0,0,
    1,4,1,96,0,0,
    2,7,1,1,109,1,102,0,0,
    3,2,1,0,
    10,4,1,2,0,11,
    0,18,4,110,97,109,101,1,11,2,0,3,105,109,112,1,3,100,101,102,
  ]);
  const names = wasmFunctionNames(bytes);
  expect(names.get(0)).toBe('imp');
  expect(names.get(1)).toBe('def');
  expect(names.has(2)).toBe(false);
});

test('reads function indexes from Wasm custom name section without executing module', () => {
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,0,13,4,110,97,109,101,1,6,1,7,3,102,111,111]);
  expect(wasmFunctionNames(bytes).get(7)).toBe('foo');
  expect(wasmFunctionNames(Uint8Array.from([0,97,115,109,1,0,0,0])).size).toBe(0);
});
