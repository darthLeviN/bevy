import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const mesh = read('../../crates/bevy_pbr/src/render/mesh.rs');
const sparse = read('../../crates/bevy_render/src/render_resource/sparse_buffer_vec.rs');
const gpu = read('../../crates/bevy_render/src/batching/gpu_preprocessing.rs');
const dirtyPath = new URL('../../crates/bevy_render/src/render_resource/sparse_buffer_dirty.rs', import.meta.url).pathname;
// Compile actual production helpers/method bodies, with only storage/GPU dependencies stubbed.
function method(source, name) {
  const start = source.indexOf('    pub fn ' + name + '(');
  if (start < 0) throw Error('Missing production method: ' + name);
  const body = source.indexOf('{', start);
  let depth = 1, end = body + 1;
  while (depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
  return source.slice(start, end);
}
test('production batch writes/history match scalar ordering, concurrent dirty words and bounded allocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-batching-'));
  try {
    const path = join(directory, 'batch.rs');
    writeFileSync(path, `
use std::{sync::atomic::{AtomicU32,AtomicU64,Ordering}, marker::PhantomData};
#[path = ${JSON.stringify(dirtyPath)}] mod sparse_buffer_dirty;
trait AtomicPod: Copy { type Blob; fn write_to_blob(&self, blob: &Self::Blob); }
#[derive(Clone,Copy,Default,Debug,PartialEq)] struct MeshInputUniform { world_from_local: u32, previous_input_index: u32, flags: u32 }
#[derive(Clone,Copy,Default)] struct PreviousMeshInputUniform { world_from_local: u32 }
impl AtomicPod for MeshInputUniform { type Blob = [AtomicU32;3]; fn write_to_blob(&self,b:&Self::Blob) { b[0].store(self.world_from_local,Ordering::Relaxed); b[1].store(self.previous_input_index,Ordering::Relaxed); b[2].store(self.flags,Ordering::Relaxed); } }
impl AtomicPod for PreviousMeshInputUniform { type Blob = AtomicU32; fn write_to_blob(&self,b:&Self::Blob) { b.store(self.world_from_local,Ordering::Relaxed); } }
struct AtomicSparseBufferVec<T:AtomicPod> { values:Vec<T::Blob>,summary:Vec<AtomicU64>,dirty_bits:Vec<AtomicU64> }
impl<T:AtomicPod> AtomicSparseBufferVec<T> { ${method(sparse,'set_batch')} }
struct Raw<T:AtomicPod> { values:Vec<T::Blob>, writes:AtomicU32 }
impl<T:AtomicPod> Raw<T> { fn len(&self)->u32 { self.values.len() as u32 } fn set(&self,i:u32,v:T) { self.writes.fetch_add(1,Ordering::Relaxed); v.write_to_blob(&self.values[i as usize]); } }
struct Cursor { value:AtomicU32, reservations:AtomicU32 }
impl Cursor { fn new()->Self { Self { value:AtomicU32::new(0),reservations:AtomicU32::new(0) } } fn load(&self,o:Ordering)->u32 { self.value.load(o) } fn store(&self,v:u32,o:Ordering) { self.value.store(v,o); } fn fetch_add(&self,v:u32,o:Ordering)->u32 { self.reservations.fetch_add(1,Ordering::Relaxed); self.value.fetch_add(v,o) } }
struct PreviousInstanceInputUniformBuffer<BPDI:AtomicPod> { buffer:Raw<BPDI>,atomic_len:Cursor }
impl<BPDI:AtomicPod> PreviousInstanceInputUniformBuffer<BPDI> { ${method(gpu,'push_batch')} }
struct InstanceInputUniformBuffer<T:AtomicPod> { buffer:AtomicSparseBufferVec<T>, marker:PhantomData<T> }
impl<BDI:AtomicPod> InstanceInputUniformBuffer<BDI> { ${method(gpu,'set_batch')} }
impl InstanceInputUniformBuffer<MeshInputUniform> { fn get_unchecked(&self,i:u32)->MeshInputUniform { let v=&self.buffer.values[i as usize]; MeshInputUniform { world_from_local:v[0].load(Ordering::Relaxed),previous_input_index:v[1].load(Ordering::Relaxed),flags:v[2].load(Ordering::Relaxed) } } }
${mesh.slice(mesh.indexOf('fn queue_mesh_input_batch('),mesh.indexOf('/// Creates the [\u0060RenderMeshInstanceGpu\u0060]s',mesh.indexOf('fn queue_mesh_input_batch(')))}
fn current(n:usize)->InstanceInputUniformBuffer<MeshInputUniform> { InstanceInputUniformBuffer { buffer:AtomicSparseBufferVec { values:(0..n).map(|i|[AtomicU32::new(i as u32),AtomicU32::new(u32::MAX),AtomicU32::new(0)]).collect(),dirty_bits:(0..n.div_ceil(64)).map(|_|AtomicU64::new(0)).collect(),summary:(0..n.div_ceil(4096)).map(|_|AtomicU64::new(0)).collect() },marker:PhantomData } }
fn history(n:usize)->PreviousInstanceInputUniformBuffer<PreviousMeshInputUniform> { PreviousInstanceInputUniformBuffer { buffer:Raw { values:(0..n).map(|_|AtomicU32::new(0)).collect(),writes:AtomicU32::new(0) },atomic_len:Cursor::new() } }
#[test] fn mixed_sparse_duplicates_drains_reuse_and_history() {
 let c=current(513); let h=history(2048); let mut batch=Vec::with_capacity(128); let capacity=batch.capacity();
 let mut reference:(Vec<_>,Vec<u32>)=((0..513).map(|i|MeshInputUniform { world_from_local:i,previous_input_index:u32::MAX,flags:0 }).collect(),vec![]);
 let mut uploaded=reference.0.clone();
 for frame in 0..6u32 {
  let mut expected_dirty=vec![false;513];
  h.atomic_len.store(0,Ordering::Relaxed); reference.1.clear();
  for step in 0..900u32 {
   let i=(step*137)%513; if i%7==frame { continue; }
   let v=MeshInputUniform { world_from_local:frame*1000+step,previous_input_index:0,flags:step%31 };
   expected_dirty[i as usize]=true;
   let old=reference.0[i as usize]; let mut expected=v; expected.previous_input_index=reference.1.len() as u32; reference.1.push(old.world_from_local); reference.0[i as usize]=expected;
   queue_mesh_input_batch(&mut batch,i,v,&c,&h);
  }
  expected_dirty[64]=true;
  // Explicit duplicate must capture the immediately preceding value.
  for value in [42,43] { let i=64; let mut v=MeshInputUniform { world_from_local:value,flags:99,previous_input_index:0 }; reference.1.push(reference.0[i].world_from_local); v.previous_input_index=reference.1.len() as u32-1; reference.0[i]=v; queue_mesh_input_batch(&mut batch,i as u32,v,&c,&h); }
  flush_mesh_input_batch(&mut batch,&c,&h);
  assert_eq!(batch.capacity(),capacity); assert_eq!(capacity,128);
  for i in 0..513 {
   let block=i/64;
   let marked=c.buffer.dirty_bits[block].load(Ordering::Relaxed)&(1<<(i%64))!=0;
   assert_eq!(marked,expected_dirty[i]);
   if marked { assert_ne!(c.buffer.summary[block/64].load(Ordering::Relaxed)&(1<<(block%64)),0); uploaded[i]=c.get_unchecked(i as u32); }
   assert_eq!(c.get_unchecked(i as u32),reference.0[i]);
  }
  assert_eq!(uploaded,reference.0,"drained sparse upload equals full reference after reuse");
  assert_eq!(h.atomic_len.load(Ordering::Relaxed) as usize,reference.1.len());
  for (i,old) in reference.1.iter().enumerate() { assert_eq!(h.buffer.values[i].load(Ordering::Relaxed),*old); }
  for word in c.buffer.dirty_bits.iter().chain(c.buffer.summary.iter()) { word.store(0,Ordering::Relaxed); }
 }
}
#[test] fn joined_workers_share_words_without_losing_updates() {
 let c=current(1024); let h=history(1024);
 std::thread::scope(|scope| { for worker in 0..4u32 { let c=&c; let h=&h; scope.spawn(move || { let mut entries=Vec::with_capacity(128); for i in (worker..1024).step_by(4) { queue_mesh_input_batch(&mut entries,i,MeshInputUniform { world_from_local:i+10000,previous_input_index:0,flags:worker },c,h); } flush_mesh_input_batch(&mut entries,c,h); }); } });
 assert_eq!(h.atomic_len.load(Ordering::Relaxed),1024);
 assert_eq!(h.atomic_len.reservations.load(Ordering::Relaxed),8, "1024 histories use eight reservations, not 1024");
 let mut seen=vec![false;1024];
 for i in 0..1024 { let v=c.get_unchecked(i); assert_eq!(v.world_from_local,i+10000); let p=v.previous_input_index as usize; assert!(!seen[p]); seen[p]=true; assert_eq!(h.buffer.values[p].load(Ordering::Relaxed),i); }
 for word in &c.buffer.dirty_bits { assert_eq!(word.load(Ordering::Relaxed),u64::MAX); }
 assert_eq!(c.buffer.summary[0].load(Ordering::Relaxed),65535);
}
#[test] fn bulk_reservation_and_empty_batch() {
 let h=history(512); let old=h.atomic_len.load(Ordering::Relaxed); assert_eq!(h.push_batch(&[]),old); assert_eq!(h.atomic_len.load(Ordering::Relaxed),old);
 let values=[PreviousMeshInputUniform { world_from_local:7 };128];
 assert_eq!(h.push_batch(&values),0); assert_eq!(h.push_batch(&values),128); assert_eq!(h.atomic_len.load(Ordering::Relaxed),256); assert_eq!(h.buffer.writes.load(Ordering::Relaxed),256); assert_eq!(h.atomic_len.reservations.load(Ordering::Relaxed),2);
}
`);
    const binary = join(directory, 'batch-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('7 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production u64 blobs preserve bytes, u32 field access and joined reuse', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-atomic-words-'));
  try {
    const source = read('../../crates/bevy_render/src/render_resource/atomic_pod.rs');
    const macro = source.slice(source.indexOf('#[macro_export]'), source.indexOf('impl_atomic_pod!((),'))
      .replace('#[derive(::bevy_derive::Deref, ::bevy_derive::DerefMut)]', '');
    const path = join(directory, 'words.rs');
    writeFileSync(path, `
extern crate self as bevy_platform;
extern crate self as bytemuck;
pub mod sync { pub use std::sync::*; }
// Stub only the external bit-cast dependency and derive; execute production atomics.
pub fn must_cast<A:Copy,B:Copy>(a:A)->B { assert_eq!(size_of::<A>(),size_of::<B>()); unsafe { std::mem::transmute_copy(&a) } }
pub fn must_cast_ref<A,B>(a:&A)->&B { assert_eq!(size_of::<A>(),size_of::<B>()); assert!(align_of::<A>()>=align_of::<B>()); unsafe { &*(a as *const A as *const B) } }
pub mod render_resource {
 pub trait AtomicPod: Copy { type Blob; fn read_from_blob(blob:&Self::Blob)->Self; fn write_to_blob(&self,blob:&Self::Blob); }
 pub unsafe trait AtomicPodBlob {}
}
use render_resource::AtomicPod;
${macro}
#[repr(C,align(16))] #[derive(Clone,Copy,Default,Debug,PartialEq)] pub struct Input { words:[u32;28] }
#[repr(C,align(16))] #[derive(Clone,Copy,Default,Debug,PartialEq)] pub struct History { words:[u32;12] }
#[repr(C)] #[derive(Clone,Copy,Default,Debug,PartialEq)] pub struct Fields { a:u32,b:u32 }
impl_atomic_pod!(Input,InputBlob,atomic_u64);
impl_atomic_pod!(History,HistoryBlob,atomic_u64);
impl_atomic_pod!(Fields,FieldsBlob,field(a:u32,a,set_a),field(b:u32,b,set_b));
#[test] fn exact_bytes_and_layout() {
 assert_eq!(size_of::<InputBlob>(),size_of::<Input>()); assert_eq!(size_of::<HistoryBlob>(),size_of::<History>());
 assert_eq!(InputBlob::default().0.len(),14); assert_eq!(HistoryBlob::default().0.len(),6);
 assert!(align_of::<InputBlob>()>=align_of::<std::sync::atomic::AtomicU64>());
 let v=Input { words:std::array::from_fn(|i| [0x80000000,0x7fc00001,0xffffffff,0x01234567][i%4]) };
 let blob=InputBlob::from(&v); assert_eq!(Input::read_from_blob(&blob),v);
 let bytes:Vec<_>=blob.0.iter().flat_map(|w|w.load(std::sync::atomic::Ordering::Relaxed).to_ne_bytes()).collect();
 assert_eq!(bytes,v.words.iter().flat_map(|w|w.to_ne_bytes()).collect::<Vec<_>>());
 let h=History { words:std::array::from_fn(|i|(i as u32).wrapping_mul(987654321)) }; let blob=HistoryBlob::from(&h); assert_eq!(History::read_from_blob(&blob),h);
 let f=Fields { a:3,b:9 }; let blob=FieldsBlob::from(&f); blob.set_a(11); assert_eq!(blob.a(),11); assert_eq!(blob.b(),9); blob.set_b(99); assert_eq!(Fields::read_from_blob(&blob),Fields { a:11,b:99 });
}
#[test] fn concurrent_writers_join_then_recycle_all_slots() {
 let blobs:Vec<_>=(0..1024).map(|_|InputBlob::default()).collect();
 for frame in 0..6u32 {
  std::thread::scope(|scope| { for worker in 0..4 { let blobs=&blobs; scope.spawn(move || { for i in (worker..1024).step_by(4) { Input { words:std::array::from_fn(|w|frame*100000+i as u32*32+w as u32) }.write_to_blob(&blobs[i]); } }); } });
  for (i,blob) in blobs.iter().enumerate() { assert_eq!(Input::read_from_blob(blob).words,std::array::from_fn(|w|frame*100000+i as u32*32+w as u32)); }
 }
}
`);
    const binary = join(directory, 'word-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    if (result.exitCode !== 0) throw Error(result.stdout.toString() + result.stderr.toString());
    expect(result.stdout.toString()).toContain('2 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
