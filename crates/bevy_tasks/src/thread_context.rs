use std::cell::OnceCell;

struct ThreadContext(OnceCell<bool>);

impl ThreadContext {
    const fn new() -> Self { Self(OnceCell::new()) }

    fn is_worker(&self, detect: impl FnOnce() -> bool) -> bool {
        *self.0.get_or_init(detect)
    }
}

/// Whether the current Wasm instance runs in a Web Worker.
///
/// The JavaScript context cannot change during a thread's lifetime, so its
/// detection is cached in thread-local storage instead of evaluated per scope.
#[cfg(all(target_arch = "wasm32", feature = "wasm_threads"))]
pub fn is_web_worker_thread() -> bool {
    std::thread_local! {
        static CONTEXT: ThreadContext = const { ThreadContext::new() };
    }
    CONTEXT.with(|context| context.is_worker(wasm_thread::is_web_worker_thread))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn context_detection_runs_once_including_for_main_thread_false() {
        for expected in [false, true] {
            let context = ThreadContext::new();
            let calls = Cell::new(0);
            for _ in 0..100 {
                assert_eq!(context.is_worker(|| { calls.set(calls.get() + 1); expected }), expected);
            }
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn worker_context_does_not_change_the_page_context() {
        let page = ThreadContext::new();
        assert!(!page.is_worker(|| false));
        assert!(std::thread::spawn(|| ThreadContext::new().is_worker(|| true)).join().unwrap());
        assert!(!page.is_worker(|| panic!("must retain cached page context")));
    }
}
