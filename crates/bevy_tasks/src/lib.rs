#![doc = include_str!("../README.md")]
#![cfg_attr(docsrs, feature(doc_cfg))]
#![doc(
    html_logo_url = "https://bevy.org/assets/icon.png",
    html_favicon_url = "https://bevy.org/assets/icon.png"
)]
#![no_std]

/// Configuration information for this crate.
pub mod cfg {
    pub(crate) use bevy_platform::cfg::*;

    pub use bevy_platform::cfg::{alloc, std, web};

    define_alias! {
        #[cfg(feature = "async_executor")] => {
            /// Indicates `async_executor` is used as the future execution backend.
            async_executor
        }

        #[cfg(all(any(not(target_arch = "wasm32"), feature = "wasm_threads"), feature = "multi_threaded"))] => {
            /// Indicates multithreading support.
            multi_threaded
        }

        #[cfg(target_arch = "wasm32")] => {
            /// Indicates the current target requires additional `Send` bounds.
            conditional_send
        }

    }
}

cfg::std! {
    extern crate std;
    mod scope_dispatch;
    pub use scope_dispatch::with_local_task_scopes;
}

#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
mod worker_failure;
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
mod thread_context;
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
pub use thread_context::is_web_worker_thread;
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
static WORKER_FAILURE: worker_failure::WorkerFailure = worker_failure::WorkerFailure::new();

/// Records a worker trap using shared memory, even if the page's JS queue is blocked.
/// Worker entry-point error handlers must call this before posting JS diagnostics.
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
pub fn report_web_worker_failure(message: &str) {
    WORKER_FAILURE.report(message);
}

extern crate alloc;

#[cfg(all(feature = "wasm_threads", target_arch = "wasm32", not(target_feature = "atomics")))]
compile_error!("wasm_threads requires an atomics-enabled Wasm build and rebuilt standard library");

cfg::conditional_send! {
    if {
        /// Use [`ConditionalSend`] to mark an optional Send trait bound. Useful as on certain platforms (eg. Wasm),
        /// futures aren't Send.
        pub trait ConditionalSend {}
        impl<T> ConditionalSend for T {}
    } else {
        /// Use [`ConditionalSend`] to mark an optional Send trait bound. Useful as on certain platforms (eg. Wasm),
        /// futures aren't Send.
        pub trait ConditionalSend: Send {}
        impl<T: Send> ConditionalSend for T {}
    }
}

/// Use [`ConditionalSendFuture`] for a future with an optional Send trait bound, as on certain platforms (eg. Wasm),
/// futures aren't Send.
pub trait ConditionalSendFuture: Future + ConditionalSend {}

impl<T: Future + ConditionalSend> ConditionalSendFuture for T {}

use alloc::boxed::Box;

/// An owned and dynamically typed Future used when you can't statically type your result or need to add some indirection.
pub type BoxedFuture<'a, T> = core::pin::Pin<Box<dyn ConditionalSendFuture<Output = T> + 'a>>;

// Modules
mod executor;
pub mod futures;
mod iter;
mod slice;
mod usages;

cfg::async_executor! {
    if {} else {
        mod edge_executor;
    }
}

// Exports
pub use async_task::Task;
pub use iter::ParallelIterator;
pub use slice::{ParallelSlice, ParallelSliceMut};
pub use usages::{AsyncComputeTaskPool, ComputeTaskPool, IoTaskPool};

pub use futures_lite;
pub use futures_lite::future::poll_once;

cfg::web! {
    if {} else {
        pub use usages::tick_global_task_pools_on_main_thread;
    }
}

cfg::multi_threaded! {
    if {
        mod task_pool;
        mod thread_executor;

        pub use task_pool::{Scope, TaskPool, TaskPoolBuilder};
        pub use thread_executor::{ThreadExecutor, ThreadExecutorTicker};
    } else {
        mod single_threaded_task_pool;

        pub use single_threaded_task_pool::{Scope, TaskPool, TaskPoolBuilder, ThreadExecutor};
    }
}

#[cfg(not(all(target_arch = "wasm32", feature = "wasm_threads")))]
pub use bevy_platform::future::block_on;

/// Completes a synchronous CPU task scope without parking the browser main thread.
///
/// Workers use the normal parking implementation. The browser main thread must
/// poll instead: `memory.atomic.wait32` is forbidden there. This cannot drive
/// browser I/O or worker startup; await those asynchronously before entering a scope.
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    if is_web_worker_thread() {
        return bevy_platform::future::block_on(future);
    }
    let mut future = core::pin::pin!(future);
    let mut context = core::task::Context::from_waker(core::task::Waker::noop());
    loop {
        if let Some(message) = WORKER_FAILURE.message() {
            panic!("Web Worker failed while the page awaited an ECS task: {message}");
        }
        match future.as_mut().poll(&mut context) {
            core::task::Poll::Ready(value) => return value,
            core::task::Poll::Pending => core::hint::spin_loop(),
        }
    }
}

/// Creates and asynchronously starts shared-memory task pools for a regular web page.
///
/// Await this after wasm-bindgen initialization and before constructing/running
/// the Bevy app. Existing pools are retained. Schedules and non-Send systems stay
/// on their calling thread; eligible Send systems and parallel queries use workers.
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
pub async fn init_web_thread_pools(compute_threads: usize) {
    assert!(compute_threads > 0);
    let compute = ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new()
        .num_threads(compute_threads).thread_name("Compute Task Pool".into()).build());
    let io = IoTaskPool::get_or_init(|| TaskPoolBuilder::new()
        .num_threads(1).thread_name("IO Task Pool".into()).build());
    let asynchronous = AsyncComputeTaskPool::get_or_init(|| TaskPoolBuilder::new()
        .num_threads(1).thread_name("Async Compute Task Pool".into()).build());
    compute.ready().await;
    io.ready().await;
    asynchronous.ready().await;
}

/// The tasks prelude.
///
/// This includes the most common types in this crate, re-exported for your convenience.
pub mod prelude {
    #[doc(hidden)]
    pub use crate::{
        block_on,
        iter::ParallelIterator,
        slice::{ParallelSlice, ParallelSliceMut},
        usages::{AsyncComputeTaskPool, ComputeTaskPool, IoTaskPool},
    };
}

/// Gets the logical CPU core count available to the current process.
///
/// This is identical to `std::thread::available_parallelism`, except
/// it will return a default value of 1 if it internally errors out.
///
/// This will always return at least 1.
pub fn available_parallelism() -> usize {
    cfg::switch! {{
        cfg::std => {
            std::thread::available_parallelism()
                .map(core::num::NonZero::<usize>::get)
                .unwrap_or(1)
        }
        _ => {
            1
        }
    }}
}
