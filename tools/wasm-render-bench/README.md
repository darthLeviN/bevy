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

## Whole-record atomic word width (2026-11-03)

The post-batching profile's leading collection stacks end directly in sparse
`set_batch` and history `push_batch`, called by `flush_mesh_input_batch`; they do
not hide synchronous JS/device capability getters. Inspection of the served
Wasm code bodies confirmed 28 `i32.atomic.store` instructions per mesh input and
12 per previous-transform record. In the earlier `13-08-57.657Z` threaded report,
these two named contributors account for 5.03 and 2.27 ms/update, versus 0.32 ms
for builder preparation. This is sampled attribution, not instruction-level
sampling or proof that every attributed cycle is an atomic store. The collection
task wrapper also contains real work, including duplicate detection, preparation,
shared instance writes and culling-bound comparisons.

`impl_atomic_pod!` now has an opt-in `atomic_u64` whole-record form. Only
`MeshInputUniform` and `PreviousMeshInputUniform` use it; existing field-addressed
blobs remain 32-bit. Shared accesses remain atomic and consistently use one word
width per blob. Sizes and uploaded bytes are unchanged; blob allocations provide
64-bit alignment. This neither makes multiword snapshots coherent nor replaces
worker joins before upload/removal/reuse. Geometry caching, batch size 128,
duplicate handling, history reservations, dirty-mask merging, metadata lookups,
previous transforms, events and workload are preserved. No plain shared writes
or partition-lock protocol was added.

The cached O3 build and wasm-bindgen generation passed. The new served Wasm's
`set_batch` body (function 20819, offset 20758799) contains 14 `i64.atomic.store`
instructions; history is now inlined into `flush_mesh_input_batch` (function
3480, offset 9775145), which contains six. The old bodies were function 12172
(offset 16972015) and function 14431 (offset 18140984). These are exact-build
inspection identifiers, not mappings to apply across rebuilds. This removes
200,000 payload atomic stores per 10,000-mesh update; it does not remove payload
bytes, all history reads, or batch scans/copies.

`bun test mesh-batching.test.mjs mesh-collection.test.mjs` passes three Bun tests
executing twelve Rust tests in isolated fixtures. Added coverage expands the
production macro itself (only external bit casts and derives are stubbed), checking
112/48-byte layouts, byte-identical NaN/signed-zero representations, 14/6-word
storage, unchanged 32-bit field getters/setters, and joined multiworker writes
across six rounds of slot reuse. Existing actual-production collection/batching
fixtures retain scalar/history equivalence, duplicate ordering, dirty-word
contention, removal/reuse and frame-local metadata/geometry invalidation coverage.
The fixtures do not execute full GPU visibility/layer routing or motion-vector
pixels; the Wasm build uses the real dependencies.

Matched root-runner commands used exactly `--headless --meshes 10000 --workers 4
--cpu-work 1`, two fresh browser sessions each, readiness-gated warmup (6.09–6.30 s)
and separate samples (5.04–5.07 s). Reports under root
`.cache/bevy-web-ecs/render-results/`: before `2026-11-03T13-14-45.482Z.json`;
after `2026-11-03T13-17-48.882Z.json`. Both report status `ok`, 10,001 meshes and
material assets, verified motion/CPU reference and GPU readiness, with browser-main
GPU ownership unchanged.

| Metric | Threaded before → after | Serial before → after |
| --- | --- | --- |
| Updates/sec | 12.25 → 12.43 | 13.04 → 12.10 |
| Sampled total CPU ms/update | 83.02 → 80.16 | 75.35 → 77.29 |
| Render preparation ms/update | 33.07 → 31.35 | 32.84 → 31.38 |
| Collection-associated named group ms/update | 10.83 → 7.84 | 11.67 → 8.24 |
| Sparse input set_batch ms/update | 4.14 → 1.57 | 4.64 → 1.30 |
| History push_batch + flush ms/update | 3.18 → 3.14 | 2.55 → 2.75 |
| GPU instrumented passes mean ms/frame | 0.1129 → 0.1128 | 0.1131 → 0.1125 |

Contributor analysis uses captured named labels, with no rebuilt-index mapping
for older samples. The group exclusively sums collection task wrappers, builder
preparation, sparse input/culling setters, history pushes and flushes; history
inlining is included rather than counted as eliminated. The localized group
falls about 28–29% in both modes, consistent with the instruction reduction, but
one pair with 61–66 updates and 10-ms profiler samples is not repeatability proof.
**There is no demonstrated consistent end-to-end gain:** threaded cadence rises
1.4%, while serial falls 7.2%, with variation in unrelated categories. GPU timings
exclude copies/uninstrumented passes; update cadence is not physical presentation.
No further small speculative optimization was stacked on this result.

## Batched mesh input and transform history (2026-11-03)

The existing GPU-collection fast path now accumulates at most 128 distinct sparse
indices per task-local vector, reused across flushes. `queue_mesh_input_batch`
flushes before duplicate indices, preserving sequential previous-transform reads.
`flush_mesh_input_batch` reads the old transforms, calls
`PreviousInstanceInputUniformBuffer::push_batch` once, maps contiguous history
indices back to the original sparse indices, then calls
`InstanceInputUniformBuffer::set_batch`. Each worker flushes before returning;
the scope joins before slow-path updates, removals, index reuse or GPU uploads.
New entities and layer/culling-mode changes retain the original slow path,
including the first-frame history sentinel. Geometry caching, live material/skin/
morph/flag preparation, culling-bound comparisons and the benchmark workload are
unchanged.

`AtomicSparseBufferVec::set_batch` retains atomic payload stores, but sorts fixed
stack storage of dirty-word masks and merges them before marking. There is at
most one dirty-word RMW per distinct word per chunk (none if already dirty),
with the existing first-transition summary marking. `fetch_or` preserves other
writers' bits in the same word. Drains require exclusive ownership after joins;
relaxed atomics do not themselves publish complete multiword payloads. No unsafe
plain writes or new `AtomicBlob` ordering assumptions were introduced. History
uses one relaxed cursor reservation per nonempty batch, bounds-checks the range,
and writes only its reserved indices. Payload atomic stores remain per mesh;
noncontiguous indices and sorting/duplicate checks still cost CPU. The task vector
allocates once with capacity 128, never grows in this path; history scratch and
dirty-mask scratch are fixed stack arrays.

From this directory, `bun test mesh-batching.test.mjs mesh-collection.test.mjs`
compiles actual production helper/method bodies into isolated Rust fixtures,
without the blocked enclosing Cargo test workspace. The new fixture executes
seven Rust tests (including the four existing dirty-helper tests); the preserved
collection fixture executes three. Coverage includes scalar/batch equivalence,
noncontiguous writes, duplicate-index history, repeated drains/reuse, concurrent
same-word writers and history reservations, and stable task-vector capacity.
A counted cursor verifies 1,024 histories use eight reservations, not 1,024.
The storage/GPU dependencies are stubs; these tests do not execute full visibility/
layer routing or verify GPU motion-vector pixels.

One requested cached O3 build and matched headless before/after commands completed:
`--meshes 10000 --workers 4 --cpu-work 1`, two fresh browser sessions per command,
readiness-gated warmup (6.04–6.13 s observed) and separate samples (5.01–5.05 s).
Reports under root `.cache/bevy-web-ecs/render-results/`:
`2026-11-03T13-05-15.840Z.json` before and
`2026-11-03T13-08-57.657Z.json` after. Both retain 10,001 meshes/material assets,
32 CPU lane systems, verified motion/CPU reference and GPU validation.

| Metric | Threaded before → after | Serial before → after |
| --- | --- | --- |
| Updates/sec | 12.53 → 12.08 | 12.30 → 12.37 |
| Sampled total CPU ms/update | 79.60 → 81.96 | 78.02 → 77.43 |
| Render preparation ms/update | 32.89 → 32.57 | 34.16 → 33.56 |
| Collection-associated named group ms/update | 12.06 → 10.54 | 11.81 → 10.82 |
| Collection task wrapper ms/update | 5.64 → 2.92 | 6.23 → 3.82 |
| Mesh input sparse set / set_batch ms/update | 5.64 → 5.03 | 5.59 → 4.29 |
| History push_batch ms/update | inlined → 2.27 | inlined → 2.39 |
| GPU instrumented passes mean ms/frame | 0.1127 → 0.1131 | 0.1127 → 0.1125 |

The named group uses captured named stack frames for collection/task wrappers,
builder preparation, mesh-input sparse writes and history batches; each sample
is attributed exclusively through the existing contributor analysis. Unrelated
system wrappers merely mentioning input-buffer parameter types are excluded.
This is a named attribution group, not an exact collection timer, and inlined
work can move between names after batching. No old Wasm indices were remapped
using the rebuilt binary. Profiler sampling, about 61–63 updates per case and
unrelated CPU variation limit the comparison. The localized group decreased,
but this pair demonstrates **no end-to-end gain**; threaded cadence worsened.
GPU times exclude copies/uninstrumented passes, and cadence is not presentation.

## Task-local mesh geometry lookup cache (2026-11-03)

Collection workers now retain the last mesh's vertex/index/metadata allocation
ranges for the lifetime of one task. The allocator is immutably borrowed during
collection; each invocation creates fresh caches, so allocation changes, missing
meshes becoming available and reused asset IDs cannot retain prior-frame ranges.
There is no heap allocation or shared cache lock. Alternating mesh IDs miss normally.
Transforms, history pushes, materials, skins, morphs, lightmaps and instance flags
are not cached. Existing sparse/culling optimizations remain unchanged.

`bun test mesh-collection.test.mjs` compiles the production cache, preparation,
update and removal functions with CPU fixtures outside the enclosing Cargo
workspace. Three Rust tests cover mixed indexed/nonindexed/missing geometry,
changing instance metadata and transforms, missing materials, previous-transform
history, removal/recycled slots, frame-local invalidation and independent workers.
Four workers preparing 10,000 identical mesh IDs each perform 12 allocator calls
rather than 120,000; cache storage is at most 64 bytes per worker. These checks do
not execute the complete visibility/layer-routing systems or GPU motion vectors.

Matched headless runs used `--meshes 10000 --workers 4 --cpu-work 1`, fresh browser
profiles, readiness-dependent warmup and sampling, with unchanged O3 configuration.
Before report: `2026-11-03T12-52-24.851Z.json`; after:
`2026-11-03T12-56-17.168Z.json`, both under root
`.cache/bevy-web-ecs/render-results/`.

| Metric | Threaded before → after | Serial before → after |
| --- | --- | --- |
| Updates/sec | 11.55 → 12.36 | 11.66 → 11.97 |
| Sampled total CPU ms/update | 87.35 → 79.86 | 81.85 → 79.34 |
| Render preparation ms/update | 35.40 → 32.09 | 35.90 → 35.72 |
| Collection-associated named group ms/update | 11.41 → 11.49 | 12.92 → 11.69 |
| Collection task wrapper ms/update | 6.82 → 6.70 | 8.05 → 7.08 |
| Mesh input sparse set ms/update | 3.75 → 3.99 | 4.19 → 4.28 |
| GPU instrumented passes mean ms/frame | 0.1132 → 0.1128 | 0.1130 → 0.1125 |

The named group sums collection/task-wrapper, builder preparation, mesh-input set
and culling-bound set attribution; it is not exact function self time. The wrapper
contains real work. One matched pair does not establish a repeatable high-impact
collection speedup: threaded collection was effectively unchanged, serial improved,
and unrelated categories varied. The deterministic result is eliminated repeated
allocator lookups, not proof that all observed cadence/CPU changes came from this
cache. No further speculative optimization was stacked on this result.

## Mesh collection / sparse-buffer experiment (2026-11-03)

This focused change skips byte-identical model-space culling-bound writes in both
collection paths. It preserves signed-zero and NaN payload differences, new-slot
dirty state, and replacement writes at reused instance indices. Instance transform
and previous-transform writes remain unconditional. Sparse dirty marking now marks
a summary bit only on the first clean-to-dirty transition of its 64-element block;
repeated marking of an already-dirty element avoids another atomic RMW. This relies
on the existing exclusive upload/drain phase after worker joins, not concurrent
upload and mutation. No GPU affinity or threading guard was changed.

The GPU-culling steady-state fast path already avoids per-instance channel sends.
The three channels are created per collection invocation, but new instances and
layer/culling-mode changes use their slow path. The collection task wrapper also
contains actual preparation, shared POD writes, and previous-transform history;
its sampled cost is not purely executor overhead. Those operations, workload,
unique materials, specialization and pipeline cloning were left unchanged.

The actual CPU helpers can be tested without the enclosing Bevy Cargo workspace:

```sh
# From src/bevy; output uses the existing benchmark cache.
rustc --edition=2024 --test crates/bevy_render/src/render_resource/sparse_buffer_dirty.rs -o /home/levi/dev/space-maker/.cache/bevy-web-ecs/sparse-buffer-dirty-tests
/home/levi/dev/space-maker/.cache/bevy-web-ecs/sparse-buffer-dirty-tests
```

Four deterministic tests cover byte-exact no-ops and changes, dirty retention,
concurrent same-bit/shared-word marking, exclusive drains, reused slots, and
parallel sparse-upload byte equivalence against full copies across 10,001 slots.
They exercise CPU helpers used by the real buffer; they do not execute GPU scatter
or the complete renderer's entity-removal/layer-transition systems.

The cached O3 Wasm build and wasm-bindgen generation succeeded. Both before and
after used the root runner with `--headless --meshes 10000 --workers 4 --cpu-work 1`,
fresh browsers per case, graphics readiness, at least five seconds of warmup and a
separate five-second sample. Both reports passed motion/CPU validation with 10,001
meshes and 10,001 unique materials and retained browser-main GPU ownership.

| Metric | Threaded before | Threaded after | Serial before | Serial after |
| --- | ---: | ---: | ---: | ---: |
| Application updates/sec | 6.684 | 6.489 | 6.562 | 6.642 |
| Sampled render preparation ms/update | 42.75 | 46.60 | 42.55 | 45.19 |
| Sampled collection + instance/culling + builder ms/update | 12.52 | 14.04 | 13.48 | 13.04 |

Before: repository-root
`.cache/bevy-web-ecs/render-results/2026-11-03T11-24-16.838Z.json`.
After: `.cache/bevy-web-ecs/render-results/2026-11-03T11-29-02.992Z.json`.
Comparison used captured named stack labels, not the rebuilt binary's function
indices to resolve an older profile. The culling setter no longer appears as a
separate sampled contributor after the change, but inlining/ancestor attribution
can move costs. **This pair does not demonstrate an overall speedup or a reliable
reduction of the complete target group.** Threaded cadence decreased about 2.9%;
serial increased about 1.2%. Each case contains only 33–34 measured updates and
10-ms statistical samples. Earlier `11-18-32.298Z` results had substantially higher
cadence even before this change and are not a matched speedup baseline. Do not
claim the original roughly 14.4 ms group was eliminated.

## Base material specialization cache-hit experiment (2026-11-03)

Captured named stacks establish a separate source of repeated preparation work:
`specialize_material_meshes` → `base_specialize` → `World::resource_scope` →
`MeshLayouts::clone`, including allocator, memory-copy and layout destruction
frames. This is not collection-task wrapper overhead. The base specialization
path cloned the entire `MeshPipeline` before `SpecializedMeshPipelines::specialize`
could discover an existing key/layout entry. Animated material preparation can
revisit specialization without requiring a new GPU pipeline. The prepass path
already checks `get_pipeline` before constructing its owned specializer.

`base_specialize` now performs that same read-only lookup first. Hits bypass the
resource scope, pipeline/layout clone and property reference clone; misses retain
the original implementation. There is no additional cache, retained world/device
resource or changed invalidation policy: every lookup reads the current
`SpecializedMeshPipelines<MaterialPipelineSpecializer>` resource. All preceding
mesh/culling/sparse-buffer experiments remain in place. Workload, materials,
systems, worker counts and browser-main GPU ownership are unchanged.

Run `bun test src/bevy/tools/wasm-render-bench/specialization.test.mjs` from the
repository root. It compiles the actual `base_specialize` source body with
GPU/ECS resource fakes and runs four Rust tests: 10,001 hits without pipeline
resources or slow-path calls; cold misses and distinct keys/layouts; cache-resource
replacement/invalidation; and repeated errors with no cached success. Reference
counts check temporary pipeline/property ownership is released. These tests check
actual function routing with fake resources, **not** real GPU pipeline creation,
Bevy resource-scope internals or the real cache's hashing/equality implementation.
They run independently of the enclosing workspace's nested-tools Cargo issue.
The cached O3 Wasm build and wasm-bindgen generation also passed.

A fresh bounded headless before/after pair used `--meshes 10000 --workers 4
--cpu-work 1`, exactly two fresh browsers per run, readiness-gated warmup and a
separate five-second sample, with owned cleanup. Reports:

- Before: `.cache/bevy-web-ecs/render-results/2026-11-03T11-34-16.636Z.json`.
- After: `.cache/bevy-web-ecs/render-results/2026-11-03T11-37-20.570Z.json`.

| Metric | Threaded before | Threaded after | Serial before | Serial after |
| --- | ---: | ---: | ---: | ---: |
| Application updates/sec | 6.529 | 8.383 | 6.953 | 8.628 |
| Sampled render preparation ms/update | 42.20 | 39.71 | 42.53 | 43.19 |
| Sampled asset/material preparation ms/update | 14.16 | 11.70 | 14.35 | 11.00 |
| Sampled CPU with named `base_specialize` ancestor ms/update | 4.79 | 0.00 | 4.48 | 0.45 |
| Measured updates | 33 | 43 | 35 | 44 |

The ancestor row combines exclusive contributors from preparation, asset/material,
queue/sort and command categories, without double-counting. Before had 16 samples
per case; after had 0/2. Layout clone/drop contributors disappeared from the after
capture. Comparisons used captured named labels, not the rebuilt binary's indices
for the older profile. All cases verified motion/CPU work, 10,001 meshes and unique
materials, requested workers, and complete GPU timing coverage (about 0.113 ms).

Cadence improved 28.4% threaded and 24.1% serial in this pair. This is one profiled
pair, not a repeated median/range or proof that the full cadence gain comes from
cloning. Sampling/inlining can move category attribution, and zero samples do not
prove zero CPU. In particular, **the broad preparation category remains large and
serial preparation did not improve**. This identifies and removes confirmed
avoidable specialization work; it does not establish that mesh collection, material
uploads or the entire roughly 40-ms preparation category have been fixed.

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

### OS CPU accounting and explicit GPU availability

The default summary also prints an **exclusive sampled CPU breakdown** for each
mode, with main/worker/total milliseconds per update and sample counts. The runner
reads the function-name section of the exact served `pkg/wasm_render_bench_bg.wasm`
and resolves Firefox `wasm-function[N]` locations without rebuilding or adding
per-system markers. `breakdown.mjs` owns the ordered operation-name rules. Walking
from leaf to root, the first recognized operation receives the entire sample's
OS CPU delta; nested categories never double-count. The same measurement-window,
Wasm-stack and worker-selection rules as the aggregate apply. Unrecognized Wasm
stacks appear as `Unclassified Wasm`, so unrounded category totals conserve the
reported application CPU totals independently for main and workers.

This is statistical **stack-name attribution**, not exact per-system accounting:
inlining and generic ECS wrappers can hide the executing system, and a recognized
ancestor may receive its cost. The executor category includes task-pool machinery;
it does not independently distinguish useful task execution, scheduling and spin.
Sleeping time is not converted to CPU. Sample counts include zero-CPU samples and
are not CPU weights; small counts and zero-count categories are inconclusive.
Missing binary names are recorded in JSON and do not manufacture stage timings.
`cpu_execution.breakdown` saves the method, limitations, symbol count and rows.
No performance markers, wall-duration apportionment or additional runtime hooks
are required, so capture settings and workload semantics remain unchanged.

`cpu_execution.breakdown.command_breakdown` refines **only** the existing
`render_commands` parent: uploads/writes/copies; pipeline/binding/resource creation;
render/compute pass begin/end; draw/dispatch/binding state; encoder creation/finish;
queue submission; buffer mapping/readback; named backend conversions/capabilities;
and explicit encoding/backend other. Each child includes main/worker/total CPU
ms/update and sample counts. Children sum to the parent independently for each
role and must **not** be added to the broad rows. Resource work already attributed
to asset/material preparation or another broad category is not moved here.

Child attribution uses the same innermost recognized frame as its parent. Rules
require qualified GPU receiver/method names (including demangled crate hashes,
legacy Rust names, and WebGPU generated bindings); generic `wgpu`, `submit`,
`finish`, or `end` substrings do not establish queue submission or pass work.
An opaque backend helper is not reassigned to an outer submission frame.
`map_wgt_features`, `map_wgt_limits`, and `map_texture_format` are labeled by their
symbol names, not interpreted as independently timed stages. Inlining, optimized
symbol aliases, truncated names, and generic wrappers can conceal actual work;
backend-other and zero-sample rows are not estimates of missing operations.
Coverage records `unresolved_symbol_samples`: samples encountering an unresolved
`wasm-function[N]` before reaching their attribution frame (not all unnamed native
frames or a count of unique missing symbols).

The authorized headless one-mesh/four-worker/CPU-work-1 capture
`2026-11-03T10-50-35.468Z.json` measured command-parent CPU of 0.6980/0.6413
ms/update threaded/serial, with 93/82 samples. Resource creation accounted for
0.2091/0.1882; queue submission for 0.0227/0.0079 (only 3/1 samples);
backend conversions for 0.1131/0.1170; backend-other for 0.1347/0.1014.
These are statistical symbol attributions from one profiled run, not exact stage
latencies or evidence that the threaded/serial differences are significant.

#### Repeated device capability conversion at 1,000 meshes

The saved visible-Firefox `2026-11-03T10-54-41.062Z.json` profile has these
exclusive conversion-symbol contributors (OS CPU ms/update; samples in parentheses):

| Symbol | Threaded / four workers | Serial |
| --- | --- | --- |
| `map_wgt_features` | 35.6516 (299) | 34.1990 (290) |
| `map_wgt_limits` | 0.3568 (3) | 0.5900 (5) |
| `map_texture_format` | 0 (0) | 0 (0) |

These stacks already contain Firefox-demangled names, rather than depending on
raw-index lookup. Native leaves, Wasm exit shims, `passStringToWasm0`, string-get
and `__wbg_has` JS wrappers sit **inside** `map_wgt_features`, with material
`bind_group_layout_entries` / `build_bind_group` preparation as callers. The
category is ancestor-inclusive, not Rust function self-time. Samples are not
function call counts. This evidence matches installed wgpu 30.0.0's WebGPU
`DeviceInterface::features`: every query reruns `map_wgt_features`, iterating the
feature mapping, converting JS strings and querying `GPUSupportedFeatures.has`.
Limits likewise reread browser properties on every query.

`RenderDevice` now snapshots its device's immutable features and limits in `new`,
retains them in clones, and returns them without repeating backend queries. It
caches device capabilities, not the potentially broader adapter capabilities.
The workload is unchanged: 1,000 moving meshes, 1,001 unique materials, CPU work 1,
and 32 independent CPU systems with a dependent per-material color update.

After the O3 Wasm rebuild, the authorized two-case **headless** capture
`2026-11-03T11-01-57.274Z.json` retained that workload and recorded conversion CPU
of 0 (0 samples) threaded and 0.2044 ms/update (2 samples) serial. Both remaining
samples come through `Adapter::get_texture_format_features` in mip-generation
preparation, not the repaired material/device path. Total sampled application CPU
was 25.25/23.31 ms/update, with 18.82/19.39 updates/s. The baseline was visible,
so this is not a matched FPS comparison or a precise speedup estimate. Zero
samples does not prove zero remaining conversion work. The runner completed both
fresh browser cases and owned cleanup without a runtime timeout.

Offline diagnostic (run from repository root; supply the exact captured Wasm for
profiles containing raw function indexes):

```sh
bun src/bevy/tools/wasm-render-bench/contributors.mjs REPORT.json SERVED.wasm
# Add --full-stacks for all weighted leaf-to-root stacks instead of three excerpts.
# Select creation costs, with bounded symbol-summary output:
bun src/bevy/tools/wasm-render-bench/contributors.mjs REPORT.json SERVED.wasm --summary resource_creation
```

The diagnostic preserves raw labels, resolved symbols, OS weights and boundary
exclusions, and splits the category by its innermost conversion symbol without
claiming call counts or discarding native/browser leaves. A later rebuilt Wasm
must not resolve an older profile's raw indexes; the observations above use the
older profile's already-demangled conversion frames.

The native `RenderDevice` regression test uses wgpu's noop device to check
capability values across repeated reads, clones and separate devices. Its attempted
execution was blocked before compilation by the existing engine workspace error:
`multiple workspace roots found in the same workspace` (the root and standalone
Wasm benchmarks). That test remains unexecuted; the O3 Wasm build and authorized
browser capture passed. No workspace repair was included.

Focused checks: `bun test src/bevy/tools/wasm-render-bench/breakdown.test.mjs src/bevy/tools/wasm-render-bench/contributors.test.mjs src/bevy/tools/wasm-render-bench/cpu.test.mjs src/bevy/tools/wasm-render-bench/run.test.mjs src/bevy/tools/wasm-render-bench/capture.test.mjs`.
They cover realistic captured symbols, raw index resolution, method-name
collisions, broad-category precedence, per-role parent/child CPU and sample
conservation, and human-readable hierarchical reporting.

#### Non-bindless material uniform reuse

The saved visible report `2026-11-03T11-05-55.257Z.json` attributed
10.5652 / 11.423 ms per update (threaded / serial) to resource creation.
Weighted threaded contributors were `DeviceExt::create_buffer_init` 3.3189 ms
(49 samples), `GPUDevice.createBuffer` 1.2859 (19), `WebDevice::create_buffer`
0.2030 (3), bind-group entry conversion 1.8974 (28),
`WebDevice::create_bind_group` 2.5745 (38), and `GPUDevice.createBindGroup`
1.2856 (19). These are exclusive sampled OS CPU weights, not invocation counts.
Buffer initialization stacks include `GPUBuffer.unmap` under the non-bindless
material allocator's `prepare_bind_groups`; this is not recurring pipeline compilation.

The derived `StandardMaterial` path already builds CPU-side `Data` ranges.
`RenderMaterialBindings::prepare_material` attempted `try_update_data`, but the
non-bindless allocator always rejected it, freed the previous allocation, and
queued a replacement. Its preparation then created a new uniform buffer for each
`Data` binding and a new bind group. Thus changing only color still recreated
both GPU objects for every changed material.

The non-bindless fast path now checks layout, binding indices/count, resource
identities/types and uniform sizes before mutating retained bytes. Compatible
updates retain the material's bind group and uniform buffers; the existing
`write_material_bind_group_buffers` phase uploads current bytes with
`Queue::write_buffer`. Resource/layout/size changes still use replacement, and
shader-buffer identity invalidation still unprepares/rebuilds from current data.
Freeing a slot clears pending writes. No derive API redesign or benchmark scene,
CPU workload, material sharing, or frozen-color shortcut was introduced.

One matched headless pair used 1,000 moving meshes, four/zero workers and CPU work
1, with fresh browsers/profiles, readiness-gated five-second warmup/sample and
owned cleanup. Baseline: `2026-11-03T11-09-58.250Z.json`; after:
`2026-11-03T11-12-48.983Z.json` (both repository-root render-results directory).

| Sampled CPU ms/update | Before threaded / serial | After threaded / serial |
| --- | ---: | ---: |
| Resource creation | 11.4242 / 10.2385 | 0.2410 / 0.3493 |
| Render preparation | 4.6300 / 4.02 | 4.39 / 4.16 |

After-run application cadence was 49.13 / 50.58 updates/sec, with total attributed
application CPU 12.49 / 10.96 ms/update. Both cases passed motion/CPU reference
validation and retained 1,001 unique materials. One before/after pair does not
establish repeated-trial significance, physical displayed FPS, or full-editor
performance. The visible saved report is not a matched headless baseline.

Four contributor tests passed, including exclusive weighted creation attribution
and retained caller stacks. The cached O3 Wasm build and wasm-bindgen generation
passed. Added native allocator tests check GPU object identity with wgpu's noop
backend, layout rejection, pending-write cleanup, 1,000 independent changing byte
states, and atomic rejection of binding/size changes. Their execution remains
blocked before compilation by the existing multiple-workspace-roots Cargo error;
no native-test success is claimed and workspace repair is outside this change.

The default runner no longer installs wall-time boundary schedules or emits
`schedule_timings`. It controls Firefox's supported `nsIProfiler` API and captures
`GeckoMain` and `DOM Worker` threads. Profiles are saved beside the result JSON
and read only after owned browser shutdown.

After graphics readiness and at least five seconds of warmup, the page enters
`Preparing CPU capture`. The runner starts a **fresh** recording, awaits profiler
startup in subprocesses and one periodic sampling cycle, then acknowledges that
readiness epoch. Only the next application callback establishes the measurement
boundary; neither WebDriver latency nor polling defines measured time. There is
no polling loop: mutation/performance observers deliver the request/end signal.
Readiness changes invalidate the epoch, restart warmup and require a fresh capture.
The end mark wakes the runner before asynchronous GPU-result draining. The runner
awaits a bracketing sample, pauses recording and dumps the profile, so loading,
warmup and GPU drain cannot consume its retained measurement history. Standalone
pages without the runner's `profile-controlled=1` retain their ungated behavior.

The recording requests 16,777,216 **eight-byte entries** (128 MiB per process), not
bytes or samples. Sampling is 10 ms for up to four compute workers, increasing
with larger worker counts to keep periodic thread samples roughly bounded
(including the two auxiliary DOM workers). `cpu_capture` saves requested settings,
actual Firefox configuration and the acknowledged epoch. The supported features
are `js,stackwalk,nomarkerstacks`; current Firefox records OS thread CPU deltas
without the obsolete `cpu`, `leaf` or `threads` feature names. Marker stacks are
unnecessary for sampled Wasm attribution. Only controlled capture requests the
geckodriver `--allow-system-access` flag, on the owned loopback driver, to permit
the privileged profiler API. Inherited profiler environment overrides are removed
from that owned child; other browser workflows retain their existing settings.

The exact visible failure `2026-11-03T10-24-57.686Z.json` used **1 ms**, not 0.1 ms,
sampling. Firefox clamped the earlier buffer request to 16,777,216 entries. In its
threaded content process, retained samples started around 7569.6 ms, after the
expected measurement start at 7332.991 ms; only the 12334.711 ms end mark survived.
The earlier buffer increase therefore did not preserve the five-second window.

Retention is no longer dependent on startup/warmup/drain duration. A deterministic
variable-byte ring stress fixture reproduces old truncation and tests fresh capture
at 1200 updates/s, 60 128-byte markers/update and 16 KiB/thread sample, across
0–32 compute workers with six seconds of capture slack. This is a conservative
**tested workload budget**, not a proof that arbitrary Firefox marker volume,
stack depth, stalls or control-channel delays cannot overflow a finite buffer.
CPU accounting still requires both original boundary marks and complete retained
sample coverage for every included thread. Overflow, unknown units or missing
attribution remain explicitly unavailable; no start marker is synthesized and no
wall time or fake zero substitutes for missing CPU. Coarser sampling reduces
perturbation but increases statistical uncertainty, particularly for short worker
bursts; inspect sample/stack coverage and omitted-boundary bounds.

The authorized headless one-mesh/four-worker/CPU-work-1 comparison
`2026-11-03T10-36-28.404Z.json` returned sampled CPU in both cases (threaded total
2.77 ms/update at 213.82 updates/s; serial 1.76 ms/update at 249.68 updates/s).
It did not reproduce the visible 388 updates/s case. The high-rate evidence is the
separate deterministic stress fixture, not that slower headless run.

The root command `bun bevy-benchmark/run.mjs --meshes 100 --workers 8 --cpu-work 1`
automatically captures and reports sampled application CPU in both cases; no
separate profile-analysis command is needed. `cpu_execution` weights each OS
thread CPU delta by whether its sampled raw Gecko stack contains Wasm, reusing
the shared stack classifier. Console summaries report sampled main, workers and
total CPU milliseconds per update, stack coverage and other/unclassified CPU.
This is sampled attribution, not exact app-only execution. Synchronous browser
callees with Wasm ancestors are included; JS-only and asynchronous work are not.
The isolated benchmark process is assumed to contain only the benchmark Wasm.
Missing per-thread stacks or no identifiable Wasm samples report unavailable,
not a misleading application zero. Partial missing stacks remain explicitly
unclassified, with sample counts and missing-stack CPU retained in coverage.

The separately named `browser_thread_cpu` diagnostic
identifies the content process by its own readiness-gated
`benchmark-cpu-start`/`benchmark-cpu-end` markers, emitted from the measurement
system before final verification. Readiness loss resets the window. Browser-parent,
compositor and unrelated-process CPU are excluded. CPU deltas are converted using
the profile's declared units, never from frame durations or `performance.now()`.
The latter still controls cadence and warmup, not CPU execution accounting.

Full browser-thread diagnostics and GPU sample coverage remain in saved JSON.
The console table reports GPU milliseconds separately from sampled CPU milliseconds. Browser-thread diagnostics include
GeckoMain CPU, summed DOM-worker CPU, their total, and each divided
by the measured update count. This is an aggregate CPU-per-update mean, not
per-update latency or percentiles, and includes browser/JS/Wasm work on those
threads—not isolated Wasm CPU or all browser CPU. Rendering/driver work executed
on these threads and profiling effects are not subtracted; profiler work on other
threads is not included. No unprofiled control establishes the overhead magnitude.
All captured DOM workers in the
marked process are included, not just compute workers. Thread PID/TID, CPU totals,
covered intervals and sample counts are retained.

Only sample intervals fully enclosed in the marked window are summed. Crossing
intervals are omitted without wall-time interpolation: totals are lower bounds,
with an aggregate boundary CPU upper bound in milliseconds (at most one CPU per
thread). Missing units, CPU deltas, worker coverage, ambiguous markers or incomplete
window coverage, duplicate thread IDs or non-increasing sample times produce `supported: false` and an explicit reason, never a proxy.
Profiling adds overhead to both cases; these FPS results are profiled diagnostics,
not clean unprofiled comparisons. Actual Firefox delivery remains unverified by
deterministic tests or Wasm compilation. Readiness, five-second warmup/sample,
exactly two fresh browsers, materials and the optional CPU workload are unchanged.

This experimental engine extends `RenderDiagnosticsPlugin` with the standard
wgpu 30 pass-boundary `timestamp_writes` path for WebGPU. The benchmark uses
`WgpuSettings.optional_features = TIMESTAMP_QUERY` with WebGPU priority and no
required features. Only adapter-supported optional features are enabled; neither
`TIMESTAMP_QUERY_INSIDE_ENCODERS` nor `TIMESTAMP_QUERY_INSIDE_PASSES` is requested.
Unsupported adapters retain CPU/cadence reporting without timestamp queries.
Native encoder/in-pass diagnostic spans remain available with their existing features.

`gpu_timing` uses `source: "timestamp-query"` and
`scope: "sum_disjoint_instrumented_passes"`. It sums complete timestamp pairs from
tracked render passes and the PBR uniform allocation, bin unpacking, early/late
mesh preprocessing and indirect-parameter compute passes. This is actual GPU
execution duration of those disjoint passes, **not** submission latency, display
presentation, CPU duration or a sum of nested diagnostic spans. Copies, gaps,
raw/uninstrumented passes (including other optional rendering features) and
explicit caller-owned timestamp writes are excluded. It is not whole-queue GPU
busy time. Query pairs share the existing recorder allocator, resolve buffers and
asynchronous map/recycling path. Exhausted-query frames are rejected, not counted
as deceptively small complete samples. Map errors complete as missing samples.

Each sampled update tags its subsequent render frame before encoding. Delayed,
out-of-order and duplicate readbacks cannot enter a different measurement window;
readiness resets discard old tags. After the last sampled update the page drains
pending results for at most 120 additional updates, outside CPU/cadence sampling.
`expected_samples` equals measured updates; `samples` counts valid render-frame
results, and `missing_samples` includes unsupported, exhausted, failed or still
pending results. Mean and nearest-rank p50/p95 are per **received valid sampled
render frame**, not divided by all updates when coverage is incomplete. Inspect
coverage before comparing results. Zero-duration quantized samples are valid;
zero received samples report `supported: false`, null statistics and a reason.
No CPU or frame-time proxy is substituted. The CPU reader still reports stale
artifacts without CPU markers as unavailable. No browser execution was used to
verify this feature; tests and compilation do not prove live GPU timing delivery.
`profile.mjs` retains the existing workload/worker CLI options.

Run deterministic CPU accounting and runner checks from the repository root:
`bun test src/bevy/tools/wasm-render-bench/cpu.test.mjs src/bevy/tools/wasm-render-bench/run.test.mjs src/bevy/tools/wasm-render-bench/capture.test.mjs editor-benchmark/shared_browser.test.mjs`.
The shared `editor-benchmark/profile.mjs` reader also respects declared CPU units
and excludes start-crossing intervals; its sampled stack rankings are not exact
function execution measurements. At exact sample boundaries no interval is omitted.
Cadence counts intervals between measurement callbacks, not the initial boundary
callback as another frame. CPU markers are emitted just after the cadence clock
reads; the reader allows up to 10 ms duration mismatch, so these are not exact
per-update execution boundaries.
The earlier wall-span accumulator remains an unused diagnostic source, not default
instrumentation. The historical wall-span measurements below are not CPU execution
measurements.

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
