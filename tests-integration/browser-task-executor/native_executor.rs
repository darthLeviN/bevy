//! Exercises the real dependency's native production selection, without cfg(test)
//! inside bevy_tasks (and therefore without injected browser mutexes/drivers).
use bevy_tasks::{TaskPoolBuilder, block_on};
use std::{any::type_name_of_val, rc::Rc, sync::atomic::{AtomicUsize, Ordering}};

#[test]
fn native_dependency_selects_vendored_executor_and_supports_local_futures() {
    let pool = TaskPoolBuilder::new().num_threads(2).build();
    pool.with_local_executor(|local| {
        assert_eq!(type_name_of_val(&**local).split('<').next(), Some("bevy_tasks::async_executor::LocalExecutor"));
        let value = Rc::new(42);
        let task = local.spawn(async move { value });
        assert_eq!(*block_on(local.run(task)), 42);
        assert!(local.is_empty());
    });
}

#[test]
fn native_dependency_runs_large_and_nested_scopes_and_cancellation() {
    let pool = TaskPoolBuilder::new().num_threads(2).build();
    let completed = AtomicUsize::new(0);
    let results = pool.scope(|scope| {
        for i in 0..2048 {
            let completed = &completed;
            scope.spawn(async move {
                completed.fetch_add(1, Ordering::Relaxed);
                i
            });
        }
    });
    assert_eq!(completed.load(Ordering::Relaxed), 2048);
    assert_eq!(results.into_iter().sum::<usize>(), (0..2048).sum::<usize>());
    let nested = pool.scope(|scope| {
        for _ in 0..8 {
            let pool = &pool;
            scope.spawn(async move { pool.scope(|inner| { inner.spawn(async { 7 }); })[0] });
        }
    });
    assert_eq!(nested, vec![7; 8]);
    let pending = pool.spawn(core::future::pending::<()>());
    assert_eq!(block_on(pending.cancel()), None);
}

#[test]
fn native_block_on_is_the_platform_driver() {
    fn ready() -> core::future::Ready<usize> { core::future::ready(42) }
    let native: fn(core::future::Ready<usize>) -> usize = bevy_tasks::block_on;
    let platform: fn(core::future::Ready<usize>) -> usize = bevy_platform::future::block_on;
    assert!(std::ptr::fn_addr_eq(native, platform));
    assert_eq!(native(ready()), 42);
}

#[test]
fn native_platform_locks_are_standard_locks_with_poisoning() {
    let mutex: std::sync::Mutex<usize> = bevy_platform::sync::Mutex::new(1);
    let guard: bevy_platform::sync::MutexGuard<'_, usize> = mutex.lock().unwrap();
    drop(guard);
    assert!(std::panic::catch_unwind(|| {
        let mut guard = mutex.lock().unwrap();
        *guard = 2;
        panic!("native mutex poison");
    }).is_err());
    assert!(mutex.is_poisoned());
    assert_eq!(*mutex.lock().unwrap_err().into_inner(), 2);

    let rwlock: std::sync::RwLock<usize> = bevy_platform::sync::RwLock::new(3);
    let guard: bevy_platform::sync::RwLockReadGuard<'_, usize> = rwlock.read().unwrap();
    assert_eq!(*guard, 3);
}
