//! Schedule timing accumulation with an injected monotonic clock value.
#[derive(Default)]
pub struct Stats {
    start: Option<f64>,
    pub calls: usize,
    pub milliseconds: f64,
    samples: Vec<f64>,
}

impl Stats {
    pub fn begin(&mut self, now: f64) { self.start = Some(now); }

    pub fn end(&mut self, now: f64) {
        if let Some(start) = self.start.take() {
            self.record(now - start);
        }
    }

    pub fn record(&mut self, milliseconds: f64) {
        if !milliseconds.is_finite() || milliseconds < 0.0 { return; }
        self.calls += 1;
        self.milliseconds += milliseconds;
        self.samples.push(milliseconds);
    }

    pub fn percentiles(&self) -> (f64, f64) {
        if self.samples.is_empty() { return (0.0, 0.0); }
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let percentile = |p: f64| sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)];
        (percentile(0.5), percentile(0.95))
    }

    pub fn reset(&mut self) {
        self.start = None;
        self.calls = 0;
        self.milliseconds = 0.0;
        self.samples.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregation_rejects_invalid_values_and_uses_nearest_rank_percentiles() {
        let mut stats = Stats::default();
        for value in [4.0, 1.0, 3.0, 2.0, f64::NAN, -1.0, f64::INFINITY] { stats.record(value); }
        assert_eq!(stats.calls, 4);
        assert_eq!(stats.milliseconds / stats.calls as f64, 2.5);
        assert_eq!(stats.percentiles(), (2.0, 4.0));
        stats.reset();
        assert_eq!(stats.percentiles(), (0.0, 0.0));
    }

    #[test]
    fn counts_only_completed_spans_and_reset_discards_warmup() {
        let mut stats = Stats::default();
        stats.end(1.0);
        assert_eq!(stats.calls, 0);
        stats.begin(2.0);
        stats.end(5.0);
        stats.end(9.0);
        assert_eq!(stats.calls, 1);
        assert_eq!(stats.milliseconds, 3.0);
        stats.begin(10.0);
        stats.reset();
        stats.end(12.0);
        assert_eq!(stats.calls, 0, "a warmup span must not cross the reset boundary");
        stats.begin(15.0);
        stats.end(17.0);
        stats.begin(20.0);
        stats.end(24.0);
        assert_eq!(stats.calls, 2);
        assert_eq!(stats.milliseconds / stats.calls as f64, 3.0);
    }
}
