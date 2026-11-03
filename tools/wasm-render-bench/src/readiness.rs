#[path = "../../../../../editor-benchmark/src/timing.rs"]
mod timing;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Readiness {
    pub gpu_meshes: usize,
    pub render_targets: usize,
    pub pipelines: usize,
    pub completed_pipelines: usize,
    pub waiting_pipelines: usize,
}

impl Readiness {
    pub fn ready(self) -> bool {
        self.gpu_meshes >= 2 && self.render_targets > 0 && self.pipelines > 0
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
}

impl SamplingGate {
    pub fn tick(&mut self, now: f64, state: Readiness) -> bool {
        if self.previous_state != Some(state) {
            *self = Self { previous_state: Some(state), ..Self::default() };
        }
        if !state.ready() {
            self.window.tick(now, false);
            self.phase = "Loading GPU meshes and pipelines";
            return false;
        }
        let ready_at = *self.ready_at.get_or_insert(now);
        let warmed = now - ready_at >= timing::WARMUP_MS;
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
        Readiness { gpu_meshes: 2, render_targets: 1, pipelines: 3, completed_pipelines: 3, waiting_pipelines: 0 }
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
    fn readiness_requires_all_gpu_inputs_and_successful_pipelines() {
        assert!(ready().ready());
        for incomplete in [
            Readiness { gpu_meshes: 1, ..ready() },
            Readiness { render_targets: 0, ..ready() },
            Readiness { pipelines: 0, completed_pipelines: 0, ..ready() },
            Readiness { completed_pipelines: 2, ..ready() },
            Readiness { waiting_pipelines: 1, ..ready() },
        ] { assert!(!incomplete.ready()); }
    }
}
