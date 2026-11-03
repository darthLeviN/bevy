#[path = "../../../crates/bevy_tasks/src/polling_scope.rs"]
mod polling_scope;

use std::{
    future::Future,
    pin::pin,
    sync::{Arc, atomic::{AtomicUsize, Ordering}},
    task::{Context, Poll, Wake, Waker},
};
use bevy_tasks::{ThreadExecutor, futures_lite::FutureExt};

#[derive(Default)]
struct Wakes(AtomicUsize);
impl Wake for Wakes {
    fn wake(self: Arc<Self>) { self.0.fetch_add(1, Ordering::Relaxed); }
    fn wake_by_ref(self: &Arc<Self>) { self.0.fetch_add(1, Ordering::Relaxed); }
}

#[test]
fn empty_polling_executor_does_not_register_a_redundant_sleeper() {
    let executor = ThreadExecutor::new();
    let ticker = executor.ticker().unwrap();
    let wakes = Arc::new(Wakes::default());
    let waker = Waker::from(wakes.clone());
    let mut cx = Context::from_waker(&waker);
    let mut driver = pin!(polling_scope::execute(core::future::pending::<()>(), || {
        ticker.try_tick();
    }));
    assert!(driver.as_mut().poll(&mut cx).is_pending());
    let task = executor.spawn(async { 7 });
    assert_eq!(wakes.0.load(Ordering::Relaxed), 0, "enqueue must not notify the busy-polling caller");
    assert!(driver.as_mut().poll(&mut cx).is_pending());
    assert_eq!(bevy_tasks::block_on(task), 7);

    // Positive control: the previous waiting API registers a sleeper and wakes
    // the caller when a runnable is enqueued, even though the caller cannot park.
    let mut waiting = pin!(ticker.tick());
    assert!(waiting.as_mut().poll(&mut cx).is_pending());
    let task = executor.spawn(async { 8 });
    assert!(wakes.0.load(Ordering::Relaxed) > 0);
    assert!(waiting.as_mut().poll(&mut cx).is_ready());
    assert_eq!(bevy_tasks::block_on(task), 8);
}

#[test]
fn polling_drives_each_executor_and_repolls_pending_tasks_on_the_owner() {
    let executors = [ThreadExecutor::new(), ThreadExecutor::new(), ThreadExecutor::new()];
    let tickers = executors.each_ref().map(|executor| executor.ticker().unwrap());
    let owner = std::thread::current().id();
    let mut tasks = Vec::new();
    for (index, executor) in executors.iter().enumerate() {
        tasks.push(executor.spawn(async move {
            bevy_tasks::futures_lite::future::yield_now().await;
            assert_eq!(std::thread::current().id(), owner);
            index
        }));
    }
    let results = async move {
        let mut values = Vec::new();
        for task in tasks {
            values.push(polling_scope::wait_for_task(task, |task| task.is_finished()).await);
        }
        values
    };
    let mut ticks = 0;
    let mut driver = pin!(polling_scope::execute(results, || {
        ticks += 1;
        for ticker in &tickers { ticker.try_tick(); }
    }));
    let mut cx = Context::from_waker(Waker::noop());
    for _ in 0..16 {
        if let Poll::Ready(values) = driver.as_mut().poll(&mut cx) {
            assert_eq!(values, vec![0, 1, 2]);
            return;
        }
    }
    panic!("polling scope failed to finish within deterministic poll budget");
}

#[test]
fn ready_results_do_not_tick_and_task_panics_reach_results() {
    let mut driver = pin!(polling_scope::execute(async { 42 }, || panic!("unnecessary tick")));
    let mut cx = Context::from_waker(Waker::noop());
    assert_eq!(driver.as_mut().poll(&mut cx), Poll::Ready(42));

    let executor = ThreadExecutor::new();
    let ticker = executor.ticker().unwrap();
    let task = executor.spawn(std::panic::AssertUnwindSafe(async {
        panic!("scoped task panic");
    }).catch_unwind());
    let result = polling_scope::wait_for_task(task, |task| task.is_finished());
    let mut driver = pin!(polling_scope::execute(result, || { ticker.try_tick(); }));
    for _ in 0..4 {
        if let Poll::Ready(result) = driver.as_mut().poll(&mut cx) {
            assert!(result.is_err());
            return;
        }
    }
    panic!("task panic was not returned to the scope collector");
}

#[test]
fn unfinished_results_are_not_polled_or_registered_for_wakeup() {
    struct ResultFuture {
        polls: Arc<AtomicUsize>,
        finished: Arc<AtomicUsize>,
    }
    impl Future for ResultFuture {
        type Output = usize;
        fn poll(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<usize> {
            self.polls.fetch_add(1, Ordering::Relaxed);
            cx.waker().wake_by_ref();
            Poll::Ready(42)
        }
    }
    let polls = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicUsize::new(0));
    let future = ResultFuture { polls: polls.clone(), finished: finished.clone() };
    let mut result = pin!(polling_scope::wait_for_task(future, |task| {
        task.finished.load(Ordering::Acquire) != 0
    }));
    let wakes = Arc::new(Wakes::default());
    let waker = Waker::from(wakes.clone());
    let mut cx = Context::from_waker(&waker);
    for _ in 0..1000 {
        assert!(result.as_mut().poll(&mut cx).is_pending());
    }
    assert_eq!(polls.load(Ordering::Relaxed), 0);
    assert_eq!(wakes.0.load(Ordering::Relaxed), 0);
    finished.store(1, Ordering::Release);
    assert_eq!(result.as_mut().poll(&mut cx), Poll::Ready(42));
    assert_eq!(polls.load(Ordering::Relaxed), 1);
}

#[test]
fn completed_results_do_not_notify_the_polling_collector() {
    let executor = ThreadExecutor::new();
    let ticker = executor.ticker().unwrap();
    let task = executor.spawn(async { 7 }).fallible();
    let mut result = pin!(polling_scope::wait_for_task(task, |task| task.is_finished()));
    let wakes = Arc::new(Wakes::default());
    let waker = Waker::from(wakes.clone());
    let mut cx = Context::from_waker(&waker);
    assert!(result.as_mut().poll(&mut cx).is_pending());
    assert!(ticker.try_tick());
    assert_eq!(wakes.0.load(Ordering::Relaxed), 0);
    assert_eq!(result.as_mut().poll(&mut cx), Poll::Ready(Some(7)));
}

#[test]
fn dropped_runnable_returns_none_instead_of_spinning_forever() {
    let executor = ThreadExecutor::new();
    let task = executor.spawn(core::future::pending::<()>()).fallible();
    let mut result = pin!(polling_scope::wait_for_task(task, |task| task.is_finished()));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(result.as_mut().poll(&mut cx).is_pending());
    drop(executor);
    assert_eq!(result.as_mut().poll(&mut cx), Poll::Ready(None));
}
