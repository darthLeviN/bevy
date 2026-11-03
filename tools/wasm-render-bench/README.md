# O3 Wasm rendering comparison

From the repository root, the existing visible launcher now uses this updated
benchmark and its current artifacts:

```sh
bun bevy-benchmark/run.mjs
```

It opens a fresh Firefox browser for each case: threaded first, then serial.
Each browser is fully closed before the next starts; all processes close automatically.
Add `--headless` to run the same comparison without a window. Both routes use O3
artifacts under `src/bevy/tools/wasm-render-bench/pkg/`, uncapped Firefox callbacks
and owned cleanup. The launcher does not serve the legacy `bevy-benchmark/pkg/`
artifact or compile anything. It prints the exact Wasm artifact path on startup.

After an explicitly requested build produces current `pkg/wasm_render_bench.js`
and its Wasm, run from this directory:

```sh
bun run.mjs
```

The runner does not build. Intended build: optimization level 3, no LTO,
16 codegen units, 2 build jobs. Cargo, build configuration and Rust scene code
are isolated to this experiment. The scene reuses the existing `bevy-benchmark` plane and cube:
2 meshes, 1 camera, unlit materials, MSAA 1, 1280×720 canvas.

Exactly two independent Firefox processes/sessions and fresh temporary profiles run in order:
MULTITHREADED (`threaded`, four compute workers), then SINGLE (`serial`, zero
compute workers). The page awaits Wasm initialization, then `start(threaded,
shim_url, worker_url)`. Rust owns scene readiness, a minimum 5-second warmup
**after graphics readiness**, a separate minimum 5-second sample, and the JSON result
in `#result` with `data-complete="true"`.

Graphics readiness is published after a render schedule completes: both GPU meshes
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
There are no visible browser windows. WebDriver/Firefox automation defaults
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
Each row records its browser session ID and Firefox process ID. Driver logs are
retained separately per case. No second case starts after a case or cleanup failure.
The static asset server is shared, but browser processes, workers and profiles are not.
The two measured values are printed on success. No live execution has been
established by the fake-based tests:

```sh
bun test run.test.mjs
```

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
