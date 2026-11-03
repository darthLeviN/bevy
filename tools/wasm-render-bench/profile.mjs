import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
import { cliOptions } from './options.mjs';
import { createSharedBrowser } from '../../../../editor-benchmark/shared_browser.mjs';
import { measurementEnds, cpuWindow } from '../../../../editor-benchmark/profile.mjs';

const directory = new URL('../../../../.cache/bevy-web-ecs/render-results/', import.meta.url);
await mkdir(directory, { recursive: true });
const profiles = [];
const report = await run({
  ...cliOptions(process.argv.slice(2), true),
  log: () => {},
  createBrowser(options) {
    const mode = options.variants[0];
    const path = fileURLToPath(new URL(crypto.randomUUID() + '-' + mode + '-profile.json', directory));
    profiles.push({ mode, path });
    return createSharedBrowser({ ...options, profilePath: path });
  },
});
for (const { mode, path } of profiles) {
  const profile = await Bun.file(path).json();
  const end = measurementEnds(profile).find(end => end.variant === mode);
  if (!end) throw Error('Missing measurement marker in ' + path);
  console.log(JSON.stringify({ mode, path, fps: report.results.find(row => row.mode === mode).fps,
    note: 'Profiled headless diagnostic, not a clean FPS comparison; CPU samples are not GPU timings.',
    threads: cpuWindow(profile, end).filter(thread => (thread.cpuMs ?? 0) >= 2).slice(0, 5),
  }, null, 2));
}
