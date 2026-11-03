#[path = "../../../../../editor-benchmark/src/timing.rs"]
mod timing;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Readiness {
    pub gpu_meshes: usize,
    pub gpu_materials: usize,
    pub material_instances: usize,
    pub required_materials: usize,
    pub scene_materials_prepared: bool,
    pub motion_updated: bool,
    pub render_targets: usize,
    pub pipelines: usize,
    pub completed_pipelines: usize,
    pub waiting_pipelines: usize,
}

impl Readiness {
    pub fn ready(self) -> bool {
        self.gpu_meshes >= 2 && self.required_materials > 0
            && self.gpu_materials >= self.required_materials
            && self.material_instances >= self.required_materials
            && self.scene_materials_prepared && self.motion_updated
            && self.render_targets > 0 && self.pipelines > 0
            && self.completed_pipelines == self.pipelines && self.waiting_pipelines == 0
    }
}

#[derive(Default)]
pub struct SamplingGate {
    window: timing::SampleWindow,
    previous_state: Option<Readiness>,
    ready_at: Option<f64>,
    pub frames: u64,
    pub elapsed_ms: f64,
    pub warmup_ms: f64,
    pub phase: &'static str,
    pub capture_epoch: u64,
}

impl SamplingGate {
    pub fn tick(&mut self, now: f64, state: Readiness) -> bool {
        self.tick_with_capture(now, state, None)
    }

    pub fn tick_with_capture(&mut self, now: f64, state: Readiness, capture: Option<u64>) -> bool {
        if self.previous_state != Some(state) {
            *self = Self { previous_state: Some(state), capture_epoch: self.capture_epoch + 1, ..Self::default() };
        }
        if !state.ready() {
            self.window.tick(now, false);
            self.phase = "Loading GPU meshes, materials, motion and pipelines";
            return false;
        }
        let ready_at = *self.ready_at.get_or_insert(now);
        let warmed = now - ready_at >= timing::WARMUP_MS;
        if warmed && capture.is_some_and(|epoch| epoch != self.capture_epoch) {
            self.phase = "Preparing CPU capture";
            return false;
        }
        self.phase = if warmed { "Measuring (5 seconds)" } else { "Warming up (5 seconds after graphics readiness)" };
        let Some(frame) = self.window.tick(now, true) else { return false; };
        if self.frames == 0 { self.warmup_ms = now - frame.interval_ms - ready_at; }
        self.frames += 1;
        self.elapsed_ms = frame.elapsed_ms;
        frame.complete
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Readiness {
        Readiness {
                    gpu_meshes: 2, gpu_materials: 2, material_instances: 2, required_materials: 2,
                    scene_materials_prepared: true, motion_updated: true, render_targets: 1, pipelines: 3,
                    completed_pipelines: 3, waiting_pipelines: 0,
                }
    }

    #[test]
    fn loading_never_counts_towards_warmup_or_measurement() {
        let mut gate = SamplingGate::default();
        assert!(!gate.tick(0.0, Readiness::default()));
        assert!(!gate.tick(30_000.0, Readiness::default()));
        assert!(!gate.tick(40_000.0, ready()));
        assert!(!gate.tick(44_999.0, ready()));
        assert_eq!(gate.frames, 0);
        assert!(!gate.tick(45_000.0, ready()));
        assert_eq!(gate.frames, 0);
        assert!(!gate.tick(45_010.0, ready()));
        assert_eq!(gate.frames, 1);
        assert_eq!(gate.elapsed_ms, 10.0);
        assert_eq!(gate.warmup_ms, 5000.0);
        assert!(!gate.tick(49_999.0, ready()));
        assert!(gate.tick(50_000.0, ready()));
    }

    #[test]
    fn pipeline_changes_restart_the_full_settling_period() {
        let mut gate = SamplingGate::default();
        gate.tick(0.0, ready());
        gate.tick(5000.0, ready());
        gate.tick(5100.0, ready());
        assert_eq!(gate.frames, 1);
        let changed = Readiness { pipelines: 4, completed_pipelines: 4, ..ready() };
        assert!(!gate.tick(5200.0, changed));
        assert_eq!(gate.frames, 0);
        assert!(!gate.tick(10_199.0, changed));
        assert!(!gate.tick(10_200.0, changed));
        assert!(!gate.tick(10_210.0, changed));
        assert_eq!(gate.elapsed_ms, 10.0);
    }

    #[test]
    fn every_material_must_be_prepared_before_settling_and_changes_reset_sampling() {
        let all = Readiness { gpu_materials: 10_001, material_instances: 10_001, required_materials: 10_001, ..ready() };
        let partial = Readiness { gpu_materials: 10_000, ..all };
        let mut gate = SamplingGate::default();
        assert!(!gate.tick(0.0, partial));
        assert!(!gate.tick(30_000.0, partial));
        assert!(!gate.tick(40_000.0, all));
        assert!(!gate.tick(45_000.0, all));
        assert!(!gate.tick(45_010.0, all));
        assert_eq!(gate.frames, 1);
        assert!(!gate.tick(45_020.0, partial));
        assert_eq!(gate.frames, 0);
        assert!(!gate.tick(46_000.0, all));
        assert!(!gate.tick(50_999.0, all));
        assert_eq!(gate.frames, 0);
        assert!(!gate.tick(51_000.0, all));
        assert!(!gate.tick(51_010.0, all));
        assert_eq!(gate.elapsed_ms, 10.0);
    }

    #[test]
    fn capture_handshake_excludes_loading_warmup_and_arbitrary_driver_delay() {
        let mut gate = SamplingGate::default();
        gate.tick_with_capture(30_000.0, ready(), Some(0));
        gate.tick_with_capture(35_000.0, ready(), Some(0));
        assert_eq!(gate.phase, "Preparing CPU capture");
        gate.tick_with_capture(55_000.0, ready(), Some(0));
        assert_eq!(gate.frames, 0);
        let epoch = gate.capture_epoch;
        gate.tick_with_capture(55_100.0, ready(), Some(epoch));
        assert_eq!(gate.phase, "Measuring (5 seconds)");
        assert_eq!(gate.frames, 0);
        gate.tick_with_capture(55_102.5, ready(), Some(epoch));
        assert_eq!(gate.frames, 1);
        assert_eq!(gate.elapsed_ms, 2.5);
        assert!(gate.tick_with_capture(60_100.0, ready(), Some(epoch)));
        assert_eq!(gate.elapsed_ms, 5000.0);
        gate.tick_with_capture(60_101.0, Readiness::default(), Some(epoch));
        gate.tick_with_capture(61_000.0, ready(), Some(epoch));
        gate.tick_with_capture(66_000.0, ready(), Some(epoch));
        assert_eq!(gate.phase, "Preparing CPU capture");
        assert!(gate.capture_epoch > epoch);
        assert_eq!(gate.frames, 0);
    }

    #[test]
    fn readiness_requires_all_gpu_inputs_and_successful_pipelines() {
        assert!(ready().ready());
        for incomplete in [
            Readiness { gpu_meshes: 1, ..ready() },
            Readiness { gpu_materials: 1, ..ready() },
            Readiness { material_instances: 1, ..ready() },
            Readiness { required_materials: 0, ..ready() },
            Readiness { motion_updated: false, ..ready() },
            Readiness { gpu_materials: 10_001, scene_materials_prepared: false, ..ready() },
            Readiness { render_targets: 0, ..ready() },
            Readiness { pipelines: 0, completed_pipelines: 0, ..ready() },
            Readiness { completed_pipelines: 2, ..ready() },
            Readiness { waiting_pipelines: 1, ..ready() },
        ] { assert!(!incomplete.ready()); }
    }
}
