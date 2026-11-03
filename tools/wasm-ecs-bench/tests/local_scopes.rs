use bevy_tasks::{TaskPoolBuilder, with_local_task_scopes};

#[test]
fn nested_gpu_scopes_stay_on_owner_and_cpu_workers_are_restored() {
    let pool = TaskPoolBuilder::new().num_threads(2).build();
    let owner = std::thread::current().id();
    assert_eq!(pool.scope_thread_num(), 2);
    with_local_task_scopes(|| {
        assert_eq!(pool.thread_num(), 2);
        assert_eq!(pool.scope_thread_num(), 1);
    });
    assert_eq!(pool.scope_thread_num(), 2);
    let local = with_local_task_scopes(|| pool.scope_with_executor(false, None, |scope| {
        for _ in 0..8 {
            let pool = &pool;
            scope.spawn(async move {
                assert_eq!(std::thread::current().id(), owner);
                pool.scope_with_executor(false, None, |inner| {
                    inner.spawn(async move { std::thread::current().id() == owner });
                })[0]
            });
        }
    }));
    assert_eq!(local, vec![true; 8]);
    let workers = pool.scope_with_executor(false, None, |scope| {
        for _ in 0..8 {
            scope.spawn(async move { std::thread::current().id() != owner });
        }
    });
    assert_eq!(workers, vec![true; 8]);
}

#[test]
fn gpu_affine_queries_use_direct_iteration_not_local_task_batches() {
    use bevy_ecs::{prelude::*, batching::BatchingStrategy};
    use bevy_tasks::ComputeTaskPool;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[derive(Component)]
    struct Value(u32);
    ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(2).build());
    let owner = std::thread::current().id();
    let mut world = World::new();
    for _ in 0..64 { world.spawn(Value(0)); }
    let initializers = AtomicUsize::new(0);
    with_local_task_scopes(|| {
        world.query::<&mut Value>().par_iter_mut(&mut world)
            .batching_strategy(BatchingStrategy::fixed(1))
            .for_each_init(|| { initializers.fetch_add(1, Ordering::Relaxed); }, |_, mut value| {
                assert_eq!(std::thread::current().id(), owner);
                value.0 += 1;
            });
    });
    assert_eq!(initializers.load(Ordering::Relaxed), 1, "must not create one task per query batch");
    assert!(world.query::<&Value>().iter(&world).all(|value| value.0 == 1));
}

#[test]
fn caller_can_execute_cpu_tasks_while_all_workers_are_busy() {
    use std::sync::{Arc, Mutex, Condvar, mpsc};
    struct Release(Arc<(Mutex<bool>, Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_all();
        }
    }
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let worker_gate = gate.clone();
    let (started, ready) = mpsc::channel();
    let pool = TaskPoolBuilder::new().num_threads(2).on_thread_spawn(move || {
        started.send(()).unwrap();
        let (lock, wake) = &*worker_gate;
        let mut released = lock.lock().unwrap();
        while !*released { released = wake.wait(released).unwrap(); }
    }).build();
    let release = Release(gate);
    ready.recv().unwrap();
    ready.recv().unwrap();
    let owner = std::thread::current().id();
    let results = pool.scope_with_executor(true, None, |scope| {
        for _ in 0..8 {
            scope.spawn(async move { std::thread::current().id() == owner });
        }
    });
    drop(release);
    assert_eq!(results, vec![true; 8]);
}
