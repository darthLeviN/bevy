import { test, expect } from 'bun:test';
import { cliOptions, configuration, htmlDefaults, pageConfiguration } from './options.mjs';

const defaults = { movingMeshes: 1, workers: 4, cpuWork: 0 };

test('HTML owns editable defaults and CLI overrides only requested fields', async () => {
  const html = await Bun.file(new URL('./index.html', import.meta.url)).text();
  expect(htmlDefaults(html)).toEqual(defaults);
  const edited = htmlDefaults('<script id="benchmark-config" type="application/json">{"movingMeshes":25,"workers":8}</script>');
  expect(configuration({}, edited)).toEqual({ movingMeshes: 25, cpuWork: 0, cases: [
    { id: 'case-1', workers: 8, mode: 'threaded' }, { id: 'case-2', workers: 0, mode: 'serial' },
  ] });
  expect(configuration(cliOptions(['--meshes', '6']), edited).movingMeshes).toBe(6);
  expect(configuration(cliOptions(['--workers', '2']), edited).cases.map(row => row.workers)).toEqual([2, 0]);
  for (const source of ['', '<script id="benchmark-config">broken</script>',
    '<script id="benchmark-config">{"movingMeshes":0,"workers":4}</script>',
    '<script id="benchmark-config">{"movingMeshes":1,"workers":0}</script>']) {
    expect(() => htmlDefaults(source)).toThrow();
  }
});

test('CLI resolves single counts and exact ordered pairs including serial', () => {
  for (const [workers, counts] of [['4', [4, 0]], ['2,8', [2, 8]], ['0,3', [0, 3]],
    ['0,0', [0, 0]], ['4,4', [4, 4]]]) {
    const config = configuration(cliOptions(['--meshes', '17', '--workers', workers]));
    expect(config.movingMeshes).toBe(17);
    expect(config.cases.map(row => row.workers)).toEqual(counts);
    expect(config.cases.map(row => row.mode)).toEqual(counts.map(n => n === 0 ? 'serial' : 'threaded'));
  }
  expect(cliOptions(['--headless']).headless).toBe(true);
  expect(cliOptions([], false).headless).toBe(false);
  expect(cliOptions([], true).headless).toBe(true);
  expect(cliOptions(['--help']).help).toBe(true);
});

test('CPU work is opt-in, bounded, and shared by both cases and the page', () => {
  expect(configuration().cpuWork).toBe(0);
  expect(configuration(cliOptions(['--cpu-work', '123'])).cpuWork).toBe(123);
  expect(pageConfiguration(new URLSearchParams('cpu-work=123'), defaults).cpuWork).toBe(123);
  expect(configuration({}, { ...defaults, cpuWork: 17 }).cpuWork).toBe(17);
  for (const value of ['-1', '1.5', '1000001', 'NaN', '']) {
    expect(() => cliOptions(['--cpu-work', value])).toThrow();
    expect(() => pageConfiguration(new URLSearchParams('cpu-work=' + value), defaults)).toThrow();
  }
  expect(() => cliOptions(['--cpu-work'])).toThrow();
  expect(() => cliOptions(['--cpu-work', '1', '--cpu-work', '2'])).toThrow();
});

test('invalid CLI input is rejected without I/O', () => {
  for (const args of [['--unknown'], ['--meshes'], ['--workers', '--headless'],
    ['--meshes', '1', '--meshes', '2'], ['--headless', '--headless']]) {
    expect(() => cliOptions(args)).toThrow();
  }
  for (const meshes of ['0', '-1', '1.5', 'NaN', '100001', '1e2', '']) {
    expect(() => cliOptions(['--meshes', meshes])).toThrow();
  }
  for (const workers of ['0', '33', '-1', '1.5', '1,2,3', '1,', ',2', '1,33']) {
    expect(() => cliOptions(['--workers', workers])).toThrow();
  }
  expect(configuration({ movingMeshes: 100000, workers: '32,0' }).movingMeshes).toBe(100000);
});

test('page query overrides defaults and serial always disables workers', () => {
  expect(pageConfiguration(new URLSearchParams(), defaults)).toEqual({ threaded: true, workers: 4, movingMeshes: 1, cpuWork: 0 });
  expect(pageConfiguration(new URLSearchParams('workers=8&meshes=20'), defaults))
    .toEqual({ threaded: true, workers: 8, movingMeshes: 20, cpuWork: 0 });
  expect(pageConfiguration(new URLSearchParams('mode=serial&workers=0&meshes=2'), defaults))
    .toEqual({ threaded: false, workers: 0, movingMeshes: 2, cpuWork: 0 });
  for (const query of ['mode=other', 'mode=threaded&workers=0', 'workers=33', 'meshes=0', 'meshes=bad']) {
    expect(() => pageConfiguration(new URLSearchParams(query), defaults)).toThrow();
  }
});
