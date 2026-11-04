import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const material = readFileSync(new URL('../../crates/bevy_pbr/src/material.rs', import.meta.url), 'utf8');
const affinity = readFileSync(new URL('../../crates/bevy_tasks/src/scope_dispatch.rs', import.meta.url), 'utf8');
function section(start, end) {
  const offset = material.indexOf(start);
  const finish = material.indexOf(end, offset);
  expect(offset).toBeGreaterThan(0);
  expect(finish).toBeGreaterThan(offset);
  return material.slice(offset, finish);
}

test('actual material planner, CPU affinity boundary, and property invalidation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bevy-material-cpu-'));
  try {
    const path = join(directory, 'tests.rs');
    const planner = section('fn material_cpu_plan(', 'fn material_properties_template');
    const matching = section('fn material_properties_match', 'fn material_properties_from_template');
    writeFileSync(path, `
use std::hash::Hash;
mod affinity { ${affinity} }
${planner}
#[derive(Clone, Copy, PartialEq, Eq)] enum OpaqueRendererMethod { Auto, Forward, Deferred }
#[derive(Clone, Copy, PartialEq, Eq)] enum AlphaMode { Opaque, Blend }
#[derive(Clone, PartialEq, Eq, Hash)] struct Key(u32);
struct ErasedMaterialKey(Key);
impl ErasedMaterialKey { fn to_key<T: From<Key>>(&self) -> T { self.0.clone().into() } }
struct MaterialProperties {
    alpha_mode: AlphaMode, depth_bias: f32, reads_view_transmission_texture: bool,
    render_method: OpaqueRendererMethod, material_layout: Option<u32>,
    draw_functions: Vec<u32>, shaders: Vec<u32>, bindless: bool,
    shadows_enabled: bool, prepass_enabled: bool, oit_enabled: bool,
    material_key: ErasedMaterialKey,
}
trait Material {
    type Data: From<Key>;
    fn opaque_render_method(&self) -> OpaqueRendererMethod;
    fn alpha_mode(&self) -> AlphaMode;
    fn depth_bias(&self) -> f32;
    fn reads_view_transmission_texture(&self) -> bool;
    fn bind_group_data(&self) -> Self::Data;
}
struct Input { alpha: AlphaMode, bias: f32, transmission: bool, method: OpaqueRendererMethod, key: Key }
impl Material for Input {
    type Data = Key;
    fn opaque_render_method(&self) -> OpaqueRendererMethod { self.method }
    fn alpha_mode(&self) -> AlphaMode { self.alpha }
    fn depth_bias(&self) -> f32 { self.bias }
    fn reads_view_transmission_texture(&self) -> bool { self.transmission }
    fn bind_group_data(&self) -> Key { self.key.clone() }
}
${matching}
fn properties() -> MaterialProperties {
    MaterialProperties { alpha_mode: AlphaMode::Opaque, depth_bias: 0.0,
        reads_view_transmission_texture: false, render_method: OpaqueRendererMethod::Deferred,
        material_layout: Some(7), draw_functions: vec![1, 2], shaders: vec![3, 4],
        bindless: false, shadows_enabled: true, prepass_enabled: true, oit_enabled: false,
        material_key: ErasedMaterialKey(Key(42)) }
}
#[test] fn partition_contract() {
    assert_eq!(material_cpu_plan(10000, 4), (2157, vec![1961,1961,1961,1960]));
    assert_eq!(material_cpu_plan(537, 4), (537, vec![]));
    assert_eq!(material_cpu_plan(538, 4), (282, vec![256]));
    for count in [0,1,255,256,537,538,1024,10000,10001] {
        for workers in 0..=32 {
            let (caller, shares) = material_cpu_plan(count, workers);
            assert_eq!(caller + shares.iter().sum::<usize>(), count);
            assert!(shares.len() <= workers);
            for share in shares { assert!(share >= 256); assert!(caller.abs_diff((share*11).div_ceil(10)) <= 2); }
        }
    }
}
#[test] fn invalidation_contract() {
    let template = properties();
    let mut input = Input { alpha: AlphaMode::Opaque, bias: 0.0, transmission: false,
        method: OpaqueRendererMethod::Auto, key: Key(42) };
    assert!(material_properties_match(&input, &template, &properties()));
    for mutation in 0..12 {
        let mut old = properties();
        match mutation {
            0 => old.alpha_mode = AlphaMode::Blend,
            1 => old.depth_bias = -0.0,
            2 => old.reads_view_transmission_texture = true,
            3 => old.render_method = OpaqueRendererMethod::Forward,
            4 => old.material_layout = Some(8),
            5 => old.draw_functions.push(5),
            6 => old.shaders.push(6),
            7 => old.bindless = true,
            8 => old.shadows_enabled = false,
            9 => old.prepass_enabled = false,
            10 => old.oit_enabled = true,
            _ => old.material_key = ErasedMaterialKey(Key(43)),
        }
        assert!(!material_properties_match(&input, &template, &old), "mutation {mutation}");
    }
    input.method = OpaqueRendererMethod::Forward;
    assert!(!material_properties_match(&input, &template, &properties()));
    let mut old = properties(); old.render_method = OpaqueRendererMethod::Forward;
    assert!(material_properties_match(&input, &template, &old));
}
`);
    const binary = join(directory, 'tests');
    const compile = Bun.spawnSync(['rustc', '--edition=2024', '--test', path, '-o', binary], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
