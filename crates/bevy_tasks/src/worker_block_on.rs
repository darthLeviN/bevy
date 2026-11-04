//! Sleeping worker driver whose waker is safe to call from a browser page.
//!
//! futures-lite's block_on installs a parking::Unparker waker. Its unpark can
//! acquire a std mutex on the *waking* thread, including the browser page. The
//! executor's own platform locks cannot protect that downstream callback.
//!
//! Only workers may drive this function. The page keeps its polling driver.
//! Every invocation has its own notification token, including recursive scopes.

use alloc::sync::Arc;
use core::{future::Future, pin::pin, task::{Context, Poll, Waker}};
use std::{sync::Condvar, task::Wake};
use bevy_platform::sync::PoisonError;
#[cfg(not(test))]
use bevy_platform::sync::Mutex;
#[cfg(all(test, not(target_arch = "wasm32")))]
use crate::async_executor::page_mutex::Mutex;
#[cfg(all(test, target_arch = "wasm32"))]
use bevy_platform::sync::Mutex;

struct Parker {
    notified: Mutex<bool>,
    ready: Condvar,
}

impl Parker {
    fn new() -> Self {
        Self { notified: Mutex::new(false), ready: Condvar::new() }
    }

    fn park(&self) {
        let mut notified = self.notified.lock().unwrap_or_else(PoisonError::into_inner);
        while !*notified {
            // Worker only. The platform mutex exposes the std guard, preserving
            // Condvar's atomic unlock-and-wait and blocking reacquisition.
            notified = self.ready.wait(notified).unwrap_or_else(PoisonError::into_inner);
        }
        *notified = false;
    }

    fn notify(&self) {
        // May run on the page. Synchronizing the token with park's mutex avoids
        // losing wakes between polling, checking the token and starting to wait.
        // Never run user code or poll futures while holding this guard.
        *self.notified.lock().unwrap_or_else(PoisonError::into_inner) = true;
        // On atomic Wasm std uses the futex Condvar: notify is atomic increment
        // plus memory.atomic.notify, not a wait or another mutex acquisition.
        self.ready.notify_one();
    }
}

impl Wake for Parker {
    fn wake(self: Arc<Self>) { self.notify(); }
    fn wake_by_ref(self: &Arc<Self>) { self.notify(); }
}

pub(crate) fn block_on<T>(future: impl Future<Output = T>) -> T {
    drive(future, Arc::new(Parker::new()))
}

fn drive<T>(future: impl Future<Output = T>, parker: Arc<Parker>) -> T {
    let mut future = pin!(future);
    let waker = Waker::from(parker.clone());
    let mut context = Context::from_waker(&waker);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => parker.park(),
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::async_executor::page_mutex;
    use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::{sync::mpsc, thread, time::Duration};

    const DEADLINE: Duration = Duration::from_secs(5);

    #[test]
    fn actual_worker_waker_contends_on_page_without_parking() {
        // Capture the waker produced by the actual worker driver, not a fake
        // notification callback. Hold its mutex from another thread until the
        // real page acquisition observes WouldBlock.
        for by_ref in [false, true] {
            let parker = Arc::new(Parker::new());
            let complete = AtomicBool::new(false);
            let (waker_tx, waker_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let (held_tx, held_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let contended = Arc::new(AtomicBool::new(false));
            thread::scope(|workers| {
                let parker_ref = &parker;
                let complete = &complete;
                workers.spawn(move || {
                    let mut sent = false;
                    let value = drive(core::future::poll_fn(|cx| {
                        if complete.load(Ordering::Acquire) { return Poll::Ready(42); }
                        if !sent {
                            waker_tx.send(cx.waker().clone()).unwrap();
                            sent = true;
                        }
                        Poll::Pending
                    }), parker_ref.clone());
                    done_tx.send(value).unwrap();
                });
                let waker = waker_rx.recv_timeout(DEADLINE).unwrap();
                workers.spawn(move || {
                    let _guard = parker_ref.notified.lock().unwrap();
                    held_tx.send(()).unwrap();
                    release_rx.recv_timeout(DEADLINE).unwrap();
                });
                held_rx.recv_timeout(DEADLINE).unwrap();
                complete.store(true, Ordering::Release);
                let observed = contended.clone();
                let mut release = Some(release_tx);
                page_mutex::with_page_contention_hook(move || {
                    observed.store(true, Ordering::Relaxed);
                    if let Some(release) = release.take() { release.send(()).unwrap(); }
                }, || {
                    if by_ref { waker.wake_by_ref(); } else { waker.wake(); }
                });
                assert_eq!(done_rx.recv_timeout(DEADLINE).unwrap(), 42);
            });
            assert!(contended.load(Ordering::Relaxed));
        }
    }

    #[test]
    fn wake_during_poll_and_recursive_drivers_do_not_lose_tokens() {
        let mut polls = 0;
        assert_eq!(block_on(core::future::poll_fn(|cx| {
            polls += 1;
            if polls == 1 {
                cx.waker().wake_by_ref();
                cx.waker().clone().wake(); // Coalesced token before park.
                assert_eq!(block_on(async { 7 }), 7);
                Poll::Pending
            } else { Poll::Ready(42) }
        })), 42);
        assert_eq!(polls, 2);
    }

    #[test]
    fn pending_worker_sleeps_and_page_wake_makes_progress() {
        let parker = Arc::new(Parker::new());
        let polls = AtomicUsize::new(0);
        let complete = AtomicBool::new(false);
        let (waker_tx, waker_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        thread::scope(|workers| {
            let parker_ref = &parker;
            let polls_ref = &polls;
            let complete_ref = &complete;
            workers.spawn(move || {
                let result = drive(core::future::poll_fn(|cx| {
                    polls_ref.fetch_add(1, Ordering::Relaxed);
                    if complete_ref.load(Ordering::Acquire) { return Poll::Ready(9); }
                    waker_tx.send(cx.waker().clone()).unwrap();
                    Poll::Pending
                }), parker_ref.clone());
                done_tx.send(result).unwrap();
            });
            let waker = waker_rx.recv_timeout(DEADLINE).unwrap();
            // No elapsed-time assertion: acquiring the same mutex synchronizes
            // with the worker's wait transition, or precedes it (token retained).
            let guard = parker.notified.lock().unwrap();
            assert!(!*guard);
            assert_eq!(polls.load(Ordering::Relaxed), 1);
            complete.store(true, Ordering::Release);
            drop(guard);
            page_mutex::with_page_context(|| waker.wake());
            assert_eq!(done_rx.recv_timeout(DEADLINE).unwrap(), 9);
        });
        assert_eq!(polls.load(Ordering::Relaxed), 2);
        // Escaped wakers can safely outlive a completed driver.
        Waker::from(parker).wake();
    }

    #[test]
    fn executor_notification_and_shutdown_use_worker_driver_waker() {
        let executor = crate::executor::Executor::new();
        let (shutdown_tx, shutdown_rx) = crate::pool_signal::channel();
        let (registered_tx, registered_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let ran = Arc::new(AtomicBool::new(false));
        let (ran_tx, ran_rx) = mpsc::channel();
        thread::scope(|workers| {
            let executor = &executor;
            workers.spawn(move || {
                let mut registered = Some(registered_tx);
                let mut run = pin!(executor.run(shutdown_rx.recv()));
                let result = block_on(core::future::poll_fn(|cx| {
                    let result = run.as_mut().poll(cx);
                    // Executor sleepers and shutdown listeners have received
                    // the actual worker waker before the simulated page acts.
                    if let Some(registered) = registered.take() { registered.send(()).unwrap(); }
                    result
                }));
                assert!(result.is_err());
                done_tx.send(()).unwrap();
            });
            registered_rx.recv_timeout(DEADLINE).unwrap();
            page_mutex::with_page_context(|| {
                let ran = ran.clone();
                executor.spawn(async move {
                    ran.store(true, Ordering::Release);
                    ran_tx.send(()).unwrap();
                }).detach();
            });
            ran_rx.recv_timeout(DEADLINE).unwrap();
            page_mutex::with_page_context(|| { shutdown_tx.close(); });
            done_rx.recv_timeout(DEADLINE).unwrap();
        });
        assert!(ran.load(Ordering::Acquire));
    }
}
