import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../../crates/bevy_pbr/src/render/mesh.rs', import.meta.url), 'utf8');
const planner = source.slice(source.indexOf('fn mesh_collection_plan('), source.indexOf('/// Creates the [`RenderMeshInstanceGpu`]s', source.indexOf('fn mesh_collection_plan(')));
const flatten = source.slice(source.indexOf('        staging.changed.clear();'), source.indexOf('        let process = |items:'));
const dispatch = source.slice(source.indexOf('        let pool = ComputeTaskPool::get();', source.indexOf('        let process = |items:')), source.indexOf('        drop(prepared_tx);', source.indexOf('        let process = |items:')));

test('production flattening, planner and dispatch reserve caller work and submit exactly one balanced share per worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-scheduling-'));
  try {
    const path = join(directory, 'scheduling.rs');
    writeFileSync(path, `
use std::sync::{Mutex, mpsc};
type MainEntity = usize;
type RenderMeshInstanceGpuBuilder = usize;
type MeshCullingData = usize;
#[derive(Default)] struct Staging { changed: Vec<Option<(usize, usize, Option<usize>)>> }
enum RenderMeshInstanceGpuQueue {
 None,
 CpuCulling { changed: Vec<(usize, usize)>, removed: Vec<usize> },
 GpuCulling { changed_cpu_culling: Vec<(usize, usize, usize)>, changed_gpu_culling: Vec<(usize, usize, usize)>, removed: Vec<usize> },
}
${planner}
// Stub the executor only: execute the actual production dispatch against owned slices.
// Deferring worker execution proves the caller runs after all submissions, before join.
std::thread_local! { static WORKERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
struct ComputeTaskPool;
struct Scope<'a> { tasks: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>> }
impl<'a> Scope<'a> { fn spawn(&mut self, task: impl std::future::Future<Output = ()> + 'a) { self.tasks.push(Box::pin(task)); SUBMITTED.with(|n|n.set(n.get()+1)); } }
impl ComputeTaskPool {
 fn get() -> Self { Self }
 fn scope_worker_num(&self) -> usize { WORKERS.with(|w|w.get()) }
 fn scope<'a>(&self, run: impl FnOnce(&mut Scope<'a>)) {
  let mut scope = Scope { tasks: vec![] }; run(&mut scope);
  assert_eq!(scope.tasks.len(), mesh_collection_plan(COUNT.with(|n|n.get()), WORKERS.with(|w|w.get())).1.count());
  let waker = std::task::Waker::noop(); let mut cx = std::task::Context::from_waker(waker);
  for mut task in scope.tasks { assert!(task.as_mut().poll(&mut cx).is_ready()); }
 }
}
std::thread_local! { static SUBMITTED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
std::thread_local! { static COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[test] fn thresholds_and_balancing() {
 for count in (0..20000).chain([100000,1000000,usize::MAX-1,usize::MAX]) { for workers in [0,1,4,8] {
  let (caller, shares) = mesh_collection_plan(count, workers); let shares: Vec<_> = shares.collect();
  assert_eq!(caller + shares.iter().sum::<usize>(), count);
  let expected_tasks = (0..=workers).filter(|k| *k == 0 || (*k as u128)*256+282 <= count as u128).max().unwrap();
  assert_eq!(shares.len(), expected_tasks); assert!(shares.iter().all(|n|*n>=256));
  if let (Some(min),Some(max)) = (shares.iter().min(), shares.iter().max()) {
   assert!(max-min<=1); assert!(caller>=256);
   assert!(caller as u128 >= (*max as u128 * 11).div_ceil(10));
   // One more worker item must violate the weighted main minimum: this
   // bounds all integer slack, including the balanced-remainder boundary.
   let next_total = count-caller+1;
   let next_max = (next_total as u128).div_ceil(shares.len() as u128);
   assert!(((caller-1) as u128) < (next_max*11).div_ceil(10));
   assert!(caller as u128 <= (*max as u128 * 11).div_ceil(10)+2);
  } else { assert_eq!(caller,count); }
 } }
 let (main, shares) = mesh_collection_plan(10000,4);
 assert_eq!(main,2158); assert_eq!(shares.collect::<Vec<_>>(),vec![1961,1961,1960,1960]);
 for count in [0,1,255,256,511,512,537] { assert_eq!(mesh_collection_plan(count,8).1.count(),0); }
 assert_eq!(mesh_collection_plan(538,8).0,282);
 assert_eq!(mesh_collection_plan(538,8).1.collect::<Vec<_>>(),vec![256]);
 let (_, shares) = mesh_collection_plan(usize::MAX,usize::MAX);
 assert_eq!(shares.size_hint(),((usize::MAX-282)/256,Some((usize::MAX-282)/256)));
}
#[test] fn actual_flatten_and_dispatch_reuse_capacity_and_assign_once() {
 let mut staging = Staging::default();
 for count in [100000,10000,1000,538,537,512,511,257,256,255,128,1,0] { for workers in [0,1,4,8] {
  WORKERS.with(|w|w.set(workers)); COUNT.with(|n|n.set(count)); SUBMITTED.with(|n|n.set(0));
  let mut render_mesh_instance_queues = vec![RenderMeshInstanceGpuQueue::None,
   RenderMeshInstanceGpuQueue::CpuCulling { changed:(0..count/4).map(|i|(i,i+100)).collect(), removed:vec![10001] },
   RenderMeshInstanceGpuQueue::GpuCulling { changed_cpu_culling:(count/4..count/2).map(|i|(i,i+100,i+200)).collect(), changed_gpu_culling:(count/2..count).map(|i|(i,i+100,i+200)).collect(), removed:vec![10002] }];
  let (removed_tx,removed_rx) = mpsc::channel();
  ${flatten}
  let capacity = staging.changed.capacity();
  let calls = Mutex::new(Vec::new()); let seen = Mutex::new(vec![false;count]);
  let process = |items: &mut [Option<(MainEntity, RenderMeshInstanceGpuBuilder, Option<MeshCullingData>)>]| {
   if calls.lock().unwrap().is_empty() && count >= 538 && workers > 0 {
    // The scope callback has submitted every task; deferred tasks cannot run
    // until this main call returns. The scope verifies the submission count.
    assert_eq!(SUBMITTED.with(|n|n.get()),mesh_collection_plan(count,workers).1.count());
    assert_eq!(items.len(),mesh_collection_plan(count,workers).0);
   }
   calls.lock().unwrap().push(items.len());
   for item in items { let (entity,builder,culling)=item.take().unwrap();
    assert_eq!(builder,entity+100); assert_eq!(culling,if entity<count/4 {None} else {Some(entity+200)});
    let mut seen=seen.lock().unwrap(); assert!(!seen[entity]); seen[entity]=true;
   }
  };
  ${dispatch}
  let (caller,shares)=mesh_collection_plan(count,workers);
  assert_eq!(*calls.lock().unwrap(),std::iter::once(caller).chain(shares).collect::<Vec<_>>());
  assert!(seen.lock().unwrap().iter().all(|v|*v)); assert!(staging.changed.iter().all(Option::is_none));
  assert_eq!(staging.changed.capacity(),capacity);
  assert_eq!(removed_rx.try_iter().collect::<Vec<_>>(),vec![10001,10002]);
  match &render_mesh_instance_queues[1] { RenderMeshInstanceGpuQueue::CpuCulling {changed,removed} => {assert!(changed.is_empty());assert!(removed.is_empty());}, _=>panic!() }
  match &render_mesh_instance_queues[2] { RenderMeshInstanceGpuQueue::GpuCulling {changed_cpu_culling,changed_gpu_culling,removed} => {assert!(changed_cpu_culling.is_empty());assert!(changed_gpu_culling.is_empty());assert!(removed.is_empty());}, _=>panic!() }
 } }
}
`);
    const binary = join(directory, 'scheduling-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    if (result.exitCode !== 0) throw Error(result.stdout.toString() + result.stderr.toString());
    expect(result.stdout.toString()).toContain('2 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
