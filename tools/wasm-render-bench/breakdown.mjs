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

export function stackCategory(thread, stack, names = new Map()) {
  const seen = new Set();
  while (stack != null && !seen.has(stack)) {
    seen.add(stack);
    const row = thread.stackTable?.data?.[stack];
    if (!row) break;
    const frame = thread.frameTable?.data?.[row[thread.stackTable.schema.frame]];
    if (!frame) break;
    const location = thread.stringTable?.[frame[thread.frameTable.schema.location]] ?? '';
    const match = /wasm-function\[(\d+)\]/.exec(location);
    const label = match ? names.get(Number(match[1])) ?? location : location;
    for (const [id, , pattern] of categories) if (pattern.test(label)) return id;
    stack = row[thread.stackTable.schema.prefix];
  }
  return 'unclassified';
}

export function cpuBreakdown(threads, updates) {
  const rows = [...categories.map(([id, label]) => ({ id, label })), { id: 'unclassified', label: 'Unclassified Wasm' }].map(row => {
    const sum = role => threads.filter(t => t.role === role).reduce((total, t) => total + (t.categories[row.id]?.cpu_ms ?? 0), 0);
    const main = sum('main'), workers = sum('worker');
    return { ...row, main_cpu_ms: main, workers_cpu_ms: workers, total_cpu_ms: main + workers,
      main_cpu_ms_per_update: main / updates, workers_cpu_ms_per_update: workers / updates,
      total_cpu_ms_per_update: (main + workers) / updates,
      samples: threads.reduce((total, t) => total + (t.categories[row.id]?.samples ?? 0), 0) };
  });
  return { method: 'Exclusive innermost recognized sampled stack, weighted by OS threadCPUDelta; no wall-time interpolation',
    limitation: 'Statistical attribution, not exact execution timers. Inlined or unnamed operations may be attributed to a recognized ancestor or remain unclassified. Zero samples does not prove zero work. Wait/spin is CPU only when sampled with a positive OS delta.',
    rows };
}
