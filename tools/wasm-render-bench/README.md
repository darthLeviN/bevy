# O3 Wasm rendering comparison

From the repository root, the existing visible launcher now uses this updated
benchmark and its current artifacts:

```sh
bun bevy-benchmark/run.mjs
bun bevy-benchmark/run.mjs --meshes 1000 --workers 8
bun bevy-benchmark/run.mjs --meshes 1000 --workers 2,8 --headless
# Opt into 32 independent CPU systems, 1000 iterations per system per mesh:
bun bevy-benchmark/run.mjs --meshes 1000 --workers 8 --cpu-work 1000
```

By default it opens a fresh Firefox browser for each case: threaded first, then serial.
`--meshes N` selects 1–100000 moving meshes (default 1). `--workers N`
selects 1–32 compute workers for the first case and zero for the second.
`--workers A,B` instead runs exactly those two counts, in order (each 0–32;
zero means serial). Both cases can be threaded, serial, or even identical.
The inert `benchmark-config` JSON in `index.html` owns editable defaults:
`movingMeshes: 1`, `workers: 4`, `cpuWork: 0`. The runner reads those defaults too; CLI
values override them. Page query parameters `mode`, `workers`, `meshes` and `cpu-work`
override page defaults; serial mode always uses zero workers.
Each browser is fully closed before the next starts; all processes close automatically.
Add `--headless` to run the same comparison without a window. Both routes use O3
artifacts under `src/bevy/tools/wasm-render-bench/pkg/`, uncapped Firefox callbacks
and owned cleanup. The launcher does not serve the legacy `bevy-benchmark/pkg/`
artifact or compile anything. It prints the exact Wasm artifact path on startup.

After an explicitly requested build produces current `pkg/wasm_render_bench.js`
and its Wasm, run from this directory:

```sh
bun run.mjs --meshes 1000 --workers 2,8
```

The runner does not build. Intended build: optimization level 3, no LTO,
16 codegen units, 2 build jobs. Cargo, build configuration and Rust scene code
are isolated to this experiment. The scene has N moving meshes plus a static
ground: N+1 meshes, N+1 unique material assets/data, 1 camera, unlit materials,
MSAA 1, 1280×720 canvas. Unique material assets/data do **not** guarantee a
separate draw call per mesh; renderer batching and submission remain engine-owned.
Results must report `moving_meshes: N`, `meshes: N+1`, `unique_materials: N+1`,
`motion_verified: true`, and the exact requested `compute_workers` for each case.

### Optional CPU workload

`--cpu-work N` accepts 0–1000000 (default **0**). Zero preserves the existing
lightweight time-based motion and static unique materials: the 32-component
workload is **not enabled by default**. Positive values attach 32 distinct
`Lane<I>` component types to every moving mesh and register 32 independent
systems. Each system writes only its own component, reading shared configuration
and immutable entity identity; none accesses `Transform` or material assets.
The scheduler may execute these systems concurrently. The final dependent system
runs after all 32, reduces every stored output into actual translation, rotation
and the color of that mesh's individually owned `StandardMaterial`. Only this
consumer mutably accesses material assets. Material assets remain unique; dynamic
RGB values are not guaranteed collision-free.

Each lane stores a wrapping update step and computes N integer mixing iterations
from that step, entity index and lane index. Outputs change with entities and
updates, are stored in ECS, and feed rendered state rather than an unused checksum.
Both cases register the same systems and execute the same per-update work; only
the executor/worker configuration differs. Different frame counts naturally mean
different total work over the measurement window. Work scales as
`movingMeshes * 32 * cpuWork` iterations per update, plus the visual consumer and
material uploads; excessively large settings can exceed the unchanged deadlines.

Before warmup and after sampling ends, a deterministic serial reference recomputes
all lanes from their stored steps, checks every output and matching steps, and
validates actual transforms and material colors. No reference replay occurs in
the timed sample, and replay does not depend on elapsed `Time` or accumulated
floating-point state. Results include `cpu_work`, `cpu_systems` (32 when enabled,
otherwise 0), and `cpu_verified`. Reference validation does not establish actual
worker overlap, correct browser rendering, or an FPS improvement.

Exactly two independent Firefox processes/sessions and fresh temporary profiles run in order:
by default MULTITHREADED (`threaded`, four compute workers), then SINGLE (`serial`,
zero compute workers), or the exact pair selected by CLI. The page awaits Wasm
initialization, then `start(threaded, shim_url, worker_url, workers, moving_meshes, cpu_work)`. Rust owns scene readiness, a minimum 5-second warmup
**after graphics readiness**, a separate minimum 5-second sample, and the JSON result
in `#result` with `data-complete="true"`.

Graphics readiness is published after a render schedule completes: the scene's GPU meshes
must be prepared, a render target must exist, and the pipeline cache must contain
only successfully created pipelines with no waiting entries. Only then does the
five-second settling window begin. Any readiness/pipeline-count change resets
warmup and discards partial measurements. Loading time never counts toward either
window. The page shows Loading, Warming up, and Measuring phases explicitly.
The earlier results below predate this stronger readiness gate; do not treat them
as measurements made with the revised settling contract.

Firefox explicitly requests `dom.webgpu.enabled=true` and
`layout.frame_rate=0` (uncapped callbacks). The only additional explicit
preference is DPR `layout.css.devPixelsPerPx="1"`; no other performance prefs
are requested. Static responses include COOP same-origin and COEP require-corp.
The direct runner defaults to headless; the root wrapper defaults to visible,
unless `--headless` is supplied. WebDriver/Firefox automation defaults
still apply.

Reported `measuredFPS` is aggregate application frame/update cadence
(`frames * 1000 / measurement_ms`), **not physically displayed FPS** or GPU
completion throughput. Both cases retain page-main-thread application ownership
and browser-main GPU submission; MULTITHREADED changes compute workers, not GPU
rendering into a multithreaded renderer. PresentMode fallback warnings are retained
and allowed; console errors, renderer failures and panics invalidate the run.

Each case has a 45-second deadline; the complete execution has a 110-second
deadline followed by bounded owned browser/driver cleanup and server shutdown.
Failure or interruption saves diagnostics and stops, without runtime retries.
Reports are saved under repository-root `.cache/bevy-web-ecs/render-results/`.
Each row records its `case_id`, requested worker count, moving mesh count,
browser session ID and Firefox process ID. Driver logs and failure diagnostics
retain case metadata too, distinguishing even two threaded cases. The report
also retains the resolved configuration. No second case starts after a case or cleanup failure.
The static asset server is shared, but browser processes, workers and profiles are not.
The two measured values are printed on success. No live execution has been
established by the fake-based tests:

```sh
bun test options.test.mjs run.test.mjs
```

### Root-wrapper integration API

The root wrapper (maintained separately) should import `cliOptions` and `usage`
from `options.mjs`, parse `process.argv.slice(2)` with `cliOptions(args, false)`
for its visible default, print `usage` and exit for `options.help`, otherwise
call the exported `run(options)` from `run.mjs`. `run` accepts `movingMeshes`,
`workers` (one count or a comma-separated pair), `cpuWork`, and `headless`, alongside its
injected dependencies. Its `loadDefaults()` dependency returns the parsed HTML
defaults; production reads `index.html`. Parsing and configuration do not build
or launch anything. The direct runner uses the same parser with headless default
`true`. The root wrapper forwards these parsed options without its own option list.

A live command must use current artifacts. A runtime timeout requires stopping
and reporting, not automatically retrying or extending deadlines.

## Current result and repair boundary

The results below used the earlier shared-browser/fresh-document strategy. An
observed order effect motivated full browser restart between cases. Keep these
figures as historical records, not an isolated-browser performance comparison.

After fixing the main-world PBR affinity violations, the O3 comparison completed
both cases successfully in headless Firefox with uncapped callbacks, at 1280×720:

| Execution | Aggregate application FPS |
| --- | ---: |
| Single-threaded | 273.37 |
| Multithreaded | 229.40 |

Each case used a five-second warmup and five-second sample of the original
plane-and-cube scene. This single run showed about 16% lower throughput with
threading, not a rendering speedup. It does not measure physically displayed FPS
or the full editor. Report at repository-root
`.cache/bevy-web-ecs/render-results/2026-11-03T06-37-42.036Z.json`.
The browser, driver and ephemeral server were cleaned up normally.

The actual worker stacks identified `no_automatic_skin_batching` and
`no_automatic_morph_batching`. Both are main-world PBR systems that query
`RenderDevice` limits even when their mesh queries are empty. They had no Wasm
thread-affinity marker and therefore ran on compute workers, where the GPU
`SendWrapper` correctly panicked. Both now declare a Wasm `NonSendMarker`.
No GPU thread-safety guards were bypassed and no scene features were removed.
The final incremental O3 build compiled PBR and its dependants only (48.25 seconds);
eight deterministic rendering-runner/source-contract tests passed before the run.

### Scheduling-overhead corrections

The current artifact also includes these changes after the comparison above:

- Parallel queries use effective scope parallelism, not the number of workers
  owned by the pool. Inside a GPU-affine local scope they take direct sequential
  iteration, without allocating/queueing local task batches.
- Browser/worker context detection is cached in thread-local storage instead of
  evaluating JavaScript on each scope/wait call.
- On the browser main thread, the multithreaded ECS executor ticks the global CPU
  task executor while waiting, so the caller can help execute Send jobs. Native
  and worker-thread schedule behavior is unchanged; non-Send work retains its
  owning thread.

Three focused native integration tests passed for direct GPU-affine query
iteration, nested affinity/restored worker dispatch, and caller participation while
all workers are held busy by a controlled gate. Two thread-context cache tests
passed. The updated O3 artifact and wasm-bindgen output were built successfully
with two build jobs and the existing isolated target cache. These checks do not
measure the FPS effect; no browser run was performed for these corrections.

### Follow-up subagent optimizations after the WIP checkpoint

WIP checkpoints: Space Maker `df6f8c3`, Bevy `1afafd2`. Subsequent optimization work
remains separate from those checkpoints.

- Ordinary automatically batched `QueryParIter` now accumulates total matched
  rows during its existing storage-metadata sizing scan. It avoids a task scope
  when work fits one calculated batch or an automatic query has at most one row
  per compute worker. No additional entity scan is introduced. Explicit fixed
  batches retain their requested dispatch; contiguous/entity-list iterators are
  unchanged by this follow-up.
- `Scope::drop` skips `block_on` when its task queue is already empty. Pending
  tasks still take the original cancellation path.

Five native integration tests passed, covering small dense/sparse queries,
explicit fixed dispatch, concurrent 16,384-entity iteration, GPU affinity, caller
participation, and empty/completed/panic-unwinding scope cleanup. The O3 artifact
and wasm-bindgen output were rebuilt successfully using the existing isolated
cache and two jobs. No browser run or FPS-parity claim was made for these changes.

### Deferred-barrier pass and diagnostic evidence

The tiny-query/scope-cleanup changes were checkpointed in Bevy `d0e048f` and
Space Maker `00cf71e`. A subsequent uncommitted executor change caches each
system's existing `has_deferred()` flag and marks only those systems as needing
buffer application. Empty `ApplyDeferred` barriers complete through existing
completion/dependency bookkeeping rather than cloning a bitset and queuing a task.
Seven focused native integration tests passed, including real/custom/exclusive
buffers, skipped barriers, final flushing and repeated runs. The O3 artifact was
rebuilt successfully once for this pass.

Fresh-browser headless checks (threaded then serial, with readiness-gated warmup):

| Check | Threaded FPS | Serial FPS | Report under repository-root `.cache/bevy-web-ecs/render-results/` |
| --- | ---: | ---: | --- |
| Before deferred-barrier change | 290.03 | 284.72 | `2026-11-03T07-20-41.297Z.json` |
| After change | 260.56 | 286.60 | `2026-11-03T07-30-18.769Z.json` |
| Same updated binary repeated | 282.39 | 294.89 | `2026-11-03T07-32-03.286Z.json` |

These do not establish an FPS gain from the new fast path. They also do not
reproduce the user's visible-browser rates of approximately 553 versus 512 FPS;
headless and visible-browser measurements must not be substituted for each other.

For a separate diagnostic run without rebuilding Rust:

```sh
bun profile.mjs
```

This uses the same bounded fresh-browser runner, with Firefox's startup CPU
profiler enabled. It saves one profile per case and analyzes only the five-second
measurement window, marked after result completion. Profiling changes overhead;
its reported FPS is not a clean performance comparison.

In `2026-11-03T07-34-34.439Z.json`, the profiled cases measured 239.47 versus
265.02 application FPS. Content-main CPU time was approximately 3.867 versus
3.449 ms per application update. Sampled Wasm native-wakeup CPU time was 74.59 ms
over 1,198 threaded updates (about 0.062 ms/update), versus no corresponding
sampled wakeup cost in serial. This is evidence of synchronization cost, not a
complete causal attribution of the visible-browser gap. Several threaded Wasm
frames were unsymbolized; a zero named-function sample count must not be read as
zero execution cost. GPU buffer calls and browser runtime work remain substantial.

Profile files in the same directory:
`eb468ace-b451-4022-9518-455ad409928e-threaded-profile.json` and
`1488e710-d3ec-4d8f-92ae-5a30b4c12c28-serial-profile.json`.

### Browser polling scopes without executor sleepers

The browser main thread already polls synchronously rather than parking. Its
scope driver previously still used `Executor::run` and `ThreadExecutorTicker::tick`,
which install waiting-executor wakeups. The browser-only path now uses the existing
`try_tick` APIs for scope, distinct external and eligible global executors, checking
scope results between rounds. Worker/native parking paths, worker dispatch,
GPU-affine local executors and task-panic collection remain unchanged. This removes
redundant sleeper registration/notification; it does not eliminate worker wakeups.

Three deterministic tests exercise the actual polling helper: an empty executor
registers no sleeper (with the previous waiting API as a positive control), all
three executors progress pending tasks on their owner, and ready results/panics
retain their behavior. All seven existing scope/query/deferred tests and 23 Bun
runner/options tests also passed. The O3 Wasm build and wasm-bindgen transform
completed successfully using two build jobs and the existing render target cache.

Matched headless runs used `--meshes 100 --workers 2 --cpu-work 100 --headless`:

| Build | Threaded FPS | Serial FPS | Report under repository-root `.cache/bevy-web-ecs/render-results/` |
| --- | ---: | ---: | --- |
| Before polling change | 68.33 | 74.18 | `2026-11-03T08-20-38.153Z.json` |
| After polling change | 82.64 | 76.64 | `2026-11-03T08-25-50.157Z.json` |

Each comparison used exactly two fresh browser processes, threaded then serial,
with readiness-gated five-second warmup and five-second sampling and owned cleanup.
Observed threaded throughput rose 20.9%; the serial control rose 3.3%. This single
before/after pair is not evidence of a repeatable 20.9% speedup or of visible-browser
performance. It measures application-update cadence, not physically displayed FPS.

### Opt-in schedule attribution

Set `BEVY_RENDER_TIMINGS=1` on the existing Cargo build command to install
single-threaded boundary schedules around the main and render schedule orders,
and a wrapper around the existing render extraction callback. Re-run the existing
wasm-bindgen command afterward. Results include `schedule_timings`: completed
span counts and mean wall milliseconds, reset when the sampling phase changes.
Without this build environment variable no boundary schedules or extraction
wrapper are installed; rebuild without it to restore the ordinary artifact.
`profile.mjs` also accepts the runner's existing workload/worker CLI options.

These are diagnostic wall spans, not GPU timings or per-system attribution.
Boundary schedules and clock/lock operations add overhead. `Last` contains the
measurement reset/report itself, so its completed span count is one lower than
the other schedules. Run the clock-injected accumulator regression with
`rustc --edition=2024 --test src/timing_stats.rs -o /home/levi/dev/space-maker/.cache/bevy-web-ecs/render-target/timing-stats-tests`
and then execute that test binary.

A headless diagnostic with 100 moving meshes and CPU work 1 measured
PostUpdate 0.362/0.466 ms and Render 7.931/7.981 ms for 2/8 workers
(`2026-11-03T08-38-12.473Z.json`). A separate 8-worker/serial pair measured
PostUpdate 0.442/0.177 ms, extraction 0.440/0.390 ms and Render 7.215/7.109 ms
(`2026-11-03T08-39-53.692Z.json`). Both used exactly two fresh browsers,
readiness-gated five-second warmup/sample and owned cleanup. The ordinary
8-worker/serial baseline was 78.02/80.13 FPS
(`2026-11-03T08-33-56.703Z.json`). These runs did not reproduce or explain the
reported visible-browser approximately 1 ms penalty. No engine scheduling fix
was justified by this evidence; worker broadcast/barrier attribution remains open.

### Earlier failures and supporting changes

The first O3 comparison measured serial application cadence at 296.48 FPS.
The threaded case timed out after 45 seconds and produced no valid result.
Report: `.cache/bevy-web-ecs/render-results/2026-11-03T06-06-12.494Z.json` at the
repository root. This is not a successful threaded rendering result.

Subsequent engine changes address two source-level defects:

- A single-threaded schedule did not constrain nested parallel queries/task
  scopes. Browser extraction and render execution now establish a local-scope
  boundary in the engine. Those scopes use a private executor ticked only by
  their caller, while normal CPU/ECS scopes outside that boundary retain workers.
- A worker trap could leave the main thread polling for a task that would never
  complete. Worker entry-point handlers now record failure in shared memory
  before posting browser messages, and the main CPU wait checks that failure.
  Missing failure-bridge exports reject stale Wasm artifacts rather than silently
  attempting an old build.

The worker crash mechanism was established by later diagnostic runs: the GPU
handle affinity violations above trapped workers while the main thread awaited
their tasks. Failure diagnostics now retain captured page console messages and
full worker reports posted directly to the owned server, rather than losing them
when result validation fails. The boundary and failure-path changes alone did
not fix rendering; the two main-world PBR markers were additionally necessary.
Focused native task-pool tests cover nested scope affinity and restoration of
normal worker dispatch; standalone tests cover scope-policy restoration and the
shared failure mailbox. JavaScript tests cover worker failure-forwarding order.
The successful run documented above supersedes the earlier failed attempts.
Do not substitute an earlier serial-only result for that matched comparison.
