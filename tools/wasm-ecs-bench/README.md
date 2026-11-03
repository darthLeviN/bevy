# Headless Firefox Wasm ECS benchmark

Standalone ECS throughput experiment: no rendering, canvas, window creation or
animation-frame scheduling. Firefox is launched with `--headless` only; the runner
supplies no browser preference overrides. Geckodriver still uses its normal
WebDriver automation profile. Bun and geckodriver must already be installed.

## Build and run

Run these commands **from this directory**. The runner never builds and has no
`--no-build` option. Cargo configuration already selects Wasm atomics and build-std.
Use a wasm-bindgen CLI compatible with the crate's wasm-bindgen dependency.

```sh
cargo +nightly-2026-10-25 build --release --target-dir /home/levi/dev/space-maker/.cache/bevy-web-ecs/target
wasm-bindgen /home/levi/dev/space-maker/.cache/bevy-web-ecs/target/wasm32-unknown-unknown/release/wasm_ecs_bench.wasm --target web --out-dir pkg
bun run.mjs
```

The inert document opens `BroadcastChannel('bevy-ecs-benchmark')` before calling
`init()` and awaiting `start(absoluteShimUrl, absoluteWorkerUrl, 4)` on the browser
main thread. The world and schedule calls remain on that main thread; only eligible
systems and query chunks run on workers. There is no coordinating worker.
`init_web_thread_pools(4).await` creates the compute/IO/async pools and yields to the
browser until their workers have started. The worker receives `[module, memory,
work]`, initializes the shared instance and invokes `wasm_thread_entry_point(work)`.
Worker/import failures publish `{fatal: ...}`. The document exposes
`window.ecsBenchmarkResult` or `window.ecsBenchmarkFatal` for bounded asynchronous
WebDriver retrieval.

The three cases are `serial`, `parallel-systems` and `parallel-query`, each with
at least five seconds of warmup and five seconds of sampling (about 30 seconds
combined, plus startup and preflight). Results include entity/system/tick/sample
counts, timing statistics, checksum and `all_entity_values_verified: true`.
The runner rejects missing cases, short windows, invalid numerical fields,
missing correctness evidence, serial preflight counts other than one, parallel
thread counts below two, and parallel-system overlap below two. The runner checks
the Rust correctness attestation; it cannot independently reconstruct entity
values from an aggregate checksum. Deterministic runner tests are not evidence
that the Rust workload actually ran or that browser threading works.

Reports are complete JSON under the repository root
`.cache/bevy-web-ecs/results/` and are also printed to stdout, including failures.
These are **ECS updates per second, not FPS**. Parallel execution has overhead;
no speedup is guaranteed. Compare matched builds and workloads, not just labels.

## Verified regular-page run

On 2026-11-03 the updated experiment ran successfully in headless Firefox with
`main_thread: true`, no browser preference overrides and no visible windows:

| Execution | Mean CPU update | Updates/second | Preflight thread participation | Overlapping systems |
| --- | ---: | ---: | ---: | ---: |
| Serial | 8.219 ms | 119.69 | 1 | 1 |
| Parallel systems | 2.232 ms | 423.11 | 4 | 4 |
| Parallel queries | 2.026 ms | 463.59 | 5 | 1 |

Each case also runs a genuinely non-Send system holding `Rc<Cell<_>>`. On every
schedule update it checks its originating thread ID and accesses the page DOM.
Its check count matched every executed tick. A page-local non-Send async task
completed through the browser event loop, and an independent timer advanced 329
times during the run. Every entity's final component values passed exact checks.
The full report is at repository-root
`.cache/bevy-web-ecs/results/2026-11-03T05-49-58.322Z.json`.

The workload yields to the browser after each 32 updates. Throughput includes those
yields, while mean/p50/p95 CPU timings cover only schedule execution. These are not
rendering FPS and are not directly comparable to the worker-only throughput below.
The updated Wasm build and threading transform passed; 33 deterministic runner
tests passed. Browser, driver and server cleanup completed normally.

### Regular-page initialization contract

Enable `wasm_threads` on `bevy`, or directly on `bevy_ecs`/`bevy_tasks`. After
wasm-bindgen initialization, await `bevy::tasks::init_web_thread_pools(n)` before
constructing/running the app. Native and ordinary single-threaded Wasm builds are
unchanged. Atomics-enabled build-std and isolated HTTP headers remain required.
No special browser flags/preferences are required by this ECS test.

Main-thread CPU scopes actively poll rather than calling the forbidden atomic
wait operation. **This consumes the caller's CPU while waiting**; it is not a
nonblocking scheduler. Normal synchronous schedules return after their systems
finish. Browser I/O and worker startup must be awaited outside those scopes;
blocking on an event-loop-dependent future cannot be made safe by polling it.
Worker threads retain normal parking behavior. Main-thread `spawn_local` uses the
browser task queue so it does not depend on a nonexistent native pool tick.
Dropping a pool on the main thread closes its shutdown channel without synchronously
joining workers; workers retain their owned state until they exit.

This establishes regular-page ECS scheduling, non-Send thread affinity, local
async progress and parallel queries. It does not establish rendered application
behavior or thread affinity for every Bevy/GPU subsystem.

## Historical worker-only first run

On 2026-11-03, the atomics-enabled Wasm build and wasm-bindgen threading transform
completed, followed by one successful headless Firefox run with no requested
browser preference overrides or visible windows:

| Execution | Mean update | Updates/second | Preflight thread participation | Overlapping systems |
| --- | ---: | ---: | ---: | ---: |
| Serial | 8.252 ms | 121.18 | 1 | 1 |
| Parallel systems | 2.181 ms | 458.59 | 4 | 4 |
| Parallel queries | 1.895 ms | 527.60 | 5 | 1 |

Each case updated 16,384 entities with four independent component lanes and the
same 128-round integer kernel. Every component value was checked against its
seed and exact executed tick count after measurement. Different checksums are
expected because each case executes a different number of ticks in five seconds.
Parallel-query participation includes the coordinating worker in addition to the
four pool workers. System/query instrumentation is disabled during timed samples.

This single CPU-heavy workload demonstrated approximately 3.78x system-scheduling
and 4.35x query-throughput gains over the serial case. It is not an editor,
rendering, GPU or frame-presentation result, and does not establish the same gain
for small workloads. Cases ran serial-first in a fixed order; repeated,
counterbalanced measurements would be needed for a stronger performance claim.

The full report is at repository-root
`.cache/bevy-web-ecs/results/2026-11-03T05-30-22.077Z.json`.
Browser, driver and ephemeral server cleanup completed through the owning runner.
The original 29 deterministic runner tests also passed before that execution.

### Experimental engine boundary

The submodule branch is `experiment/wasm-ecs-workers`. `wasm_threads` is opt-in
through the top-level Bevy feature or the ECS/task crates. Existing default builds
remain single-threaded on Wasm. Native task-pool selection is unchanged. The
experiment uses `wasm_thread` to back Bevy's existing task pool, and enables existing
parallel schedule and query paths rather than substituting another ECS.
Scopes on the browser main thread reject use before asynchronous pool startup
completes; they no longer require the caller to live in a worker.

This is experimental support for the tested schedule/query path, not proof that
all Bevy systems, messages, async I/O or rendering can safely be moved onto
workers. Non-Send resources must stay on their owning thread, as checked in the
regular-page test above. Worker failure recovery and engine-wide thread-affinity
coverage remain outside this benchmark.

The build deliberately uses O2, 16 codegen units, no LTO and two compilation jobs.
It rebuilds the standard library with atomics, but uses only ECS/task dependencies;
there are no rendering, windowing, wgpu or asset pipelines. All compiler outputs
are isolated in `.cache/bevy-web-ecs/target`. Do not point this experiment at the
application or earlier benchmark target directories.

Two setup corrections were needed: this submodule uses `Schedule::set_executor`
with executor objects rather than `ExecutorKind`; wasm-bindgen also requires an
explicit `__heap_base` export with this toolchain. The leaf build script supplies
that export without changing dependency-wide Rust flags and recompiling the graph.
After the initial dependency build, both corrective builds compiled only the small
benchmark crate.

## Ownership and deadlines

One invocation owns an ephemeral loopback Bun static server, a detached
`geckodriver --host 127.0.0.1 --port 0` process group and its Firefox session.
Only files within this benchmark directory are served, with COOP `same-origin`
and COEP `require-corp` for shared memory. The driver has a 90-second command
ceiling; the complete workload has a tighter 75-second deadline. Asynchronous
result retrieval is bounded to 60 seconds. There are no retries or preference
fallbacks. Cleanup attempts session DELETE for at most two seconds before
stopping the owned driver/browser group, and stops the server even if deletion
fails. Including process-group cleanup, runtime is bounded to about 80 seconds.
SIGINT and SIGTERM use the same cleanup path; host failure/SIGKILL cannot be
handled. No process discovery or unrelated process termination is used.

## Deterministic checks (no browser/build)

```sh
bun test --timeout 10000 run.test.mjs
```

Tests exercise capability configuration, isolated static responses, result
validation, document/worker wiring and owned cleanup through controlled fakes.
Live execution and Rust compilation are separate, explicit user-run checks.
The shared [lifecycle helper](../../../../editor-benchmark/lifecycle.mjs) is reused
read-only; see [benchmark methodology](../../../../BENCHMARKING.md).
