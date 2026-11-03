import { test, expect } from 'bun:test';
import { cpuAccounting } from './cpu.mjs';
import { cpuWindow } from '../../../../editor-benchmark/profile.mjs';

function fixture() {
  const thread = (name, tid, delta) => ({ name, tid, pid: 42, processType: 'tab',
    markers: { schema: { data: 0, startTime: 1 }, data: name === 'GeckoMain' ?
      [[{ name: 'benchmark-cpu-start' }, 10], [{ name: 'benchmark-cpu-end' }, 5010]] : [] },
    samples: { schema: { time: 0, threadCPUDelta: 1 },
      data: [[0, null], [11, delta], [1000, delta], [5009, delta], [5011, delta]] } });
  return { meta: { sampleUnits: { threadCPUDelta: 'ns' } }, threads: [{ ...thread('GeckoMain', 1, 999999999), pid: 1, processType: 'default' }],
    processes: [{ threads: [thread('GeckoMain', 42, 1000000), thread('DOM Worker', 43, 2000000)] }] };
}
const result = { frames: 500, measurement_ms: 5000, compute_workers: 1 };

function withStacks(profile) {
  for (const thread of profile.processes[0].threads) {
    thread.stringTable = ['(root)', 'update (http://localhost/pkg/wasm_render_bench_bg.wasm:1)', 'browser', '0x1234', 'wasm'];
    thread.frameTable = { schema: { location: 0, implementation: 1 }, data: [[0, null], [1, null], [2, null], [3, null], [3, 4]] };
    thread.stackTable = { schema: { prefix: 0, frame: 1 }, data: [[null, 0], [0, 1], [0, 2], [1, 3], [0, 4]] };
    thread.samples.schema.stack = 2;
    // One enclosed Wasm-ancestor sample, one enclosed nonmatching sample.
    thread.samples.data.forEach((row, index) => row.push(index === 2 ? 3 : 2));
  }
  return profile;
}

test('sampled application CPU weights actual raw Gecko stacks by deltas and separates roles', () => {
  const profile = withStacks(fixture());
  const worker = profile.processes[0].threads[1];
  worker.samples.data[2][2] = 4; // implementation string identifies Wasm even without a label
  worker.samples.data[3][1] = 8000000;
  const cpu = cpuAccounting(profile, result).application_cpu;
  expect(cpu.supported).toBe(true);
  expect(cpu.main_cpu_ms_per_update).toBe(1 / 500);
  expect(cpu.workers_cpu_ms_per_update).toBe(2 / 500);
  expect(cpu.total_cpu_ms_per_update).toBe(3 / 500);
  expect(cpu.coverage.other_or_unclassified_cpu_ms).toBe(9);
  expect(cpu.coverage.stack_samples).toBe(4);
  expect(cpu.coverage.wasm_samples).toBe(2);
  expect(cpu.threads.map(row => row.tid)).toEqual([42, 43]);
  for (const role of ['main', 'workers', 'total']) {
    expect(cpu.breakdown.rows.reduce((sum, row) => sum + row[role + '_cpu_ms_per_update'], 0))
      .toBeCloseTo(cpu[role + '_cpu_ms_per_update'], 12);
  }
  expect(cpu.breakdown.rows.find(row => row.id === 'unclassified').samples).toBe(2);
});

test('missing stacks and no identifiable Wasm are unavailable, not application zero', () => {
  for (const mutate of [
    p => { delete p.processes[0].threads[1].stackTable; },
    p => { for (const t of p.processes[0].threads) for (const row of t.samples.data) row[2] = 2; },
    p => { delete p.processes[0].threads[0].samples.schema.stack; },
  ]) {
    const profile = withStacks(fixture()); mutate(profile);
    const cpu = cpuAccounting(profile, result).application_cpu;
    expect(cpu.supported).toBe(false);
    expect(cpu.total_cpu_ms_per_update).toBeUndefined();
    expect(cpu.reason).toContain('Wasm stack attribution unavailable');
  }
});

test('partial missing stacks retain explicit unclassified CPU; serial workers are zero', () => {
  const profile = withStacks(fixture());
  profile.processes[0].threads.pop();
  profile.processes[0].threads[0].samples.data[3][2] = null;
  const cpu = cpuAccounting(profile, { ...result, compute_workers: 0 }).application_cpu;
  expect(cpu.supported).toBe(true);
  expect(cpu.workers_cpu_ms_per_update).toBe(0);
  expect(cpu.coverage.missing_stack_cpu_ms).toBe(1);
  expect(cpu.coverage.stack_samples).toBe(1);
});

test('one mesh with four sampled idle workers retains main attribution without requiring idle stacks', () => {
  const profile = withStacks(fixture());
  const threads = profile.processes[0].threads;
  const worker = threads.pop();
  for (let i = 0; i < 4; i++) {
    const idle = structuredClone(worker);
    idle.tid += i;
    delete idle.stackTable;
    for (const row of idle.samples.data) row[1] = 0;
    threads.push(idle);
  }
  const cpu = cpuAccounting(profile, { ...result, compute_workers: 4 }).application_cpu;
  expect(cpu.supported).toBe(true);
  expect(cpu.main_cpu_ms_per_update).toBe(1 / 500);
  expect(cpu.workers_cpu_ms_per_update).toBe(0);
  threads[1].samples.data[2][1] = 1000000;
  const partial = cpuAccounting(profile, { ...result, compute_workers: 4 }).application_cpu;
  expect(partial.supported).toBe(false);
  expect(partial.main_cpu_ms_per_update).toBe(1 / 500);
  expect(partial.workers_cpu_ms_per_update).toBeNull();
});

test('saved truncated-profile shape with only the end marker reports retention failure', () => {
  const profile = fixture();
  const main = profile.processes[0].threads[0];
  main.markers.data = [[{ name: 'benchmark-cpu-end' }, 12421.662494]];
  main.samples.data = [[7768.088567, null], [12420, 1000000]];
  const cpu = cpuAccounting(profile, result);
  expect(cpu.supported).toBe(false);
  expect(cpu.reason).toContain('profiler retention');
  expect(cpu.reason).not.toContain('rebuild');
});

test('OS deltas exclude browser parent and crossing intervals, sum main and workers', () => {
  const cpu = cpuAccounting(fixture(), result);
  expect(cpu.supported).toBe(true);
  expect(cpu.main_cpu_ms).toBe(2);
  expect(cpu.workers_cpu_ms).toBe(4);
  expect(cpu.total_cpu_ms_per_update).toBe(6 / 500);
  expect(cpu.threads.map(row => row.tid)).toEqual([42, 43]);
  expect(cpu.omitted_boundary_upper_bound_ms).toBe(26);
});

test('missing CPU support, worker coverage, markers and window mismatch are unavailable', () => {
  for (const mutate of [
    p => { delete p.meta.sampleUnits; },
    p => { p.meta.sampleUnits.threadCPUDelta = 'unknown'; },
    p => { delete p.processes[0].threads[0].samples.schema.threadCPUDelta; },
    p => { p.processes[0].threads.pop(); },
    p => { p.processes[0].threads[0].markers.data = []; },
    p => { p.processes[0].threads[0].markers.data[1][1] = 7000; },
    p => { p.processes[0].threads[1].samples.data[2][1] = null; },
    p => { p.processes[0].threads[1].samples.data.pop(); },
  ]) {
    const profile = fixture(); mutate(profile);
    expect(cpuAccounting(profile, result).supported).toBe(false);
  }
});

test('declared microsecond units are converted rather than assumed nanoseconds', () => {
  const profile = fixture();
  profile.meta.sampleUnits.threadCPUDelta = 'µs';
  expect(cpuAccounting(profile, result).total_cpu_ms).toBe(6000);
});

test('exact boundary samples do not inflate omitted CPU bounds', () => {
  const profile = fixture();
  for (const thread of profile.processes[0].threads) {
    thread.samples.data = [[0, null], [10, 1000000], [5010, 1000000], [5020, 1000000]];
  }
  const cpu = cpuAccounting(profile, result);
  expect(cpu.supported).toBe(true);
  expect(cpu.total_cpu_ms).toBe(2);
  expect(cpu.omitted_boundary_upper_bound_ms).toBe(0);
});

test('duplicate threads and non-increasing sample intervals cannot double-count CPU', () => {
  for (const mutate of [
    p => p.processes[0].threads.push(p.processes[0].threads[1]),
    p => { p.processes[0].threads[0].samples.data[2][0] = 11; },
    p => { p.processes[0].threads[0].samples.data[2][0] = 9; },
  ]) {
    const profile = fixture(); mutate(profile);
    expect(cpuAccounting(profile, result).supported).toBe(false);
  }
});

test('shared reader uses declared units and excludes crossing intervals', () => {
  for (const [unit, expected] of [['ns', 2], ['µs', 2000], ['ms', 2000000], ['unknown', null]]) {
    const profile = fixture();
    profile.meta = { startTime: 100, sampleUnits: { threadCPUDelta: 'ns' } };
    const process = profile.processes[0];
    process.meta = { startTime: 100, sampleUnits: { threadCPUDelta: unit } };
    for (const thread of process.threads) {
      thread.stackTable = { schema: { frame: 0, prefix: 1 }, data: [] };
      thread.samples.schema.stack = 2;
    }
    const rows = cpuWindow(profile, { absolute: 5110 }, 5000);
    const main = rows.find(row => row.pid === 42 && row.thread === 'GeckoMain');
    expect(main.cpuMs).toBe(expected);
    expect(main.cpuSamples).toBe(unit === 'unknown' ? 0 : 2);
  }
});

test('readiness reset invalidates prior start; serial has zero worker CPU', () => {
  const profile = fixture();
  const process = profile.processes[0];
  process.threads.pop();
  expect(cpuAccounting(profile, { ...result, compute_workers: 0 }).workers_cpu_ms).toBe(0);
  process.threads[0].markers.data.splice(1, 0, [{ name: 'benchmark-cpu-reset' }, 20]);
  expect(cpuAccounting(profile, result).supported).toBe(false);
});
