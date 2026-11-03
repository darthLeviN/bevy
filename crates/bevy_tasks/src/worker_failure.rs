extern crate alloc;
use alloc::string::String;
use core::sync::atomic::{AtomicU8, Ordering};

/// A lock-free failure mailbox: reporting must not depend on a blocked page's JS queue.
pub(crate) struct WorkerFailure {
    state: AtomicU8,
    message: [AtomicU8; 2048],
}

impl WorkerFailure {
    pub(crate) const fn new() -> Self {
        Self { state: AtomicU8::new(0), message: [const { AtomicU8::new(0) }; 2048] }
    }

    pub(crate) fn report(&self, message: &str) {
        if self.state.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
        }
        for (target, byte) in self.message.iter().take(2047).zip(message.bytes()) {
            target.store(byte, Ordering::Relaxed);
        }
        self.state.store(2, Ordering::Release);
    }

    pub(crate) fn message(&self) -> Option<String> {
        if self.state.load(Ordering::Acquire) != 2 { return None; }
        let bytes: alloc::vec::Vec<_> = self.message.iter()
            .map(|byte| byte.load(Ordering::Relaxed)).take_while(|byte| *byte != 0).collect();
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_is_visible_without_an_event_loop_or_lock() {
        let failure = std::sync::Arc::new(WorkerFailure::new());
        assert!(failure.message().is_none());
        let worker = failure.clone();
        std::thread::spawn(move || worker.report("GPU handle accessed on the wrong thread")).join().unwrap();
        assert_eq!(failure.message().as_deref(), Some("GPU handle accessed on the wrong thread"));
        failure.report("later error");
        assert_eq!(failure.message().as_deref(), Some("GPU handle accessed on the wrong thread"));
    }

    #[test]
    fn long_errors_are_bounded() {
        let failure = WorkerFailure::new();
        failure.report(&"x".repeat(8192));
        assert_eq!(failure.message().unwrap().len(), 2047);
    }
}
