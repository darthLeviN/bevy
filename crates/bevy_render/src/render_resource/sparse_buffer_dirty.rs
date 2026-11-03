//! CPU-only change detection and dirty marking shared by sparse buffer writers.

use core::sync::atomic::{AtomicU64, Ordering};

/// Executes a sparse-buffer write only if it changes the stored representation.
#[inline]
pub(crate) fn write_if_changed(previous: &[u8], value: &[u8], write: impl FnOnce()) {
    if previous != value {
        write();
    }
}

#[inline]
pub(crate) fn note_changed_index(index: u32, summary: &[AtomicU64], dirty_bits: &[AtomicU64]) {
    let word_index = index as usize / 64;
    let mask = 1 << (index % 64);
    let word = &dirty_bits[word_index];
    // Upload/drain requires exclusive access to the owning buffer. During the
    // shared writer phase bits only transition from clean to dirty.
    if word.load(Ordering::Relaxed) & mask != 0 {
        return;
    }
    if word.fetch_or(mask, Ordering::Relaxed) == 0 {
        // Only the first writer to a block needs to mark its summary bit.
        // The task join publishes both levels before the exclusive upload.
        summary[word_index / 64].fetch_or(1 << (word_index % 64), Ordering::Relaxed);
    }
}

/// Marks a bounded batch, merging noncontiguous indices before touching shared words.
/// Writers may share words; draining still requires exclusive access after joining writers.
pub(crate) fn note_changed_batch(indices: impl IntoIterator<Item = u32>, summary: &[AtomicU64], dirty_bits: &[AtomicU64]) {
    let mut words = [(0usize, 0u64); 128];
    let mut len = 0;
    for index in indices {
        assert!(len < words.len(), "dirty batch exceeds 128 entries");
        words[len] = (index as usize / 64, 1 << (index % 64));
        len += 1;
    }
    words[..len].sort_unstable_by_key(|entry| entry.0);
    let mut cursor = 0;
    while cursor < len {
        let (word_index, mut mask) = words[cursor];
        cursor += 1;
        while cursor < len && words[cursor].0 == word_index {
            mask |= words[cursor].1;
            cursor += 1;
        }
        let word = &dirty_bits[word_index];
        if word.load(Ordering::Relaxed) & mask != mask
            && word.fetch_or(mask, Ordering::Relaxed) == 0
        {
            summary[word_index / 64].fetch_or(1 << (word_index % 64), Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_marking_matches_reference_across_drains_and_reused_indices() {
        let count: usize = 10001;
        let dirty: Vec<_> = (0..count.div_ceil(64)).map(|_| AtomicU64::new(0)).collect();
        let summary: Vec<_> = (0..dirty.len().div_ceil(64)).map(|_| AtomicU64::new(0)).collect();
        for frame in 0..8 {
            let expected: Vec<_> = (0..count).map(|index| (index + frame) % 3 != 0).collect();
            std::thread::scope(|scope| {
                for worker in 0..4 {
                    let dirty = &dirty;
                    let summary = &summary;
                    let expected = &expected;
                    scope.spawn(move || {
                        // Interleaving workers deliberately share dirty and summary words.
                        for index in (worker..count).step_by(4) {
                            if expected[index] {
                                for _ in 0..3 {
                                    note_changed_index(index as u32, summary, dirty);
                                }
                            }
                        }
                        // Contend on exactly the same bit as well as adjacent bits.
                        note_changed_index(64, summary, dirty);
                    });
                }
            });
            for index in 0..count {
                assert_eq!(dirty[index / 64].load(Ordering::Relaxed) & (1 << (index % 64)) != 0,
                    expected[index] || index == 64);
            }
            for (index, word) in dirty.iter().enumerate() {
                assert_eq!(summary[index / 64].load(Ordering::Relaxed) & (1 << (index % 64)) != 0,
                    word.load(Ordering::Relaxed) != 0);
            }
            // Simulate exclusive upload/drain, then re-use the same slots next frame.
            for word in dirty.iter().chain(summary.iter()) {
                word.store(0, Ordering::Relaxed);
            }
        }
    }

    #[test]
    fn byte_exact_updates_preserve_dirty_state_and_reused_slots() {
        use core::cell::Cell;
        let stored = Cell::new([0u8; 32]);
        let dirty = [AtomicU64::new(0)];
        let summary = [AtomicU64::new(0)];
        let writes = Cell::new(0);
        let update = |value: [u8; 32]| {
            write_if_changed(&stored.get(), &value, || {
                stored.set(value);
                writes.set(writes.get() + 1);
                note_changed_index(7, &summary, &dirty);
            });
        };
        update([0; 32]);
        assert_eq!(writes.get(), 0);
        assert_eq!(dirty[0].load(Ordering::Relaxed), 0);
        // Model-space AABB payloads may contain signed zero and infinities.
        // Compare their representation, not floating-point PartialEq.
        for bits in [(-0.0f32).to_bits(), f32::INFINITY.to_bits(), 0x7fc00001, 0x7fc00002] {
            let mut value = [0; 32];
            value[..4].copy_from_slice(&bits.to_ne_bytes());
            update(value);
            update(value);
            assert_eq!(stored.get(), value);
            assert_eq!(dirty[0].load(Ordering::Relaxed), 1 << 7);
            assert_eq!(summary[0].load(Ordering::Relaxed), 1);
            // Exclusive upload clears dirty state. An unchanged update stays clean.
            dirty[0].store(0, Ordering::Relaxed);
            summary[0].store(0, Ordering::Relaxed);
            update(value);
            assert_eq!(dirty[0].load(Ordering::Relaxed), 0);
        }
        assert_eq!(writes.get(), 4);
        // Removing an instance doesn't clear the culling slot; a replacement
        // at the same index must compare against the old occupant's bytes.
        update([42; 32]);
        assert_eq!(stored.get(), [42; 32]);
        assert_eq!(writes.get(), 5);
        assert_eq!(dirty[0].load(Ordering::Relaxed), 1 << 7);
        update([42; 32]);
        assert_eq!(dirty[0].load(Ordering::Relaxed), 1 << 7);
    }

    #[test]
    fn parallel_updates_and_slot_reuse_match_full_upload_bytes() {
        use core::sync::atomic::AtomicU32;
        let count: usize = 10001;
        let values: Vec<_> = (0..count).map(|_| AtomicU32::new(0)).collect();
        let dirty: Vec<_> = (0..count.div_ceil(64)).map(|_| AtomicU64::new(0)).collect();
        let summary: Vec<_> = (0..dirty.len().div_ceil(64)).map(|_| AtomicU64::new(0)).collect();
        let mut uploaded = vec![0u32; count];
        for frame in 0..8u32 {
            std::thread::scope(|scope| {
                for worker in 0..4 {
                    let values = &values;
                    let dirty = &dirty;
                    let summary = &summary;
                    scope.spawn(move || {
                        for index in (worker..count).step_by(4) {
                            // Removed/unchanged slots retain their bytes; other slots
                            // acquire a new occupant/value on subsequent frames.
                            if (index as u32 + frame) % 3 == 0 {
                                continue;
                            }
                            let value = (index as u32).wrapping_mul(0x9e3779b9) ^ frame;
                            for _ in 0..2 {
                                let previous = values[index].load(Ordering::Relaxed);
                                write_if_changed(&previous.to_ne_bytes(), &value.to_ne_bytes(), || {
                                    values[index].store(value, Ordering::Relaxed);
                                    note_changed_index(index as u32, summary, dirty);
                                });
                            }
                        }
                    });
                }
            });
            for index in 0..count {
                let block = index / 64;
                if summary[block / 64].load(Ordering::Relaxed) & (1 << (block % 64)) != 0
                    && dirty[block].load(Ordering::Relaxed) & (1 << (index % 64)) != 0
                {
                    uploaded[index] = values[index].load(Ordering::Relaxed);
                }
                assert_eq!(uploaded[index].to_ne_bytes(), values[index].load(Ordering::Relaxed).to_ne_bytes());
            }
            for word in dirty.iter().chain(summary.iter()) {
                word.store(0, Ordering::Relaxed);
            }
        }
    }

    #[test]
    fn sparse_upload_bytes_match_full_copy() {
        let mut payload = [[0u8; 16]; 128];
        let mut uploaded = payload;
        let dirty = [AtomicU64::new(0), AtomicU64::new(0)];
        let summary = [AtomicU64::new(0)];
        for index in [0, 63, 64, 127, 0, 64] {
            payload[index as usize] = [index as u8; 16];
            note_changed_index(index, &summary, &dirty);
        }
        for index in 0..128 {
            if dirty[index / 64].load(Ordering::Relaxed) & (1 << (index % 64)) != 0 {
                uploaded[index] = payload[index];
            }
        }
        assert_eq!(dirty[0].load(Ordering::Relaxed), 1 | (1 << 63));
        assert_eq!(dirty[1].load(Ordering::Relaxed), 1 | (1 << 63));
        assert_eq!(summary[0].load(Ordering::Relaxed), 3);
        assert_eq!(uploaded, payload, "sparse upload must equal a full byte copy");
    }
}
