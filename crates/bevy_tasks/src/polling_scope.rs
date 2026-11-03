use core::{future::Future, pin::pin, task::Poll};

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
