use std::cell::Cell;

std::thread_local! {
    static WORKERS_ENABLED: Cell<bool> = const { Cell::new(true) };
}

pub(crate) fn workers_enabled() -> bool {
    WORKERS_ENABLED.with(Cell::get)
}

/// Runs scoped tasks on the calling thread, including nested parallel queries.
///
/// Unlike a single-threaded ECS executor alone, this also constrains task scopes
/// started by systems. Use this around browser-thread-affine GPU work. Normal
/// worker dispatch is restored when the callback returns or unwinds.
pub fn with_local_task_scopes<T>(run: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            WORKERS_ENABLED.with(|enabled| enabled.set(self.0));
        }
    }
    let _restore = Restore(WORKERS_ENABLED.with(|enabled| enabled.replace(false)));
    run()
}

/// Explicitly dispatches a batch containing only CPU-owned, `Send` data.
///
/// Snapshot thread-affine resources before entering this boundary. This does not
/// make GPU wrappers safe to access, clone, or drop on another thread.
pub fn with_cpu_task_scopes<T>(run: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            WORKERS_ENABLED.with(|enabled| enabled.set(self.0));
        }
    }
    let _restore = Restore(WORKERS_ENABLED.with(|enabled| enabled.replace(true)));
    run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_cpu_batch_restores_owner_affinity_even_on_unwind() {
        with_local_task_scopes(|| {
            with_cpu_task_scopes(|| assert!(workers_enabled()));
            assert!(!workers_enabled());
            let result = std::panic::catch_unwind(|| with_cpu_task_scopes(|| panic!("CPU batch")));
            assert!(result.is_err());
            assert!(!workers_enabled());
        });
        assert!(workers_enabled());
    }

    #[test]
    fn nested_boundaries_restore_previous_policy() {
        assert!(workers_enabled());
        with_local_task_scopes(|| {
            assert!(!workers_enabled());
            with_local_task_scopes(|| assert!(!workers_enabled()));
            assert!(!workers_enabled());
        });
        assert!(workers_enabled());
    }

    #[test]
    fn unwind_restores_policy() {
        let result = std::panic::catch_unwind(|| with_local_task_scopes(|| panic!("test panic")));
        assert!(result.is_err());
        assert!(workers_enabled());
    }

    #[test]
    fn policy_is_thread_local() {
        with_local_task_scopes(|| {
            assert!(std::thread::spawn(workers_enabled).join().unwrap());
            assert!(!workers_enabled());
        });
    }
}
