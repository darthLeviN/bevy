export const usage = 'Usage: bun bevy-benchmark/run.mjs [--meshes N] [--workers N|A,B] [--cpu-work N] [--headless]';

function integer(value, minimum, maximum, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw Error(label + ' must be an integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw Error(label + ' must be between ' + minimum + ' and ' + maximum);
  }
  return number;
}

export function htmlDefaults(source) {
  const match = source.match(/<script\b[^>]*\bid=["']benchmark-config["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw Error('Missing HTML benchmark-config initialization');
  const defaults = JSON.parse(match[1]);
  return {
    movingMeshes: integer(defaults.movingMeshes, 1, 100000, 'Moving meshes'),
    workers: integer(defaults.workers, 1, 32, 'Compute workers'),
    cpuWork: integer(defaults.cpuWork ?? 0, 0, 1000000, 'CPU work'),
  };
}

export function configuration(options = {}, defaults = { movingMeshes: 1, workers: 4 }) {
  const movingMeshes = integer(options.movingMeshes ?? defaults.movingMeshes, 1, 100000, 'Moving meshes');
  const requested = options.workers ?? defaults.workers;
  const values = Array.isArray(requested) ? requested : String(requested).split(',');
  if (values.length !== 1 && values.length !== 2) throw Error('Select one worker count or exactly two counts');
  const counts = values.length === 1
    ? [integer(values[0], 1, 32, 'Compute workers'), 0]
    : values.map(value => integer(value, 0, 32, 'Compute workers'));
  const cpuWork = integer(options.cpuWork ?? defaults.cpuWork ?? 0, 0, 1000000, 'CPU work');
  return { movingMeshes, cpuWork, cases: counts.map((workers, index) => ({
    id: 'case-' + (index + 1), workers, mode: workers === 0 ? 'serial' : 'threaded',
  })) };
}

export function cliOptions(args = [], headless = false) {
  const options = { headless };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw Error('Duplicate option: ' + flag);
    seen.add(flag);
    if (flag === '--headless') options.headless = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--meshes' || flag === '--workers' || flag === '--cpu-work') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw Error('Missing value for ' + flag);
      if (flag === '--meshes') options.movingMeshes = integer(value, 1, 100000, 'Moving meshes');
      else if (flag === '--cpu-work') options.cpuWork = integer(value, 0, 1000000, 'CPU work');
      else { configuration({ workers: value }); options.workers = value; }
    } else throw Error(usage);
  }
  return options;
}

export function pageConfiguration(params, defaults) {
  const mode = params.get('mode') ?? 'threaded';
  if (mode !== 'serial' && mode !== 'threaded') throw Error('Expected serial or threaded mode');
  const movingMeshes = integer(params.get('meshes') ?? defaults.movingMeshes, 1, 100000, 'Moving meshes');
  const workers = mode === 'serial' ? 0 : integer(params.get('workers') ?? defaults.workers, 1, 32, 'Compute workers');
  const cpuWork = integer(params.get('cpu-work') ?? defaults.cpuWork ?? 0, 0, 1000000, 'CPU work');
  return { threaded: mode === 'threaded', workers, movingMeshes, cpuWork };
}
