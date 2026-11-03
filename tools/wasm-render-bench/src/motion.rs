//! Deterministic scene layout, colors and motion, independent of Bevy and Wasm.
pub const MAX_MOVING_MESHES: usize = 100_000;
pub const SPACING: f32 = 2.4;

pub fn validate_config(threaded: bool, workers: usize, moving_meshes: usize) -> Result<usize, &'static str> {
    if !(1..=MAX_MOVING_MESHES).contains(&moving_meshes) {
        return Err("moving_meshes must be in 1..=100000");
    }
    if threaded && !(1..=32).contains(&workers) {
        return Err("threaded workers must be in 1..=32");
    }
    Ok(if threaded { workers } else { 0 })
}

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub columns: usize,
    pub rows: usize,
    pub ground: [f32; 2],
    pub camera: [f32; 3],
    pub far: f32,
}

impl Layout {
    pub fn new(count: usize) -> Self {
        assert!((1..=MAX_MOVING_MESHES).contains(&count));
        let columns = (count as f64).sqrt().ceil() as usize;
        let rows = count.div_ceil(columns);
        let width = (columns - 1) as f32 * SPACING;
        let depth = (rows - 1) as f32 * SPACING;
        // A bounding sphere fits the entire grid at the default 45-degree
        // vertical FOV. The 16:9 viewport has a wider horizontal field of view.
        let radius = ((width * 0.5 + 1.5).powi(2) + (depth * 0.5 + 1.5).powi(2) + 2.0).sqrt();
        let distance = radius / (core::f32::consts::FRAC_PI_8).sin() * 1.1;
        Self {
            columns, rows,
            ground: [(width + 4.0).max(10.0), (depth + 4.0).max(10.0)],
            camera: if count == 1 { [0.0, 5.0, 8.0] } else { [0.0, distance * 0.6, distance * 0.8] },
            far: (distance * 2.0).max(1000.0),
        }
    }

    pub fn base(self, index: usize) -> [f32; 3] {
        [
            (index % self.columns) as f32 * SPACING - (self.columns - 1) as f32 * SPACING * 0.5,
            0.5,
            (index / self.columns) as f32 * SPACING - (self.rows - 1) as f32 * SPACING * 0.5,
        ]
    }
}

/// Odd multiplication modulo 2^24 is injective on the supported index range.
/// Index zero is approximately the original cube's (0.3, 0.5, 0.9) color.
pub fn color_rgb(index: usize) -> [u8; 3] {
    let rgb = (index as u32).wrapping_mul(0x9e3779).wrapping_add(0x4d80e6) & 0xffffff;
    [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub translation: [f32; 3],
    pub yaw: f32,
}

pub fn pose(base: [f32; 3], index: usize, seconds: f32) -> Pose {
    let phase = (index % 1024) as f32 * 0.137;
    Pose {
        translation: [
            base[0] + 0.2 * ((seconds * 0.9 + phase).sin() - phase.sin()),
            base[1] + 0.15 * (1.0 - (seconds * 1.1 + phase).cos()),
            base[2] + 0.2 * ((seconds * 0.7 + phase).sin() - phase.sin()),
        ],
        yaw: seconds * 0.6 + phase,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn config_ranges_and_serial_workers_are_explicit() {
        assert_eq!(validate_config(false, 32, 1), Ok(0));
        assert_eq!(validate_config(true, 1, 1000), Ok(1));
        assert_eq!(validate_config(true, 32, 10000), Ok(32));
        for workers in [0, 33] { assert!(validate_config(true, workers, 1).is_err()); }
        for count in [0, 100001] { assert!(validate_config(false, 4, count).is_err()); }
    }

    #[test]
    fn layouts_colors_and_all_motions_are_unique_bounded_and_deterministic() {
        for count in [1, 1000, 10000, MAX_MOVING_MESHES] {
            let layout = Layout::new(count);
            let mut positions = HashSet::new();
            let mut colors = HashSet::new();
            for index in 0..count {
                let base = layout.base(index);
                assert!(positions.insert(base.map(f32::to_bits)));
                assert!(colors.insert(color_rgb(index)));
                let before = pose(base, index, 0.0);
                let after = pose(base, index, 1.25);
                assert_ne!(before.translation, after.translation);
                assert_ne!(before.yaw, after.yaw);
                assert_eq!(after, pose(base, index, 1.25));
                assert!(after.translation.iter().all(|value| value.is_finite()));
                assert!(after.translation[0].abs() + 0.9 < layout.ground[0] * 0.5);
                assert!(after.translation[2].abs() + 0.9 < layout.ground[1] * 0.5);
                if count > 1 {
                    let radius = (after.translation.iter().map(|value| value * value).sum::<f32>()).sqrt() + 0.9;
                    let distance = (layout.camera.iter().map(|value| value * value).sum::<f32>()).sqrt();
                    assert!(radius < distance * core::f32::consts::FRAC_PI_8.sin());
                    assert!(distance + radius < layout.far);
                }
            }
            // Simulated serial and partitioned worker order use exactly the
            // same function and controlled clock, without a second algorithm.
            let serial: Vec<_> = (0..count).map(|index| pose(layout.base(index), index, 2.5)).collect();
            let mut partitioned = vec![None; count];
            for lane in 0..4 {
                for index in (lane..count).step_by(4) {
                    partitioned[index] = Some(pose(layout.base(index), index, 2.5));
                }
            }
            assert_eq!(serial.into_iter().map(Some).collect::<Vec<_>>(), partitioned);
        }
    }

    #[test]
    fn one_cube_retains_original_framing_and_known_motion() {
        let layout = Layout::new(1);
        assert_eq!(layout.base(0), [0.0, 0.5, 0.0]);
        assert_eq!(layout.ground, [10.0, 10.0]);
        assert_eq!(layout.camera, [0.0, 5.0, 8.0]);
        assert_eq!(pose(layout.base(0), 0, 0.0), Pose { translation: [0.0, 0.5, 0.0], yaw: 0.0 });
        let actual = pose(layout.base(0), 0, 1.0);
        let expected = [0.2 * 0.9f32.sin(), 0.5 + 0.15 * (1.0 - 1.1f32.cos()), 0.2 * 0.7f32.sin()];
        assert_eq!(actual.translation, expected);
        assert_eq!(actual.yaw, 0.6);
    }
}
