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
  ['extraction', 'Render extraction', /extract(?:_commands|_component|_resource|_mesh|_material|_view|_camera|_visible|_lights|_windows|_assets)|ExtractSchedule/i],
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

export function stackAttribution(thread, stack, names = new Map()) {
  let unresolved = false;
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
    for (const [id, , pattern] of categories) if (pattern.test(label)) {
          return { category: id, command: id === 'render_commands' ? commandCategory(label) : undefined,
            unresolved };
        }
    stack = row[thread.stackTable.schema.prefix];
  }
  return { category: 'unclassified', unresolved };
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
  return { command_breakdown: { parent: 'render_commands', rows: commands,
      method: 'Exclusive operation on the same innermost recognized frame as the parent; children sum to parent, not additional CPU. Generic backend names never imply submission.' },
    method: 'Exclusive innermost recognized sampled stack, weighted by OS threadCPUDelta; no wall-time interpolation',
    limitation: 'Statistical attribution, not exact execution timers. Inlined or unnamed operations may be attributed to a recognized ancestor or remain unclassified. Zero samples does not prove zero work. Wait/spin is CPU only when sampled with a positive OS delta.',
    rows };
}
