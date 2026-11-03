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
fn automatic_small_queries_avoid_dispatch_but_fixed_and_large_queries_keep_batches() {
    use bevy_ecs::{batching::BatchingStrategy, prelude::*};
    use bevy_tasks::ComputeTaskPool;
    use std::sync::{atomic::{AtomicUsize, Ordering}, Barrier, Mutex};

    #[derive(Component)]
    struct Value(u32);
    #[derive(Component)]
    #[component(storage = "SparseSet")]
    struct Sparse;

    let pool = ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(2).build());
    let owner = std::thread::current().id();
    for count in 0..=pool.scope_thread_num() {
        let mut world = World::new();
        for _ in 0..count { world.spawn((Value(0), Sparse)); }
        let initializers = AtomicUsize::new(0);
        world.query::<&mut Value>().par_iter_mut(&mut world).for_each_init(
            || { initializers.fetch_add(1, Ordering::Relaxed); },
            |_, mut value| {
                assert_eq!(std::thread::current().id(), owner);
                value.0 += 1;
            },
        );
        assert_eq!(initializers.load(Ordering::Relaxed), 1);
        initializers.store(0, Ordering::Relaxed);
        world.query_filtered::<&mut Value, With<Sparse>>().par_iter_mut(&mut world).for_each_init(
            || { initializers.fetch_add(1, Ordering::Relaxed); },
            |_, mut value| {
                assert_eq!(std::thread::current().id(), owner);
                value.0 += 1;
            },
        );
        assert_eq!(initializers.load(Ordering::Relaxed), 1);
        assert!(world.query::<&Value>().iter(&world).all(|value| value.0 == 2));
    }

    let mut world = World::new();
    world.spawn(Value(0));
    world.spawn(Value(0));
    let initializers = AtomicUsize::new(0);
    world.query::<&mut Value>().par_iter_mut(&mut world)
        .batching_strategy(BatchingStrategy::fixed(1))
        .for_each_init(|| { initializers.fetch_add(1, Ordering::Relaxed); }, |_, mut value| value.0 += 1);
    assert_eq!(initializers.load(Ordering::Relaxed), 2, "fixed batches must retain explicit dispatch");

    for _ in 2..16_384 { world.spawn(Value(0)); }
    let barrier = Barrier::new(2);
    let threads = Mutex::new(std::collections::HashSet::new());
    initializers.store(0, Ordering::Relaxed);
    world.query::<&mut Value>().par_iter_mut(&mut world).for_each_init(
        || {
            threads.lock().unwrap().insert(std::thread::current().id());
            if initializers.fetch_add(1, Ordering::Relaxed) < 2 { barrier.wait(); }
        },
        |_, mut value| value.0 += 1,
    );
    assert!(threads.into_inner().unwrap().len() >= 2, "large queries must execute concurrently");
    assert_eq!(world.query::<&Value>().iter(&world).map(|value| value.0 as usize).sum::<usize>(), 16_386);
}

#[test]
fn scope_cleanup_handles_empty_drained_and_unwinding_queues() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Dropped<'a>(&'a AtomicUsize);
    impl Drop for Dropped<'_> {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    let pool = TaskPoolBuilder::new().num_threads(2).build();
    let empty: Vec<()> = pool.scope(|_| {});
    assert!(empty.is_empty());

    let completed = AtomicUsize::new(0);
    let results = pool.scope(|scope| {
        for value in 0..4 {
            let dropped = Dropped(&completed);
            scope.spawn(async move {
                drop(dropped);
                value
            });
        }
    });
    assert_eq!(results.iter().sum::<usize>(), 6);
    assert_eq!(completed.load(Ordering::Relaxed), 4);

    let cancelled = AtomicUsize::new(0);
    let (started, ready) = std::sync::mpsc::channel();
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pool.scope::<_, ()>(|scope| {
            for _ in 0..4 {
                let dropped = Dropped(&cancelled);
                let started = started.clone();
                scope.spawn(async move {
                    started.send(()).unwrap();
                    core::future::pending::<()>().await;
                    drop(dropped);
                });
            }
            for _ in 0..4 {
                ready.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            }
            panic!("exercise cancellation of queued scoped tasks");
        });
    }));
    assert!(unwind.is_err());
    assert_eq!(cancelled.load(Ordering::Relaxed), 4, "unwinding must still cancel and drop every queued future");
    assert_eq!(pool.scope(|scope| { scope.spawn(async { 7 }); }), vec![7]);
}

#[test]
fn empty_deferred_barriers_preserve_conditions_dependencies_and_real_flushes() {
    use bevy_ecs::{prelude::*, schedule::{ApplyDeferred, MultiThreadedExecutor, SingleThreadedExecutor, ScheduleBuildSettings}};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use bevy_tasks::ComputeTaskPool;

    #[derive(Resource, Default)]
    struct Events(Vec<&'static str>);

    fn queue_first(mut commands: Commands) {
        commands.queue(|world: &mut World| world.resource_mut::<Events>().0.push("first applied"));
    }
    fn queue_second(mut commands: Commands) {
        commands.queue(|world: &mut World| world.resource_mut::<Events>().0.push("second applied"));
    }
    #[derive(Resource, Default)]
    struct ConditionCalls(AtomicUsize);
    fn skip_barrier(calls: Res<ConditionCalls>) -> bool {
        calls.0.fetch_add(1, Ordering::Relaxed);
        false
    }

    ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(2).build());
    for threaded in [false, true] {
        let mut world = World::new();
        world.init_resource::<Events>();
        world.init_resource::<ConditionCalls>();
        let mut empty = Schedule::default();
        if threaded { empty.set_executor(MultiThreadedExecutor::new()); }
        else { empty.set_executor(SingleThreadedExecutor::new()); }
        empty.add_systems(ApplyDeferred);
        for _ in 0..3 { empty.run(&mut world); }

        let mut schedule = Schedule::default();
        if threaded { schedule.set_executor(MultiThreadedExecutor::new()); }
        else { schedule.set_executor(SingleThreadedExecutor::new()); }
        schedule.set_apply_final_deferred(false);
        schedule.set_build_settings(ScheduleBuildSettings {
            auto_insert_apply_deferred: false,
            ..Default::default()
        });
        schedule.add_systems((
            ApplyDeferred,
            queue_first,
            ApplyDeferred,
            |mut events: ResMut<Events>| {
                assert_eq!(events.0.last(), Some(&"first applied"));
                events.0.push("first observed");
            },
            queue_second,
            ApplyDeferred.run_if(skip_barrier),
            |mut events: ResMut<Events>| {
                assert!(!events.0.contains(&"second applied"));
                events.0.push("second still deferred");
            },
            ApplyDeferred,
            |mut events: ResMut<Events>| {
                assert_eq!(events.0.last(), Some(&"second applied"));
                events.0.push("second observed");
            },
        ).chain());
        for run in 1..=2 {
            world.resource_mut::<Events>().0.clear();
            schedule.run(&mut world);
            assert_eq!(world.resource::<Events>().0, vec![
                "first applied", "first observed",
                "second still deferred", "second applied", "second observed",
            ]);
            assert_eq!(world.resource::<ConditionCalls>().0.load(Ordering::Relaxed), run);
        }
    }
}

#[test]
fn deferred_metadata_keeps_commands_custom_buffers_and_exclusive_systems_correct() {
    use bevy_ecs::{
        prelude::*,
        schedule::{ApplyDeferred, MultiThreadedExecutor, ScheduleBuildSettings},
        system::{Deferred, System, SystemBuffer, SystemMeta},
        world::DeferredWorld,
    };
    use bevy_tasks::ComputeTaskPool;

    #[derive(Resource, Default)]
    struct Total(u32);
    #[derive(Default)]
    struct Buffer { pending: u32 }
    impl SystemBuffer for Buffer {
        fn apply(&mut self, _: &SystemMeta, world: &mut World) {
            world.resource_mut::<Total>().0 += core::mem::take(&mut self.pending);
        }
        fn queue(&mut self, _: &SystemMeta, mut world: DeferredWorld) {
            let pending = core::mem::take(&mut self.pending);
            world.commands().queue(move |world: &mut World| world.resource_mut::<Total>().0 += pending);
        }
    }
    fn normal(mut total: ResMut<Total>) { total.0 += 1; }
    fn exclusive(world: &mut World) {
        world.commands().queue(|world: &mut World| world.resource_mut::<Total>().0 += 2);
    }
    fn buffered(mut buffer: Deferred<Buffer>) { buffer.pending += 3; }
    fn commands(mut commands: Commands) {
        commands.queue(|world: &mut World| world.resource_mut::<Total>().0 += 4);
    }
    fn exclusive_buffered(_: &mut World, mut buffer: Deferred<Buffer>) { buffer.pending += 5; }

    ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(2).build());
    for final_flush in [false, true] {
        let mut world = World::new();
        world.init_resource::<Total>();
        let mut normal_system = IntoSystem::into_system(normal);
        normal_system.initialize(&mut world);
        assert!(!normal_system.has_deferred());
        let mut exclusive_system = IntoSystem::into_system(exclusive);
        exclusive_system.initialize(&mut world);
        assert!(!exclusive_system.has_deferred());
        let mut buffered_system = IntoSystem::into_system(buffered);
        buffered_system.initialize(&mut world);
        assert!(buffered_system.has_deferred());
        let mut exclusive_buffered_system = IntoSystem::into_system(exclusive_buffered);
        assert!(exclusive_buffered_system.initialize(&mut world).is_exclusive());
        assert!(exclusive_buffered_system.has_deferred());
        assert!(!ApplyDeferred.has_deferred());

        let mut schedule = Schedule::default();
        schedule.set_executor(MultiThreadedExecutor::new());
        schedule.set_apply_final_deferred(final_flush);
        schedule.set_build_settings(ScheduleBuildSettings {
            auto_insert_apply_deferred: false,
            ..Default::default()
        });
        schedule.add_systems((
            ApplyDeferred,
            normal_system,
            ApplyDeferred,
            exclusive_system,
            ApplyDeferred,
            ApplyDeferred,
            buffered_system,
            ApplyDeferred,
            ApplyDeferred,
            exclusive_buffered_system,
            ApplyDeferred,
            commands,
        ).chain());
        for run in 1..=2 {
            schedule.run(&mut world);
            assert_eq!(world.resource::<Total>().0, run * 15 - if final_flush { 0 } else { 4 });
        }
    }
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
