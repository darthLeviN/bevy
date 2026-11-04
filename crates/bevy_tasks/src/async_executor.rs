//! Engine-owned adaptation of async-executor 1.14.0 (MIT OR Apache-2.0).
//!
//! Source: https://github.com/smol-rs/async-executor/blob/v1.14.0/src/lib.rs
//! License texts: ../LICENSE-APACHE and async_executor.LICENSE-MIT.
//! Upstream examples/docs, static-executor support and diagnostic formatting are
//! omitted. Scheduling, task lifetime safety, queue sizes and wakeups follow
//! upstream. The functional change is importing locks from bevy_platform so
//! executor lock acquisition never parks the browser page. Registered wakers
//! need their own page-safe wake path (see worker_block_on). Keep this copy narrow;
//! compare these algorithms against upstream when updating the executor.
//! All async_executor-feature targets use this module; native platform locks are
//! the standard-library locks, not the browser-page wrappers.

#![expect(unsafe_code, reason = "upstream executor lifetime and task ownership implementation relies on unsafe")]
#![expect(dead_code, reason = "keeping methods from original implementation for transparency")]

use alloc::{rc::Rc, sync::Arc, vec::Vec};
use core::{
    future::Future,
    marker::PhantomData,
    panic::{RefUnwindSafe, UnwindSafe},
    pin::Pin,
    sync::atomic::{AtomicBool, AtomicPtr, Ordering},
    task::{Context, Poll, Waker},
};
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
use bevy_platform::sync::{PoisonError, RwLock};
#[cfg(not(all(target_arch = "wasm32", feature = "wasm_threads")))]
use std::sync::{PoisonError, RwLock};
#[cfg(all(not(test), target_arch = "wasm32", feature = "wasm_threads"))]
use bevy_platform::sync::{Mutex, MutexGuard};
#[cfg(all(not(test), not(all(target_arch = "wasm32", feature = "wasm_threads"))))]
use std::sync::{Mutex, MutexGuard};
// Native tests execute the actual browser mutex implementation, with an injected
// page context; no JavaScript or OS input is involved.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "../../bevy_platform/src/sync/web_mutex.rs"]
pub(super) mod page_mutex;
#[cfg(all(test, not(target_arch = "wasm32")))]
use page_mutex::{Mutex, MutexGuard};
#[cfg(all(test, target_arch = "wasm32"))]
use bevy_platform::sync::{Mutex, MutexGuard};
use async_task::{Builder, Runnable, Task};
use concurrent_queue::ConcurrentQueue;
use futures_lite::{future, FutureExt};
use pin_project_lite::pin_project;
use slab::Slab;

pub struct Executor<'a> {
    state: AtomicPtr<State>,
    _marker: PhantomData<core::cell::UnsafeCell<&'a ()>>,
}

// SAFETY: No thread-local state is accessible through another thread. All
// shared state is synchronized, and spawn requires Send futures and outputs.
unsafe impl Send for Executor<'_> {}
// SAFETY: All operations on shared executor state are internally synchronized.
unsafe impl Sync for Executor<'_> {}
impl UnwindSafe for Executor<'_> {}
impl RefUnwindSafe for Executor<'_> {}

impl<'a> Executor<'a> {
    pub const fn new() -> Self {
        Self { state: AtomicPtr::new(core::ptr::null_mut()), _marker: PhantomData }
    }

    pub fn is_empty(&self) -> bool { self.state().active().is_empty() }

    pub fn spawn<T: Send + 'a>(&self, future: impl Future<Output = T> + Send + 'a) -> Task<T> {
        let state = self.state();
        let mut active = state.active();
        // SAFETY: Both the future and T are Send.
        unsafe { Self::spawn_inner(state, future, &mut active) }
    }

    pub fn spawn_many<T: Send + 'a, F: Future<Output = T> + Send + 'a>(
        &self, futures: impl IntoIterator<Item = F>, handles: &mut impl Extend<Task<F::Output>>,
    ) {
        let state = self.state();
        let mut active = Some(state.as_ref().active());
        let tasks = futures.into_iter().enumerate().map(move |(i, future)| {
            // SAFETY: Both the future and T are Send.
            let task = unsafe { Self::spawn_inner(state, future, active.as_mut().unwrap()) };
            if i.wrapping_sub(1) % 500 == 0 {
                drop(active.take());
                active = Some(self.state().active());
            }
            task
        });
        handles.extend(tasks);
    }

    /// If used by Executor rather than LocalExecutor, future and T must be Send.
    unsafe fn spawn_inner<T: 'a>(
        state: Pin<&'a State>, future: impl Future<Output = T> + 'a, active: &mut Slab<Waker>,
    ) -> Task<T> {
        let entry = active.vacant_entry();
        let index = entry.key();
        let future = AsyncCallOnDrop::new(future, move || drop(state.active().try_remove(index)));
        // SAFETY (upstream lifetime contract): For non-Send futures the caller
        // is LocalExecutor, which is !Send + !Sync. Spawn, polling and dropping
        // runnables therefore happen on their origin thread. The scheduling
        // closure itself is Send + Sync. On executor drop every active waker is
        // woken and the queue is drained, dropping all runnables before 'a ends.
        // No runnable or scheduling closure may outlive the executor's lifetime.
        let (runnable, task) = unsafe {
            Builder::new()
                .propagate_panic(true)
                .spawn_unchecked(|()| future, Self::schedule(state))
        };
        entry.insert(runnable.waker());
        runnable.schedule();
        task
    }

    pub fn try_tick(&self) -> bool { self.state().try_tick() }
    pub async fn tick(&self) { self.state().tick().await; }
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> T { self.state().run(future).await }

    fn schedule(state: Pin<&'a State>) -> impl Fn(Runnable) + Send + Sync + 'a {
        move |runnable| {
            let result = state.queue.push(runnable);
            debug_assert!(result.is_ok()); // Global queue is unbounded.
            state.notify();
        }
    }

    fn state(&self) -> Pin<&'a State> {
        #[cold]
        fn alloc_state(atomic_ptr: &AtomicPtr<State>) -> *mut State {
            let ptr = Arc::into_raw(Arc::new(State::new())).cast_mut();
            if let Err(actual) = atomic_ptr.compare_exchange(
                core::ptr::null_mut(), ptr, Ordering::AcqRel, Ordering::Acquire,
            ) {
                // SAFETY: This pointer was just created by Arc::into_raw.
                drop(unsafe { Arc::from_raw(ptr) });
                actual
            } else { ptr }
        }
        let mut ptr = self.state.load(Ordering::Acquire);
        if ptr.is_null() { ptr = alloc_state(&self.state); }
        // SAFETY: State remains allocated and immovable until executor drop.
        Pin::new(unsafe { &*ptr })
    }
}

impl Drop for Executor<'_> {
    fn drop(&mut self) {
        let ptr = *self.state.get_mut();
        if ptr.is_null() { return; }
        // SAFETY: Non-null state was allocated by Arc::new/into_raw above.
        let state = unsafe { Arc::from_raw(ptr) };
        let mut active = state.pin().active();
        for w in active.drain() { w.wake(); }
        drop(active);
        while state.queue.pop().is_ok() {}
    }
}
impl Default for Executor<'_> { fn default() -> Self { Self::new() } }

pub struct LocalExecutor<'a> {
    inner: Executor<'a>,
    _marker: PhantomData<Rc<()>>,
}
impl UnwindSafe for LocalExecutor<'_> {}
impl RefUnwindSafe for LocalExecutor<'_> {}
impl<'a> LocalExecutor<'a> {
    pub const fn new() -> Self { Self { inner: Executor::new(), _marker: PhantomData } }
    pub fn is_empty(&self) -> bool { self.inner.is_empty() }
    pub fn spawn<T: 'a>(&self, future: impl Future<Output = T> + 'a) -> Task<T> {
        let state = self.inner.state();
        let mut active = state.active();
        // SAFETY: LocalExecutor is !Send + !Sync, so spawn/poll/drop stay local.
        unsafe { Executor::spawn_inner(state, future, &mut active) }
    }
    pub fn spawn_many<T: 'a, F: Future<Output = T> + 'a>(
        &self, futures: impl IntoIterator<Item = F>, handles: &mut impl Extend<Task<F::Output>>,
    ) {
        let state = self.inner.state();
        let mut active = state.active();
        let tasks = futures.into_iter().map(|future| {
            // SAFETY: LocalExecutor is !Send + !Sync, so spawn/poll/drop stay local.
            unsafe { Executor::spawn_inner(state, future, &mut active) }
        });
        handles.extend(tasks);
    }
    pub fn try_tick(&self) -> bool { self.inner.try_tick() }
    pub async fn tick(&self) { self.inner.tick().await; }
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> T { self.inner.run(future).await }
}
impl Default for LocalExecutor<'_> { fn default() -> Self { Self::new() } }

struct State {
    queue: ConcurrentQueue<Runnable>,
    local_queues: RwLock<Vec<Arc<ConcurrentQueue<Runnable>>>>,
    notified: AtomicBool,
    sleepers: Mutex<Sleepers>,
    active: Mutex<Slab<Waker>>,
}
impl State {
    const fn new() -> Self {
        Self {
            queue: ConcurrentQueue::unbounded(),
            local_queues: RwLock::new(Vec::new()),
            notified: AtomicBool::new(true),
            sleepers: Mutex::new(Sleepers { count: 0, wakers: Vec::new(), free_ids: Vec::new() }),
            active: Mutex::new(Slab::new()),
        }
    }
    fn pin(&self) -> Pin<&Self> { Pin::new(self) }
    fn active(self: Pin<&Self>) -> MutexGuard<'_, Slab<Waker>> {
        self.get_ref().active.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn notify(&self) {
        if self.notified.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            let waker = self.sleepers.lock().unwrap_or_else(PoisonError::into_inner).notify();
            if let Some(w) = waker { w.wake(); }
        }
    }
    fn try_tick(&self) -> bool {
        match self.queue.pop() {
            Err(_) => false,
            Ok(runnable) => { self.notify(); runnable.run(); true }
        }
    }
    async fn tick(&self) { Ticker::new(self).runnable().await.run(); }
    async fn run<T>(&self, future: impl Future<Output = T>) -> T {
        let mut runner = Runner::new(self);
        let mut rng = fastrand::Rng::new();
        let run_forever = async {
            loop {
                for _ in 0..200 { runner.runnable(&mut rng).await.run(); }
                future::yield_now().await;
            }
        };
        future.or(run_forever).await
    }
}

struct Sleepers {
    count: usize,
    wakers: Vec<(usize, Waker)>,
    free_ids: Vec<usize>,
}
impl Sleepers {
    fn insert(&mut self, waker: &Waker) -> usize {
        let id = match self.free_ids.pop() { Some(id) => id, None => self.count + 1 };
        self.count += 1;
        self.wakers.push((id, waker.clone()));
        id
    }
    fn update(&mut self, id: usize, waker: &Waker) -> bool {
        for item in &mut self.wakers {
            if item.0 == id { item.1.clone_from(waker); return false; }
        }
        self.wakers.push((id, waker.clone()));
        true
    }
    fn remove(&mut self, id: usize) -> bool {
        self.count -= 1;
        self.free_ids.push(id);
        for i in (0..self.wakers.len()).rev() {
            if self.wakers[i].0 == id { self.wakers.remove(i); return false; }
        }
        true
    }
    fn is_notified(&self) -> bool { self.count == 0 || self.count > self.wakers.len() }
    fn notify(&mut self) -> Option<Waker> {
        if self.wakers.len() == self.count { self.wakers.pop().map(|item| item.1) } else { None }
    }
}

struct Ticker<'a> { state: &'a State, sleeping: usize }
impl<'a> Ticker<'a> {
    fn new(state: &'a State) -> Self { Self { state, sleeping: 0 } }
    fn sleep(&mut self, waker: &Waker) -> bool {
        let mut sleepers = self.state.sleepers.lock().unwrap_or_else(PoisonError::into_inner);
        match self.sleeping {
            0 => self.sleeping = sleepers.insert(waker),
            id => { if !sleepers.update(id, waker) { return false; } }
        }
        self.state.notified.store(sleepers.is_notified(), Ordering::Release);
        true
    }
    fn wake(&mut self) {
        if self.sleeping != 0 {
            let mut sleepers = self.state.sleepers.lock().unwrap_or_else(PoisonError::into_inner);
            sleepers.remove(self.sleeping);
            self.state.notified.store(sleepers.is_notified(), Ordering::Release);
        }
        self.sleeping = 0;
    }
    async fn runnable(&mut self) -> Runnable {
        self.runnable_with(|| self.state.queue.pop().ok()).await
    }
    async fn runnable_with(&mut self, mut search: impl FnMut() -> Option<Runnable>) -> Runnable {
        future::poll_fn(|cx| loop {
            match search() {
                None => { if !self.sleep(cx.waker()) { return Poll::Pending; } }
                Some(r) => { self.wake(); self.state.notify(); return Poll::Ready(r); }
            }
        }).await
    }
}
impl Drop for Ticker<'_> {
    fn drop(&mut self) {
        if self.sleeping != 0 {
            let mut sleepers = self.state.sleepers.lock().unwrap_or_else(PoisonError::into_inner);
            let notified = sleepers.remove(self.sleeping);
            self.state.notified.store(sleepers.is_notified(), Ordering::Release);
            if notified { drop(sleepers); self.state.notify(); }
        }
    }
}

struct Runner<'a> {
    state: &'a State,
    ticker: Ticker<'a>,
    local: Arc<ConcurrentQueue<Runnable>>,
    ticks: usize,
}
impl<'a> Runner<'a> {
    fn new(state: &'a State) -> Self {
        let runner = Self { state, ticker: Ticker::new(state), local: Arc::new(ConcurrentQueue::bounded(512)), ticks: 0 };
        state.local_queues.write().unwrap_or_else(PoisonError::into_inner).push(runner.local.clone());
        runner
    }
    async fn runnable(&mut self, rng: &mut fastrand::Rng) -> Runnable {
        let runnable = self.ticker.runnable_with(|| {
            if let Ok(r) = self.local.pop() { return Some(r); }
            if let Ok(r) = self.state.queue.pop() { steal(&self.state.queue, &self.local); return Some(r); }
            if let Ok(local_queues) = self.state.local_queues.try_read() {
                let n = local_queues.len();
                let start = rng.usize(..n);
                let iter = local_queues.iter().chain(local_queues.iter()).skip(start).take(n);
                for local in iter.filter(|local| !Arc::ptr_eq(local, &self.local)) {
                    steal(local, &self.local);
                    if let Ok(r) = self.local.pop() { return Some(r); }
                }
            }
            None
        }).await;
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks % 64 == 0 { steal(&self.state.queue, &self.local); }
        runnable
    }
}
impl Drop for Runner<'_> {
    fn drop(&mut self) {
        self.state.local_queues.write().unwrap_or_else(PoisonError::into_inner)
            .retain(|local| !Arc::ptr_eq(local, &self.local));
        while let Ok(r) = self.local.pop() { r.schedule(); }
    }
}
fn steal<T>(src: &ConcurrentQueue<T>, dest: &ConcurrentQueue<T>) {
    let mut count = (src.len() + 1) / 2;
    if count > 0 {
        if let Some(cap) = dest.capacity() { count = count.min(cap - dest.len()); }
        for _ in 0..count {
            if let Ok(t) = src.pop() { assert!(dest.push(t).is_ok()); } else { break; }
        }
    }
}
struct CallOnDrop<F: FnMut()>(F);
impl<F: FnMut()> Drop for CallOnDrop<F> { fn drop(&mut self) { (self.0)(); } }
pin_project! {
    struct AsyncCallOnDrop<Fut, Cleanup: FnMut()> {
        #[pin]
        future: Fut,
        cleanup: CallOnDrop<Cleanup>,
    }
}
impl<Fut, Cleanup: FnMut()> AsyncCallOnDrop<Fut, Cleanup> {
    fn new(future: Fut, cleanup: Cleanup) -> Self { Self { future, cleanup: CallOnDrop(cleanup) } }
}
impl<Fut: Future, Cleanup: FnMut()> Future for AsyncCallOnDrop<Fut, Cleanup> {
    type Output = Fut::Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> { self.project().future.poll(cx) }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "../../bevy_platform/src/sync/web_rwlock.rs"]
mod page_rwlock_tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use futures_lite::future::block_on;

    #[test]
    fn unbounded_spawn_nested_work_and_cleanup() {
        let executor = Executor::new();
        let mut tasks = Vec::new();
        executor.spawn_many((0..2048).map(|i| async move { i }), &mut tasks);
        assert_eq!(block_on(executor.run(async {
            let mut sum = 0;
            for task in tasks { sum += task.await; }
            let nested = executor.spawn(async { 7 });
            sum + nested.await
        })), (0..2048).sum::<usize>() + 7);
        assert!(executor.is_empty());
    }

    #[test]
    fn sleeping_ticker_is_woken_and_unregisters() {
        let executor = Executor::new();
        let mut ticker = core::pin::pin!(executor.tick());
        assert!(block_on(future::poll_once(ticker.as_mut())).is_none());
        assert_eq!(executor.state().sleepers.lock().unwrap().count, 1);
        let task = executor.spawn(async { 42 });
        block_on(ticker);
        assert_eq!(block_on(task), 42);
        assert_eq!(executor.state().sleepers.lock().unwrap().count, 0);
    }

    #[test]
    fn cross_thread_spawn_and_completion_under_contention() {
        let executor = Executor::new();
        page_mutex::with_page_context(|| {
            let barrier = std::sync::Barrier::new(4);
            std::thread::scope(|workers| {
                for _ in 0..3 {
                    let executor = &executor;
                    let barrier = &barrier;
                    workers.spawn(move || {
                        barrier.wait();
                        for i in 0..512 {
                            let task = executor.spawn(async move { i });
                            assert_eq!(block_on(executor.run(task)), i);
                        }
                    });
                }
                barrier.wait();
                for i in 0..512 {
                    let task = executor.spawn(async move { i });
                    assert_eq!(block_on(executor.run(task)), i);
                }
            });
        });
        assert!(executor.is_empty());
        assert!(executor.state().local_queues.read().unwrap().is_empty());
    }

    #[test]
    fn page_spawn_contends_on_active_and_sleepers_with_worker_progress() {
        fn contend<T: Send>(lock: &Mutex<T>, operation: impl FnOnce()) {
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let observed = Arc::new(AtomicBool::new(false));
            std::thread::scope(|workers| {
                workers.spawn(move || {
                    let _guard = lock.lock().unwrap();
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                });
                ready_rx.recv().unwrap();
                let mut release = Some(release_tx);
                let observed = observed.clone();
                page_mutex::with_page_contention_hook(move || {
                    observed.store(true, Ordering::SeqCst);
                    if let Some(release) = release.take() { release.send(()).unwrap(); }
                }, operation);
            });
            assert!(observed.load(Ordering::SeqCst));
        }
        let executor = Executor::new();
        let state = executor.state();
        contend(&state.active, || executor.spawn(async { 42 }).detach());
        state.notified.store(false, Ordering::Release);
        contend(&state.sleepers, || executor.spawn(async { 7 }).detach());
        while executor.try_tick() {}
        assert!(executor.is_empty());
    }

    #[test]
    fn cancellation_drop_and_panic_cleanup() {
        let dropped = Arc::new(core::sync::atomic::AtomicUsize::new(0));
        struct CountDrop(Arc<core::sync::atomic::AtomicUsize>);
        impl Drop for CountDrop {
            fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); }
        }
        let executor = Executor::new();
        let guard = CountDrop(dropped.clone());
        let task = executor.spawn(async move {
            let _guard = guard;
            future::pending::<()>().await;
        });
        assert!(executor.try_tick());
        assert_eq!(block_on(executor.run(task.cancel())), None);
        assert!(executor.is_empty());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);

        let task = executor.spawn(async { panic!("task panic must propagate") });
        executor.try_tick();
        assert!(std::panic::catch_unwind(|| block_on(task)).is_err());
        assert!(executor.is_empty());

        let guard = CountDrop(dropped.clone());
        executor.spawn(async move {
            let _guard = guard;
            future::pending::<()>().await;
        }).detach();
        drop(executor);
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn local_non_send_and_borrowed_futures() {
        let value = Rc::new(42);
        let local = LocalExecutor::new();
        let task = local.spawn(async { *value });
        assert_eq!(block_on(local.run(task)), 42);
        assert!(local.is_empty());
    }
}
