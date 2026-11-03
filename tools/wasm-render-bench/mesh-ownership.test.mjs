import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../../crates/bevy_pbr/src/render/mesh.rs', import.meta.url), 'utf8');
function block(marker, sourceText = source) {
  const source = sourceText;
  const start = source.indexOf(marker);
  if (start < 0) throw Error(`Missing production block: ${marker}`);
  const body = source.indexOf('{', start);
  let end = body + 1, depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error(`Unclosed production block: ${marker}`);
  return source.slice(body + 1, end - 1);
}

test('actual history reservation checks reject capacity and wrap violations before payload writes', () => {
  const gpu = readFileSync(new URL('../../crates/bevy_render/src/batching/gpu_preprocessing.rs', import.meta.url), 'utf8');
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-reservation-'));
  try {
    const path = join(directory, 'reservation.rs');
    writeFileSync(path, `
use std::{sync::atomic::{AtomicU32,Ordering},marker::PhantomData};
struct Storage<T> { capacity:u32,writes:AtomicU32,marker:PhantomData<T> }
impl<T> Storage<T> { fn len(&self)->u32 { self.capacity } fn set(&self,i:u32,_:T) { assert!(i<self.capacity);self.writes.fetch_add(1,Ordering::Relaxed); } }
struct PreviousInstanceInputUniformBuffer<T> { buffer:Storage<T>,atomic_len:AtomicU32 }
impl<BPDI:Copy> PreviousInstanceInputUniformBuffer<BPDI> { pub fn push_batch(&self,values:&[BPDI])->u32 { ${block('    pub fn push_batch(',gpu)} } }
fn history(capacity:u32,cursor:u32)->PreviousInstanceInputUniformBuffer<u32> { PreviousInstanceInputUniformBuffer { buffer:Storage { capacity,writes:AtomicU32::new(0),marker:PhantomData },atomic_len:AtomicU32::new(cursor) } }
#[test] fn exact_capacity_and_joined_disjoint_reservations() {
 let h=history(1024,0);
 std::thread::scope(|s| { for _ in 0..8 { let h=&h;s.spawn(move|| { let start=h.push_batch(&[7;128]);assert_eq!(start%128,0); }); } });
 assert_eq!(h.atomic_len.load(Ordering::Relaxed),1024);assert_eq!(h.buffer.writes.load(Ordering::Relaxed),1024);
 assert_eq!(h.push_batch(&[]),1024);
}
#[test] fn misuse_capacity_and_wrap_panics_before_any_payload_write() {
 for (capacity,cursor) in [(1,0),(u32::MAX,u32::MAX-1)] {
  let h=history(capacity,cursor);
  assert!(std::panic::catch_unwind(||h.push_batch(&[1,2])).is_err());
  assert_eq!(h.buffer.writes.load(Ordering::Relaxed),0);
  // Reservation precedes validation: panic is not transactional rollback.
  assert_eq!(h.atomic_len.load(Ordering::Relaxed),cursor.wrapping_add(2));
 }
}
`);
    const binary = join(directory, 'reservation-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    if (result.exitCode !== 0) throw Error(result.stdout.toString() + result.stderr.toString());
    expect(result.stdout.toString()).toContain('2 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual allocator, instance update and removal preserve unique live slots through reuse', () => {
  const gpu = readFileSync(new URL('../../crates/bevy_render/src/batching/gpu_preprocessing.rs', import.meta.url), 'utf8');
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-slots-'));
  try {
    const path = join(directory, 'slots.rs');
    writeFileSync(path, `
use std::{cell::{Cell,RefCell},collections::{HashMap,HashSet,hash_map::Entry}};
type MainEntity=u32;
type MainEntityHashMap<T>=HashMap<u32,T>;
#[derive(Clone,Copy,Default)] struct MeshInputUniform { world_from_local:u32,previous_input_index:u32 }
#[derive(Clone,Copy)] struct PreviousMeshInputUniform { world_from_local:u32 }
struct Storage<T> { values:RefCell<Vec<T>> }
impl<T:Copy> Storage<T> {
 fn set(&self,i:u32,v:T) { self.values.borrow_mut()[i as usize]=v; }
 fn push(&mut self,v:T)->u32 { let values=self.values.get_mut();let i=values.len() as u32;values.push(v);i }
}
struct InstanceInputUniformBuffer<T> { buffer:Storage<T>,free_uniform_indices:Vec<u32> }
impl<BDI:Copy> InstanceInputUniformBuffer<BDI> {
 pub fn add(&mut self,element:BDI)->u32 { ${block('    pub fn add(',gpu)} }
 pub fn remove(&mut self,uniform_index:u32) { ${block('    pub fn remove(',gpu)} }
 fn get_unchecked(&self,i:u32)->BDI { self.buffer.values.borrow()[i as usize] }
 fn set(&self,i:u32,v:BDI) { self.buffer.set(i,v); }
}
struct PreviousInstanceInputUniformBuffer<T>(RefCell<Vec<T>>);
impl<T> PreviousInstanceInputUniformBuffer<T> { fn push(&self,v:T)->u32 { let mut values=self.0.borrow_mut();let i=values.len() as u32;values.push(v);i } }
#[derive(Clone,Copy,Default)] struct Shared;
type RenderMeshInstanceSharedFlatBlob=Cell<Shared>;
impl Shared { fn write_to_blob(&self,b:&Cell<Shared>) { b.set(*self); } }
#[derive(Default)] struct RenderMeshInstanceGpuFlatBlob(Cell<u32>);
impl RenderMeshInstanceGpuFlatBlob { fn current_uniform_index(&self)->u32 { self.0.get() } fn set_current_uniform_index(&self,i:u32) { self.0.set(i); } }
struct RenderMeshInstanceGpuFlat { current_uniform_index:u32 }
impl RenderMeshInstanceGpuFlat { fn write_to_blob(&self,b:&RenderMeshInstanceGpuFlatBlob) { b.0.set(self.current_uniform_index); } }
struct RenderMeshInstanceGpu { shared:Cell<Shared>,gpu_specific:RenderMeshInstanceGpuFlatBlob,render_layers:Option<u32> }
struct RenderMeshInstanceGpuPrepared { shared:Shared,mesh_input_uniform:MeshInputUniform,render_layers:Option<u32> }
impl RenderMeshInstanceGpuPrepared { ${block('impl RenderMeshInstanceGpuPrepared {')} }
fn remove_mesh_input_uniform(entity:MainEntity,render_mesh_instances:&mut MainEntityHashMap<RenderMeshInstanceGpu>,current_input_buffer:&mut InstanceInputUniformBuffer<MeshInputUniform>)->Option<u32> { ${block('fn remove_mesh_input_uniform(')} }
fn prepared(value:u32)->RenderMeshInstanceGpuPrepared { RenderMeshInstanceGpuPrepared { shared:Shared,mesh_input_uniform:MeshInputUniform { world_from_local:value,previous_input_index:u32::MAX },render_layers:Some(value%3) } }
#[test] fn generations_retries_layers_removal_idempotence_and_reuse() {
 let mut current=InstanceInputUniformBuffer { buffer:Storage { values:RefCell::new(vec![]) },free_uniform_indices:vec![] };
 let previous=PreviousInstanceInputUniformBuffer(RefCell::new(vec![]));let mut instances=HashMap::new();
 for frame in 0..8u32 {
  previous.0.borrow_mut().clear();
  // Existing instances (including layer changes/retries) keep their own index.
  let before:HashMap<_,_>=instances.iter().map(|(e,i):(&u32,&RenderMeshInstanceGpu)|(*e,i.gpu_specific.current_uniform_index())).collect();
  for (e,index) in &before { let old=current.get_unchecked(*index);assert_eq!(prepared(frame).update(*e,&mut instances,&mut current,&previous),*index);let u=current.get_unchecked(*index);assert_eq!(previous.0.borrow()[u.previous_input_index as usize].world_from_local,old.world_from_local); }
  // Repeated removal events cannot free a live index twice.
  for e in before.keys().filter(|e|**e%2==frame%2) { assert!(remove_mesh_input_uniform(*e,&mut instances,&mut current).is_some());assert!(remove_mesh_input_uniform(*e,&mut instances,&mut current).is_none()); }
  for n in 0..129 { let e=1000+frame*129+n;let index=prepared(e).update(e,&mut instances,&mut current,&previous);assert_eq!(current.get_unchecked(index).previous_input_index,u32::MAX); }
  let live:HashSet<_>=instances.values().map(|i|i.gpu_specific.current_uniform_index()).collect();assert_eq!(live.len(),instances.len());
  let free:HashSet<_>=current.free_uniform_indices.iter().copied().collect();assert_eq!(free.len(),current.free_uniform_indices.len());assert!(free.is_disjoint(&live));
  assert!(previous.0.borrow().len()<=current.buffer.values.borrow().len());
 }
}
`);
    const binary = join(directory, 'slot-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    if (result.exitCode !== 0) throw Error(result.stdout.toString() + result.stderr.toString());
    expect(result.stdout.toString()).toContain('1 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual extraction deduplication and queue methods assign each entity to one worker destination', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-ownership-'));
  try {
    const path = join(directory, 'ownership.rs');
    // Execute the complete production extraction orchestration body, queue methods,
    // and zero-bit iterator. Stub ECS query delivery and the per-row builder only;
    // neither stub implements deduplication. Rotate delivery between four queues.
    writeFileSync(path, `
use std::{cell::{Cell,RefCell,RefMut},collections::{HashMap,HashSet},ops::Deref,sync::atomic::{AtomicU64,Ordering},iter};
type Entity=u32;
type EntityHashSet=HashSet<Entity>;
#[derive(Clone,Copy,Debug,Hash,PartialEq,Eq)] struct MainEntity(u32);
impl From<u32> for MainEntity { fn from(e:u32)->Self { Self(e) } }
impl Deref for MainEntity { type Target=u32; fn deref(&self)->&u32 { &self.0 } }
type RenderMeshInstanceGpuBuilder=u32;
type MeshCullingData=u32;
#[derive(Default)] enum RenderMeshInstanceGpuQueue { #[default] None, CpuCulling { changed:Vec<(MainEntity,u32)>,removed:Vec<MainEntity> },GpuCulling { changed_cpu_culling:Vec<(MainEntity,u32,u32)>,changed_gpu_culling:Vec<(MainEntity,u32,u32)>,removed:Vec<MainEntity> } }
impl RenderMeshInstanceGpuQueue { ${block('impl RenderMeshInstanceGpuQueue {')} }
struct Queues { queues:Vec<RefCell<RenderMeshInstanceGpuQueue>>,next:Cell<usize> }
impl Queues {
 fn new()->Self { Self { queues:(0..4).map(|_|RefCell::default()).collect(),next:Cell::new(0) } }
 fn iter_mut(&mut self)->impl Iterator<Item=&mut RenderMeshInstanceGpuQueue> { self.queues.iter_mut().map(RefCell::get_mut) }
 fn borrow_local_mut(&self)->RefMut<'_,RenderMeshInstanceGpuQueue> { let i=self.next.get()%4;self.next.set(i+1);self.queues[i].borrow_mut() }
 fn destinations(&self,slots:&HashMap<MainEntity,u32>)->Vec<(usize,MainEntity,u32)> {
  let mut result=vec![];
  for (worker,q) in self.queues.iter().enumerate() { match &*q.borrow() {
   RenderMeshInstanceGpuQueue::None=>{},
   RenderMeshInstanceGpuQueue::CpuCulling { changed,.. }=>result.extend(changed.iter().map(|(e,_)|(worker,*e,slots[e]))),
   RenderMeshInstanceGpuQueue::GpuCulling { changed_cpu_culling,changed_gpu_culling,.. }=>result.extend(changed_cpu_culling.iter().chain(changed_gpu_culling).map(|(e,_,_)|(worker,*e,slots[e])))
  } }
  result
 }
}
#[derive(Default)] struct OrderedSet(Vec<u32>);
impl OrderedSet {
 fn clear(&mut self) { self.0.clear(); }
 fn extend(&mut self,it:impl IntoIterator<Item=u32>) { for e in it { if !self.0.contains(&e) { self.0.push(e); } } }
 fn len(&self)->usize { self.0.len() }
 fn get_index_of(&self,e:&u32)->Option<usize> { self.0.iter().position(|x|x==e) }
 fn get_index(&self,i:usize)->Option<&u32> { self.0.get(i) }
}
struct Query { rows:Vec<(u32,)> }
impl Query {
 fn contains(&self,e:u32)->bool { self.rows.contains(&(e,)) }
 fn get(&self,e:u32)->Result<(u32,),()> { if self.contains(e) { Ok((e,)) } else { Err(()) } }
 fn par_iter(&self)->&Self { self }
 fn for_each_init<T>(&self,init:impl Fn()->T,f:impl Fn(&mut T,(u32,))) { for row in &self.rows { f(&mut init(),*row); } }
 fn is_empty(&self)->bool { self.rows.is_empty() }
}
#[derive(Default)] struct Removed(Vec<u32>);
impl Removed { fn read(&mut self)->impl Iterator<Item=u32>+'_ { self.0.iter().copied() } }
struct RenderVisibilityRanges;
struct RenderMeshInstancesGpu;
enum RenderMeshInstances { GpuBuilding(RenderMeshInstancesGpu),Other }
// Builder seam: production extraction calls this once per selected ECS row.
// Visibility and culling vary by entity; queue routing itself is production code.
fn extract_mesh_for_gpu_building(row:(u32,),_:&RenderVisibilityRanges,_:&RenderMeshInstancesGpu,q:&mut RenderMeshInstanceGpuQueue,gpu:bool) {
 if row.0%11==0 { q.remove(row.0.into(),gpu); } else { q.push(row.0.into(),row.0,gpu.then_some(row.0),row.0%2==0); }
}
struct AtomicU64ZeroBitIter<'a> { bits:&'a [AtomicU64],current_word:u64,next_index:usize }
impl<'a> AtomicU64ZeroBitIter<'a> { ${block("impl<'a> AtomicU64ZeroBitIter<'a> {")} }
impl<'a> Iterator for AtomicU64ZeroBitIter<'a> { ${block("impl<'a> Iterator for AtomicU64ZeroBitIter<'a> {")} }
fn extract(changed_meshes_query:Query,all_meshes_query:Query,mut removed_meshes_query:Removed,gpu_culling_query:Query,meshes_to_reextract_next_frame:HashSet<MainEntity>,removed:Vec<u32>,render_mesh_instance_queues:&mut Queues) {
 let mut render_mesh_instances=Box::new(RenderMeshInstances::GpuBuilding(RenderMeshInstancesGpu));
 let render_visibility_ranges=RenderVisibilityRanges;
 let mut reextract_entities=EntityHashSet::new();
 let mut potential_reextraction_set=OrderedSet::default();
 let mut potential_reextraction_bitfield=Vec::new();
 let mut removed_previous_global_transform_query=Removed(removed.clone());
 let mut removed_lightmap_query=Removed(removed.clone());
 let mut removed_aabb_query=Removed(removed.clone());
 let mut removed_mesh_tag_query=Removed(removed.clone());
 let mut removed_no_frustum_culling_query=Removed(removed.clone());
 let mut removed_not_shadow_receiver_query=Removed(removed.clone());
 let mut removed_transmitted_receiver_query=Removed(removed.clone());
 let mut removed_not_shadow_caster_query=Removed(removed.clone());
 let mut removed_no_automatic_batching_query=Removed(removed.clone());
 let mut removed_no_cpu_culling_query=Removed(removed.clone());
 let mut removed_visibility_range_query=Removed(removed.clone());
 let mut removed_skinned_mesh_query=Removed(removed.clone());
 let mut removed_render_layers_query=Removed(removed);
 ${source.slice(source.indexOf('    reextract_entities.clear();',source.indexOf('pub fn extract_meshes_for_gpu_building(')),source.indexOf('\n}\n',source.indexOf('    reextract_entities.clear();',source.indexOf('pub fn extract_meshes_for_gpu_building('))))}
}
#[test] fn changed_retry_and_thirteen_removal_streams_across_workers() {
 let slots:HashMap<_,_>=(1..=257).map(|e|(MainEntity(e),(e*137)%257)).collect();
 let mut queues=Queues::new();
 for gpu in [false,true,false,true] {
  for split in [0,1,63,64,65,128,257] {
   // Repeated events and all retries intentionally overlap changed rows.
   let changed=(1..=split).map(|e|(e,)).collect();
   let all=(1..=257).map(|e|(e,)).collect();
   extract(Query { rows:changed },Query { rows:all },Removed(vec![2,2,999]),Query { rows:if gpu { vec![(1,)] } else { vec![] } },slots.keys().copied().collect(),(1..=257).chain(1..=257).collect(),&mut queues);
   let destinations=queues.destinations(&slots);
   let mut entities=HashSet::new();let mut indices=HashSet::new();let mut workers=HashSet::new();
   for (worker,e,index) in &destinations { assert!(entities.insert(*e),"duplicate entity {e:?} in different extraction routes");assert!(indices.insert(*index),"duplicate destination {index}");workers.insert(*worker); }
   assert_eq!(destinations.len(),257-257/11);
   if split>=4 { assert_eq!(workers.len(),4); }
  }
 }
}
#[test] fn despawn_absent_rows_and_remove_readd_do_not_duplicate_payloads() {
 let mut queues=Queues::new();let slots=HashMap::from([(MainEntity(1),0),(MainEntity(2),1)]);
 extract(Query { rows:vec![(1,)] },Query { rows:vec![(1,),(2,)] },Removed(vec![1,1,3,3]),Query { rows:vec![(1,)] },HashSet::from([MainEntity(1),MainEntity(2),MainEntity(3)]),vec![1,2,3,3],&mut queues);
 let mut destinations=queues.destinations(&slots);destinations.sort_by_key(|x|x.1.0);
 assert_eq!(destinations.iter().map(|x|(x.1.0,x.2)).collect::<Vec<_>>(),vec![(1,0),(2,1)]);
}
`);
    const binary = join(directory, 'ownership-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    if (result.exitCode !== 0) throw Error(result.stdout.toString() + result.stderr.toString());
    expect(result.stdout.toString()).toContain('2 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
