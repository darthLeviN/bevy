use bevy::prelude::*;
use bevy::light::cluster::ClusterConfig;
use bevy::render::view::{DebandDither, Tonemapping};
use bevy::ecs::{schedule::{Schedules, SingleThreadedExecutor}, system::NonSendMarker};
use bevy::tasks::{ComputeTaskPool, AsyncComputeTaskPool, IoTaskPool, TaskPoolBuilder};
use wasm_bindgen::prelude::*;
use bevy::render::{Render, RenderApp, RenderSystems, mesh::RenderMesh, render_asset::RenderAssets,
    render_resource::{PipelineCache, CachedPipelineState}, view::ViewTarget};
use std::{collections::HashSet, sync::{Arc, Mutex, OnceLock}};
use bevy::asset::AssetId;
use bevy::pbr::{PreparedMaterial, RenderMaterialInstances};
use bevy::render::erased_render_asset::ErasedRenderAssets;
mod motion;
mod workload;
mod heavy;
mod readiness;
mod timings;
mod timing_stats;
use readiness::{Readiness, SamplingGate};

#[derive(Resource, Clone)]
struct MainConfig {
    moving_meshes: usize,
    cpu_work: u32,
    scene_materials: Arc<OnceLock<Vec<AssetId<StandardMaterial>>>>,
}

#[derive(Component)]
struct Moving {
    index: usize,
    base: [f32; 3],
    last_updated: Option<f32>,
}

#[derive(Resource, Clone, Default)]
struct GraphicsReadiness(Arc<Mutex<Readiness>>);

fn publish_readiness(
    state: Res<GraphicsReadiness>, meshes: Res<RenderAssets<RenderMesh>>,
    cache: Res<PipelineCache>, targets: Query<&ViewTarget>,
    materials: Res<ErasedRenderAssets<PreparedMaterial>>,
    instances: Res<RenderMaterialInstances>, config: Res<MainConfig>,
    mut verified_material_count: Local<Option<usize>>, _: NonSendMarker,
) {
    let mut pipelines = 0;
    let mut completed_pipelines = 0;
    for pipeline in cache.pipelines() {
        pipelines += 1;
        if matches!(pipeline.state, CachedPipelineState::Ok(_)) { completed_pipelines += 1; }
    }
    let gpu_materials = materials.iter().count();
    let required_materials = config.moving_meshes + 1;
    // Asset counts alone could include unrelated default assets. Check actual
    // scene identities before warmup, and cache success while the count is stable.
    let scene_materials_prepared = gpu_materials >= required_materials && (
        *verified_material_count == Some(gpu_materials) || config.scene_materials.get().is_some_and(|ids| {
            ids.len() == required_materials && ids.iter().all(|id| materials.get(*id).is_some())
        })
    );
    *verified_material_count = scene_materials_prepared.then_some(gpu_materials);
    *state.0.lock().unwrap() = Readiness {
        gpu_meshes: meshes.iter().count(), render_targets: targets.iter().count(),
        gpu_materials, material_instances: instances.instances.len(),
        required_materials, scene_materials_prepared, motion_updated: false,
        pipelines, completed_pipelines, waiting_pipelines: cache.waiting_pipelines().count(),
    };
}

#[derive(Resource, Default)]
struct Measurement {
    sample: SamplingGate,
    displayed_phase: &'static str,
    finished: bool,
    threaded: bool,
    motion_ready: bool,
}

#[wasm_bindgen]
pub fn report_worker_failure(message: String) {
    bevy::tasks::report_web_worker_failure(&message);
}

#[wasm_bindgen]
pub async fn start(threaded: bool, shim_url: String, worker_url: String, workers: usize, moving_meshes: usize, cpu_work: u32) {
    let workers = motion::validate_config(threaded, workers, moving_meshes).expect("valid benchmark configuration");
    assert!(cpu_work <= workload::MAX_CPU_WORK, "cpu_work must be in 0..=1000000");
    let config = MainConfig { moving_meshes, cpu_work, scene_materials: Arc::new(OnceLock::new()) };
    wasm_thread::Builder::new().wasm_bindgen_shim_url(shim_url).worker_script_url(worker_url).set_default();
    if threaded {
        bevy::tasks::init_web_thread_pools(workers).await;
    } else {
        ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
        AsyncComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
        IoTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
    }
    let mut app = App::new();
    let readiness = GraphicsReadiness::default();
    app.insert_resource(readiness.clone()).insert_resource(config.clone());
    app.insert_resource(Measurement { threaded, ..default() })
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Bevy minimal FPS benchmark".into(),
                canvas: Some("#scene".into()),
                resolution: (1280, 720).into(),
                present_mode: bevy::window::PresentMode::Immediate,
                ..default()
            }),
            ..default()
        }))
        .add_systems(Startup, setup)
        .add_systems(Last, measure);
    if cpu_work > 0 { heavy::install(&mut app); }
    else { app.add_systems(Update, animate); }
    app.sub_app_mut(RenderApp).insert_resource(readiness).insert_resource(config)
        .add_systems(Render, publish_readiness.in_set(RenderSystems::PostCleanup));
    // WebGPU handles are browser-thread-affine. Keep GPU sub-app schedules on
    // that thread; the main world's eligible ECS work and parallel queries use workers.
    for (index, sub_app) in app.sub_apps_mut().iter_mut().enumerate() {
        if !threaded || index != 0 {
            for (_, schedule) in sub_app.world_mut().resource_mut::<Schedules>().iter_mut() {
                schedule.set_executor(SingleThreadedExecutor::new());
            }
        }
    }
    if option_env!("BEVY_RENDER_TIMINGS").is_some() { timings::install(&mut app); }
    app.run();
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    config: Res<MainConfig>,
) {
    let layout = motion::Layout::new(config.moving_meshes);
    let mut scene_materials = Vec::with_capacity(config.moving_meshes + 1);
    let ground_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.6, 0.6, 0.6),
        unlit: true,
        ..default()
    });
    scene_materials.push(ground_material.id());
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(layout.ground[0], layout.ground[1]))),
        MeshMaterial3d(ground_material),
    ));
    let cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    for index in 0..config.moving_meshes {
        let base = layout.base(index);
        let rgb = motion::color_rgb(index).map(|channel| channel as f32 / 255.0);
        let initial = motion::pose(base, index, 0.0);
        let material = materials.add(StandardMaterial {
            base_color: Color::srgb(rgb[0], rgb[1], rgb[2]),
            unlit: true,
            ..default()
        });
        scene_materials.push(material.id());
        let mut entity = commands.spawn((
            Mesh3d(cube.clone()),
            MeshMaterial3d(material),
            Transform::from_translation(Vec3::from_array(initial.translation))
                .with_rotation(Quat::from_rotation_y(initial.yaw)),
            Moving { index, base, last_updated: None },
        ));
        if config.cpu_work > 0 { heavy::insert(&mut entity); }
    }
    config.scene_materials.set(scene_materials).expect("scene materials initialized once");
    commands.spawn((
        DirectionalLight {
            shadow_maps_enabled: false,
            contact_shadows_enabled: false,
            ..default()
        },
        Transform::from_xyz(3.0, 8.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        Camera3d::default(),
        Projection::Perspective(PerspectiveProjection { far: layout.far, ..default() }),
        Msaa::Off,
        Tonemapping::None,
        DebandDither::Disabled,
        ClusterConfig::Single,
        Transform::from_translation(Vec3::from_array(layout.camera)).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

fn animate(time: Res<Time>, mut moving: Query<(&mut Transform, &mut Moving)>) {
    let seconds = time.elapsed_secs();
    moving.par_iter_mut().for_each(|(mut transform, mut moving)| {
        let pose = motion::pose(moving.base, moving.index, seconds);
        transform.translation = Vec3::from_array(pose.translation);
        transform.rotation = Quat::from_rotation_y(pose.yaw);
        moving.last_updated = Some(seconds);
    });
}

fn verify_motion(moving: &Query<(&Moving, &Transform)>, expected_count: usize, seconds: f32) {
    let mut count = 0;
    for (moving, transform) in moving.iter() {
        let expected = motion::pose(moving.base, moving.index, seconds);
        assert_eq!(moving.last_updated, Some(seconds), "every moving mesh must be animated this frame");
        assert!(transform.translation.abs_diff_eq(Vec3::from_array(expected.translation), 0.0001), "moving translation mismatch");
        assert!(transform.rotation.abs_diff_eq(Quat::from_rotation_y(expected.yaw), 0.0001), "moving rotation mismatch");
        assert!(transform.scale.abs_diff_eq(Vec3::ONE, 0.0001), "moving scale mismatch");
        count += 1;
    }
    assert_eq!(count, expected_count, "every configured moving mesh must exist");
}

fn measure(
    mut measurement: ResMut<Measurement>, readiness: Res<GraphicsReadiness>, config: Res<MainConfig>,
    timings: Option<Res<timings::Timings>>,
    time: Res<Time>, moving: Query<(&Moving, &Transform)>, cameras: Query<&Camera>,
    meshes: Query<(&Mesh3d, &MeshMaterial3d<StandardMaterial>)>,
    entities: Query<heavy::OutputsReadOnly>, materials: Res<Assets<StandardMaterial>>, _: NonSendMarker,
) {
    if measurement.finished {
        return;
    }
    if !measurement.motion_ready {
        if config.cpu_work > 0 { heavy::verify(&entities, &materials, &config); }
        else { verify_motion(&moving, config.moving_meshes, time.elapsed_secs()); }
        measurement.motion_ready = true;
    }
    let window = web_sys::window().expect("browser window");
    let now = window.performance().expect("performance clock").now();
    let mut ready = *readiness.0.lock().unwrap();
    ready.motion_updated = measurement.motion_ready;
    let previous_phase = measurement.sample.phase;
    let complete = measurement.sample.tick(now, ready);
    if previous_phase != measurement.sample.phase {
        if let Some(timings) = &timings { timings.reset(); }
    }
    if measurement.displayed_phase != measurement.sample.phase {
        measurement.displayed_phase = measurement.sample.phase;
        window.document().unwrap().get_element_by_id("result").unwrap()
            .set_text_content(Some(measurement.sample.phase));
    }
    if complete {
        // Sampling has ended; replay never runs inside the timed frame loop.
        if config.cpu_work > 0 { heavy::verify(&entities, &materials, &config); }
        else { verify_motion(&moving, config.moving_meshes, time.elapsed_secs()); }
        let mut material_ids = HashSet::with_capacity(config.moving_meshes + 1);
        let mut mesh_count = 0;
        for (_, material) in meshes.iter() {
            assert!(material_ids.insert(material.0.id()), "each mesh must own a unique material asset");
            mesh_count += 1;
        }
        assert_eq!(mesh_count, config.moving_meshes + 1);
        let unique_materials = material_ids.len();
        let moving_meshes = config.moving_meshes;
        let cpu_work = config.cpu_work;
        let cpu_systems = if cpu_work > 0 { workload::LANES } else { 0 };
        measurement.finished = true;
        let fps = measurement.sample.frames as f64 * 1000.0 / measurement.sample.elapsed_ms;
        let mode = if measurement.threaded { "threaded" } else { "serial" };
        let workers = ComputeTaskPool::get().thread_num();
        let schedule_timings = timings.as_ref().map(|timings| timings.json()).unwrap_or_else(|| "[]".into());
        let result = format!(
            r#"{{"mode":"{mode}","fps":{fps},"frames":{},"measurement_ms":{},"warmup_ms":{},"graphics_ready":true,"compute_workers":{workers},"moving_meshes":{moving_meshes},"unique_materials":{unique_materials},"motion_verified":true,"cpu_work":{cpu_work},"cpu_systems":{cpu_systems},"cpu_verified":true,"cameras":{},"meshes":{},"unlit":true,"msaa_samples":1,"optimization":"{}","page_main_thread":true,"gpu_thread":"browser-main","schedule_timings":{schedule_timings}}}"#,
            measurement.sample.frames, measurement.sample.elapsed_ms, measurement.sample.warmup_ms,
            cameras.iter().count(), mesh_count,
            env!("BENCH_OPT_LEVEL"),
        );
        info!(target: "bevy_benchmark", "{result}");
        let element = window.document().unwrap().get_element_by_id("result").unwrap();
        element.set_text_content(Some(&result));
        element.set_attribute("data-complete", "true").unwrap();
    }
}
