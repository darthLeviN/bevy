import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../../crates/bevy_render/src/material_bind_groups.rs', import.meta.url), 'utf8');
const material = readFileSync(new URL('../../crates/bevy_pbr/src/material.rs', import.meta.url), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  expect(offset).toBeGreaterThan(0);
  const finish = source.indexOf(end, offset);
  expect(finish).toBeGreaterThan(offset);
  return source.slice(offset, finish);
}

test('material preparation uses the current type allocator instead of regenerating entries', () => {
  const start = material.indexOf('    fn prepare_asset(');
  expect(start).toBeGreaterThan(0);
  const end = material.indexOf('        let shadows_enabled', start);
  expect(end).toBeGreaterThan(start);
  const body = material.slice(start, end);
  expect(body).toContain('.get(&TypeId::of::<M>())');
  expect(body).toContain('.bind_group_layout()');
  expect(body).not.toContain('M::bind_group_layout_descriptor(render_device)');
  expect(source).toContain('MaterialBindGroupNonBindlessAllocator::new(label, bind_group_layout)');
});

test('actual data update validates mixed bindings atomically before staging page writes', () => {
  const update = section('fn update_non_bindless_data(', 'impl MaterialBindGroupNonBindlessAllocator');
  const directory = mkdtempSync(join(tmpdir(), 'bevy-material-data-'));
  try {
    const path = join(directory, 'data.rs');
    writeFileSync(path, `
use std::ops::{Deref, DerefMut, Range};
mod render_resource { pub type BindingResources = Vec<(u32, super::OwnedBindingResource)>; }
#[derive(Clone)] struct Resource(u32);
impl Resource { fn id(&self) -> u32 { self.0 } }
struct Data(Vec<u8>);
impl Deref for Data { type Target = Vec<u8>; fn deref(&self) -> &Vec<u8> { &self.0 } }
enum OwnedBindingResource { Data(Data), Buffer(Resource), ShaderBuffer(Resource), TextureView(u32, Resource), Sampler(u32, Resource) }
enum UnpreparedBindingResource { Data(Range<u32>), Buffer(Resource), ShaderBuffer(Resource), TextureView(u32, Resource), Sampler(u32, Resource) }
struct BindGroupBuilder { binding_resources: Vec<(u32, UnpreparedBindingResource)>, data_buffer: Vec<u8> }
${update}
#[test] fn mixed_multiple_bindings_and_atomic_fallback() {
    let mut old = vec![(0, OwnedBindingResource::Data(Data(vec![1;4]))),
        (1, OwnedBindingResource::TextureView(2, Resource(3))),
        (2, OwnedBindingResource::Sampler(4, Resource(5))),
        (3, OwnedBindingResource::Data(Data(vec![6;8]))),
        (4, OwnedBindingResource::Buffer(Resource(7))),
        (5, OwnedBindingResource::ShaderBuffer(Resource(8)))];
    let mut builder = BindGroupBuilder { binding_resources: vec![
        (0, UnpreparedBindingResource::Data(0..4)),
        (1, UnpreparedBindingResource::TextureView(2, Resource(3))),
        (2, UnpreparedBindingResource::Sampler(4, Resource(5))),
        (3, UnpreparedBindingResource::Data(4..12)),
        (4, UnpreparedBindingResource::Buffer(Resource(7))),
        (5, UnpreparedBindingResource::ShaderBuffer(Resource(8)))], data_buffer: vec![9;12] };
    assert!(update_non_bindless_data(&mut old, &builder));
    for bad in [UnpreparedBindingResource::Data(4..13), UnpreparedBindingResource::Data(4..11),
        UnpreparedBindingResource::Sampler(4, Resource(5))] {
        builder.data_buffer.fill(10);
        builder.binding_resources[3].1 = bad;
        assert!(!update_non_bindless_data(&mut old, &builder));
        let OwnedBindingResource::Data(data) = &old[0].1 else { panic!() };
        assert_eq!(data.0, vec![9;4]);
    }
    builder.binding_resources[3].1 = UnpreparedBindingResource::Data(4..12);
    builder.binding_resources[1].1 = UnpreparedBindingResource::TextureView(2, Resource(99));
    assert!(!update_non_bindless_data(&mut old, &builder));
    builder.binding_resources[1].1 = UnpreparedBindingResource::TextureView(2, Resource(3));
    builder.binding_resources[2].1 = UnpreparedBindingResource::Sampler(4, Resource(99));
    assert!(!update_non_bindless_data(&mut old, &builder));
}
`);
    const binary = join(directory, 'tests');
    const compile = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual allocator constructor and accessor retain layouts and follow replacement', () => {
  const accessor = section('    pub fn bind_group_layout(&self)', '    /// Returns the slab');
  const constructor = section("    fn new(\n        label: &'static str,\n        bind_group_layout: BindGroupLayoutDescriptor,", '    fn try_update_data(');
  const directory = mkdtempSync(join(tmpdir(), 'bevy-material-layout-'));
  try {
    const path = join(directory, 'layout.rs');
    writeFileSync(path, `
use std::collections::HashSet;
#[derive(Clone, Debug, PartialEq)]
struct BindGroupLayoutDescriptor { device: u32, entries: Vec<u32> }
struct MaterialBindGroupBindlessAllocator { bind_group_layout: BindGroupLayoutDescriptor }
struct UniformPages<T>(std::marker::PhantomData<T>);
impl<T> Default for UniformPages<T> { fn default() -> Self { Self(std::marker::PhantomData) } }
struct Buffer;
struct MaterialBindGroupNonBindlessAllocator {
    bind_group_layout: BindGroupLayoutDescriptor, label: &'static str,
    bind_groups: Vec<Option<()>>, to_prepare: HashSet<u32>,
    free_indices: Vec<u32>, dirty_uniforms: HashSet<u32>,
    uniform_pages: UniformPages<Buffer>,
}
enum MaterialBindGroupAllocator {
    Bindless(Box<MaterialBindGroupBindlessAllocator>),
    NonBindless(Box<MaterialBindGroupNonBindlessAllocator>),
}
impl MaterialBindGroupAllocator { ${accessor} }
impl MaterialBindGroupNonBindlessAllocator { ${constructor} }
fn layout(device: u32, material: u32) -> BindGroupLayoutDescriptor {
    BindGroupLayoutDescriptor { device, entries: vec![material, 19, 23] }
}
#[test]
fn layouts_are_allocator_owned_not_global_and_replacement_invalidates() {
    let mut allocators = vec![
        MaterialBindGroupAllocator::NonBindless(Box::new(MaterialBindGroupNonBindlessAllocator::new("a", layout(1, 7)))),
        MaterialBindGroupAllocator::NonBindless(Box::new(MaterialBindGroupNonBindlessAllocator::new("b", layout(1, 8)))),
        MaterialBindGroupAllocator::Bindless(Box::new(MaterialBindGroupBindlessAllocator { bind_group_layout: layout(2, 9) })),
    ];
    for _ in 0..10000 {
        assert_eq!(allocators[0].bind_group_layout(), &layout(1, 7));
        assert_eq!(allocators[1].bind_group_layout(), &layout(1, 8));
        assert_eq!(allocators[2].bind_group_layout(), &layout(2, 9));
    }
    let retained = allocators[0].bind_group_layout().clone();
    allocators[0] = MaterialBindGroupAllocator::NonBindless(Box::new(MaterialBindGroupNonBindlessAllocator::new("a", layout(3, 7))));
    assert_eq!(allocators[0].bind_group_layout(), &layout(3, 7));
    assert_eq!(retained, layout(1, 7));
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
