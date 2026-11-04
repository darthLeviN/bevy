import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual descriptor caches entry hashing across clones and direct/nested map keys', () => {
  const descriptor = readFileSync(new URL('../../crates/bevy_material/src/descriptor.rs', import.meta.url), 'utf8');
  const platform = readFileSync(new URL('../../crates/bevy_platform/src/hash.rs', import.meta.url), 'utf8');
  const start = descriptor.indexOf('/// An immutable, pre-hashed layout');
  const end = descriptor.indexOf('/// Describes a render (graphics) pipeline.');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const hashed = platform.slice(platform.indexOf('pub struct Hashed<'), platform.indexOf('/// A [`BuildHasher`] that results'));
  const directory = mkdtempSync(join(tmpdir(), 'bevy-layout-hash-'));
  try {
    const path = join(directory, 'tests.rs');
    writeFileSync(path, `
use std::{borrow::Cow, hash::{BuildHasher, Hash, Hasher}, marker::PhantomData, ops::Deref, fmt::Debug, collections::HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
type FixedHasher = std::hash::BuildHasherDefault<std::collections::hash_map::DefaultHasher>;
static HASHES: AtomicUsize = AtomicUsize::new(0);
#[derive(Clone, Debug, PartialEq, Eq)]
struct BindGroupLayoutEntry(u32);
impl Hash for BindGroupLayoutEntry {
    fn hash<H: Hasher>(&self, state: &mut H) {
        HASHES.fetch_add(1, Ordering::Relaxed);
        self.0.hash(state);
    }
}
${hashed}
${descriptor.slice(start, end)}
#[derive(Default)] struct CollisionHasher;
impl Hasher for CollisionHasher {
    fn finish(&self) -> u64 { 0 }
    fn write(&mut self, _: &[u8]) {}
}
#[test] fn cached_keys_and_replacement() {
    let entries = vec![BindGroupLayoutEntry(1), BindGroupLayoutEntry(2)];
    let a = BindGroupLayoutDescriptor::new("material", &entries);
    assert_eq!(HASHES.load(Ordering::Relaxed), 2);
    let mut direct = HashMap::new();
    direct.insert(a.clone(), 7);
    let mut nested = HashMap::new();
    nested.insert((vec![a.clone(), a.clone()], 17u32), 9);
    for _ in 0..100 {
        assert_eq!(direct.get(&a.clone()), Some(&7));
        assert_eq!(nested.get(&(vec![a.clone(), a.clone()], 17)), Some(&9));
    }
    assert_eq!(HASHES.load(Ordering::Relaxed), 2, "lookups and clones must not hash entries");
    let b = BindGroupLayoutDescriptor::from_entries(a.label().to_owned(), vec![BindGroupLayoutEntry(3)]);
    assert_eq!(HASHES.load(Ordering::Relaxed), 3);
    assert_ne!(a, b);
    assert_eq!(direct.get(&a), Some(&7));
    assert_eq!(direct.get(&b), None);
    assert_eq!(a.entries(), entries);
    let equivalent = BindGroupLayoutDescriptor::new("material", &entries);
    assert_eq!(direct.get(&equivalent), Some(&7));
    assert_eq!(FixedHasher::default().hash_one(&a), FixedHasher::default().hash_one(&equivalent));
    assert_eq!(BindGroupLayoutDescriptor::default(), BindGroupLayoutDescriptor::new("", &[]));
    let mut collisions: HashMap<_, _, std::hash::BuildHasherDefault<CollisionHasher>> = HashMap::default();
    collisions.insert(a.clone(), 1);
    collisions.insert(b.clone(), 2);
    assert_eq!(collisions.get(&a), Some(&1));
    assert_eq!(collisions.get(&b), Some(&2));
    // Force collisions inside the actual Hashed implementation too.
    type Colliding = Hashed<BindGroupLayoutDescriptorData, std::hash::BuildHasherDefault<CollisionHasher>>;
    let x = Colliding::new(BindGroupLayoutDescriptorData { label: "a".into(), entries: entries.clone() });
    let y = Colliding::new(BindGroupLayoutDescriptorData { label: "b".into(), entries });
    assert_eq!(x.hash(), y.hash());
    assert_ne!(x, y);
}
`);
    const binary = join(directory, 'tests');
    const compile = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
