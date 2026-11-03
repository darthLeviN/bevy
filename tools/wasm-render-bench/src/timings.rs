//! Scoped CPU wall-time diagnostics; no changes to executor or workload policy.
use bevy::{app::{MainScheduleOrder, SubApp}, ecs::schedule::ScheduleLabel, prelude::*, render::{RenderApp, RenderScheduleOrder}};
use bevy::platform::time::Instant;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use crate::timing_stats::Stats;

fn now() -> f64 {
    // Instant is monotonic and uses the same browser clock for every boundary.
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[derive(ScheduleLabel, Clone, Debug, PartialEq, Eq, Hash)]
struct Boundary(usize, bool);

#[derive(Default)]
struct Entry {
    name: String,
    stats: Stats,
}

#[derive(Resource, Clone, Default)]
pub struct Timings(Arc<Mutex<Vec<Entry>>>, Arc<AtomicBool>);

impl Timings {
    pub fn collecting(&self, enabled: bool) { self.1.store(enabled, Ordering::Relaxed); }

    pub fn reset(&self) {
        for entry in self.0.lock().unwrap().iter_mut() {
            entry.stats.reset();
        }
    }

    pub fn json(&self) -> String {
        let entries = self.0.lock().unwrap();
        let rows: Vec<_> = entries.iter().filter(|entry| entry.stats.calls > 0).map(|entry| {
            let (p50, p95) = entry.stats.percentiles();
            format!(r#"{{"schedule":"{}","calls":{},"mean_ms":{},"p50_ms":{p50},"p95_ms":{p95}}}"#,
                entry.name, entry.stats.calls, entry.stats.milliseconds / entry.stats.calls as f64)
        }).collect();
        format!("[{}]", rows.join(","))
    }
}

pub fn install(app: &mut App) {
    let timings = Timings::default();
    app.insert_resource(timings.clone());
    let labels = app.world().resource::<MainScheduleOrder>().labels.clone();
    let mut order = Vec::new();
    for label in labels {
        let index = instrument(app.main_mut(), &timings, format!("main:{label:?}"));
        order.extend([Boundary(index, false).intern(), label, Boundary(index, true).intern()]);
    }
    app.world_mut().resource_mut::<MainScheduleOrder>().labels = order;
    let render = app.sub_app_mut(RenderApp);
    let labels = render.world().resource::<RenderScheduleOrder>().labels.clone();
    let mut order = Vec::new();
    for label in labels {
        let index = instrument(render, &timings, format!("render:{label:?}"));
        order.extend([Boundary(index, false).intern(), label, Boundary(index, true).intern()]);
    }
    render.world_mut().resource_mut::<RenderScheduleOrder>().labels = order;
    if let Some(mut extract) = render.take_extract() {
        let index = timings.0.lock().unwrap().len();
        timings.0.lock().unwrap().push(Entry { name: "render:extract_callback".into(), ..default() });
        render.set_extract(move |main, sub| {
            let collecting = timings.1.load(Ordering::Relaxed);
            if collecting { timings.0.lock().unwrap()[index].stats.begin(now()); }
            extract(main, sub);
            if collecting { timings.0.lock().unwrap()[index].stats.end(now()); }
        });
    }
}

fn instrument(app: &mut SubApp, timings: &Timings, name: String) -> usize {
    let index = {
        let mut entries = timings.0.lock().unwrap();
        let index = entries.len();
        entries.push(Entry { name, ..default() });
        index
    };
    let start = timings.clone();
    let end = timings.clone();
    let mut before = Schedule::new(Boundary(index, false));
    before.set_executor(bevy::ecs::schedule::SingleThreadedExecutor::new());
    before.add_systems(move || {
        if start.1.load(Ordering::Relaxed) { start.0.lock().unwrap()[index].stats.begin(now()); }
    });
    let mut after = Schedule::new(Boundary(index, true));
    after.set_executor(bevy::ecs::schedule::SingleThreadedExecutor::new());
    after.add_systems(move || {
        if end.1.load(Ordering::Relaxed) { end.0.lock().unwrap()[index].stats.end(now()); }
    });
    app.add_schedule(before);
    app.add_schedule(after);
    index
}
