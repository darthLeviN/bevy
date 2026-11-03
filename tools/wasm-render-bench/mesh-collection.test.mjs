import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile production preparation, history update, removal and cache code against
// deterministic CPU resources. No enclosing Cargo workspace or GPU is needed.
const source = readFileSync(new URL('../../crates/bevy_pbr/src/render/mesh.rs', import.meta.url), 'utf8');
const geometry = source.slice(source.indexOf('#[derive(Default)]\nstruct MeshCollectionGeometryCache'), source.indexOf('impl RenderMeshInstanceGpuBuilder {'));
const preparation = source.slice(source.indexOf('impl RenderMeshInstanceGpuBuilder {'), source.indexOf('/// Data needed to construct the [`RenderMeshInstanceGpu`]'));
const update = source.slice(source.indexOf('impl RenderMeshInstanceGpuPrepared {'), source.indexOf('impl MeshCullingData {'));

test('production mesh collection preserves live instance data and history with bounded task-local geometry caching', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-mesh-collection-'));
  try {
    const path = join(directory, 'collection.rs');
    writeFileSync(path, `
use std::{cell::{Cell, RefCell}, collections::{HashMap, hash_map::Entry}, marker::PhantomData, sync::atomic::{AtomicUsize, Ordering}};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)] struct Mesh;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)] struct AssetId<T>(u32, PhantomData<T>);
fn asset(id: u32) -> AssetId<Mesh> { AssetId(id, PhantomData) }
struct Slice { range: std::ops::Range<u32> }
#[derive(Default)] struct MeshAllocator { ranges: HashMap<AssetId<Mesh>, (Option<std::ops::Range<u32>>, Option<std::ops::Range<u32>>, Option<std::ops::Range<u32>>)>, calls: AtomicUsize }
impl MeshAllocator {
 fn slice(&self, id: &AssetId<Mesh>, field: usize) -> Option<Slice> {
  self.calls.fetch_add(1, Ordering::Relaxed);
  self.ranges.get(id).and_then(|r| match field { 0 => &r.0, 1 => &r.1, _ => &r.2 }.clone()).map(|range| Slice { range })
 }
 fn mesh_vertex_slice(&self, id: &AssetId<Mesh>) -> Option<Slice> { self.slice(id, 0) }
 fn mesh_index_slice(&self, id: &AssetId<Mesh>) -> Option<Slice> { self.slice(id, 1) }
 fn mesh_metadata_slice(&self, id: &AssetId<Mesh>) -> Option<Slice> { self.slice(id, 2) }
}
type MainEntity = u32;
type MainEntityHashMap<T> = HashMap<MainEntity, T>;
type RenderLayers = u32;
#[derive(Clone, Copy)] struct FrameCount(u32);
#[derive(Clone, Copy, Default, Debug, PartialEq)] struct MaterialBindingId { slot: u16 }
#[derive(Clone, Copy, Default)] struct Slab(Option<u32>);
#[derive(Clone, Copy, Default)] struct Shared { asset_id: AssetId<Mesh>, material_bindings_index: MaterialBindingId, lightmap_slab_index: Slab, tag: u32 }
impl Shared { fn write_to_blob(&self, blob: &Cell<Shared>) { blob.set(*self); } }
struct WorldTransform([u32; 12]);
impl WorldTransform { fn to_transpose(&self) -> [u32; 12] { self.0 } }
struct Flags(u32);
impl Flags { fn bits(&self) -> u32 { self.0 } }
struct RenderMeshInstanceGpuBuilder { shared: Shared, world_from_local: WorldTransform, lightmap_uv_rect: [u32; 2], mesh_flags: Flags, render_layers: Option<u32> }
#[derive(Clone, Copy, Default, Debug, PartialEq)] struct MeshInputUniform {
 world_from_local: [u32; 12], lightmap_uv_rect: [u32; 2], flags: u32, previous_input_index: u32, timestamp: u32,
 first_vertex_index: u32, first_index_index: u32, index_count: u32, current_skin_index: u32,
 material_and_lightmap_bind_group_slot: u32, tag: u32, morph_descriptor_index: u32, metadata_index: u32, pad: u32,
}
#[derive(Clone, Copy)] struct PreviousMeshInputUniform { world_from_local: [u32; 12] }
struct RenderMeshInstanceGpuPrepared { shared: Shared, mesh_input_uniform: MeshInputUniform, render_layers: Option<u32> }
#[derive(Default)] struct RenderMaterialInstances(HashMap<u32, u32>);
impl RenderMaterialInstances { fn mesh_material(&self, e: u32) -> Option<u32> { self.0.get(&e).copied() } }
type RenderMaterialBindings = HashMap<u32, MaterialBindingId>;
struct Lightmap { slot_index: Box<u16>, slab_index: u32 }
#[derive(Default)] struct RenderLightmaps { render_lightmaps: HashMap<u32, Lightmap> }
impl From<Option<u32>> for Slab { fn from(v: Option<u32>) -> Self { Self(v) } }
struct SkinIndex(u32);
impl SkinIndex { fn index(&self) -> u32 { self.0 } }
#[derive(Default)] struct SkinUniforms(HashMap<u32, u32>);
impl SkinUniforms { fn skin_byte_offset(&self, e: u32) -> Option<SkinIndex> { self.0.get(&e).copied().map(SkinIndex) } }
#[derive(Default)] struct MorphIndices(HashMap<u32, u32>);
impl MorphIndices { fn morph_descriptor_index(&self, e: u32) -> Option<&u32> { self.0.get(&e) } }
struct InstanceInputUniformBuffer<T: Copy> { values: RefCell<Vec<T>>, free: Vec<u32> }
impl<T: Copy> Default for InstanceInputUniformBuffer<T> { fn default() -> Self { Self { values: RefCell::default(), free: vec![] } } }
impl<T: Copy> InstanceInputUniformBuffer<T> {
 fn get_unchecked(&self, i: u32) -> T { self.values.borrow()[i as usize] }
 fn set(&self, i: u32, v: T) { self.values.borrow_mut()[i as usize] = v; }
 fn add(&mut self, v: T) -> u32 { if let Some(i) = self.free.pop() { self.set(i, v); i } else { let i = self.values.borrow().len() as u32; self.values.borrow_mut().push(v); i } }
 fn remove(&mut self, i: u32) { self.free.push(i); }
}
struct PreviousInstanceInputUniformBuffer<T>(RefCell<Vec<T>>);
impl<T> Default for PreviousInstanceInputUniformBuffer<T> { fn default() -> Self { Self(RefCell::default()) } }
impl<T> PreviousInstanceInputUniformBuffer<T> { fn push(&self, v: T) -> u32 { let i = self.0.borrow().len() as u32; self.0.borrow_mut().push(v); i } }
#[derive(Default)] struct RenderMeshInstanceGpuFlatBlob(Cell<u32>);
impl RenderMeshInstanceGpuFlatBlob { fn current_uniform_index(&self) -> u32 { self.0.get() } fn set_current_uniform_index(&self, i: u32) { self.0.set(i); } }
struct RenderMeshInstanceGpuFlat { current_uniform_index: u32 }
impl RenderMeshInstanceGpuFlat { fn write_to_blob(&self, b: &RenderMeshInstanceGpuFlatBlob) { b.0.set(self.current_uniform_index); } }
type RenderMeshInstanceSharedFlatBlob = Cell<Shared>;
struct RenderMeshInstanceGpu { shared: Cell<Shared>, gpu_specific: RenderMeshInstanceGpuFlatBlob, render_layers: Option<u32> }
${geometry}
${preparation}
${update}
fn allocator() -> MeshAllocator {
 let mut a = MeshAllocator::default();
 a.ranges.insert(asset(1), (Some(10..34), Some(40..76), Some(3..4)));
 a.ranges.insert(asset(2), (Some(100..109), None, None)); a
}
fn builder(id: u32, step: u32) -> RenderMeshInstanceGpuBuilder {
 RenderMeshInstanceGpuBuilder { shared: Shared { asset_id: asset(id), tag: step, ..Default::default() }, world_from_local: WorldTransform([step; 12]), lightmap_uv_rect: [step, step+1], mesh_flags: Flags(step), render_layers: Some(step) }
}
#[test] fn cached_preparation_matches_uncached_with_mixed_live_metadata() {
 let a = allocator(); let mut cache = MeshCollectionGeometryCache::default();
 let mut ids = RenderMaterialInstances::default(); let mut bindings = RenderMaterialBindings::default();
 let mut lights = RenderLightmaps::default(); let mut skins = SkinUniforms::default(); let mut morphs = MorphIndices::default();
 for step in 0..80 {
  let id = [1,1,2,2,3,1,1,1][step as usize % 8];
  ids.0.insert(7, step); bindings.insert(step, MaterialBindingId { slot: step as u16 });
  lights.render_lightmaps.clear(); skins.0.clear(); morphs.0.clear();
  if step % 2 == 0 { lights.render_lightmaps.insert(7, Lightmap { slot_index: Box::new(step as u16), slab_index: step }); skins.0.insert(7, step); morphs.0.insert(7, step); }
  let cached = builder(id, step).prepare(7, &a, &mut cache, &ids, &bindings, &lights, &skins, &morphs, FrameCount(step)).unwrap();
  let fresh = builder(id, step).prepare(7, &a, &mut MeshCollectionGeometryCache::default(), &ids, &bindings, &lights, &skins, &morphs, FrameCount(step)).unwrap();
  assert_eq!(cached.mesh_input_uniform, fresh.mesh_input_uniform); assert_eq!(cached.render_layers, fresh.render_layers);
  assert_eq!(cached.shared.lightmap_slab_index.0, fresh.shared.lightmap_slab_index.0);
  assert_eq!(cached.shared.material_bindings_index, fresh.shared.material_bindings_index);
  let u = cached.mesh_input_uniform;
  assert_eq!(u.world_from_local, [step;12]); assert_eq!(u.flags, step); assert_eq!(u.timestamp, step);
  assert_eq!((u.first_vertex_index, u.first_index_index, u.index_count, u.metadata_index), match id { 1 => (10,40,36,3), 2 => (100,0,9,0), _ => (0,0,0,0) });
 }
 bindings.clear(); assert!(builder(1, 0).prepare(7, &a, &mut cache, &ids, &bindings, &lights, &skins, &morphs, FrameCount(99)).is_none());
}
#[test] fn actual_update_preserves_history_and_recycled_slot_first_frame() {
 let a = allocator(); let mut cache = MeshCollectionGeometryCache::default(); let mut instances = HashMap::new();
 let mut current = InstanceInputUniformBuffer::default(); let previous = PreviousInstanceInputUniformBuffer::default();
 let ids = RenderMaterialInstances::default(); let bindings = RenderMaterialBindings::default(); let lights = RenderLightmaps::default(); let skins = SkinUniforms::default(); let morphs = MorphIndices::default();
 for step in 1..8 {
  let prepared = builder(1,step).prepare(7,&a,&mut cache,&ids,&bindings,&lights,&skins,&morphs,FrameCount(step)).unwrap();
  let i = prepared.update(7,&mut instances,&mut current,&previous);
  let u = current.get_unchecked(i); assert_eq!(u.world_from_local,[step;12]);
  if step == 1 { assert_eq!(u.previous_input_index,u32::MAX); } else { assert_eq!(previous.0.borrow()[u.previous_input_index as usize].world_from_local,[step-1;12]); }
 }
 assert_eq!(remove_mesh_input_uniform(7,&mut instances,&mut current),Some(0));
 assert_eq!(remove_mesh_input_uniform(7,&mut instances,&mut current),None);
 let prepared = builder(2,99).prepare(8,&a,&mut cache,&ids,&bindings,&lights,&skins,&morphs,FrameCount(99)).unwrap();
 let i = prepared.update(8,&mut instances,&mut current,&previous); assert_eq!(i,0);
 assert_eq!(current.get_unchecked(i).previous_input_index,u32::MAX); assert_eq!(current.get_unchecked(i).world_from_local,[99;12]);
}
#[test] fn bounded_worker_local_cache_and_frame_invalidation() {
 let mut a = allocator();
 std::thread::scope(|s| { for _ in 0..4 { let a = &a; s.spawn(move || { let mut cache = MeshCollectionGeometryCache::default(); for _ in 0..10000 { assert_eq!(cache.get(asset(1),a).index_count,36); } }); } });
 assert_eq!(a.calls.load(Ordering::Relaxed),12); assert!(std::mem::size_of::<MeshCollectionGeometryCache>() <= 64);
 a.ranges.insert(asset(1),(Some(200..205),None,Some(9..10)));
 let mut next_frame = MeshCollectionGeometryCache::default(); let g = next_frame.get(asset(1),&a);
 assert_eq!((g.first_vertex_index,g.index_count,g.metadata_index),(200,5,9));
}
`);
    const binary = join(directory, 'collection-tests');
    const build = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { timeout: 20000 });
    expect(build.stderr.toString()).not.toContain('error[');
    expect(build.exitCode).toBe(0);
    const result = Bun.spawnSync([binary], { timeout: 20000 });
    expect(result.stdout.toString()).toContain('3 passed');
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
