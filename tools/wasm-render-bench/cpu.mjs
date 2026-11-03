import { processes, cpuMillisecondsPerUnit, hasWasmFrame } from '../../../../editor-benchmark/profile.mjs';

function sampledApplicationCpu(threads, updates) {
  const sum = key => threads.reduce((total, row) => total + row[key], 0);
  const coverage = {
    samples: sum('samples'), stack_samples: sum('stack_samples'), wasm_samples: sum('wasm_samples'),
    captured_threads: threads.length,
    threads_with_stacks: threads.filter(row => row.stack_samples > 0).length,
    other_or_unclassified_cpu_ms: sum('other_or_unclassified_cpu_ms'),
    missing_stack_cpu_ms: sum('missing_stack_cpu_ms'),
    omitted_boundary_upper_bound_ms: sum('omitted_boundary_upper_bound_ms'),
  };
  const metadata = { method: 'sampled Wasm stack attribution weighted by OS threadCPUDelta',
    scope: 'Marked content GeckoMain + DOM workers only; synchronous browser callees with Wasm ancestors included; JS-only and asynchronous work excluded',
    coverage, threads };
  const roleCpu = role => {
    const rows = threads.filter(row => row.role === role);
    if (!rows.length) return role === 'worker' ? 0 : null;
    // A sampled zero CPU delta needs no stack attribution. Positive CPU
    // without any readable stacks must not masquerade as idle Wasm.
    if (rows.some(row => row.cpu_ms > 0 && !row.stack_samples)) return null;
    if (!rows.some(row => row.wasm_samples) && rows.some(row => row.cpu_ms > 0)) return null;
    return rows.reduce((total, row) => total + row.sampled_wasm_cpu_ms, 0);
  };
  const main = roleCpu('main');
  const workers = roleCpu('worker');
  if (main === null || workers === null) {
    return { ...metadata, supported: false, partial: true, reason: 'Wasm stack attribution unavailable for one or more CPU roles; available roles retained',
      updates, main_cpu_ms_per_update: main === null ? null : main / updates,
      workers_cpu_ms_per_update: workers === null ? null : workers / updates };
  }
  return { ...metadata, supported: true, updates,
    main_cpu_ms: main, workers_cpu_ms: workers, total_cpu_ms: main + workers,
    main_cpu_ms_per_update: main / updates, workers_cpu_ms_per_update: workers / updates,
    total_cpu_ms_per_update: (main + workers) / updates };
}

export function cpuAccounting(profile, result) {
  const unavailable = reason => ({ supported: false, reason });
  const windows = [], markerCoverage = [];
  for (const process of processes(profile)) for (const thread of process.threads ?? []) {
    if (thread.name !== 'GeckoMain' || !['tab', 'content'].includes(thread.processType)) continue;
    let start;
    const observed = { pid: thread.pid, tid: thread.tid,
      retained_first_sample_ms: thread.samples?.data?.[0]?.[thread.samples?.schema?.time], markers: [] };
    markerCoverage.push(observed);
    const schema = thread.markers?.schema;
    if (!schema) continue;
    for (const row of thread.markers.data) {
      const name = row[schema.data]?.name;
      const time = row[schema.startTime] ?? row[schema.endTime];
      if (/^benchmark-cpu-(start|end|reset)$/.test(name)) observed.markers.push({ name, time });
      if (name === 'benchmark-cpu-reset') start = undefined;
      if (name === 'benchmark-cpu-start') start = time;
      if (name === 'benchmark-cpu-end' && Number.isFinite(start) && time > start) {
        windows.push({ process, main: thread, start, end: time });
      }
    }
  }
  if (windows.length !== 1) return { ...unavailable('Missing or ambiguous content-process CPU window; profiler retention may have lost measurement markers'), marker_coverage: markerCoverage };
  const { process, main, start, end } = windows[0];
  const unit = process.meta?.sampleUnits?.threadCPUDelta ?? profile.meta?.sampleUnits?.threadCPUDelta;
  const millisecondsPerUnit = cpuMillisecondsPerUnit(profile, process);
  if (!millisecondsPerUnit) return unavailable('Unknown Firefox threadCPUDelta unit: ' + String(unit));
  if (Math.abs(end - start - result.measurement_ms) > 10) return unavailable('CPU markers do not match the update measurement window');
  const threads = (process.threads ?? []).filter(thread => thread.pid === main.pid &&
    (thread === main || /^DOM Worker(?:$|\b)/.test(thread.name)));
  if (threads.length - 1 < result.compute_workers) return unavailable('Profiler did not capture all requested DOM workers');
  if (new Set(threads.map(thread => thread.tid)).size !== threads.length) {
    return unavailable('Duplicate profiler thread IDs would double-count CPU');
  }
  const rows = [];
  for (const thread of threads) {
    const schema = thread.samples?.schema;
    const data = thread.samples?.data;
    if (schema?.threadCPUDelta === undefined || !data?.length) return unavailable('Firefox OS thread CPU deltas unavailable');
    let cpuDelta = 0, previous, first, last, boundaryMaxMs = 0, count = 0;
    let wasmDelta = 0, missingStackDelta = 0, stackSamples = 0, wasmSamples = 0;
    const stacks = new Map();
    for (const sample of data) {
      const time = sample[schema.time];
      if (!Number.isFinite(time) || (previous !== undefined && time <= previous)) {
        return unavailable('Invalid or overlapping profiler sample intervals');
      }
      // A delta belongs to the interval since the previous sample. Never
      // prorate a crossing interval using wall time or count it as CPU.
      if (Number.isFinite(previous) && previous >= start && time <= end) {
        const delta = sample[schema.threadCPUDelta];
        if (!Number.isFinite(delta) || delta < 0) return unavailable('Missing OS CPU delta within measurement window');
        cpuDelta += delta;
        const stack = sample[schema.stack];
        if (!stacks.has(stack)) stacks.set(stack, hasWasmFrame(thread, stack));
        const wasm = stacks.get(stack);
        if (wasm === null) missingStackDelta += delta;
        else stackSamples++;
        if (wasm === true) { wasmDelta += delta; wasmSamples++; }
        first ??= previous;
        last = time;
        count++;
      }
      if (Number.isFinite(previous) && ((previous < start && time > start) || (previous < end && time > end))) {
        boundaryMaxMs += time - previous;
      }
      previous = time;
    }
    if (!count || first === undefined || last === undefined || data[0][schema.time] > start || previous < end) {
      return unavailable('Profiler samples do not cover the complete CPU window');
    }
    rows.push({ pid: thread.pid, tid: thread.tid, name: thread.name,
      role: thread === main ? 'main' : 'worker', cpu_ms: cpuDelta * millisecondsPerUnit,
      sampled_wasm_cpu_ms: wasmDelta * millisecondsPerUnit,
      other_or_unclassified_cpu_ms: (cpuDelta - wasmDelta) * millisecondsPerUnit,
      missing_stack_cpu_ms: missingStackDelta * millisecondsPerUnit,
      stack_samples: stackSamples, wasm_samples: wasmSamples,
      samples: count, covered_start_ms: first, covered_end_ms: last,
      omitted_boundary_upper_bound_ms: boundaryMaxMs });
  }
  const mainMs = rows.filter(row => row.role === 'main').reduce((sum, row) => sum + row.cpu_ms, 0);
  const workerMs = rows.filter(row => row.role === 'worker').reduce((sum, row) => sum + row.cpu_ms, 0);
  const applicationCpu = sampledApplicationCpu(rows, result.frames);
  return { supported: true, application_cpu: applicationCpu, source: 'Firefox profiler OS threadCPUDelta', cpu_delta_unit: unit,
    scope: 'Marked content process GeckoMain + all captured DOM workers; includes browser/JS/Wasm work on those threads, not Wasm-only or whole-browser CPU',
    profiled: true, boundary_policy: 'Sum only fully enclosed sample intervals; lower bound, no wall-time interpolation',
    pid: main.pid, start_ms: start, end_ms: end, updates: result.frames,
    main_cpu_ms: mainMs, workers_cpu_ms: workerMs, total_cpu_ms: mainMs + workerMs,
    main_cpu_ms_per_update: mainMs / result.frames, workers_cpu_ms_per_update: workerMs / result.frames,
    total_cpu_ms_per_update: (mainMs + workerMs) / result.frames,
    omitted_boundary_upper_bound_ms: rows.reduce((sum, row) => sum + row.omitted_boundary_upper_bound_ms, 0), threads: rows };
}
