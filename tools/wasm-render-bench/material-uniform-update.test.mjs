import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../../crates/bevy_render/src/material_bind_groups.rs', import.meta.url), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset);
  expect(offset).toBeGreaterThan(0);
  expect(finish).toBeGreaterThan(offset);
  return source.slice(offset, finish);
}

test('production snapshot validation and commit preserve independent uniforms and reject incompatible updates', () => {
  const snapshot = section('pub struct MaterialUniformUpdateSnapshot', 'impl RenderMaterialBindings {');
  const methods = section('    pub fn uniform_update_snapshot', '    /// Prepares a material asset for the render world.');
  const directory = mkdtempSync(join(tmpdir(), 'bevy-material-uniform-update-'));
  try {
    const path = join(directory, 'test.rs');
    writeFileSync(path, `
use std::{any::TypeId, collections::{HashMap, HashSet}, marker::PhantomData, mem, ops::Deref};
trait Asset: 'static {}
struct Material; impl Asset for Material {}
#[derive(Debug, PartialEq, Eq, Clone)] struct BindGroupLayoutDescriptor(u32);
#[derive(Debug, PartialEq, Eq, Clone)] enum BindingResourceKey { Texture(u32,u32), Sampler(u32,u32) }
#[derive(Debug, PartialEq, Eq, Clone, Copy)] struct Index(u32);
impl Deref for Index { type Target=u32; fn deref(&self)->&u32 { &self.0 } }
#[derive(Debug, PartialEq, Eq, Clone, Copy)] struct MaterialBindingId { group: Index, slot: u32 }
#[derive(Clone, Copy)] struct AssetId<M>(u32, PhantomData<M>);
impl<M> AssetId<M> { fn untyped(self)->u32 { self.0 } }
impl<M> From<AssetId<M>> for u32 { fn from(id: AssetId<M>) -> u32 { id.0 } }
struct Resource(u32); impl Resource { fn id(&self)->u32 { self.0 } }
struct Data(Vec<u8>); impl Deref for Data { type Target=Vec<u8>; fn deref(&self)->&Vec<u8>{&self.0} }
enum OwnedBindingResource { Data(Data), TextureView(u32,Resource), Sampler(u32,Resource), Buffer }
type BindGroupId=u32;
struct PreparedBindGroup { bind_group: Resource, bindings: Vec<(u32,OwnedBindingResource)> }
enum MaterialNonBindlessAllocatedBindGroup { Prepared { bind_group:PreparedBindGroup, layout:BindGroupLayoutDescriptor, uniform_buffers:Vec<()> }, Unprepared }
struct Allocator { bind_groups:Vec<Option<MaterialNonBindlessAllocatedBindGroup>>, dirty_uniforms:HashSet<Index> }
impl std::hash::Hash for Index { fn hash<H:std::hash::Hasher>(&self,h:&mut H) { self.0.hash(h); } }
enum MaterialBindGroupAllocator { NonBindless(Allocator), Bindless }
type MaterialBindGroupAllocators=HashMap<TypeId,MaterialBindGroupAllocator>;
struct RenderMaterialBindings { bindings:HashMap<u32,MaterialBindingId> }
${snapshot}
impl RenderMaterialBindings { ${methods} }
fn id(value:u32)->AssetId<Material> { AssetId(value,PhantomData) }
fn setup()->(RenderMaterialBindings,MaterialBindGroupAllocators) {
  let mut bindings=HashMap::new(); let mut groups=Vec::new();
  for n in 0..10000u32 {
    bindings.insert(n,MaterialBindingId{group:Index(n),slot:0});
    groups.push(Some(MaterialNonBindlessAllocatedBindGroup::Prepared {
      layout:BindGroupLayoutDescriptor(1),uniform_buffers:vec![(),()],
      bind_group:PreparedBindGroup{bind_group:Resource(n+100000),bindings:vec![
        (0,OwnedBindingResource::Data(Data(vec![1;4]))),
        (1,OwnedBindingResource::TextureView(2,Resource(n))),
        (2,OwnedBindingResource::Sampler(3,Resource(4))),
        (3,OwnedBindingResource::Data(Data(vec![5;8])))]}
    }));
  }
  (RenderMaterialBindings{bindings},HashMap::from([(TypeId::of::<Material>(),MaterialBindGroupAllocator::NonBindless(Allocator{bind_groups:groups,dirty_uniforms:HashSet::new()}))]))
}
#[test] fn parallel_validation_and_commit() {
 let (bindings,mut allocators)=setup();
 let mut jobs:Vec<_>=(0..10000u32).map(|n| {
   let (binding,snapshot)=bindings.uniform_update_snapshot(id(n),&allocators).unwrap();
   (n,binding,snapshot,vec![(0,vec![(n%251) as u8;4]),(3,vec![(n%241) as u8;8])])
 }).collect();
 std::thread::scope(|scope| {
   for chunk in jobs.chunks_mut(2500) { scope.spawn(move|| {
     for (n,_,snapshot,data) in chunk {
       let key=vec![(1,BindingResourceKey::Texture(2,*n)),(2,BindingResourceKey::Sampler(3,4))];
       assert!(snapshot.matches(&BindGroupLayoutDescriptor(1),&key,data));
       assert!(!snapshot.matches(&BindGroupLayoutDescriptor(2),&key,data));
       let mut changed=key.clone(); changed[0].1=BindingResourceKey::Texture(2,10001);
       assert!(!snapshot.matches(&BindGroupLayoutDescriptor(1),&changed,data));
       changed=key.clone(); changed[1].1=BindingResourceKey::Sampler(3,5);
       assert!(!snapshot.matches(&BindGroupLayoutDescriptor(1),&changed,data));
       let mut bad=data.clone();bad[1].1.pop();
       assert!(!snapshot.matches(&BindGroupLayoutDescriptor(1),&key,&bad));
     }
   }); }
 });
 for (n,binding,snapshot,data) in &mut jobs {
   assert!(bindings.commit_uniform_update(id(*n),*binding,snapshot,data,&mut allocators));
   assert_eq!(data[0].1,vec![1;4]);assert_eq!(data[1].1,vec![5;8]);
 }
 let MaterialBindGroupAllocator::NonBindless(allocator)=allocators.get(&TypeId::of::<Material>()).unwrap() else {panic!()};
 assert_eq!(allocator.dirty_uniforms.len(),10000);
 for (n,group) in allocator.bind_groups.iter().enumerate() {
   let Some(MaterialNonBindlessAllocatedBindGroup::Prepared{bind_group,..})=group else {panic!()};
   let OwnedBindingResource::Data(a)=&bind_group.bindings[0].1 else {panic!()};
   let OwnedBindingResource::Data(b)=&bind_group.bindings[3].1 else {panic!()};
   assert_eq!(a.0,vec![(n%251) as u8;4]);assert_eq!(b.0,vec![(n%241) as u8;8]);
 }
}
#[test] fn reject_commit_without_partial_writes() {
 let (mut bindings,mut allocators)=setup();
 let (binding,snapshot)=bindings.uniform_update_snapshot(id(0),&allocators).unwrap();
 let mut bad=vec![(0,vec![9;4]),(3,vec![9;7])];
 assert!(!bindings.commit_uniform_update(id(0),binding,&snapshot,&mut bad,&mut allocators));
 bindings.bindings.insert(0,MaterialBindingId{group:Index(1),slot:0});
 let mut good=vec![(0,vec![9;4]),(3,vec![9;8])];
 assert!(!bindings.commit_uniform_update(id(0),binding,&snapshot,&mut good,&mut allocators));
 let MaterialBindGroupAllocator::NonBindless(allocator)=allocators.get(&TypeId::of::<Material>()).unwrap() else {panic!()};
 assert!(allocator.dirty_uniforms.is_empty());
 let Some(MaterialNonBindlessAllocatedBindGroup::Prepared{bind_group,..})=&allocator.bind_groups[0] else {panic!()};
 let OwnedBindingResource::Data(data)=&bind_group.bindings[0].1 else {panic!()};assert_eq!(data.0,vec![1;4]);
}
#[test] fn unsupported_or_unprepared_allocations_keep_full_preparation_path() {
 let (bindings,mut allocators)=setup();
 assert!(bindings.uniform_update_snapshot(id(10001),&allocators).is_none());
 let MaterialBindGroupAllocator::NonBindless(allocator)=allocators.get_mut(&TypeId::of::<Material>()).unwrap() else {panic!()};
 allocator.bind_groups[0]=Some(MaterialNonBindlessAllocatedBindGroup::Unprepared);
 assert!(bindings.uniform_update_snapshot(id(0),&allocators).is_none());
 let MaterialBindGroupAllocator::NonBindless(allocator)=allocators.get_mut(&TypeId::of::<Material>()).unwrap() else {panic!()};
 let Some(MaterialNonBindlessAllocatedBindGroup::Prepared{bind_group,..})=&mut allocator.bind_groups[1] else {panic!()};
 bind_group.bindings.push((8,OwnedBindingResource::Buffer));
 assert!(bindings.uniform_update_snapshot(id(1),&allocators).is_none());
 allocators.insert(TypeId::of::<Material>(),MaterialBindGroupAllocator::Bindless);
 assert!(bindings.uniform_update_snapshot(id(2),&allocators).is_none());
}
#[test] fn replaced_gpu_group_invalidates_cached_snapshot() {
 let (bindings,mut allocators)=setup();
 let (binding,snapshot)=bindings.uniform_update_snapshot(id(0),&allocators).unwrap();
 let MaterialBindGroupAllocator::NonBindless(allocator)=allocators.get_mut(&TypeId::of::<Material>()).unwrap() else {panic!()};
 let Some(MaterialNonBindlessAllocatedBindGroup::Prepared{bind_group,..})=&mut allocator.bind_groups[0] else {panic!()};
 bind_group.bind_group=Resource(200000);
 let mut data=vec![(0,vec![9;4]),(3,vec![9;8])];
 assert!(!bindings.commit_uniform_update(id(0),binding,&snapshot,&mut data,&mut allocators));
 assert_eq!(data[0].1,vec![9;4]);
 let (_,fresh)=bindings.uniform_update_snapshot(id(0),&allocators).unwrap();
 assert!(bindings.commit_uniform_update(id(0),binding,&fresh,&mut data,&mut allocators));
}
`);
    const binary = join(directory, 'tests');
    const compile = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
