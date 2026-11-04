//! Standard mutex poisoning/guard semantics without parking a browser page.
//!
//! Like web_rwlock, this only permits contention released by independently
//! progressing workers. Never hold these locks across page-local async work.

use core::fmt;
use std::sync::{LockResult, TryLockError, TryLockResult};
pub use std::sync::MutexGuard;

#[cfg(target_arch = "wasm32")]
fn is_page_thread() -> bool {
    std::thread_local! {
        static PAGE: bool = js_sys::Reflect::has(
            &js_sys::global(), &wasm_bindgen::JsValue::from_str("window"),
        ).expect("detect browser lock context");
    }
    PAGE.with(|page| *page)
}

fn acquire<T>(may_block: bool, mut attempt: impl FnMut() -> TryLockResult<T>, block: impl FnOnce() -> LockResult<T>) -> LockResult<T> {
    if may_block { return block(); }
    loop {
        match attempt() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(error)) => return Err(error),
            Err(TryLockError::WouldBlock) => {
                #[cfg(all(test, not(target_arch = "wasm32")))]
                CONTENTION.with(|hook| {
                    if let Some(hook) = hook.borrow_mut().as_mut() { hook(); }
                });
                core::hint::spin_loop();
            }
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
std::thread_local! { static PAGE: core::cell::Cell<bool> = const { core::cell::Cell::new(false) }; }
#[cfg(all(test, not(target_arch = "wasm32")))]
fn is_page_thread() -> bool { PAGE.with(core::cell::Cell::get) }

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn with_page_context<T>(run: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) { PAGE.with(|page| page.set(self.0)); }
    }
    let _restore = Restore(PAGE.with(|page| page.replace(true)));
    run()
}

// Test-only release seam: the worker is released only after the real lock
// reports WouldBlock, so executor regression tests cannot pass uncontended.
#[cfg(all(test, not(target_arch = "wasm32")))]
std::thread_local! {
    static CONTENTION: core::cell::RefCell<Option<std::boxed::Box<dyn FnMut()>>> = const { core::cell::RefCell::new(None) };
}
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn with_page_contention_hook<T>(hook: impl FnMut() + 'static, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<std::boxed::Box<dyn FnMut()>>);
    impl Drop for Restore {
        fn drop(&mut self) { CONTENTION.with(|hook| *hook.borrow_mut() = self.0.take()); }
    }
    let _restore = Restore(CONTENTION.with(|slot| slot.replace(Some(std::boxed::Box::new(hook)))));
    with_page_context(run)
}

/// A standard mutex whose browser-page acquisition never parks.
pub struct Mutex<T: ?Sized> { inner: std::sync::Mutex<T> }
impl<T> Mutex<T> {
    pub const fn new(value: T) -> Self { Self { inner: std::sync::Mutex::new(value) } }
    pub fn into_inner(self) -> LockResult<T> { self.inner.into_inner() }
}
impl<T: ?Sized> Mutex<T> {
    pub fn lock(&self) -> LockResult<MutexGuard<'_, T>> {
        acquire(!is_page_thread(), || self.inner.try_lock(), || self.inner.lock())
    }
    pub fn try_lock(&self) -> TryLockResult<MutexGuard<'_, T>> { self.inner.try_lock() }
    pub fn is_poisoned(&self) -> bool { self.inner.is_poisoned() }
    pub fn clear_poison(&self) { self.inner.clear_poison(); }
    pub fn get_mut(&mut self) -> LockResult<&mut T> { self.inner.get_mut() }
}
impl<T: Default> Default for Mutex<T> { fn default() -> Self { Self::new(T::default()) } }
impl<T> From<T> for Mutex<T> { fn from(value: T) -> Self { Self::new(value) } }
impl<T: ?Sized + fmt::Debug> fmt::Debug for Mutex<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { self.inner.fmt(formatter) }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use core::cell::Cell;

    #[test]
    fn page_retries_without_entering_parking_path() {
        let attempts = Cell::new(0);
        assert_eq!(acquire(false, || {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 4 { Err(TryLockError::WouldBlock) } else { Ok(42) }
        }, || panic!("page must not park")).unwrap(), 42);
        assert_eq!(attempts.get(), 4);
    }

    #[test]
    fn worker_keeps_standard_blocking_path() {
        assert_eq!(acquire(true, || panic!("worker must not spin"), || Ok(7)).unwrap(), 7);
    }

    #[test]
    fn contention_preserves_exclusion_and_worker_progress() {
        let lock = Mutex::new(0);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|workers| {
            let lock_ref = &lock;
            workers.spawn(move || {
                let mut guard = lock_ref.lock().unwrap();
                *guard = 9;
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            ready_rx.recv().unwrap();
            let mut release = Some(release_tx);
            let mut guard = acquire(false, || {
                let result = lock.inner.try_lock();
                if matches!(result, Err(TryLockError::WouldBlock)) {
                    if let Some(release) = release.take() { release.send(()).unwrap(); }
                }
                result
            }, || panic!("page must never enter std Mutex::lock")).unwrap();
            assert!(release.is_none(), "test must observe contention");
            assert_eq!(*guard, 9);
            *guard += 1;
        });
        PAGE.with(|page| page.set(true));
        assert_eq!(*lock.lock().unwrap(), 10);
        PAGE.with(|page| page.set(false));
        assert_eq!(lock.into_inner().unwrap(), 10);
    }

    #[test]
    fn page_preserves_poison_recovery() {
        let mut lock = Mutex::new(1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            *lock.lock().unwrap() = 2;
            let _guard = lock.lock().unwrap();
            panic!("poison test");
        })).is_err());
        assert!(lock.is_poisoned());
        PAGE.with(|page| page.set(true));
        assert_eq!(*lock.lock().unwrap_err().into_inner(), 2);
        match lock.try_lock() {
            Err(TryLockError::Poisoned(error)) => assert_eq!(*error.into_inner(), 2),
            _ => panic!("try_lock must preserve poison"),
        }
        PAGE.with(|page| page.set(false));
        lock.clear_poison();
        *lock.get_mut().unwrap() = 3;
        assert_eq!(lock.into_inner().unwrap(), 3);
    }
}
