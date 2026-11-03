import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the actual engine function, not a rewritten model. GPU/ECS resources
// are fakes so cache-hit ordering can be checked without a GPU or Bevy workspace.
const source = readFileSync(new URL('../../crates/bevy_pbr/src/material.rs', import.meta.url), 'utf8');
const start = source.indexOf('pub fn base_specialize(');
const end = source.indexOf('\nfn prepass_specialize(', start);

test('base specialization checks the current cache before constructing its specializer', () => {
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const directory = mkdtempSync(join(tmpdir(), 'bevy-specialization-'));
  try {
    const path = join(directory, 'specialization.rs');
    writeFileSync(path, `
use std::{any::{Any, TypeId}, collections::HashMap, marker::PhantomData,
    ops::{Deref, DerefMut}, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
type CachedRenderPipelineId = u32;
type ErasedMaterialPipelineKey = u32;
type MeshVertexBufferLayoutRef = u32;
type SpecializedMeshPipelineError = &'static str;
#[derive(Default)]
pub struct MaterialProperties;
pub struct MeshPipeline(Arc<AtomicUsize>);
impl Clone for MeshPipeline {
    fn clone(&self) -> Self { self.0.fetch_add(1, Ordering::SeqCst); Self(self.0.clone()) }
}
pub struct MaterialPipeline { mesh_pipeline: MeshPipeline }
pub struct MaterialPipelineSpecializer { pipeline: MaterialPipeline, properties: Arc<MaterialProperties> }
pub struct PipelineCache;
pub struct SpecializedMeshPipelines<S> {
    entries: HashMap<(u32, u32), u32>, calls: usize, fail: bool, marker: PhantomData<S>,
}
impl<S> Default for SpecializedMeshPipelines<S> {
    fn default() -> Self { Self { entries: HashMap::new(), calls: 0, fail: false, marker: PhantomData } }
}
impl<S> SpecializedMeshPipelines<S> {
    fn get_pipeline(&self, key: &u32, layout: &u32) -> Option<u32> {
        self.entries.get(&(*key, *layout)).copied()
    }
    fn specialize(&mut self, _: &PipelineCache, _: &S, key: u32, layout: &u32) -> Result<u32, &'static str> {
        self.calls += 1;
        if self.fail { return Err("missing vertex attribute"); }
        Ok(*self.entries.entry((key, *layout)).or_insert(100 + key + layout))
    }
}
pub struct Mut<'a, T>(&'a mut T);
impl<T> Deref for Mut<'_, T> { type Target = T; fn deref(&self) -> &T { self.0 } }
impl<T> DerefMut for Mut<'_, T> { fn deref_mut(&mut self) -> &mut T { self.0 } }
#[derive(Default)]
pub struct World { resources: HashMap<TypeId, Box<dyn Any>>, scopes: usize }
impl World {
    fn insert<T: 'static>(&mut self, value: T) { self.resources.insert(TypeId::of::<T>(), Box::new(value)); }
    fn get_resource<T: 'static>(&self) -> Option<&T> { self.resources.get(&TypeId::of::<T>())?.downcast_ref() }
    fn resource<T: 'static>(&self) -> &T { self.get_resource().expect("missing resource") }
    fn resource_scope<T: 'static, R>(&mut self, f: impl FnOnce(&mut Self, Mut<T>) -> R) -> R {
        self.scopes += 1;
        let mut resource = self.resources.remove(&TypeId::of::<T>()).unwrap().downcast::<T>().unwrap();
        let result = f(self, Mut(&mut resource));
        self.insert(*resource);
        result
    }
}
${source.slice(start, end)}
type Pipelines = SpecializedMeshPipelines<MaterialPipelineSpecializer>;
fn fixture() -> (World, Arc<AtomicUsize>, Arc<MaterialProperties>) {
    let clones = Arc::new(AtomicUsize::new(0));
    let mut world = World::default();
    world.insert(MeshPipeline(clones.clone()));
    world.insert(PipelineCache);
    world.insert(Pipelines::default());
    (world, clones, Arc::new(MaterialProperties))
}
#[test]
fn cache_hit_needs_no_pipeline_resources_or_owned_properties() {
    let mut world = World::default();
    let mut cache = Pipelines::default();
    cache.entries.insert((1, 2), 77);
    world.insert(cache);
    let properties = Arc::new(MaterialProperties);
    for _ in 0..10001 { assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(77)); }
    assert_eq!(world.scopes, 0);
    assert_eq!(world.resource::<Pipelines>().calls, 0);
    assert_eq!(Arc::strong_count(&properties), 1);
}
#[test]
fn misses_keep_existing_specialization_and_key_layout_distinctions() {
    let (mut world, clones, properties) = fixture();
    assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(103));
    assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(103));
    assert_eq!(base_specialize(&mut world, 2, &2, &properties), Ok(104));
    assert_eq!(base_specialize(&mut world, 1, &3, &properties), Ok(104));
    assert_eq!(world.resource::<Pipelines>().calls, 3);
    assert_eq!(clones.load(Ordering::SeqCst), 3);
    assert_eq!(Arc::strong_count(&clones), 2);
    assert_eq!(Arc::strong_count(&properties), 1);
}
#[test]
fn replacement_and_invalidation_consult_current_resource() {
    let (mut world, clones, properties) = fixture();
    assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(103));
    let mut replacement = Pipelines::default();
    replacement.entries.insert((1, 2), 999);
    world.insert(replacement);
    assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(999));
    world.insert(Pipelines::default());
    assert_eq!(base_specialize(&mut world, 1, &2, &properties), Ok(103));
    assert_eq!(clones.load(Ordering::SeqCst), 2);
}
#[test]
fn errors_remain_errors_and_do_not_become_cached_successes() {
    let (mut world, clones, properties) = fixture();
    let mut cache = Pipelines::default(); cache.fail = true; world.insert(cache);
    for _ in 0..2 { assert_eq!(base_specialize(&mut world, 1, &2, &properties), Err("missing vertex attribute")); }
    assert!(world.resource::<Pipelines>().entries.is_empty());
    assert_eq!(clones.load(Ordering::SeqCst), 2);
    assert_eq!(Arc::strong_count(&clones), 2);
    assert_eq!(Arc::strong_count(&properties), 1);
}
`);
    const binary = join(directory, 'tests');
    const compile = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
