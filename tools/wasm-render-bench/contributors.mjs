import { readFileSync } from 'node:fs';

import { processes, cpuMillisecondsPerUnit } from '../../../../editor-benchmark/profile.mjs';
import { cpuAccounting } from './cpu.mjs';
import { stackAttribution, commandCategory, categories, wasmFunctionNames } from './breakdown.mjs';

// Preserve complete leaf-to-root evidence: an attributed ancestor is not self CPU.
export function conversionContributors(profile, result, names, category = 'backend_conversion') {
  const accounting = cpuAccounting(profile, result, names);
  if (!accounting.supported) throw Error(accounting.reason);
  const topLevel = categories.find(([id]) => id === category);
  const rows = new Map();
  for (const process of processes(profile)) for (const thread of process.threads ?? []) {
    if (!accounting.threads.some(t => t.pid === thread.pid && t.tid === thread.tid)) continue;
    const unit = cpuMillisecondsPerUnit(profile, process);
    const schema = thread.samples.schema;
    let previous;
    for (const sample of thread.samples.data) {
      const time = sample[schema.time];
      if (previous >= accounting.start_ms && time <= accounting.end_ms &&
          stackAttribution(thread, sample[schema.stack], names)[topLevel ? 'category' : 'command'] === category) {
        const labels = [], seen = new Set();
        let stack = sample[schema.stack];
        while (stack != null && !seen.has(stack)) {
          seen.add(stack);
          const row = thread.stackTable.data[stack];
          if (!row) break;
          const frame = thread.frameTable.data[row[thread.stackTable.schema.frame]];
          const raw = thread.stringTable[frame[thread.frameTable.schema.location]];
          const index = /wasm-function\[(\d+)\]/.exec(raw);
          labels.push({ raw, symbol: index ? names.get(Number(index[1])) ?? raw : raw });
          stack = row[thread.stackTable.schema.prefix];
        }
        const key = JSON.stringify([thread.tid, labels]);
        const symbol = labels.find(frame => topLevel ? topLevel[2].test(frame.symbol) : commandCategory(frame.symbol) === category)?.symbol;
                const entry = rows.get(key) ?? { tid: thread.tid, name: thread.name, symbol, samples: 0, cpu_ms: 0, stack: labels };
        entry.samples++;
        entry.cpu_ms += sample[schema.threadCPUDelta] * unit;
        rows.set(key, entry);
      }
      previous = time;
    }
  }
  return [...rows.values()].sort((a, b) => b.cpu_ms - a.cpu_ms)
    .map(row => ({ ...row, cpu_ms_per_update: row.cpu_ms / result.frames }));
}

export function contributorSummary(rows) {
  return [...new Set(rows.map(row => row.symbol))].map(symbol => {
    const matching = rows.filter(row => row.symbol === symbol);
    return { symbol, samples: matching.reduce((sum, row) => sum + row.samples, 0),
      cpu_ms_per_update: matching.reduce((sum, row) => sum + row.cpu_ms_per_update, 0) };
  });
}

if (import.meta.main) {
  const [reportPath, wasmPath, detail, category = 'backend_conversion'] = process.argv.slice(2);
  if (!reportPath || !wasmPath || (detail && !['--full-stacks', '--summary'].includes(detail))) {
    throw Error('Usage: bun contributors.mjs REPORT.json SERVED.wasm [--full-stacks|--summary] [CATEGORY]');
  }
  const report = JSON.parse(readFileSync(reportPath));
  const names = wasmFunctionNames(readFileSync(wasmPath));
  for (const result of report.results) {
    const profile = JSON.parse(readFileSync(result.cpu_profile_path));
    const rows = conversionContributors(profile, result, names, category);
    const evidence = detail === '--summary' ? {} : detail ? { stacks: rows } : { top_stacks: rows.slice(0, 3).map(row => ({
      ...row, stack: row.stack.slice(0, row.stack.findIndex(frame => frame.symbol === row.symbol) + 3),
    })) };
    console.log(JSON.stringify({ mode: result.mode, function_names: names.size,
      samples: rows.reduce((sum, row) => sum + row.samples, 0),
      cpu_ms_per_update: rows.reduce((sum, row) => sum + row.cpu_ms_per_update, 0),
      symbols: contributorSummary(rows),
      limitation: 'Ancestor attribution includes synchronous native/JS callees; sample counts are not function call counts. Raw indexes require the exact captured binary, not a later rebuild.',
      ...evidence }, null, 2));
  }
}
