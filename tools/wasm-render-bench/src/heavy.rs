use super::*;
use bevy::ecs::query::QueryData;

#[derive(Component, Default)]
struct Lane<const I: usize> {
    step: u32,
    output: u32,
}

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
struct ComputeLanes;

fn compute_lane<const I: usize>(config: Res<MainConfig>, mut query: Query<(&Moving, &mut Lane<I>)>) {
    for (moving, mut lane) in &mut query {
        lane.step = lane.step.wrapping_add(1);
        lane.output = workload::compute(workload::seed(moving.index, I, lane.step), config.cpu_work);
    }
}

macro_rules! lanes {
    ($($field:ident: $index:literal),+ $(,)?) => {
        #[derive(QueryData)]
        #[query_data(mutable)]
        pub(super) struct Outputs {
            moving: &'static mut Moving,
            transform: &'static mut Transform,
            material: &'static MeshMaterial3d<StandardMaterial>,
            $($field: &'static Lane<$index>,)+
        }

        pub fn install(app: &mut App) {
            // Separate registrations avoid tuple-size limits; no ordering edges
            // exist between lanes and each has a disjoint mutable component.
            $(app.add_systems(Update, compute_lane::<$index>.in_set(ComputeLanes));)+
            app.add_systems(Update, apply.after(ComputeLanes));
        }

        pub fn insert(entity: &mut bevy::ecs::system::EntityCommands) {
            $(entity.insert(Lane::<$index>::default());)+
        }

        fn apply(time: Res<Time>, mut query: Query<Outputs>, mut materials: ResMut<Assets<StandardMaterial>>) {
            for mut item in &mut query {
                let values = [$(item.$field.output,)+];
                let (offset, yaw, rgb) = workload::visual(&values);
                item.transform.translation = Vec3::from_array(core::array::from_fn(|axis| item.moving.base[axis] + offset[axis]));
                item.transform.rotation = Quat::from_rotation_y(yaw);
                materials.get_mut(&item.material.0).expect("unique moving material").base_color = Color::srgb(rgb[0], rgb[1], rgb[2]);
                item.moving.last_updated = Some(time.elapsed_secs());
            }
        }

        pub fn verify(entities: &Query<OutputsReadOnly>, materials: &Assets<StandardMaterial>, config: &MainConfig) {
            let mut count = 0;
            for entity in entities {
                let moving = entity.moving;
                let step = entity.l00.step;
                let expected = workload::reference(moving.index, step, config.cpu_work);
                $(let lane = entity.$field;
                assert_eq!(lane.step, step, "every lane executes exactly once per update");
                assert_eq!(lane.output, expected[$index], "serial reference lane mismatch");)+
                let (offset, yaw, rgb) = workload::visual(&expected);
                let transform = entity.transform;
                let translation = Vec3::from_array(core::array::from_fn(|axis| moving.base[axis] + offset[axis]));
                assert!(transform.translation.abs_diff_eq(translation, 0.0001));
                assert!(transform.rotation.abs_diff_eq(Quat::from_rotation_y(yaw), 0.0001));
                assert_eq!(transform.scale, Vec3::ONE);
                let handle = entity.material;
                assert_eq!(materials.get(&handle.0).unwrap().base_color, Color::srgb(rgb[0], rgb[1], rgb[2]));
                count += 1;
            }
            assert_eq!(count, config.moving_meshes);
        }
    };
}

lanes!(
    l00: 0, l01: 1, l02: 2, l03: 3, l04: 4, l05: 5, l06: 6, l07: 7,
    l08: 8, l09: 9, l10: 10, l11: 11, l12: 12, l13: 13, l14: 14, l15: 15,
    l16: 16, l17: 17, l18: 18, l19: 19, l20: 20, l21: 21, l22: 22, l23: 23,
    l24: 24, l25: 25, l26: 26, l27: 27, l28: 28, l29: 29, l30: 30, l31: 31,
);
