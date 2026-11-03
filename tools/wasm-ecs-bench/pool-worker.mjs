let reportFailure;
async function fatal(error) {
  const message = String(error?.stack ?? error);
  try { reportFailure?.(message); } catch {}
  const channel = new BroadcastChannel('bevy-ecs-benchmark');
  channel.postMessage({ fatal: message });
  channel.close();
  self.close();
}

self.onmessage = async event => {
  self.onmessage = null;
  try {
    const [module, memory, work] = event.data;
    const { default: init, wasm_thread_entry_point, report_worker_failure } = await import('./pkg/wasm_ecs_bench.js');
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
