
import { run } from './run.mjs';
import { cliOptions } from './options.mjs';

const report = await run({
  ...cliOptions(process.argv.slice(2), true),
  log: () => {},

});
for (const row of report.results) {
  console.log(JSON.stringify({ case_id: row.case_id, mode: row.mode,
    path: row.cpu_profile_path, fps: row.fps,
    note: 'Profiled diagnostic, not a clean FPS comparison; OS CPU deltas are not GPU timings.',
    cpu_execution: row.cpu_execution,
  }, null, 2));
}
