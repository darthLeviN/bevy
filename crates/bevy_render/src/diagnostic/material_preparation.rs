//! Named material-operation boundaries for CPU sampling profilers.
//!
//! These wrappers execute their closure synchronously on the current thread.
//! They do not read a clock, collect samples, allocate, dispatch work, or make
//! GPU resources worker-safe. A CPU profiler supplies execution-time samples.
//! Nested operations must be attributed exclusively, not added to their parents.

/// Stable operation names for profiling material preparation.
///
/// These are operations, not a promised linear sequence: reuse skips binding
/// construction, CPU preparation can run on workers, and uploads occur later.
/// Wasm boundaries are deliberately not inlined so browser CPU profilers can
/// distinguish them. Their instrumentation cost is not assumed to be zero.
pub struct MaterialPreparation;

macro_rules! operations {
    ($($name:ident => $description:literal),* $(,)?) => {
        impl MaterialPreparation {
            $(
                #[doc = $description]
                #[cfg_attr(target_arch = "wasm32", inline(never))]
                pub fn $name<T>(operation: impl FnOnce() -> T) -> T {
                    operation()
                }
            )*
        }
    };
}

operations! {
    copy_layout => "Clone an owned CPU layout descriptor.",
    resolve_layout => "Look up or create a GPU layout, including its returned handle clone.",
    build_bindings => "Build temporary resource bindings and uniform data.",
    lookup_binding => "Look up an existing material binding allocation.",
    validate_update => "Validate and update retained material data on the owner.",
    validate_cpu => "Validate CPU-only binding identities, layouts and sizes.",
    new_allocation => "Allocate bindings for a material without an existing allocation.",
    replace_allocation => "Free incompatible bindings and allocate their replacement.",
    clear_builder => "Clear temporary binding data and release its owned references.",
    drop_layout => "Release a temporary GPU-layout handle.",
    properties => "Build or reuse CPU material properties and specialization keys.",
    return_material => "Construct the prepared material result, excluding map insertion.",
    retained_uniform_write => "Copy retained uniform bytes into upload-page staging memory.",
    page_upload => "Enqueue dirty uniform-page uploads, excluding GPU completion.",
}

impl MaterialPreparation {
    /// Remove an old prepared entry and destroy the returned value before returning.
    /// Includes removal, reference releases, and any last-owner destruction.
    #[cfg_attr(target_arch = "wasm32", inline(never))]
    pub fn drop_previous<T>(remove: impl FnOnce() -> T) {
        drop(remove());
    }
}

#[cfg(test)]
mod tests {
    use super::MaterialPreparation;
    use core::cell::Cell;

    #[test]
    fn preserves_result_error_and_single_execution() {
        let calls = Cell::new(0);
        let result: Result<u32, &str> = MaterialPreparation::validate_cpu(|| {
            calls.set(calls.get() + 1);
            Err("not compatible")
        });
        assert_eq!(result, Err("not compatible"));
        assert_eq!(calls.get(), 1);
        assert_eq!(MaterialPreparation::return_material(|| 42), 42);
    }

    #[test]
    fn removal_destroys_returned_value_before_returning() {
        struct Value<'a>(&'a Cell<u32>);
        impl Drop for Value<'_> {
            fn drop(&mut self) { self.0.set(self.0.get() + 1); }
        }
        let count = Cell::new(0);
        MaterialPreparation::drop_previous(|| Some(Value(&count)));
        assert_eq!(count.get(), 1);
    }

    #[test]
    fn executes_on_calling_thread_and_propagates_panics() {
        let caller = std::thread::current().id();
        assert_eq!(MaterialPreparation::build_bindings(|| std::thread::current().id()), caller);
        let result = std::panic::catch_unwind(|| MaterialPreparation::properties(|| panic!("test")));
        assert!(result.is_err());
    }
}
