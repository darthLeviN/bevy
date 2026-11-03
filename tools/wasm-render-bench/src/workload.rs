//! Independent integer lanes: bounded inputs make serial replay independent of Time.
pub const LANES: usize = 32;
pub const MAX_CPU_WORK: u32 = 1_000_000;

pub fn seed(index: usize, lane: usize, step: u32) -> u32 {
    (index as u32).wrapping_mul(0x9e3779b9)
        ^ (lane as u32 + 1).wrapping_mul(0x85ebca6b) ^ step.wrapping_mul(0xc2b2ae35)
}

pub fn compute(mut value: u32, iterations: u32) -> u32 {
    for iteration in 0..iterations {
        value ^= value.rotate_left(13);
        value = value.wrapping_mul(0x85ebca6b).wrapping_add(iteration);
        value ^= value >> 16;
    }
    value
}

pub fn reference(index: usize, step: u32, iterations: u32) -> [u32; LANES] {
    core::array::from_fn(|lane| compute(seed(index, lane, step), iterations))
}

pub fn visual(values: &[u32; LANES]) -> ([f32; 3], f32, [f32; 3]) {
    let mut sums = [0u32; 4];
    for (lane, value) in values.iter().enumerate() {
        sums[lane % 4] = sums[lane % 4].wrapping_add(value.rotate_left(lane as u32));
    }
    let unit = sums.map(|value| (value & 0xffff) as f32 / 65535.0);
    ([0.2 * (unit[0] - 0.5), 0.15 * unit[1], 0.2 * (unit[2] - 0.5)],
        unit[3] * core::f32::consts::TAU, [0.2 + unit[0] * 0.6 + unit[3] * 0.2, 0.2 + unit[1] * 0.6 + unit[3] * 0.2, 0.2 + unit[2] * 0.6 + unit[3] * 0.2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_lanes_match_serial_reference_and_feed_both_visual_outputs() {
        for iterations in [1, 7, 100] {
            for index in [0, 1, 99999] {
                for step in [1, 27, u32::MAX, 0] {
                    let expected = reference(index, step, iterations);
                    let mut partitioned = [0; LANES];
                    for worker in 0..4 {
                        for lane in (worker..LANES).step_by(4) {
                            partitioned[lane] = compute(seed(index, lane, step), iterations);
                        }
                    }
                    assert_eq!(expected, partitioned);
                    assert_ne!(expected, reference(index, step.wrapping_add(1), iterations));
                    for lane in 0..LANES {
                        let mut changed = expected;
                        changed[lane] ^= 1u32.rotate_right(lane as u32);
                        let before = visual(&expected);
                        let after = visual(&changed);
                        assert!(before.0 != after.0 || before.1 != after.1);
                        assert_ne!(before.2, after.2);
                    }
                }
            }
        }
        assert_ne!(reference(0, 1, 1), reference(1, 1, 1));
        assert_ne!(reference(0, 1, 1), reference(0, 1, 2));
    }
}
