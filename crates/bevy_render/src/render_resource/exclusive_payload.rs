//! Exclusive, scoped payload access. Generic shared buffer operations remain atomic.
use alloc::vec::Vec;
use core::{marker::PhantomData, mem::{size_of, MaybeUninit}, ptr, sync::atomic::{AtomicBool, AtomicU32, Ordering}};
use super::AtomicPod;

/// Borrows the allocation exclusively, excluding atomic payload access, growth and
/// upload until all scoped workers and record handles have finished.
pub struct ExclusivePayload<'a, T: AtomicPod> {
    pointer: *mut T::Blob,
    claims: Vec<AtomicBool>,
    borrow: PhantomData<&'a mut [T::Blob]>,
}
// SAFETY: The exclusive slice borrow excludes external access. Each slot can be
// claimed exactly once for the entire phase, and only its non-Sync handle can
// access its bytes. Neither the pointer nor blob references escape this module.
unsafe impl<T: AtomicPod> Sync for ExclusivePayload<'_, T> {}

impl<'a, T: AtomicPod> ExclusivePayload<'a, T> {
    pub(crate) fn new(values: &'a mut [T::Blob]) -> Self {
        assert_eq!(size_of::<T>(), size_of::<T::Blob>());
        Self { pointer: values.as_mut_ptr(), claims: (0..values.len()).map(|_| AtomicBool::new(false)).collect(), borrow: PhantomData }
    }

    /// Rejects duplicate destinations before ordinary access, including duplicates
    /// in different tasks. Claims deliberately persist until the phase ends.
    pub fn claim(&self, index: u32) -> PayloadRecord<'_, T> {
        assert!(!self.claims[index as usize].swap(true, Ordering::Relaxed), "duplicate payload destination");
        PayloadRecord { phase: self, index: index as usize, not_sync: PhantomData }
    }

    /// Checked append reservation: failure leaves the cursor unchanged, so even
    /// caught capacity/overflow panics cannot wrap and alias an earlier writer.
    pub fn append(&self, cursor: &AtomicU32, values: &[T]) -> u32 {
        let count = u32::try_from(values.len()).expect("history batch too large");
        let first = cursor.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| {
            old.checked_add(count).filter(|end| *end as usize <= self.claims.len())
        }).expect("history batch exceeded pre-allocated capacity");
        for (offset, value) in values.iter().enumerate() {
            self.claim(first + offset as u32).write(*value);
        }
        first
    }
}

/// A unique record capability; no references into atomic storage are constructed.
pub struct PayloadRecord<'a, T: AtomicPod> {
    phase: &'a ExclusivePayload<'a, T>,
    index: usize,
    not_sync: PhantomData<core::cell::Cell<()>>,
}
impl<T: AtomicPod> PayloadRecord<'_, T> {
    pub fn read(&self) -> T {
        let mut value = MaybeUninit::<T>::uninit();
        // SAFETY: claim checked bounds and uniqueness. AtomicPodBlob guarantees
        // initialized POD-equivalent bytes. Byte copies need no T alignment in
        // blob storage (e.g. T may be align(16), its blob only align(8)). No
        // atomic payload access is possible during this exclusive phase; see
        // https://doc.rust-lang.org/std/sync/atomic/index.html#memory-model-for-atomic-accesses
        unsafe {
            ptr::copy_nonoverlapping(self.phase.pointer.add(self.index).cast::<u8>(), value.as_mut_ptr().cast::<u8>(), size_of::<T>());
            value.assume_init()
        }
    }
    pub fn write(&mut self, value: T) {
        // SAFETY: Same exclusive claim and bounds as read; &mut self excludes
        // simultaneous access through this handle. All bit patterns are valid.
        unsafe {
            ptr::copy_nonoverlapping((&value as *const T).cast::<u8>(), self.phase.pointer.add(self.index).cast::<u8>(), size_of::<T>());
        }
    }
}
