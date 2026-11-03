//! Fixed GPU pages: growing the pool never replaces a live binding's buffer.
use core::ops::Range;

#[derive(Clone, Copy, Debug)]
pub(crate) struct UniformSlot {
    pub page: usize,
    pub offset: u64,
    pub size: u64,
}

struct Page<B> {
    buffer: B,
    bytes: Vec<u8>,
    stride: usize,
    free: Vec<usize>,
    live: usize,
    dirty: Option<Range<usize>>,
}

pub(crate) struct UniformPages<B> {
    pages: Vec<Option<Page<B>>>,
}

impl<B> Default for UniformPages<B> {
    fn default() -> Self { Self { pages: Vec::new() } }
}

impl<B> UniformPages<B> {
    pub fn allocate(
        &mut self,
        data: &[u8],
        alignment: u32,
        max_binding_size: u64,
        max_buffer_size: u64,
        create: impl FnOnce(u64) -> B,
    ) -> UniformSlot {
        assert!(!data.is_empty() && data.len() as u64 <= max_binding_size);
        // Device uniform alignment is a power of two; uploads also require four bytes.
        let alignment = (alignment as usize).max(4);
        assert!(alignment.is_power_of_two());
        let stride = data.len().checked_next_multiple_of(alignment).unwrap();
        let capacity = (max_buffer_size.min(64 * 1024) / stride as u64).max(1) as usize;
        let page_size = stride.checked_mul(capacity).unwrap();
        assert!(page_size as u64 <= max_buffer_size);
        let page = self.pages.iter().position(|page| page.as_ref().is_some_and(|p| p.stride == stride && !p.free.is_empty()))
            .unwrap_or_else(|| {
                let index = self.pages.iter().position(Option::is_none).unwrap_or(self.pages.len());
                let page = Some(Page {
                    buffer: create(page_size as u64), bytes: vec![0; page_size], stride,
                    free: (0..capacity).rev().collect(), live: 0, dirty: None,
                });
                if index == self.pages.len() { self.pages.push(page); } else { self.pages[index] = page; }
                index
            });
        let p = self.pages[page].as_mut().unwrap();
        let offset = p.free.pop().unwrap() * p.stride;
        p.live += 1;
        let slot = UniformSlot { page, offset: offset as u64, size: data.len() as u64 };
        self.update(slot, data);
        slot
    }

    pub fn buffer(&self, slot: UniformSlot) -> &B {
        &self.pages[slot.page].as_ref().unwrap().buffer
    }

    pub fn update(&mut self, slot: UniformSlot, data: &[u8]) {
        assert_eq!(slot.size as usize, data.len());
        let p = self.pages[slot.page].as_mut().unwrap();
        let start = slot.offset as usize;
        let end = start + p.stride;
        p.bytes[start..end].fill(0);
        p.bytes[start..start + data.len()].copy_from_slice(data);
        p.dirty = Some(match p.dirty.take() {
            Some(range) => range.start.min(start)..range.end.max(end),
            None => start..end,
        });
    }

    pub fn free(&mut self, slot: UniformSlot) {
        let p = self.pages[slot.page].as_mut().unwrap();
        // Clear pending bytes as well as padding before this region can be reused.
        let start = slot.offset as usize;
        p.bytes[start..start + p.stride].fill(0);
        p.free.push(start / p.stride);
        p.live -= 1;
        if p.live == 0 { self.pages[slot.page] = None; }
    }

    pub fn upload(&mut self, mut write: impl FnMut(&B, u64, &[u8])) {
        for p in self.pages.iter_mut().flatten() {
            if let Some(range) = p.dirty.take() {
                write(&p.buffer, range.start as u64, &p.bytes[range]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_thousand_independent_bindings_batch_and_reuse() {
        let mut pages = UniformPages::default();
        let mut next = 0;
        let mut slots = Vec::new();
        for i in 0u32..10000 {
            slots.push(pages.allocate(&i.to_le_bytes(), 256, 65536, 65536, |_| { next += 1; next }));
        }
        assert_eq!(next, 40);
        let mut writes = 0;
        pages.upload(|_, offset, bytes| {
            writes += 1;
            assert_eq!(offset, 0);
            for chunk in bytes.chunks_exact(256) { assert!(chunk[4..].iter().all(|b| *b == 0)); }
        });
        assert_eq!(writes, 40);
        for (i, slot) in slots.iter().enumerate() {
            assert_eq!(slot.offset % 256, 0);
            assert_eq!(slot.size, 4);
            let p = pages.pages[slot.page].as_ref().unwrap();
            assert_eq!(&p.bytes[slot.offset as usize..slot.offset as usize + 4], &(i as u32).to_le_bytes());
        }
        pages.update(slots[1], &[9; 4]);
        pages.update(slots[3], &[7; 4]);
        pages.free(slots[1]);
        let reused = pages.allocate(&[5; 3], 256, 65536, 65536, |_| panic!("reuse"));
        assert_eq!((reused.page, reused.offset), (slots[1].page, slots[1].offset));
        pages.upload(|_, offset, bytes| {
            assert_eq!(offset, 256);
            assert_eq!(bytes.len(), 768);
            assert_eq!(&bytes[..4], &[5, 5, 5, 0]);
            assert_eq!(&bytes[256..260], &2u32.to_le_bytes());
            assert_eq!(&bytes[512..516], &[7; 4]);
        });
        pages.upload(|_, _, _| panic!("clean"));
    }

    #[test]
    fn sizes_limits_and_empty_page_pending_uploads() {
        let mut pages = UniformPages::default();
        let a = pages.allocate(&[1; 3], 1, 16, 32, |size| { assert_eq!(size, 32); 1 });
        let b = pages.allocate(&[2; 9], 8, 16, 32, |size| { assert_eq!(size, 32); 2 });
        assert_ne!(a.page, b.page);
        assert_eq!(b.size, 9);
        pages.free(a);
        pages.free(b);
        pages.upload(|_, _, _| panic!("freed writes"));
        assert!(pages.pages.iter().all(Option::is_none));
        let c = pages.allocate(&[3; 16], 256, 16, 256, |size| { assert_eq!(size, 256); 3 });
        assert_eq!(*pages.buffer(c), 3);
    }

    #[test]
    #[should_panic]
    fn rejects_binding_over_device_limit() {
        UniformPages::default().allocate(&[0; 17], 256, 16, 65536, |_| ());
    }
}
