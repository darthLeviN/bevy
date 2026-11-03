//! Utilities that allow updating of large POD structures from multiple threads.
//!
//! In a select few cases, for performance reasons, we want to update "plain
//! old data"—data without any pointers—from helper threads, without having to
//! send the new data over a channel first. These utilities allow code that
//! needs to perform this operation to do so without dropping down to unsafe
//! code.
//!
//! Note that, while this operation is always *memory* safe, it isn't free of
//! potential data races. Updating large amounts of POD atomically, word by
//! word, amplifies the consequences of data races, because write hazards can
//! result in data "slicing". That is, one thread can see the results of a copy
//! operation in progress, a situation which ordinary atomics prevent. So you
//! should use the functionality in here sparingly and only when measured
//! performance concerns justify it.

use bytemuck::Pod;

/// Data that can be converted to an array of atomic unsigned words.
///
/// That array is known as the *blob* ([`Self::Blob`]). The trait provides
/// methods to copy data into and out of the blob type.
///
/// Note that, while implementing this trait isn't unsafe, it can be tedious,
/// and in any case implementing [`AtomicPodBlob`] *is* unsafe. Therefore, you
/// should almost always use the `impl_atomic_pod!` macro to produce
/// implementations of this trait.
pub trait AtomicPod: Pod + Default + Send + Sync + 'static {
    /// The *blob* type that allows shared mutation.
    ///
    /// This type must wrap an array of atomic `u32` or `u64` words.
    /// Because the renderer can't guarantee that, the [`AtomicPodBlob`] trait
    /// is unsafe. However, the [`crate::impl_atomic_pod`] macro can
    /// automatically generate safe implementations of [`AtomicPodBlob`] for
    /// you.
    type Blob: AtomicPodBlob;

    /// Produces a value of this type from the blob, typically by reading its
    /// fields one after another atomically.
    fn read_from_blob(blob: &Self::Blob) -> Self;

    /// Copies the `self` value to the blob, typically by writing its fields one
    /// after another atomically.
    ///
    /// Note that, because we're using atomics, the `blob` parameter doesn't
    /// need a mutable reference.
    fn write_to_blob(&self, blob: &Self::Blob);
}

/// Describes a type that has the same bit pattern as another type, but is made
/// up entirely of an array of atomic `u32` or `u64` values.
///
/// This trait enables values of whatever type this mirrors to be written from
/// multiple threads. It's memory-safe because the type must be POD. However,
/// this doesn't protect against data races; it's possible for safe code to see
/// partially-updated values, which might be incorrect. Therefore, use this type
/// with caution.
///
/// The [`crate::impl_atomic_pod`] macro that generates an implementation of
/// [`AtomicPod`] automatically generates a blob type that implements
/// [`AtomicPodBlob`]. This is the preferred way to implement this trait and
/// doesn't require any unsafe code.
///
/// # Safety
///
/// This trait must only be implemented by types that are `#[repr(transparent)]`
/// wrappers around `[AtomicU32; N]` or `[AtomicU64; N]` for some N (which may be 0).
/// The wrapper must have exactly the size and byte representation of its POD type;
/// its allocation must satisfy the atomic word alignment. All shared accesses to
/// a blob must use its chosen word width; mixing overlapping widths is not allowed.
/// That's because values implementing this trait are read as a `&[u8]` when
/// uploading to the GPU.
pub unsafe trait AtomicPodBlob: Default + Send + Sync + 'static {}

/// A macro that generates a *blob* type that allows a POD type to be updated in
/// shared memory.
///
/// An example of use of this macro:
///
/// ```
/// # use bevy_render::impl_atomic_pod;
/// # use bevy_render::render_resource::AtomicPod;
/// # use bytemuck::{Pod, Zeroable};
/// # use std::mem::offset_of;
/// #[derive(Clone, Copy, Default, Pod, Zeroable)]
/// #[repr(C)]
/// struct Foo {
///     a: u32,
///     b: u32,
/// }
/// impl_atomic_pod!(
///     Foo,
///     FooBlob,
///     field(a: u32, a, set_a),
///     field(b: u32, b, set_b),
/// );
/// ```
///
/// The first argument to this macro is the name of the type that you wish to be
/// updatable in shared memory. The second argument is the name of a "blob"
/// type: conventionally, it matches the name of the type with `Blob` appended.
///
/// Afterward follow optional *field getter and setter* declarations. These
/// declarations direct the [`crate::impl_atomic_pod`] macro to create
/// convenience accessor and mutation methods that allow fields of the blob
/// value to be accessed and mutated. The first argument of `field` is the name
/// of the field, a `:`, and the type of the field. The second argument is the
/// name that this macro should assign the accessor method, and the third,
/// optional, argument is the name that this macro should give the mutator
/// method.
///
/// This macro generates (1) the `struct` corresponding to the blob type; (2)
/// the implementation of `AtomicPod` for the POD type; (3) the unsafe
/// implementation of `AtomicPodBlob`; (4) an inherent implementation of
/// `AtomicPodBlob` that contains accessor and mutator methods as directed.
///
/// The POD type must have a size that's a multiple of 4 bytes, as must the
/// types of any fields that are named in `field` declarations.
///
/// Whole-record types with sizes divisible by 8 can opt into 64-bit words with
/// `impl_atomic_pod!(Type, TypeBlob, atomic_u64)`. This form provides no field
/// accessors, so every shared access uses the same width. On Wasm this halves
/// the atomic payload instruction count; it does not make whole-record writes
/// atomic or replace the caller's join/publication requirements.
#[macro_export]
macro_rules! impl_atomic_pod {
    ($pod_ty:ty, $blob_ty:ident, atomic_u64 $(,)?) => {
        $crate::impl_atomic_pod!(@words $pod_ty, $blob_ty, u64, AtomicU64, 8);
    };
    (
        $pod_ty: ty,
        $blob_ty: ident
        $(, field($field_name: ident : $field_ty: ty, $getter: ident $(, $($setter: ident)?)?))*
        $(,)?
    ) => {
        $crate::impl_atomic_pod!(@words $pod_ty, $blob_ty, u32, AtomicU32, 4
            $(, field($field_name: $field_ty, $getter $(, $($setter)?)?))*);
    };
    (
        @words $pod_ty: ty,
        $blob_ty: ident, $word_ty:ty, $atomic_ty:ident, $word_size:literal
        $(, field($field_name: ident : $field_ty: ty, $getter: ident $(, $($setter: ident)?)?))*
        $(,)?
    ) => {
        #[derive(::bevy_derive::Deref, ::bevy_derive::DerefMut)]
        #[repr(transparent)]
        pub struct $blob_ty(
            pub [::core::sync::atomic::$atomic_ty; ::core::mem::size_of::<$pod_ty>() / $word_size],
        );

        // Manually implement `Default` as `#[derive(Default)]` can't be used for arrays larger than 32 elements.
        impl Default for $blob_ty {
            fn default() -> Self {
                Self([const { ::core::sync::atomic::$atomic_ty::new(0) }; ::core::mem::size_of::<$pod_ty>() / $word_size])
            }
        }

        impl $crate::render_resource::AtomicPod for $pod_ty {
            type Blob = $blob_ty;

            fn read_from_blob(blob: &Self::Blob) -> Self {
                const _ASSERT_POD_TYPE_SIZE: () = ::core::assert!(
                    ::core::mem::size_of::<$pod_ty>() % $word_size == 0
                );

                // Read the value word by word.
                // Note that relaxed atomics, at the hardware level, are as
                // cheap as regular loads on x86-64 and AArch64.
                let nonatomic_data: [$word_ty; ::core::mem::size_of::<$pod_ty>() / $word_size] =
                    ::core::array::from_fn(|i| {
                        blob.0[i].load(::bevy_platform::sync::atomic::Ordering::Relaxed)
                    });
                ::bytemuck::must_cast(nonatomic_data)
            }

            fn write_to_blob(&self, blob: &Self::Blob) {
                // Store the value word by word.
                // Note that relaxed atomics, at the hardware level, are as
                // cheap as regular loads on x86-64 and AArch64.
                let src: [$word_ty; ::core::mem::size_of::<$pod_ty>() / $word_size] =
                    ::bytemuck::must_cast(*self);
                for (dest, src) in blob.0.iter().zip(src.iter()) {
                    dest.store(*src, ::bevy_platform::sync::atomic::Ordering::Relaxed);
                }
            }
        }

        // SAFETY: The transparent wrapper contains only atomic unsigned words.
        // The casts above check that their byte size matches the POD value.
        unsafe impl $crate::render_resource::AtomicPodBlob for $blob_ty {}

        impl<'a> ::core::convert::From<&'a $pod_ty> for $blob_ty {
            fn from(pod: &'a $pod_ty) -> Self {
                let blob = Self::default();
                pod.write_to_blob(&blob);
                blob
            }
        }

        impl $blob_ty {
            $(
                $(
                    pub fn $getter(&self) -> $field_ty {
                        const _ASSERT_FIELD_SIZE: () = ::core::assert!(
                            ::core::mem::size_of::<$field_ty>() % 4 == 0
                        );

                        // Extract the field we're looking for.
                        // Note that the field must have a size that is a
                        // multiple of 4.
                        let words: [u32; ::core::mem::size_of::<$field_ty>() / 4] =
                            ::core::array::from_fn(|i| {
                                self.0[::core::mem::offset_of!($pod_ty, $field_name) / 4 + i]
                                    .load(::bevy_platform::sync::atomic::Ordering::Relaxed)
                            });
                        *::bytemuck::must_cast_ref(&words)
                    }

                    $(
                        pub fn $setter(&self, value: $field_ty) {
                            // Insert the appropriate field.
                            // Note that the field must have a size that is a
                            // multiple of 4.
                            let words: [u32; ::core::mem::size_of::<$field_ty>() / 4] =
                                ::bytemuck::must_cast(value);
                            for i in 0..(::core::mem::size_of::<$field_ty>() / 4) {
                                self.0[::core::mem::offset_of!($pod_ty, $field_name) / 4 + i]
                                    .store(words[i], ::bevy_platform::sync::atomic::Ordering::Relaxed);
                            }
                        }
                    )?
                )*
            )?
        }
    };
}

impl_atomic_pod!((), AtomicPodUnitBlob);
impl_atomic_pod!(u32, AtomicPodU32Blob);
