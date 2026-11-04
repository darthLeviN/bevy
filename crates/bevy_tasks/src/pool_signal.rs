//! Closure-only task-pool startup/shutdown signals.
//!
//! async-channel's event-listener list takes a std mutex during registration,
//! notification and removal. Pool lifecycle signals can cross the browser page,
//! so use platform locks here as well as in the executor and its worker waker.
//! Closing or dropping the final sender wakes all receivers, outside the lock.

use alloc::sync::Arc;
use core::{future::Future, pin::Pin, task::{Context, Poll, Waker}};
use bevy_platform::sync::PoisonError;
#[cfg(not(test))]
use bevy_platform::sync::Mutex;
#[cfg(all(test, not(target_arch = "wasm32")))]
use crate::async_executor::page_mutex::Mutex;
#[cfg(all(test, target_arch = "wasm32"))]
use bevy_platform::sync::Mutex;
use slab::Slab;

struct State {
    senders: usize,
    closed: bool,
    waiters: Slab<Waker>,
}

#[derive(Clone)]
pub(crate) struct Receiver(Arc<Mutex<State>>);
pub(crate) struct Sender(Arc<Mutex<State>>);
#[derive(Debug)]
pub(crate) struct Closed;

pub(crate) fn channel() -> (Sender, Receiver) {
    let state = Arc::new(Mutex::new(State { senders: 1, closed: false, waiters: Slab::new() }));
    (Sender(state.clone()), Receiver(state))
}

impl Clone for Sender {
    fn clone(&self) -> Self {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).senders += 1;
        Self(self.0.clone())
    }
}

fn close(state: &mut State) -> Slab<Waker> {
    state.closed = true;
    core::mem::take(&mut state.waiters)
}
fn wake(waiters: Slab<Waker>) {
    for waker in waiters { waker.1.wake(); }
}
impl Sender {
    pub(crate) fn close(&self) {
        let waiters = close(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner));
        wake(waiters);
    }
}
impl Drop for Sender {
    fn drop(&mut self) {
        let waiters = {
            let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            state.senders -= 1;
            if state.senders == 0 { close(&mut state) } else { Slab::new() }
        };
        wake(waiters);
    }
}
impl core::fmt::Debug for Sender {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { f.write_str("PoolSignalSender") }
}
impl core::fmt::Debug for Receiver {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { f.write_str("PoolSignalReceiver") }
}
impl Receiver {
    pub(crate) fn is_closed(&self) -> bool {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).closed
    }
    pub(crate) fn recv(&self) -> Recv<'_> { Recv { receiver: self, slot: None } }
}
pub(crate) struct Recv<'a> { receiver: &'a Receiver, slot: Option<usize> }
impl Future for Recv<'_> {
    type Output = Result<(), Closed>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let mut state = this.receiver.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closed { this.slot = None; return Poll::Ready(Err(Closed)); }
        if let Some(slot) = this.slot {
            if !state.waiters[slot].will_wake(cx.waker()) {
                state.waiters[slot] = cx.waker().clone();
            }
        } else {
            this.slot = Some(state.waiters.insert(cx.waker().clone()));
        }
        Poll::Pending
    }
}
impl Drop for Recv<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot {
            let waker = self.receiver.0.lock().unwrap_or_else(PoisonError::into_inner).waiters.try_remove(slot);
            drop(waker);
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::async_executor::page_mutex;
    use core::sync::atomic::{AtomicUsize, Ordering};
    use std::{sync::mpsc, task::Wake, thread, time::Duration};

    struct Count(AtomicUsize);
    impl Wake for Count {
        fn wake(self: Arc<Self>) { self.0.fetch_add(1, Ordering::Relaxed); }
    }
    #[test]
    fn last_sender_closes_all_waiters_and_cancel_unregisters() {
        let (sender, receiver) = channel();
        let other_sender = sender.clone();
        let count = Arc::new(Count(AtomicUsize::new(0)));
        let waker = Waker::from(count.clone());
        let mut cx = Context::from_waker(&waker);
        let mut first = core::pin::pin!(receiver.recv());
        let second_receiver = receiver.clone();
        let mut second = core::pin::pin!(second_receiver.recv());
        assert!(first.as_mut().poll(&mut cx).is_pending());
        assert!(second.as_mut().poll(&mut cx).is_pending());
        {
            let mut cancelled = core::pin::pin!(receiver.recv());
            assert!(cancelled.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!(receiver.0.lock().unwrap().waiters.len(), 2);
        drop(sender);
        assert!(!receiver.is_closed());
        drop(other_sender);
        assert_eq!(count.0.load(Ordering::Relaxed), 2);
        assert!(first.as_mut().poll(&mut cx).is_ready());
        assert!(second.as_mut().poll(&mut cx).is_ready());
        assert!(receiver.is_closed());
        assert!(crate::worker_block_on::block_on(receiver.recv()).is_err());
    }

    #[test]
    fn page_close_contends_and_wakes_outside_signal_lock() {
        let (sender, receiver) = channel();
        // Reentrant inspection in wake would deadlock if close held the lock.
        struct Inspect(Receiver);
        impl Wake for Inspect {
            fn wake(self: Arc<Self>) { assert!(self.0.is_closed()); }
        }
        let waker = Waker::from(Arc::new(Inspect(receiver.clone())));
        let mut waiter = core::pin::pin!(receiver.recv());
        assert!(waiter.as_mut().poll(&mut Context::from_waker(&waker)).is_pending());
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        thread::scope(|workers| {
            let receiver = &receiver;
            workers.spawn(move || {
                let _guard = receiver.0.lock().unwrap();
                held_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut release = Some(release_tx);
            page_mutex::with_page_contention_hook(move || {
                if let Some(release) = release.take() { release.send(()).unwrap(); }
            }, || sender.close());
        });
        assert!(receiver.is_closed());
    }
}
