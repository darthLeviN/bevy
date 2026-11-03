import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { cleanupAll, ownProcessGroup, watchSignals, withTimeout } from '../../../../editor-benchmark/lifecycle.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
export const firefoxCapabilities = () => ({ capabilities: { alwaysMatch: {
  browserName: 'firefox', 'moz:firefoxOptions': { args: ['--headless'] },
} } });
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export function staticHandler(root = directory) {
  return async request => {
    let path;
    try { path = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Bad path', { status: 400, headers }); }
    const filename = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!filename.startsWith(resolve(root) + sep) || path.includes('\\')) {
      return new Response('Forbidden', { status: 403, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers });
    let canonical;
    try { canonical = await realpath(filename); }
    catch { return new Response('Not found', { status: 404, headers }); }
    if (!canonical.startsWith((await realpath(root)) + sep)) {
      return new Response('Forbidden', { status: 403, headers });
    }
    const file = Bun.file(canonical);
    if (!(await file.exists())) return new Response('Not found', { status: 404, headers });
    return new Response(request.method === 'HEAD' ? null : file, {
      headers: { ...headers, 'Content-Type': file.type },
    });
  };
}

export function validateResult(value) {
  const fail = message => { throw Error(`Invalid ECS benchmark: ${message}`); };
  if (value?.fatal != null) fail(String(value.fatal));
  if (value?.workers !== 4 || value.visuals !== false || value.atomics !== true) fail('environment');
  if (value.main_thread !== true || value.local_task_verified !== true || !(value.page_event_loop_ticks > 0)) fail('regular page execution');
  const names = ['serial', 'parallel-systems', 'parallel-query'];
  if (!Array.isArray(value.results) || value.results.length !== 3) fail('three cases required');
  for (const name of names) {
    const rows = value.results.filter(row => row.name === name);
    if (rows.length !== 1) fail(`missing or duplicate ${name}`);
    const row = rows[0];
    for (const key of ['entities', 'systems', 'ticks', 'samples', 'participating_threads_preflight', 'overlapping_systems_preflight']) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 1) fail(`${name}.${key}`);
    }
    for (const key of ['warmup_ms', 'sample_ms', 'updates_per_second', 'mean_ms', 'p50_ms', 'p95_ms']) {
      if (!Number.isFinite(row[key]) || row[key] <= 0) fail(`${name}.${key}`);
    }
    if (row.warmup_ms < 5000 || row.sample_ms < 5000) fail(`${name} timing windows`);
    if (row.p95_ms < row.p50_ms) fail(`${name} percentiles`);
    if (row.all_entity_values_verified !== true ||
        !((Number.isSafeInteger(row.checksum) && row.checksum >= 0) ||
          (typeof row.checksum === 'string' && /^\d+$/.test(row.checksum)))) fail(`${name} correctness`);
    if (row.page_owner_checks !== row.ticks) fail(`${name} non-Send thread affinity`);
    if (name === 'serial' && (row.participating_threads_preflight !== 1 || row.overlapping_systems_preflight !== 1)) fail('serial preflight');
    if (name !== 'serial' && row.participating_threads_preflight < 2) fail(`${name} thread proof`);
    if (name === 'parallel-systems' && row.overlapping_systems_preflight < 2) fail('system overlap proof');
  }
  return value;
}

export function ownedCleanup({ deleteSession, stopGroup, stopServer }) {
  return cleanupAll([
    async () => { try { await withTimeout(deleteSession, 2000); } finally { await stopGroup(); } },
    stopServer,
  ]);
}

export async function run({ spawnDriver = spawn, serve = options => Bun.serve(options), fetchRequest = fetch } = {}) {
  const signals = watchSignals();
  const controller = new AbortController();
  let server, group, session, endpoint;
  let driverTimer;
  const cleanup = ownedCleanup({
    deleteSession: async () => {
      if (session) await fetchRequest(`${endpoint}/session/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(1800) });
    },
    stopGroup: async () => { clearTimeout(driverTimer); await group?.stop(); },
    stopServer: async () => { await server?.stop(true); },
  });
  const interrupt = () => controller.abort(signals.signal.reason);
  signals.signal.addEventListener('abort', interrupt, { once: true });
  let report;
  try {
    report = await withTimeout(async () => {
      server = serve({ hostname: '127.0.0.1', port: 0, fetch: staticHandler() });
      const child = spawnDriver('geckodriver', ['--host', '127.0.0.1', '--port', '0'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      group = ownProcessGroup(child);
      driverTimer = setTimeout(() => controller.abort(Error('geckodriver command timed out (90s)')), 90000);
      endpoint = await new Promise((resolveEndpoint, reject) => {
        let output = '';
        const onData = chunk => {
          output = (output + chunk.toString()).slice(-16384);
          const match = output.match(/Listening on (?:127\.0\.0\.1|localhost):(\d+)/);
          if (match) finish(null, `http://127.0.0.1:${match[1]}`);
        };
        const onAbort = () => finish(controller.signal.reason);
        const finish = (error, url) => {
          child.stdout.off('data', onData); child.stderr.off('data', onData);
          controller.signal.removeEventListener('abort', onAbort);
          error ? reject(error) : resolveEndpoint(url);
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        group.exited.then(result => finish(result.error ?? Error(`geckodriver exited ${result.code}`)));
      });
      async function command(path, body, timeout = 10000) {
        const response = await fetchRequest(endpoint + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
        });
        const json = await response.json();
        if (!response.ok || json.value?.error) throw Error(JSON.stringify(json));
        return json.value;
      }
      const created = await command('/session', firefoxCapabilities());
      session = created.sessionId;
      if (!session) throw Error('WebDriver omitted sessionId');
      await command(`/session/${session}/timeouts`, { script: 60000, pageLoad: 10000, implicit: 0 });
      await command(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
      const result = await command(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          if (window.ecsBenchmarkFatal != null) done({fatal: window.ecsBenchmarkFatal});
          else if (window.ecsBenchmarkResult != null) done(window.ecsBenchmarkResult);
          else window.addEventListener('ecs-benchmark-complete', () => done(
            window.ecsBenchmarkFatal != null ? {fatal: window.ecsBenchmarkFatal} : window.ecsBenchmarkResult
          ), {once: true});`, args: [],
      }, 60000);
      validateResult(result);
      return { status: 'ok', metric: 'ECS updates/second (not FPS)', browser: created.capabilities,
        firefoxOptions: firefoxCapabilities().capabilities.alwaysMatch['moz:firefoxOptions'], ...result };
    }, 75000, { message: 'Benchmark total deadline exceeded (75s); no retry' });
  } catch (error) {
    report = { status: 'failed', fatal: String(error?.stack ?? error) };
  } finally {
    controller.abort(Error('Benchmark finished'));
    try { await cleanup(); }
    catch (error) { report = { ...report, status: 'failed', cleanupFatal: String(error) }; }
    signals.signal.removeEventListener('abort', interrupt);
    signals.dispose();
  }
  const output = new URL('../../../../.cache/bevy-web-ecs/results/', import.meta.url);
  await mkdir(output, { recursive: true });
  const path = new URL(`${new Date().toISOString().replaceAll(':', '-')}.json`, output);
  await Bun.write(path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, reportPath: fileURLToPath(path) }, null, 2));
  if (report.status !== 'ok') throw Error(report.fatal ?? report.cleanupFatal);
  return report;
}

if (import.meta.main) {
  if (process.argv.length > 2) throw Error('No options supported; build explicitly before running');
  await run();
}
