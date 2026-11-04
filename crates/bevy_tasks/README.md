# Bevy Tasks

[![License](https://img.shields.io/badge/license-MIT%2FApache-blue.svg)](https://github.com/bevyengine/bevy#license)
[![Crates.io](https://img.shields.io/crates/v/bevy.svg)](https://crates.io/crates/bevy_tasks)
[![Downloads](https://img.shields.io/crates/d/bevy_tasks.svg)](https://crates.io/crates/bevy_tasks)
[![Docs](https://docs.rs/bevy_tasks/badge.svg)](https://docs.rs/bevy_tasks/latest/bevy_tasks/)
[![Discord](https://img.shields.io/discord/691052431525675048.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/bevy)

A refreshingly simple task executor for bevy. :)

This is a simple threadpool with minimal dependencies. The main usecase is a scoped fork-join, i.e. spawning tasks from
a single thread and having that thread await the completion of those tasks. This is intended specifically for
[`bevy`][bevy] as a lighter alternative to [`rayon`][rayon] for this specific usecase. There are also utilities for
generating the tasks from a slice of data. This library is intended for games and makes no attempt to ensure fairness
or ordering of spawned tasks.

It is based on [`async-executor`][async-executor], a lightweight executor that allows the end user to manage their own threads.
`async-executor` is based on async-task, a core piece of async-std.

### Browser-page lock compatibility (engine fork)

Every target with the `async_executor` feature uses the engine-owned adaptation
of async-executor 1.14.0 in [`src/async_executor.rs`](src/async_executor.rs).
There is no upstream async-executor dependency. Without this feature the existing
edge/no_std backend is unchanged. Native platform locks remain standard-library
locks, including blocking and poisoning semantics. The adaptation retains
upstream's unbounded global queue,
512-entry runner queues, stealing, notifications, panic propagation and scoped
future cleanup, but imports mutexes and reader/writer locks from `bevy_platform`.
Upstream directly uses standard-library locks, which can call forbidden
`Atomics.wait` when a browser page contends with a worker during nested scopes.
No executor lock-customization API is available in that version.

On atomic browser builds the platform locks use try-acquisition and spin on the
page, while workers retain standard blocking and poisoning semantics. This is
only safe for short critical sections released by independently progressing
workers: it does not permit holding a guard across page-local browser I/O.
Threads are not disabled, and the bounded `edge_executor` is not substituted.
The source header records upstream provenance and the adjacent MIT license;
this crate's Apache license also applies. When updating, compare the adaptation
against upstream, especially task lifetime/cancellation and wakeup ordering.

Executor locks are only one boundary: `futures_lite::block_on` registers a
`parking::Unparker` waker whose `wake`/`wake_by_ref` can take another standard
mutex on the *waking* page thread. Threaded Wasm workers therefore use
[`src/worker_block_on.rs`](src/worker_block_on.rs). Its platform-mutex-protected
notification token and condition variable retain worker sleeping, coalesce wakes,
and prevent lost notifications between polling and sleeping. Only workers wait
on the condition variable; on atomic Wasm, notification uses std's futex
`memory.atomic.notify` path. Each recursive driver has its own token. The page
continues polling CPU scopes, and native production `block_on` is unchanged.

The task-pool wake-path audit also covers global/local/thread executor sleepers,
scoped-result and cancellation awaiters, startup readiness and shutdown. The
first groups receive the same worker-driver waker. Readiness/shutdown now use
[`src/pool_signal.rs`](src/pool_signal.rs) on threaded Wasm: the previous
async-channel/event-listener listener list also acquired a standard mutex.
These closure-only signals use platform locks, unregister cancelled waiters,
and wake all receivers outside the lock on close/final-sender drop. Native
production builds and native task-pool unit tests retain async-channel and the original platform
`block_on`; browser replacements are tested separately without redirecting the
native task-pool paths. The vendored executor explicitly imports standard-library
locks outside threaded Wasm. This does not make arbitrary external futures
or third-party wakers page-safe; they require their own synchronization audit.

Run the focused, non-browser regression suite from the repository root:

```sh
cargo test --manifest-path src/bevy/tests-integration/browser-task-executor/Cargo.toml --target-dir src/target
```

It compiles the adapted executor source directly, exercises page-context mutex
contention and worker execution, real worker-driver `wake`/`wake_by_ref` under
forced cross-thread contention, wake-before-park/recursive drivers, pool-signal
closure/cancellation, queues larger than 64, borrowed/local futures and nested
engine task scopes. Its native integration tests also exercise the actual
`bevy_tasks` dependency compiled without `cfg(test)`, checking vendored backend
selection and standard native lock behavior rather than only injected locks.
It does not establish live browser input,
worker bootstrap or rendered behavior. The parent repository's actual threaded
Wasm build must also pass; see its development guide for build commands.

## Usage

In order to be able to optimize task execution in multi-threaded environments,
bevy provides three different thread pools via which tasks of different kinds can be spawned.
(The same API is used in single-threaded environments, even if execution is limited to a single thread.
This currently applies to Wasm targets.)
The determining factor for what kind of work should go in each pool is latency requirements:

* For CPU-intensive work (tasks that generally spin until completion) we have a standard
  [`ComputeTaskPool`] and an [`AsyncComputeTaskPool`]. Work that does not need to be completed to
  present the next frame should go to the [`AsyncComputeTaskPool`].

* For IO-intensive work (tasks that spend very little time in a "woken" state) we have an
  [`IoTaskPool`] whose tasks are expected to complete very quickly. Generally speaking, they should just
  await receiving data from somewhere (i.e. disk) and signal other systems when the data is ready
  for consumption. (likely via channels)

## `no_std` Support

To enable `no_std` support in this crate, you will need to disable default features, and enable the `edge_executor` and `critical-section` features.

[bevy]: https://bevy.org
[rayon]: https://github.com/rayon-rs/rayon
[async-executor]: https://github.com/stjepang/async-executor
