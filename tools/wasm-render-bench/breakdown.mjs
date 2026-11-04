// Resolve raw Firefox wasm-function[N] frames using the exact served module.
export function wasmFunctionNames(bytes) {
  const names = new Map();
  const module = new WebAssembly.Module(bytes);
  const decoder = new TextDecoder();
  for (const section of WebAssembly.Module.customSections(module, 'name')) {
    const data = new Uint8Array(section);
    let offset = 0;
    const uint = () => {
      let value = 0, shift = 0, byte;
      do {
        if (offset >= data.length || shift > 28) throw Error('Invalid Wasm name section');
        byte = data[offset++]; value += (byte & 127) * 2 ** shift; shift += 7;
      } while (byte & 128);
      return value;
    };
    while (offset < data.length) {
      const kind = data[offset++], size = uint(), end = offset + size;
      if (end > data.length) throw Error('Truncated Wasm name subsection');
      if (kind === 1) {
        const count = uint();
        for (let i = 0; i < count; i++) {
          const index = uint(), length = uint();
          if (offset + length > end) throw Error('Truncated Wasm function name');
          names.set(index, decoder.decode(data.subarray(offset, offset + length)));
          offset += length;
        }
      }
      offset = end;
    }
  }
  return names;
}

export const categories = [
  ['ecs_workload', 'ECS benchmark workload', /wasm_render_bench.*(?:heavy|motion)/i],
  ['transform_visibility', 'Transform / visibility', /bevy_(?:transform|camera.*visibility)|visibility::|check_visibility/i],
  ['extraction', 'Render extraction', /extract(?:_commands|_component|_resource|_mesh|_material|_view|_camera|_visible|_lights|_windows|_assets|_erased_assets|_erased_render_asset)|ExtractSchedule/i],
  ['assets_materials', 'Asset / material preparation', /bevy_asset|prepare_(?:assets|asset|material)|RenderAsset|MaterialPipeline/i],
  ['render_queue_sort', 'Render queue / sort', /queue_(?:meshes|material|shadows|view)|sort_(?:phase|binned|sorted)|batch_and_prepare|render_phase/i],
  ['render_preparation', 'Render preparation', /prepare_|bevy_render.*(?:bind_group|uniform|storage)|bevy_pbr.*(?:mesh|light)/i],
  ['render_commands', 'Command encoding / submission', /wgpu|webgpu|render_system|render_graph|draw_mesh|command_encoder|submit/i],
  ['ecs_scheduling', 'ECS executor / scheduling', /bevy_ecs.*(?:schedule|executor)|bevy_tasks|async_executor|concurrent_queue|event_listener|spin_loop|futex|atomic_wait/i],
  ['ecs_systems', 'Other ECS system machinery', /bevy_ecs/i],
];

export const commandCategories = [
  ['uploads_copies', 'Uploads / writes / copies'],
  ['resource_creation', 'Pipeline / binding / resource creation'],
  ['pass_boundaries', 'Render / compute pass begin/end'],
  ['draw_dispatch_state', 'Draw / dispatch / binding state'],
  ['encoder_lifecycle', 'Encoder creation / command finish'],
  ['queue_submission', 'Queue submission'],
  ['buffer_mapping', 'Buffer mapping / readback'],
  ['backend_conversion', 'Backend conversions / capabilities'],
  ['encoding_other', 'Encoding / backend other (unresolved)'],
];

// Normalize legacy Rust names as well as Firefox's demangled crate[hash] names.
// Do not interpret arbitrary `submit`, `finish`, `end`, or generic wgpu types as operations.
export function commandCategory(symbol) {
  let label = symbol.replace(/\[[0-9a-f]{8,}\]/gi, '');
  if (/^_ZN/.test(label)) {
    const parts = [];
    let rest = label.slice(3);
    while (/^\d/.test(rest)) {
      const length = /^\d+/.exec(rest)[0];
      rest = rest.slice(length.length);
      parts.push(rest.slice(0, Number(length)));
      rest = rest.slice(Number(length));
    }
    label = parts.join('::').replace(/\$LT\$/g, '<').replace(/\$GT\$/g, '>');
  }

  const method = (operation, owners) =>
    new RegExp(`(?:\\bwgpu::[\\w:]*|\\bGPU)(?:${owners})(?:Interface)?[> ]*(?:::|\\.)(?:${operation})(?=::|[< (]|$|_with_)`, 'i').test(label);
  if (method('write_buffer|write_texture|writeBuffer|writeTexture', '(?:Web|Gpu)?Queue') ||
        method('copy_buffer_to_buffer|copy_buffer_to_texture|copy_texture_to_buffer|copy_texture_to_texture|clear_buffer|resolve_query_set|copyBufferToBuffer|copyBufferToTexture|copyTextureToBuffer|copyTextureToTexture|clearBuffer|resolveQuerySet', '(?:Web|Gpu)?CommandEncoder')) return 'uploads_copies';
  if (method('create_command_encoder|createCommandEncoder', '(?:Web|Gpu)?Device') ||
      method('finish', '(?:Web|Gpu)?CommandEncoder')) return 'encoder_lifecycle';
  if (method('create_(?:render_pipeline|compute_pipeline|pipeline_layout|bind_group_layout|bind_group|buffer_init|buffer|texture|sampler|query_set)|create_view|createBindGroup|createBuffer|createTexture|createRenderPipeline|createComputePipeline', '(?:Web|Gpu)?(?:Device|Texture)|DeviceExt')) return 'resource_creation';
  if (method('begin_render_pass|begin_compute_pass|beginRenderPass|beginComputePass', '(?:Web|Gpu)?CommandEncoder') ||
      method('end', '(?:Web|Gpu)?(?:RenderPass|ComputePass)(?:Encoder)?')) return 'pass_boundaries';
  if (method('draw|draw_indexed|draw_indirect|draw_indexed_indirect|multi_draw_indirect|multi_draw_indexed_indirect|dispatch_workgroups|dispatch_workgroups_indirect|set_bind_group|set_pipeline|set_vertex_buffer|set_index_buffer|set_viewport|set_scissor_rect|set_blend_constant|set_stencil_reference|execute_bundles|setBindGroup|setPipeline|dispatchWorkgroups', '(?:Web|Gpu)?(?:RenderPass|ComputePass)(?:Encoder)?')) return 'draw_dispatch_state';
  if (method('submit', '(?:Web|Gpu)?Queue')) return 'queue_submission';
  if (method('map_async|get_mapped_range|unmap', '(?:Web|Gpu)?Buffer') ||
        method('map_buffer_on_submit', '(?:Web|Gpu)?CommandEncoder')) return 'buffer_mapping';
  if (/\bwgpu::backend::webgpu::(?:map_wgt_features|map_wgt_limits|map_texture_format)\b/.test(label)) return 'backend_conversion';
  return 'encoding_other';
}

export const materialCategories = [
  ['source_clone', 'Extraction / source clone'],
  ['old_properties_drop', 'Old prepared properties drop'],
  ['copy_layout', '1 Copy cached CPU layout descriptor'],
  ['get_layout', '2 Resolve GPU layout cache / handle clone'],
  ['build_bindings', '3 Build temporary bindings / uniform bytes'],
  ['lookup_binding', '4 Look up existing binding allocation'],
  ['validate_update', '5 Compare / reuse / retained bytes dirty'],
  ['new_allocation', '5 Allocate without existing binding'],
  ['replace_allocation', '5 Free / replace incompatible binding'],
  ['builder_clear', '6 Clear temporary binding builder'],
  ['drop_layout', '7 Drop temporary GPU layout handle'],
  ['properties', '8 Build CPU properties / keys / metadata'],
  ['return', '9 Return PreparedMaterial (not map insert)'],
  ['retained_uniform_write', 'Retained uniform page CPU write'],
  ['page_upload', 'Uniform page upload (separate)'],
  ['material_other', 'Material preparation (unresolved)'],
];

// A cross-cut of the exclusive broad rows, not a second additive CPU total.
// Generic Arc drops, memcpy, and uniform operations require a material ancestor.
export function materialAttribution(labels) {
  const normalized = labels.map(label => label.replace(/\[[0-9a-f]{8,}\]/gi, ''));
  const context = normalized.some(label => /material_prepare_|material_bind_groups::.*(?:prepare_material|write_material_bind_group_buffers|write_buffers)|(?:prepare_erased_assets|extract_erased_assets|extract_erased_render_asset).*MeshMaterial3d|MeshMaterial3d.*(?:prepare_cpu_assets|prepare_asset|prepare_erased_assets|extract_erased_assets|extract_erased_render_asset)/.test(label));
  if (!context) return undefined;
  if (normalized.some(label => /material_prepare_cpu_validate\b/.test(label))) return 'validate_update';
  // Whole sampling boundaries win over their implementation children (including drops).
  const boundary = normalized.map(label => /material_prepare_(copy_layout|get_layout|build_bindings|lookup_binding|replace_allocation|new_allocation|validate_update|builder_clear|drop_layout|properties|return)\b/.exec(label)).find(Boolean);
  if (boundary) return boundary[1];
  for (const label of normalized) {
    if (/material_prepare_page_upload/.test(label)) return 'page_upload';
    if (/material_prepare_retained_uniform_write/.test(label)) return 'retained_uniform_write';
    if (/drop_previous_prepared_asset|drop_in_place.*(?:PreparedMaterial|MaterialProperties)|Arc.*MaterialProperties.*drop/.test(label)) return 'old_properties_drop';
    if (/material_prepare_builder_clear|BindGroupBuilder.*clear/.test(label)) return 'builder_clear';
    if (/material_prepare_build_bindings|build_bind_group|binding_resource_key|uniform_from_texture_formats|AsBindGroupShaderType.*as_bind_group_shader_type/.test(label)) return 'build_bindings';
    if (/material_prepare_validate_update|update_non_bindless_data|material_bind_groups.*(?:try_update_data|update_data|commit_uniform_update|gpu_resources_are_unchanged)/.test(label)) return 'validate_update';
    if (/material_prepare_properties/.test(label)) return 'properties';
    if (/extract_erased_assets|extract_erased_render_asset/.test(label)) return 'source_clone';
  }
  return 'material_other';
}

export const bindingCategories = [
  ['texture_view_clone', 'TextureView wrapper clone'],
  ['sampler_clone', 'Sampler wrapper clone'],
  ['bindings_other', 'Other step 3 (lookup / fallback / uniform conversion / other)'],
];

export function bindingAttribution(labels) {
  if (materialAttribution(labels) !== 'build_bindings') return undefined;
  for (const raw of labels) {
    const label = raw.replace(/\[[0-9a-f]{8,}\]/gi, '');
    const match = /bevy_render::render_resource::texture::(TextureView|Sampler) as (?:core::clone::)?Clone>::clone\b/.exec(label);
    if (match) return match[1] === 'TextureView' ? 'texture_view_clone' : 'sampler_clone';
  }
  return 'bindings_other';
}

export function stackAttribution(thread, stack, names = new Map()) {
  let unresolved = false;
  let attribution;
  const labels = [];
  const seen = new Set();
  while (stack != null && !seen.has(stack)) {
    seen.add(stack);
    const row = thread.stackTable?.data?.[stack];
    if (!row) break;
    const frame = thread.frameTable?.data?.[row[thread.stackTable.schema.frame]];
    if (!frame) break;
    const location = thread.stringTable?.[frame[thread.frameTable.schema.location]] ?? '';
    const match = /wasm-function\[(\d+)\]/.exec(location);
    if (match && !names.has(Number(match[1]))) unresolved = true;
    const label = match ? names.get(Number(match[1])) ?? location : location;
    labels.push(label);
    if (!attribution) for (const [id, , pattern] of categories) if (pattern.test(label)) {
      attribution = { category: id, command: id === 'render_commands' ? commandCategory(label) : undefined };
      break;
    }
    stack = row[thread.stackTable.schema.prefix];
  }
  return { ...(attribution ?? { category: 'unclassified' }), unresolved, material: materialAttribution(labels), binding: bindingAttribution(labels) };
}

export function stackCategory(thread, stack, names = new Map()) {
  return stackAttribution(thread, stack, names).category;
}

export function cpuBreakdown(threads, updates) {
  const aggregate = (definitions, key) => definitions.map(row => {
    const sum = role => threads.filter(t => t.role === role).reduce((total, t) => total + (t[key]?.[row.id]?.cpu_ms ?? 0), 0);
    const main = sum('main'), workers = sum('worker');
    return { ...row, main_cpu_ms: main, workers_cpu_ms: workers, total_cpu_ms: main + workers,
      main_cpu_ms_per_update: main / updates, workers_cpu_ms_per_update: workers / updates,
      total_cpu_ms_per_update: (main + workers) / updates,
      samples: threads.reduce((total, t) => total + (t[key]?.[row.id]?.samples ?? 0), 0) };
  });
  const rows = aggregate([...categories.map(([id, label]) => ({ id, label })), { id: 'unclassified', label: 'Unclassified Wasm' }], 'categories');
  const commands = aggregate(commandCategories.map(([id, label]) => ({ id, label })), 'command_categories');
  const materials = aggregate(materialCategories.map(([id, label]) => ({ id, label })), 'material_categories');
  const materialParents = aggregate([...categories.map(([id, label]) => ({ id, label })), { id: 'unclassified', label: 'Unclassified Wasm' }], 'material_parents');
  return { material_breakdown: { rows: materials, parents: materialParents,
        build_bindings: { parent: 'build_bindings', rows: aggregate(bindingCategories.map(([id, label]) => ({ id, label })), 'binding_categories'),
          method: 'Exclusive children of step 3, not additional CPU. Clone boundaries include ID copy and inner wrapper clone plus synchronous descendants only; zero samples is not zero cost.' }, 
      method: 'Exclusive innermost material substep across broad categories; parents show the exact broad-row portions covered. Do not add these rows to broad or command CPU. Extraction and page writes/uploads can be outside asset preparation.',
      classified_samples: materials.filter(row => row.id !== 'material_other').reduce((sum, row) => sum + row.samples, 0),
      samples: materials.reduce((sum, row) => sum + row.samples, 0) },
    command_breakdown: { parent: 'render_commands', rows: commands,
      method: 'Exclusive operation on the same innermost recognized frame as the parent; children sum to parent, not additional CPU. Generic backend names never imply submission.' },
    method: 'Exclusive innermost recognized sampled stack, weighted by OS threadCPUDelta; no wall-time interpolation',
    limitation: 'Statistical attribution, not exact execution timers. Inlined or unnamed operations may be attributed to a recognized ancestor or remain unclassified. Zero samples does not prove zero work. Wait/spin is CPU only when sampled with a positive OS delta.',
    rows };
}
