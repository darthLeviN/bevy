use bevy::prelude::*;
use bevy::light::cluster::ClusterConfig;
use bevy::render::view::{DebandDither, Tonemapping};
use bevy::ecs::{schedule::{Schedules, SingleThreadedExecutor}, system::NonSendMarker};
use bevy::tasks::{ComputeTaskPool, AsyncComputeTaskPool, IoTaskPool, TaskPoolBuilder};
use wasm_bindgen::prelude::*;
use bevy::render::{Render, RenderApp, RenderSystems, mesh::RenderMesh, render_asset::RenderAssets,
    render_resource::{PipelineCache, CachedPipelineState}, view::ViewTarget};
use std::sync::{Arc, Mutex};
mod readiness;
use readiness::{Readiness, SamplingGate};

#[derive(Resource, Clone, Default)]
struct GraphicsReadiness(Arc<Mutex<Readiness>>);

fn publish_readiness(
    state: Res<GraphicsReadiness>, meshes: Res<RenderAssets<RenderMesh>>,
    cache: Res<PipelineCache>, targets: Query<&ViewTarget>, _: NonSendMarker,
) {
    let mut pipelines = 0;
    let mut completed_pipelines = 0;
    for pipeline in cache.pipelines() {
        pipelines += 1;
        if matches!(pipeline.state, CachedPipelineState::Ok(_)) { completed_pipelines += 1; }
    }
    *state.0.lock().unwrap() = Readiness {
        gpu_meshes: meshes.iter().count(), render_targets: targets.iter().count(),
        pipelines, completed_pipelines, waiting_pipelines: cache.waiting_pipelines().count(),
    };
}

#[derive(Resource, Default)]
struct Measurement {
    sample: SamplingGate,
    displayed_phase: &'static str,
    finished: bool,
    threaded: bool,
}

#[wasm_bindgen]
pub fn report_worker_failure(message: String) {
    bevy::tasks::report_web_worker_failure(&message);
}

#[wasm_bindgen]
pub async fn start(threaded: bool, shim_url: String, worker_url: String) {
    wasm_thread::Builder::new().wasm_bindgen_shim_url(shim_url).worker_script_url(worker_url).set_default();
    if threaded {
        bevy::tasks::init_web_thread_pools(4).await;
    } else {
        ComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
        AsyncComputeTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
        IoTaskPool::get_or_init(|| TaskPoolBuilder::new().num_threads(0).build());
    }
    let mut app = App::new();
    let readiness = GraphicsReadiness::default();
    app.insert_resource(readiness.clone());
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
    app.sub_app_mut(RenderApp).insert_resource(readiness)
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
    app.run();
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(10.0, 10.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb(0.6, 0.6, 0.6),
                    unlit: true,
                    ..default()
                })),
    ));
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(1.0, 1.0, 1.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb(0.3, 0.5, 0.9),
                    unlit: true,
                    ..default()
                })),
        Transform::from_xyz(0.0, 0.5, 0.0),
    ));
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
        Msaa::Off,
        Tonemapping::None,
        DebandDither::Disabled,
        ClusterConfig::Single,
        Transform::from_xyz(0.0, 5.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

fn measure(mut measurement: ResMut<Measurement>, readiness: Res<GraphicsReadiness>, cameras: Query<&Camera>, meshes: Query<&Mesh3d>, _: NonSendMarker) {
    if measurement.finished {
        return;
    }
    let window = web_sys::window().expect("browser window");
    let now = window.performance().expect("performance clock").now();
    let ready = *readiness.0.lock().unwrap();
    let complete = measurement.sample.tick(now, ready);
    if measurement.displayed_phase != measurement.sample.phase {
        measurement.displayed_phase = measurement.sample.phase;
        window.document().unwrap().get_element_by_id("result").unwrap()
            .set_text_content(Some(measurement.sample.phase));
    }
    if complete {
        measurement.finished = true;
        let fps = measurement.sample.frames as f64 * 1000.0 / measurement.sample.elapsed_ms;
        let mode = if measurement.threaded { "threaded" } else { "serial" };
        let workers = ComputeTaskPool::get().thread_num();
        let result = format!(
            r#"{{"mode":"{mode}","fps":{fps},"frames":{},"measurement_ms":{},"warmup_ms":{},"graphics_ready":true,"compute_workers":{workers},"cameras":{},"meshes":{},"unlit":true,"msaa_samples":1,"optimization":"{}","page_main_thread":true,"gpu_thread":"browser-main"}}"#,
            measurement.sample.frames, measurement.sample.elapsed_ms, measurement.sample.warmup_ms,
            cameras.iter().count(), meshes.iter().count(),
            env!("BENCH_OPT_LEVEL"),
        );
        info!(target: "bevy_benchmark", "{result}");
        let element = window.document().unwrap().get_element_by_id("result").unwrap();
        element.set_text_content(Some(&result));
        element.set_attribute("data-complete", "true").unwrap();
    }
}
