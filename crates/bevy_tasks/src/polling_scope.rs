use core::{future::Future, pin::{pin, Pin}, task::Poll};

/// Waits without installing a task awaiter on a caller that cannot sleep.
/// Like `execute`, this must only be driven by continuous browser polling.
/// Checking completion first avoids contending on the task's awaiter state on
/// every spin, and avoids a worker notifying the no-op browser waker.
pub(crate) async fn wait_for_task<F: Future + Unpin>(
    mut task: F,
    is_finished: impl Fn(&F) -> bool,
) -> F::Output {
    core::future::poll_fn(|cx| {
        if is_finished(&task) {
            Pin::new(&mut task).poll(cx)
        } else {
            Poll::Pending
        }
    }).await
}

/// Drives a scope whose caller already polls continuously, without registering
/// executor sleepers that would notify a thread which cannot park.
///
/// This future deliberately does not wake its caller after ticking. Only use it
/// with the browser's polling `block_on`, never a parking/async executor.
pub(crate) async fn execute<T>(results: impl Future<Output = T>, mut tick: impl FnMut()) -> T {
    let mut results = pin!(results);
    core::future::poll_fn(|cx| {
        if let Poll::Ready(result) = results.as_mut().poll(cx) {
            return Poll::Ready(result);
        }
        tick();
        Poll::Pending
    }).await
}
