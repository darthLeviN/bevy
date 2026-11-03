//! Submission-window attribution, independent of callback arrival order and clocks.
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct Window {
    next: u64,
    pub tag: Option<u64>,
    pending: HashSet<u64>,
    samples: HashMap<u64, f64>,
    expected: usize,
}

impl Window {
    pub fn reset(&mut self) {
        self.tag = None;
        self.pending.clear();
        self.samples.clear();
        self.expected = 0;
    }

    pub fn submit(&mut self) {
        self.next += 1;
        self.tag = Some(self.next);
        self.pending.insert(self.next);
        self.expected += 1;
    }

    pub fn receive(&mut self, tag: Option<u64>, ms: Option<f64>, missed: u32) {
        let Some(tag) = tag else { return; };
        if !self.pending.remove(&tag) { return; }
        if missed == 0 {
            if let Some(ms) = ms.filter(|v| v.is_finite() && *v >= 0.0) {
                self.samples.insert(tag, ms);
            }
        }
    }

    pub fn drained(&self) -> bool { self.pending.is_empty() }

    pub fn json(&self) -> String {
        let count = self.samples.len();
        let missing = self.expected - count;
        if count == 0 {
            return format!(r#"{{"supported":false,"samples":0,"expected_samples":{},"missing_samples":{missing},"mean_ms":null,"p50_ms":null,"p95_ms":null,"reason":"WebGPU timestamp-query unavailable, readback failed, or no complete instrumented pass samples"}}"#, self.expected);
        }
        let mut values: Vec<_> = self.samples.values().copied().collect();
        values.sort_by(f64::total_cmp);
        let mean = values.iter().sum::<f64>() / count as f64;
        let p50 = values[((count as f64 * 0.5).ceil() as usize).saturating_sub(1)];
        let p95 = values[((count as f64 * 0.95).ceil() as usize).saturating_sub(1)];
        format!(r#"{{"supported":true,"source":"timestamp-query","scope":"sum_disjoint_instrumented_passes","samples":{count},"expected_samples":{},"missing_samples":{missing},"mean_ms":{mean},"p50_ms":{p50},"p95_ms":{p95}}}"#, self.expected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_out_of_order_and_duplicate_results_keep_submission_attribution() {
        let mut w = Window::default();
        w.submit(); let warm = w.tag;
        w.reset();
        w.submit(); let a = w.tag;
        w.submit(); let b = w.tag;
        w.receive(warm, Some(100.0), 0);
        w.receive(b, Some(3.0), 0);
        w.receive(b, Some(99.0), 0);
        assert!(!w.drained());
        w.tag = None; // sample window closed, callbacks still accepted
        w.receive(a, Some(1.0), 0);
        assert!(w.drained());
        assert!(w.json().contains("\"mean_ms\":2"));
        assert!(w.json().contains("\"samples\":2"));
    }
    #[test]
    fn unsupported_partial_exhausted_and_invalid_are_not_zero_samples() {
        let mut w = Window::default();
        for (ms, missed) in [(None, 0), (Some(2.0), 1), (Some(f64::NAN), 0)] {
            w.submit(); w.receive(w.tag, ms, missed);
        }
        assert!(w.drained());
        assert!(w.json().contains("\"supported\":false"));
        w.submit(); w.receive(w.tag, Some(0.0), 0);
        assert!(w.json().contains("\"supported\":true"));
        assert!(w.json().contains("\"missing_samples\":3"));
        w.submit();
        assert!(!w.drained());
        assert!(w.json().contains("\"missing_samples\":4"));
    }
}
