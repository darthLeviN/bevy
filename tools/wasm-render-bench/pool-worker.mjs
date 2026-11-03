let reportFailure;
const workerDiagnostics = [];
for (const level of ['error', 'warn', 'log']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (workerDiagnostics.length < 20) workerDiagnostics.push(args.map(String).join(' '));
    original(...args);
  };
}
async function fatal(error) {
  const message = workerDiagnostics.join('\n') + '\n' + String(error?.stack ?? error);
  try {
    await fetch('/worker-error', { method: 'POST', body: message,
      signal: AbortSignal.timeout(2000) });
  } catch {}
  try { reportFailure?.(message); } catch {}
  const channel = new BroadcastChannel('bevy-render-benchmark');
  channel.postMessage({ fatal: message });
  channel.close();
  self.close();
}

self.onmessage = async event => {
  self.onmessage = null;
  try {
    const [module, memory, work] = event.data;
    const { default: init, wasm_thread_entry_point, report_worker_failure } = await import('./pkg/wasm_render_bench.js');
    if (typeof report_worker_failure !== 'function') throw Error('Stale Wasm artifact: missing worker-failure bridge');
    reportFailure = report_worker_failure;
    await init({ module_or_path: module, memory });
    wasm_thread_entry_point(work);
    self.close();
  } catch (error) {
    await fatal(error);
  }
};
self.addEventListener('unhandledrejection', event => { void fatal(event.reason); });
