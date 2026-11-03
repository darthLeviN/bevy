#![cfg(target_arch = "wasm32")]

use bevy_ecs::{prelude::*, schedule::{MultiThreadedExecutor, SingleThreadedExecutor, Schedule}, batching::BatchingStrategy, system::NonSendMut};
use bevy_tasks::ComputeTaskPool;
use std::{cell::Cell, rc::Rc, collections::HashSet, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}, thread::ThreadId};
use wasm_bindgen::prelude::*;

const ENTITIES: usize = 16_384;
const WARMUP_MS: f64 = 5_000.0;
const SAMPLE_MS: f64 = 5_000.0;

#[derive(Component)]
struct Lane<const N: usize> { seed: u32, value: u32 }

#[derive(Resource, Clone)]
struct Mode {
    parallel_query: bool,
    verify: bool,
    threads: Arc<Mutex<HashSet<ThreadId>>>,
    running: Arc<AtomicUsize>,
    overlap: Arc<AtomicUsize>,
}

fn kernel(mut value: u32) -> u32 {
    for _ in 0..128 {
        value = value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        value ^= value.rotate_left(13);
    }
    value
}

fn update<const N: usize>(mut query: Query<&mut Lane<N>>, mode: Res<Mode>) {
    if mode.verify {
        mode.threads.lock().unwrap().insert(std::thread::current().id());
        let active = mode.running.fetch_add(1, Ordering::SeqCst) + 1;
        mode.overlap.fetch_max(active, Ordering::SeqCst);
    }
    if mode.parallel_query {
        query.par_iter_mut().batching_strategy(BatchingStrategy::fixed(256)).for_each_init(
            || {
                if mode.verify {
                    mode.threads.lock().unwrap().insert(std::thread::current().id());
                }
            },
            |_, mut lane| lane.value = lane.value.wrapping_add(kernel(lane.seed)),
        );
    } else {
        for mut lane in &mut query {
            lane.value = lane.value.wrapping_add(kernel(lane.seed));
        }
    }
    if mode.verify { mode.running.fetch_sub(1, Ordering::SeqCst); }
}

struct PageOwner {
    thread: ThreadId,
    checks: Rc<Cell<u32>>,
}

fn check_page_owner(owner: NonSendMut<PageOwner>) {
    assert_eq!(owner.thread, std::thread::current().id());
    assert!(web_sys::window().unwrap().document().is_some());
    owner.checks.set(owner.checks.get() + 1);
}

fn clock() -> f64 {
    web_sys::window().expect("benchmark schedules must run on the page main thread")
        .performance().unwrap().now()
}

async fn yield_browser() {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        web_sys::window().unwrap().set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 0).unwrap();
    });
    wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();
}

fn seed<const N: usize>(index: usize) -> Lane<N> {
    Lane { seed: (index as u32).wrapping_add(N as u32 * 17), value: 0 }
}

fn validate<const N: usize>(world: &mut World, ticks: u32) -> u64 {
    let mut checksum = 0u64;
    for lane in world.query::<&Lane<N>>().iter(world) {
        let expected = kernel(lane.seed).wrapping_mul(ticks);
        assert_eq!(lane.value, expected, "lost or duplicated ECS update in lane {N}");
        checksum = checksum.wrapping_add(u64::from(lane.value));
    }
    checksum
}

async fn measure(name: &str, parallel_systems: bool, parallel_query: bool) -> serde_json::Value {
    let mut world = World::new();
    for index in 0..ENTITIES {
        world.spawn((seed::<0>(index), seed::<1>(index), seed::<2>(index), seed::<3>(index)));
    }
    let mode = Mode {
        parallel_query, verify: true, threads: Arc::default(), running: Arc::default(), overlap: Arc::default(),
    };
    world.insert_resource(mode.clone());
    let owner_checks = Rc::new(Cell::new(0));
    world.insert_non_send(PageOwner { thread: std::thread::current().id(), checks: owner_checks.clone() });
    let mut schedule = Schedule::default();
    if parallel_systems { schedule.set_executor(MultiThreadedExecutor::new()); }
    else { schedule.set_executor(SingleThreadedExecutor::new()); }
    schedule.add_systems((update::<0>, update::<1>, update::<2>, update::<3>, check_page_owner));
    schedule.run(&mut world);
    let participating_threads = mode.threads.lock().unwrap().len();
    let overlap = mode.overlap.load(Ordering::SeqCst);
    if name == "parallel-systems" {
        assert!(participating_threads >= 2, "schedule did not use multiple worker threads");
        assert!(overlap >= 2, "independent ECS systems never overlapped");
    }
    if parallel_query { assert!(participating_threads >= 2, "par_iter stayed single-threaded"); }
    world.resource_mut::<Mode>().verify = false;
    let mut ticks = 1u32;
    let warmup_start = clock();
    while clock() - warmup_start < WARMUP_MS {
        schedule.run(&mut world);
        ticks += 1;
        if ticks % 32 == 0 { yield_browser().await; }
    }
    let warmup_ms = clock() - warmup_start;
    let start = clock();
    let mut samples = Vec::new();
    while clock() - start < SAMPLE_MS {
        let before = clock();
        schedule.run(&mut world);
        samples.push(clock() - before);
        ticks += 1;
        if ticks % 32 == 0 { yield_browser().await; }
    }
    let elapsed = clock() - start;
    let checksum = validate::<0>(&mut world, ticks)
        .wrapping_add(validate::<1>(&mut world, ticks))
        .wrapping_add(validate::<2>(&mut world, ticks))
        .wrapping_add(validate::<3>(&mut world, ticks));
    assert_eq!(owner_checks.get(), ticks, "non-Send page system missed an update");
    let cpu_mean = samples.iter().sum::<f64>() / samples.len() as f64;
    samples.sort_by(f64::total_cmp);
    serde_json::json!({
        "name": name, "entities": ENTITIES, "systems": 4, "ticks": ticks,
        "warmup_ms": warmup_ms, "sample_ms": elapsed, "samples": samples.len(),
        "updates_per_second": samples.len() as f64 * 1000.0 / elapsed,
        "mean_ms": cpu_mean,
        "page_owner_checks": owner_checks.get(),
        "p50_ms": samples[samples.len() / 2], "p95_ms": samples[samples.len() * 95 / 100],
        "participating_threads_preflight": participating_threads, "overlapping_systems_preflight": overlap,
        "all_entity_values_verified": true, "checksum": checksum,
    })
}

#[wasm_bindgen]
pub fn report_worker_failure(message: String) {
    bevy_tasks::report_web_worker_failure(&message);
}

#[wasm_bindgen]
pub async fn start(shim_url: String, worker_url: String, workers: usize) {
    console_error_panic_hook::set_once();
    assert!((2..=8).contains(&workers));
    wasm_thread::Builder::new().wasm_bindgen_shim_url(shim_url).worker_script_url(worker_url).set_default();
    assert!(web_sys::window().is_some(), "start must be called from a regular page");
    bevy_tasks::init_web_thread_pools(workers).await;
    // Readiness remains safe to await again, including concurrent callers.
    bevy_tasks::futures_lite::future::zip(ComputeTaskPool::get().ready(), ComputeTaskPool::get().ready()).await;
    let local_completed = Rc::new(Cell::new(false));
    let local = local_completed.clone();
    ComputeTaskPool::get().spawn_local(async move {
        yield_browser().await;
        assert!(web_sys::window().is_some());
        local.set(true);
    }).await;
    assert!(local_completed.get());
    // The world and all schedule calls now live on the browser main thread.
    let results = [
        measure("serial", false, false).await,
        measure("parallel-systems", true, false).await,
        measure("parallel-query", false, true).await,
    ];
    let report = serde_json::json!({ "workers": workers, "visuals": false,
        "main_thread": true, "local_task_verified": local_completed.get(),
        "atomics": cfg!(target_feature = "atomics"), "results": results });
    publish(&report.to_string());
}

#[wasm_bindgen(inline_js = "export function publish(json) { const channel = new BroadcastChannel('bevy-ecs-benchmark'); channel.postMessage(JSON.parse(json)); channel.close(); }")]
extern "C" { fn publish(json: &str); }
