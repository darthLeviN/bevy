import { test, expect } from 'bun:test';
import { stackCategory, stackAttribution, commandCategory, cpuBreakdown, wasmFunctionNames } from './breakdown.mjs';

function thread(labels) {
  return { stringTable: labels, frameTable: { schema: { location: 0 }, data: labels.map((_, i) => [i]) },
    stackTable: { schema: { frame: 1, prefix: 0 }, data: labels.map((_, i) => [i ? i - 1 : null, i]) } };
}

test('all nine prepare boundaries and allocation branches retain exclusive context', () => {
  const parent = 'bevy_pbr::MeshMaterial3d<StandardMaterial>::prepare_asset';
  for (const id of ['copy_layout', 'get_layout', 'build_bindings', 'lookup_binding', 'validate_update', 'new_allocation', 'replace_allocation', 'builder_clear', 'drop_layout', 'properties', 'return']) {
    const labels = [parent, `bevy_render::material_prepare_${id}`, 'memcpy'];
    expect(stackAttribution(thread(labels), 2).material).toBe(id);
  }
  const labels = [parent, 'material_prepare_validate_update', 'material_prepare_replace_allocation', 'GPUDevice.createBindGroup'];
  expect(stackAttribution(thread(labels), 3).material).toBe('replace_allocation');
  expect(stackAttribution(thread(['GPUDevice.createBindGroup']), 0).material).toBeUndefined();
});

test('parallel material validation and ID-only binding resolution keep material attribution', () => {
  for (const [operation, expected] of [
    ['material_prepare_cpu_validate', 'validate_update'],
    ['bevy_pbr::StandardMaterial::binding_resource_key', 'build_bindings'],
    ['bevy_pbr::StandardMaterial::uniform_from_texture_formats', 'build_bindings'],
  ]) {
    const labels = ['bevy_pbr::MeshMaterial3d<StandardMaterial>::prepare_cpu_assets', operation, 'memcpy'];
    expect(stackAttribution(thread(labels), 2).material).toBe(expected);
  }
  const commit = ['bevy_pbr::MeshMaterial3d<StandardMaterial>::prepare_asset', 'bevy_render::material_bind_groups::RenderMaterialBindings::commit_uniform_update'];
  expect(stackAttribution(thread(commit), 1).material).toBe('validate_update');
  expect(stackAttribution(thread(['other::uniform_from_texture_formats']), 0).material).toBeUndefined();
});

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

test('material substeps use innermost context and never capture unrelated generic drops', () => {
  const parent = 'bevy_render::erased_render_asset::prepare_erased_assets<bevy_pbr::MeshMaterial3d<bevy_pbr::StandardMaterial>>';
  const cases = [
    [['bevy_render::material_bind_groups::material_prepare_build_bindings', 'encase::core::WriteInto::write_into'], 'build_bindings'],
    [['bevy_render::material_bind_groups::material_prepare_validate_update', 'bevy_render::material_bind_groups::update_non_bindless_data', 'memcpy'], 'validate_update'],
    [['bevy_render::drop_previous_prepared_asset', 'alloc::sync::Arc<bevy_material::MaterialProperties>::drop_slow', '__rust_dealloc'], 'old_properties_drop'],
    [['bevy_render::material_bind_groups::material_prepare_builder_clear', 'alloc::vec::Vec::clear'], 'builder_clear'],
    [['bevy_pbr::material::material_prepare_properties', 'alloc::sync::Arc::new'], 'properties'],
    [['bevy_render::material_bind_groups::material_prepare_retained_uniform_write', 'memcpy'], 'retained_uniform_write'],
    [['bevy_render::material_bind_groups::material_prepare_page_upload', 'wgpu::Queue::write_buffer'], 'page_upload'],
    [[], 'material_other'],
  ];
  for (const [children, expected] of cases) {
    const labels = [parent, ...children];
    expect(stackAttribution(thread(labels), labels.length - 1).material).toBe(expected);
  }
  const extraction = thread(['bevy_render::erased_render_asset::extract_erased_render_asset<bevy_pbr::MeshMaterial3d<bevy_pbr::StandardMaterial>>', 'StandardMaterial::clone']);
  expect(stackAttribution(extraction, 1)).toMatchObject({ category: 'extraction', material: 'source_clone' });
  const unrelated = thread(['bevy_render::prepare_meshes', 'alloc::sync::Arc::drop_slow', 'memcpy']);
  expect(stackAttribution(unrelated, 2).material).toBeUndefined();
  const nested = thread([parent, 'bevy_pbr::material::material_prepare_properties', 'bevy_render::material_bind_groups::material_prepare_build_bindings']);
  expect(stackAttribution(nested, 2).material).toBe('build_bindings');
  const upload = thread([parent, 'bevy_render::material_bind_groups::material_prepare_page_upload', 'wgpu::Queue::write_buffer']);
  expect(stackAttribution(upload, 2)).toMatchObject({ category: 'render_commands', command: 'uploads_copies', material: 'page_upload' });
});

test('steps 2 and 3 capture whole boundaries without unrelated layout lookups or child drops', () => {
  const parent = 'bevy_render::material_bind_groups::RenderMaterialBindings::prepare_material';
  for (const [boundary, expected] of [['get_layout', 'get_layout'], ['build_bindings', 'build_bindings']]) {
    const labels = [parent, `bevy_render::material_bind_groups::material_prepare_${boundary}`,
      'PipelineCache::get_bind_group_layout', 'core::ptr::drop_in_place<MaterialProperties>'];
    expect(stackAttribution(thread(labels), labels.length - 1).material).toBe(expected);
  }
  const unrelated = thread(['bevy_render::pipeline_cache::compile_pipelines', 'PipelineCache::get_bind_group_layout']);
  expect(stackAttribution(unrelated, 1).material).toBeUndefined();
  const outside = thread([parent, 'PipelineCache::get_bind_group_layout']);
  expect(stackAttribution(outside, 1).material).toBe('material_other');
  const result = cpuBreakdown([{ role: 'main', material_categories: {
    get_layout: { cpu_ms: 2, samples: 1 }, build_bindings: { cpu_ms: 8, samples: 4 },
  }, material_parents: { render_preparation: { cpu_ms: 10, samples: 5 } } }], 2);
  const rows = result.material_breakdown.rows.filter(row => ['get_layout', 'build_bindings'].includes(row.id));
  expect(rows.map(row => row.total_cpu_ms_per_update)).toEqual([1, 4]);
  expect(rows.reduce((sum, row) => sum + row.samples, 0)).toBe(5);
});

test('material cross-cut conserves CPU and samples across different broad parents and roles', () => {
  const result = cpuBreakdown([
    { role: 'main', categories: { render_preparation: { cpu_ms: 20, samples: 4 }, render_commands: { cpu_ms: 5, samples: 1 } },
      material_categories: { properties: { cpu_ms: 10, samples: 2 }, material_other: { cpu_ms: 10, samples: 2 }, page_upload: { cpu_ms: 5, samples: 1 } },
      material_parents: { render_preparation: { cpu_ms: 20, samples: 4 }, render_commands: { cpu_ms: 5, samples: 1 } } },
    { role: 'worker', categories: { extraction: { cpu_ms: 3, samples: 1 } },
      material_categories: { source_clone: { cpu_ms: 3, samples: 1 } }, material_parents: { extraction: { cpu_ms: 3, samples: 1 } } },
  ], 2);
  const detail = result.material_breakdown;
  for (const key of ['main_cpu_ms', 'workers_cpu_ms', 'total_cpu_ms', 'samples']) {
    expect(detail.rows.reduce((s, r) => s + r[key], 0)).toBe(detail.parents.reduce((s, r) => s + r[key], 0));
    expect(detail.rows.reduce((s, r) => s + r[key], 0)).toBe(result.rows.reduce((s, r) => s + r[key], 0));
  }
  expect(detail.classified_samples).toBe(4);
  expect(detail.samples).toBe(6);
});

test('step 3 clone children require exact wrapper clone and material boundary, including synchronous JS descendants', () => {
  const build = 'bevy_render::material_bind_groups::material_prepare_build_bindings';
  const clone = type => `<bevy_render[123456789abcdef0]::render_resource::texture::${type} as core::clone::Clone>::clone`;
  for (const [type, expected] of [['TextureView', 'texture_view_clone'], ['Sampler', 'sampler_clone']]) {
    const labels = [build, clone(type), 'send_wrapper::SendWrapper::clone', 'JS::CloneWrapper'];
    expect(stackAttribution(thread(labels), 3)).toMatchObject({ material: 'build_bindings', binding: expected });
    expect(stackAttribution(thread([clone(type)]), 0).binding).toBeUndefined();
    const dropped = ['bevy_render::material_bind_groups::material_prepare_builder_clear', clone(type)];
    expect(stackAttribution(thread(dropped), 1).binding).toBeUndefined();
  }
  for (const leaf of ['Arc<MaterialProperties>::clone', 'TextureView::lookup', 'fallback_image', 'uniform_conversion', 'drop_in_place<TextureView>']) {
    expect(stackAttribution(thread([build, leaf]), 1).binding).toBe('bindings_other');
  }
  const result = cpuBreakdown([{ role: 'main', material_categories: { build_bindings: { cpu_ms: 10, samples: 5 } },
    binding_categories: { texture_view_clone: { cpu_ms: 4, samples: 2 }, sampler_clone: { cpu_ms: 2, samples: 1 }, bindings_other: { cpu_ms: 4, samples: 2 } } }], 2);
  const detail = result.material_breakdown;
  for (const key of ['main_cpu_ms', 'total_cpu_ms', 'samples']) {
    expect(detail.build_bindings.rows.reduce((sum, row) => sum + row[key], 0)).toBe(detail.rows.find(row => row.id === 'build_bindings')[key]);
  }
});

test('reads function indexes from Wasm custom name section without executing module', () => {
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,0,13,4,110,97,109,101,1,6,1,7,3,102,111,111]);
  expect(wasmFunctionNames(bytes).get(7)).toBe('foo');
  expect(wasmFunctionNames(Uint8Array.from([0,97,115,109,1,0,0,0])).size).toBe(0);
});
