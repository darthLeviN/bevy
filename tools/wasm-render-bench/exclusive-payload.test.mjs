import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual exclusive phase and collector: parallel bytes/history, claims, overflow, reuse, unwind and borrow exclusion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-exclusive-'));
  try {
    const module = new URL('../../crates/bevy_render/src/render_resource/exclusive_payload.rs', import.meta.url).pathname;
    const dirtyModule = new URL('../../crates/bevy_render/src/render_resource/sparse_buffer_dirty.rs', import.meta.url).pathname;
    const mesh = readFileSync(new URL('../../crates/bevy_pbr/src/render/mesh.rs', import.meta.url), 'utf8');
    const helper = mesh.slice(mesh.indexOf('fn flush_exclusive_mesh_input_batch('), mesh.indexOf('/// Creates the [`RenderMeshInstanceGpu`]s', mesh.indexOf('fn flush_exclusive_mesh_input_batch(')));
    const fixture = `
extern crate alloc;
extern crate self as bevy_render;
use std::sync::atomic::{AtomicU64,AtomicU32,Ordering};
pub trait AtomicPod: Copy { type Blob; }
#[path=${JSON.stringify(module)}] mod exclusive_payload;
#[path=${JSON.stringify(dirtyModule)}] mod dirty;
pub mod render_resource {
 pub use crate::exclusive_payload::*;
 pub fn mark_exclusive_payload_batch(indices:impl IntoIterator<Item=u32>,summary:&[std::sync::atomic::AtomicU64],bits:&[std::sync::atomic::AtomicU64]) { crate::dirty::note_changed_batch(indices,summary,bits); }
}
use render_resource::ExclusivePayload;
#[repr(C,align(16))] #[derive(Clone,Copy,Default,Debug,PartialEq)] pub struct MeshInputUniform { world_from_local:[u64;12], previous_input_index:u32, padding:[u32;3] }
#[repr(C,align(16))] #[derive(Clone,Copy,Default,Debug,PartialEq)] pub struct PreviousMeshInputUniform { world_from_local:[u64;12] }
impl AtomicPod for MeshInputUniform { type Blob=[AtomicU64;14]; }
impl AtomicPod for PreviousMeshInputUniform { type Blob=[AtomicU64;12]; }
${helper}
fn blobs<const N:usize>(n:usize)->Vec<[AtomicU64;N]> { (0..n).map(|_|std::array::from_fn(|_|AtomicU64::new(0))).collect() }
#[test] fn concurrent_collector_bytes_history_and_reuse() {
 let mut current=blobs::<14>(1024); let mut history=blobs::<12>(1024);
 let bits:Vec<_>=(0..16).map(|_|AtomicU64::new(0)).collect(); let summary=[AtomicU64::new(0)]; let cursor=AtomicU32::new(0);
 for frame in 1..4u64 {
  cursor.store(0,Ordering::Relaxed);
  { let c=ExclusivePayload::<MeshInputUniform>::new(&mut current); let h=ExclusivePayload::<PreviousMeshInputUniform>::new(&mut history);
   std::thread::scope(|s| { for worker in 0..4 { let c=&c;let h=&h;let bits=&bits;let summary=&summary;let cursor=&cursor;s.spawn(move|| {
    let mut batch=Vec::with_capacity(128);
    for i in (worker..1024).step_by(4) {
     batch.push((i,MeshInputUniform { world_from_local:[frame*10000+i as u64;12],..Default::default() }));
     if batch.len()==128 { flush_exclusive_mesh_input_batch(&mut batch,c,h,cursor,bits,summary); }
    }
    flush_exclusive_mesh_input_batch(&mut batch,c,h,cursor,bits,summary);
   }); } });
  }
  assert_eq!(cursor.load(Ordering::Relaxed),1024);
  let mut seen=vec![false;1024];
  for (i,blob) in current.iter().enumerate() {
   let words:Vec<_>=blob.iter().map(|v|v.load(Ordering::Relaxed)).collect();
   assert_eq!(&words[..12],&[frame*10000+i as u64;12]);
   let p=words[12] as u32 as usize;assert!(!seen[p]);seen[p]=true;
   let expected=if frame==1 {0} else {(frame-1)*10000+i as u64};
   assert!(history[p].iter().all(|v|v.load(Ordering::Relaxed)==expected));
   assert_eq!(words[12]>>32,0);assert_eq!(words[13],0);
  }
  assert!(bits.iter().all(|v|v.load(Ordering::Relaxed)==u64::MAX));
 }
}
#[test] fn duplicate_across_tasks_rejected_before_access() {
 let mut storage=blobs::<14>(1);let p=ExclusivePayload::<MeshInputUniform>::new(&mut storage);
 std::thread::scope(|s| { let record=p.claim(0);s.spawn(|| { assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||p.claim(0))).is_err()); }).join().unwrap();assert_eq!(record.read(),MeshInputUniform::default()); });
}
#[test] fn capacity_wrap_and_unwind_cleanup() {
 let mut storage=blobs::<12>(2);let cursor=AtomicU32::new(0);
 {let p=ExclusivePayload::<PreviousMeshInputUniform>::new(&mut storage);
  assert_eq!(p.append(&cursor,&[PreviousMeshInputUniform::default();2]),0);
  for initial in [2,u32::MAX] {cursor.store(initial,Ordering::Relaxed);assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||p.append(&cursor,&[PreviousMeshInputUniform::default()]))).is_err());assert_eq!(cursor.load(Ordering::Relaxed),initial);}
 }
 assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {let p=ExclusivePayload::<PreviousMeshInputUniform>::new(&mut storage);let mut r=p.claim(0);r.write(PreviousMeshInputUniform {world_from_local:[42;12]});panic!("worker panic");})).is_err());
 let p=ExclusivePayload::<PreviousMeshInputUniform>::new(&mut storage);assert_eq!(p.claim(0).read().world_from_local,[42;12]);
}
`;
    const path = join(directory, 'phase.rs');
    writeFileSync(path, fixture);
    const binary = join(directory, 'phase-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const run = Bun.spawnSync([binary], { timeout: 20000 });
    if (run.exitCode !== 0) throw Error(run.stdout.toString() + run.stderr.toString());
    expect(run.stdout.toString()).toContain('7 passed');
    writeFileSync(path, fixture + '\nfn forbidden() { let mut data=blobs::<14>(1); let p=ExclusivePayload::<MeshInputUniform>::new(&mut data); data.clear(); let _=p.claim(0); }');
    const rejected = Bun.spawnSync(['rustc', '--edition=2024', '--crate-type=lib', path, '-o', join(directory, 'rejected.rlib')], { timeout: 20000 });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain('E0499');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
