//! Schedule timing accumulation with an injected monotonic clock value.
#[derive(Default)]
pub struct Stats {
    start: Option<f64>,
    pub calls: usize,
    pub milliseconds: f64,
}

impl Stats {
    pub fn begin(&mut self, now: f64) { self.start = Some(now); }

    pub fn end(&mut self, now: f64) {
        if let Some(start) = self.start.take() {
            self.calls += 1;
            self.milliseconds += now - start;
        }
    }

    pub fn reset(&mut self) { *self = Self::default(); }
}

#[cfg(test)]
mod tests {
    use super::*;

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
