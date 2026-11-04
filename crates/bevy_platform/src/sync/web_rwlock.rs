//! Standard-library RwLock semantics without parking a browser Window thread.
//!
//! Workers may park normally. The page can only retry synchronous acquisition;
//! contention must be released by independently progressing work, not by an
//! event-loop callback on the blocked page. This does not make holding a guard
//! across browser I/O or waiting for a page-local future safe.

use core::fmt;
use std::sync::{LockResult, TryLockError, TryLockResult};
pub use std::sync::{RwLockReadGuard, RwLockWriteGuard};

fn acquire<T>(may_block: bool, mut attempt: impl FnMut() -> TryLockResult<T>, block: impl FnOnce() -> LockResult<T>) -> LockResult<T> {
    if may_block { return block(); }
    loop {
        match attempt() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(error)) => return Err(error),
            Err(TryLockError::WouldBlock) => core::hint::spin_loop(),
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn is_page_thread() -> bool {
    std::thread_local! {
        static PAGE: bool = js_sys::Reflect::has(
            &js_sys::global(), &wasm_bindgen::JsValue::from_str("window"),
        ).expect("detect browser lock context");
    }
    PAGE.with(|page| *page)
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

/// A poisoned, standard-library reader/writer lock whose page-thread acquisition
/// never calls a parking primitive. Guard types and worker behavior are unchanged.
pub struct RwLock<T: ?Sized> {
    inner: std::sync::RwLock<T>,
}

impl<T> RwLock<T> {
    pub const fn new(value: T) -> Self { Self { inner: std::sync::RwLock::new(value) } }
    pub fn into_inner(self) -> LockResult<T> { self.inner.into_inner() }
}

impl<T: ?Sized> RwLock<T> {
    pub fn read(&self) -> LockResult<RwLockReadGuard<'_, T>> {
        acquire(!is_page_thread(), || self.inner.try_read(), || self.inner.read())
    }
    pub fn write(&self) -> LockResult<RwLockWriteGuard<'_, T>> {
        acquire(!is_page_thread(), || self.inner.try_write(), || self.inner.write())
    }
    pub fn try_read(&self) -> TryLockResult<RwLockReadGuard<'_, T>> { self.inner.try_read() }
    pub fn try_write(&self) -> TryLockResult<RwLockWriteGuard<'_, T>> { self.inner.try_write() }
    pub fn is_poisoned(&self) -> bool { self.inner.is_poisoned() }
    pub fn clear_poison(&self) { self.inner.clear_poison(); }
    pub fn get_mut(&mut self) -> LockResult<&mut T> { self.inner.get_mut() }
}

impl<T: Default> Default for RwLock<T> {
    fn default() -> Self { Self::new(T::default()) }
}
impl<T> From<T> for RwLock<T> {
    fn from(value: T) -> Self { Self::new(value) }
}
impl<T: ?Sized + fmt::Debug> fmt::Debug for RwLock<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { self.inner.fmt(formatter) }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use core::cell::Cell;

    #[test]
    fn page_retries_without_calling_parking_path() {
        let attempts = Cell::new(0);
        let value = acquire(false, || {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 4 { Err(TryLockError::WouldBlock) } else { Ok(42) }
        }, || panic!("page must not park"));
        assert_eq!(value.unwrap(), 42);
        assert_eq!(attempts.get(), 4);
    }

    #[test]
    fn worker_keeps_blocking_acquisition() {
        assert_eq!(acquire(true, || panic!("not the page retry path"), || Ok(7)).unwrap(), 7);
    }

    #[test]
    fn page_contention_preserves_exclusion_and_worker_progress() {
        std::thread::scope(|scope| {
            let lock = RwLock::new(0);
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let lock_ref = &lock;
            // Join this nested scope before the lock's storage leaves its scope.
            std::thread::scope(|workers| {
                workers.spawn(move || {
                    let _guard = lock_ref.read().unwrap();
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                });
                ready_rx.recv().unwrap();
                let mut release = Some(release_tx);
                let mut guard = acquire(false, || {
                    let result = lock.inner.try_write();
                    if matches!(result, Err(TryLockError::WouldBlock)) {
                        if let Some(release) = release.take() { release.send(()).unwrap(); }
                    }
                    result
                }, || panic!("page must never enter std RwLock::write" )).unwrap();
                *guard = 9;
            });
            PAGE.with(|page| page.set(true));
            assert_eq!(*lock.read().unwrap(), 9);
            *lock.write().unwrap() += 1;
            PAGE.with(|page| page.set(false));
            assert_eq!(lock.into_inner().unwrap(), 10);
            let _ = scope;
        });
    }

    #[test]
    fn poison_and_exclusive_access_semantics_are_preserved() {
        let mut lock = RwLock::new(1);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut guard = lock.write().unwrap();
            *guard = 2;
            panic!("poison test");
        }));
        assert!(result.is_err());
        PAGE.with(|page| page.set(true));
        assert_eq!(*lock.read().unwrap_err().into_inner(), 2);
        assert_eq!(*lock.write().unwrap_err().into_inner(), 2);
        PAGE.with(|page| page.set(false));
        lock.clear_poison();
        *lock.get_mut().unwrap() = 3;
        assert_eq!(lock.into_inner().unwrap(), 3);
    }
}
