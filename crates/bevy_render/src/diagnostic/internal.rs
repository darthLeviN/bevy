use alloc::{borrow::Cow, sync::Arc};
use core::{
    ops::{DerefMut, Range},
    sync::atomic::{AtomicBool, Ordering},
};
use std::thread::{self, ThreadId};

use bevy_diagnostic::{Diagnostic, DiagnosticMeasurement, DiagnosticPath, DiagnosticsStore};
use bevy_ecs::resource::Resource;
use bevy_ecs::system::{Res, ResMut};
use bevy_platform::time::Instant;
use std::sync::Mutex;
use wgpu::{
    Buffer, BufferDescriptor, BufferSize, BufferSlice, BufferUsages, CommandEncoder, ComputePass,
    Device, Features, MapMode, PipelineStatisticsTypes, QuerySet, QuerySetDescriptor, QueryType,
    RenderPass,
};

use crate::renderer::{wgpu_wrapper, RenderAdapterInfo, RenderDevice, RenderQueue};

use super::RecordDiagnostics;

// buffer offset must be divisible by 256, so this constant must be divisible by 32 (=256/8)
const MAX_TIMESTAMP_QUERIES: u32 = 256;
const MAX_PIPELINE_STATISTICS: u32 = 128;

const TIMESTAMP_SIZE: u64 = 8;
const PIPELINE_STATISTICS_SIZE: u64 = 40;

struct DiagnosticsRecorderInternal {
    timestamp_period_ns: f32,
    features: Features,
    current_frame: Mutex<FrameData>,
    submitted_frames: Vec<FrameData>,
    finished_frames: Vec<FrameData>,
    #[cfg(feature = "tracing-tracy")]
    tracy_gpu_context: Option<tracy_client::GpuContext>,
}

wgpu_wrapper!(struct WgpuDiagnosticsRecorderInternal(DiagnosticsRecorderInternal));

/// Records diagnostics into [`QuerySet`]'s keeping track of the mapping between
/// spans and indices to the corresponding entries in the [`QuerySet`].
#[derive(Resource)]
pub struct DiagnosticsRecorder(WgpuDiagnosticsRecorderInternal);

impl DiagnosticsRecorder {
    /// Creates the new `DiagnosticsRecorder`.
    pub fn new(
        adapter_info: &RenderAdapterInfo,
        device: &RenderDevice,
        queue: &RenderQueue,
    ) -> DiagnosticsRecorder {
        let features = device.features();

        #[cfg(feature = "tracing-tracy")]
        let tracy_gpu_context =
            super::tracy_gpu::new_tracy_gpu_context(adapter_info, device, queue);
        let _ = adapter_info; // Prevent unused variable warnings when tracing-tracy is not enabled

        DiagnosticsRecorder(WgpuDiagnosticsRecorderInternal::new(
            DiagnosticsRecorderInternal {
                timestamp_period_ns: queue.get_timestamp_period(),
                features,
                current_frame: Mutex::new(FrameData::new(
                    device,
                    features,
                    #[cfg(feature = "tracing-tracy")]
                    tracy_gpu_context.clone(),
                )),
                submitted_frames: Vec::new(),
                finished_frames: Vec::new(),
                #[cfg(feature = "tracing-tracy")]
                tracy_gpu_context,
            },
        ))
    }

    fn current_frame_mut(&mut self) -> &mut FrameData {
        self.0.current_frame.get_mut().expect("lock poisoned")
    }

    fn current_frame_lock(&self) -> impl DerefMut<Target = FrameData> + '_ {
        self.0.current_frame.lock().expect("lock poisoned")
    }

    /// Begins recording diagnostics for a new frame.
    pub fn begin_frame(&mut self) {
        let internal = &mut self.0;
        let mut idx = 0;
        while idx < internal.submitted_frames.len() {
            let timestamp = internal.timestamp_period_ns;
            if internal.submitted_frames[idx].run_mapped_callback(timestamp) {
                let removed = internal.submitted_frames.swap_remove(idx);
                internal.finished_frames.push(removed);
            } else {
                idx += 1;
            }
        }

        self.current_frame_mut().begin();
    }

    /// Associates caller-owned sampling metadata with this frame, before recording passes.
    pub fn set_frame_tag(&mut self, tag: Option<u64>) {
        self.current_frame_mut().frame_tag = tag;
    }

    fn pass_timestamp_queries(&self) -> Option<(QuerySet, u32, u32)> {
        let mut frame = self.current_frame_lock();
        let supported = frame.timestamps_query_set.is_some();
        let Some((begin, end)) = allocate_pass_queries(supported, &mut frame.num_timestamps) else {
            frame.missed_passes += 1;
            return None;
        };
        frame.pass_queries.push((begin, end));
        Some((frame.timestamps_query_set.as_ref().unwrap().clone(), begin, end))
    }

    /// Begins a render pass with optional pass-boundary timestamps. Explicit caller
    /// timestamp writes are preserved and excluded from the recorder's pass total.
    pub fn begin_render_pass<'a>(
        &self,
        encoder: &'a mut CommandEncoder,
        descriptor: &wgpu::RenderPassDescriptor<'_>,
    ) -> RenderPass<'a> {
        let queries = if descriptor.timestamp_writes.is_none() { self.pass_timestamp_queries() } else { None };
        let mut descriptor = descriptor.clone();
        if let Some((ref set, begin, end)) = queries {
            descriptor.timestamp_writes = Some(wgpu::RenderPassTimestampWrites {
                query_set: set, beginning_of_pass_write_index: Some(begin), end_of_pass_write_index: Some(end),
            });
        }
        encoder.begin_render_pass(&descriptor)
    }

    /// Begins a compute pass with optional pass-boundary timestamps.
    pub fn begin_compute_pass<'a>(
        &self,
        encoder: &'a mut CommandEncoder,
        descriptor: &wgpu::ComputePassDescriptor<'_>,
    ) -> ComputePass<'a> {
        let queries = if descriptor.timestamp_writes.is_none() { self.pass_timestamp_queries() } else { None };
        let mut descriptor = descriptor.clone();
        if let Some((ref set, begin, end)) = queries {
            descriptor.timestamp_writes = Some(wgpu::ComputePassTimestampWrites {
                query_set: set, beginning_of_pass_write_index: Some(begin), end_of_pass_write_index: Some(end),
            });
        }
        encoder.begin_compute_pass(&descriptor)
    }

    /// Copies data from [`QuerySet`]'s to a [`Buffer`], after which it can be downloaded to CPU.
    ///
    /// Should be called before [`DiagnosticsRecorder::finish_frame`].
    pub fn resolve(&mut self, encoder: &mut CommandEncoder) {
        self.current_frame_mut().resolve(encoder);
    }

    /// Finishes recording diagnostics for the current frame.
    ///
    /// The specified `callback` will be invoked when diagnostics become available.
    ///
    /// Should be called after [`DiagnosticsRecorder::resolve`],
    /// and **after** all commands buffers have been queued.
    pub fn finish_frame(
        &mut self,
        device: &RenderDevice,
        callback: impl FnOnce(RenderDiagnostics) + Send + Sync + 'static,
    ) {
        #[cfg(feature = "tracing-tracy")]
        let tracy_gpu_context = self.0.tracy_gpu_context.clone();

        let internal = &mut self.0;
        internal
            .current_frame
            .get_mut()
            .expect("lock poisoned")
            .finish(callback);

        // reuse one of the finished frames, if we can
        let new_frame = match internal.finished_frames.pop() {
            Some(frame) => frame,
            None => FrameData::new(
                device,
                internal.features,
                #[cfg(feature = "tracing-tracy")]
                tracy_gpu_context,
            ),
        };

        let old_frame = core::mem::replace(
            internal.current_frame.get_mut().expect("lock poisoned"),
            new_frame,
        );
        internal.submitted_frames.push(old_frame);
    }
}

impl RecordDiagnostics for DiagnosticsRecorder {
    fn record_f32<N>(&self, command_encoder: &mut CommandEncoder, buffer: &BufferSlice, name: N)
    where
        N: Into<Cow<'static, str>>,
    {
        assert_eq!(
            buffer.size(),
            BufferSize::new(4).unwrap().get(),
            "DiagnosticsRecorder::record_f32 buffer slice must be 4 bytes long"
        );
        assert!(
            buffer.buffer().usage().contains(BufferUsages::COPY_SRC),
            "DiagnosticsRecorder::record_f32 buffer must have BufferUsages::COPY_SRC"
        );

        self.current_frame_lock()
            .record_value(command_encoder, buffer, name.into(), true);
    }

    fn record_u32<N>(&self, command_encoder: &mut CommandEncoder, buffer: &BufferSlice, name: N)
    where
        N: Into<Cow<'static, str>>,
    {
        assert_eq!(
            buffer.size(),
            BufferSize::new(4).unwrap().get(),
            "DiagnosticsRecorder::record_u32 buffer slice must be 4 bytes long"
        );
        assert!(
            buffer.buffer().usage().contains(BufferUsages::COPY_SRC),
            "DiagnosticsRecorder::record_u32 buffer must have BufferUsages::COPY_SRC"
        );

        self.current_frame_lock()
            .record_value(command_encoder, buffer, name.into(), false);
    }

    fn begin_time_span<E: WriteTimestamp>(&self, encoder: &mut E, span_name: Cow<'static, str>) {
        self.current_frame_lock()
            .begin_time_span(encoder, span_name);
    }

    fn end_time_span<E: WriteTimestamp>(&self, encoder: &mut E) {
        self.current_frame_lock().end_time_span(encoder);
    }

    fn begin_pass_span<P: Pass>(&self, pass: &mut P, span_name: Cow<'static, str>) {
        self.current_frame_lock().begin_pass(pass, span_name);
    }

    fn end_pass_span<P: Pass>(&self, pass: &mut P) {
        self.current_frame_lock().end_pass(pass);
    }
}

struct SpanRecord {
    thread_id: ThreadId,
    path_range: Range<usize>,
    pass_kind: Option<PassKind>,
    begin_timestamp_index: Option<u32>,
    end_timestamp_index: Option<u32>,
    begin_instant: Option<Instant>,
    end_instant: Option<Instant>,
    pipeline_statistics_index: Option<u32>,
}

struct FrameData {
    device: Device,
    timestamps_query_set: Option<QuerySet>,
    num_timestamps: u32,
    supports_timestamps_inside_passes: bool,
    supports_timestamps_inside_encoders: bool,
    pipeline_statistics_query_set: Option<QuerySet>,
    num_pipeline_statistics: u32,
    buffer_size: u64,
    pipeline_statistics_buffer_offset: u64,
    resolve_buffer: Option<Buffer>,
    read_buffer: Option<Buffer>,
    path_components: Vec<Cow<'static, str>>,
    open_spans: Vec<SpanRecord>,
    closed_spans: Vec<SpanRecord>,
    value_buffers: Vec<(Buffer, Cow<'static, str>, bool)>,
    is_mapped: Arc<AtomicBool>,
    map_failed: Arc<AtomicBool>,
    callback: Option<Box<dyn FnOnce(RenderDiagnostics) + Send + Sync + 'static>>,
    frame_tag: Option<u64>,
    pass_queries: Vec<(u32, u32)>,
    missed_passes: u32,
    #[cfg(feature = "tracing-tracy")]
    tracy_gpu_context: Option<tracy_client::GpuContext>,
}

impl FrameData {
    fn new(
        device: &RenderDevice,
        features: Features,
        #[cfg(feature = "tracing-tracy")] tracy_gpu_context: Option<tracy_client::GpuContext>,
    ) -> FrameData {
        let wgpu_device = device.wgpu_device();
        let mut buffer_size = 0;

        let timestamps_query_set = if features.contains(Features::TIMESTAMP_QUERY) {
            buffer_size += u64::from(MAX_TIMESTAMP_QUERIES) * TIMESTAMP_SIZE;
            Some(wgpu_device.create_query_set(&QuerySetDescriptor {
                label: Some("timestamps_query_set"),
                ty: QueryType::Timestamp,
                count: MAX_TIMESTAMP_QUERIES,
            }))
        } else {
            None
        };

        let pipeline_statistics_buffer_offset = buffer_size;

        let pipeline_statistics_query_set =
            if features.contains(Features::PIPELINE_STATISTICS_QUERY) {
                buffer_size += u64::from(MAX_PIPELINE_STATISTICS) * PIPELINE_STATISTICS_SIZE;
                Some(wgpu_device.create_query_set(&QuerySetDescriptor {
                    label: Some("pipeline_statistics_query_set"),
                    ty: QueryType::PipelineStatistics(PipelineStatisticsTypes::all()),
                    count: MAX_PIPELINE_STATISTICS,
                }))
            } else {
                None
            };

        let (resolve_buffer, read_buffer) = if buffer_size > 0 {
            let resolve_buffer = wgpu_device.create_buffer(&BufferDescriptor {
                label: Some("render_statistics_resolve_buffer"),
                size: buffer_size,
                usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let read_buffer = wgpu_device.create_buffer(&BufferDescriptor {
                label: Some("render_statistics_read_buffer"),
                size: buffer_size,
                usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            (Some(resolve_buffer), Some(read_buffer))
        } else {
            (None, None)
        };

        FrameData {
            device: wgpu_device.clone(),
            timestamps_query_set,
            num_timestamps: 0,
            supports_timestamps_inside_passes: features
                .contains(Features::TIMESTAMP_QUERY_INSIDE_PASSES),
            supports_timestamps_inside_encoders: features
                .contains(Features::TIMESTAMP_QUERY_INSIDE_ENCODERS),
            pipeline_statistics_query_set,
            num_pipeline_statistics: 0,
            buffer_size,
            pipeline_statistics_buffer_offset,
            resolve_buffer,
            read_buffer,
            path_components: Vec::new(),
            open_spans: Vec::new(),
            closed_spans: Vec::new(),
            value_buffers: Vec::new(),
            is_mapped: Arc::new(AtomicBool::new(false)),
            map_failed: Arc::new(AtomicBool::new(false)),
            callback: None,
            frame_tag: None,
            pass_queries: Vec::new(),
            missed_passes: 0,
            #[cfg(feature = "tracing-tracy")]
            tracy_gpu_context,
        }
    }

    fn begin(&mut self) {
        self.frame_tag = None;
        self.pass_queries.clear();
        self.missed_passes = 0;
        self.num_timestamps = 0;
        self.num_pipeline_statistics = 0;
        self.path_components.clear();
        self.open_spans.clear();
        self.closed_spans.clear();
    }

    fn write_timestamp(
        &mut self,
        encoder: &mut impl WriteTimestamp,
        is_inside_pass: bool,
    ) -> Option<u32> {
        // `encoder.write_timestamp` is unsupported on WebGPU.
        if !self.supports_timestamps_inside_encoders {
            return None;
        }

        if is_inside_pass && !self.supports_timestamps_inside_passes {
            return None;
        }

        if self.num_timestamps >= MAX_TIMESTAMP_QUERIES {
            return None;
        }

        let set = self.timestamps_query_set.as_ref()?;
        let index = self.num_timestamps;
        encoder.write_timestamp(set, index);
        self.num_timestamps += 1;
        Some(index)
    }

    fn write_pipeline_statistics(
        &mut self,
        encoder: &mut impl WritePipelineStatistics,
    ) -> Option<u32> {
        if self.num_pipeline_statistics >= MAX_PIPELINE_STATISTICS {
            return None;
        }

        let set = self.pipeline_statistics_query_set.as_ref()?;
        let index = self.num_pipeline_statistics;
        encoder.begin_pipeline_statistics_query(set, index);
        self.num_pipeline_statistics += 1;
        Some(index)
    }

    fn open_span(
        &mut self,
        pass_kind: Option<PassKind>,
        name: Cow<'static, str>,
    ) -> &mut SpanRecord {
        let thread_id = thread::current().id();

        let parent = self.open_spans.iter().rfind(|v| v.thread_id == thread_id);

        let path_range = match &parent {
            Some(parent) if parent.path_range.end == self.path_components.len() => {
                parent.path_range.start..parent.path_range.end + 1
            }
            Some(parent) => {
                self.path_components
                    .extend_from_within(parent.path_range.clone());
                self.path_components.len() - parent.path_range.len()..self.path_components.len() + 1
            }
            None => self.path_components.len()..self.path_components.len() + 1,
        };

        self.path_components.push(name);

        self.open_spans.push(SpanRecord {
            thread_id,
            path_range,
            pass_kind,
            begin_timestamp_index: None,
            end_timestamp_index: None,
            begin_instant: None,
            end_instant: None,
            pipeline_statistics_index: None,
        });

        self.open_spans.last_mut().unwrap()
    }

    fn close_span(&mut self) -> &mut SpanRecord {
        let thread_id = thread::current().id();

        let iter = self.open_spans.iter();
        let (index, _) = iter
            .enumerate()
            .rfind(|(_, v)| v.thread_id == thread_id)
            .unwrap();

        let span = self.open_spans.swap_remove(index);
        self.closed_spans.push(span);
        self.closed_spans.last_mut().unwrap()
    }

    fn record_value(
        &mut self,
        command_encoder: &mut CommandEncoder,
        buffer: &BufferSlice,
        name: Cow<'static, str>,
        is_f32: bool,
    ) {
        let dest_buffer = self.device.create_buffer(&BufferDescriptor {
            label: Some(&format!("render_diagnostic_{name}")),
            size: 4,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        command_encoder.copy_buffer_to_buffer(
            buffer.buffer(),
            buffer.offset(),
            &dest_buffer,
            0,
            Some(buffer.size()),
        );

        command_encoder.map_buffer_on_submit(&dest_buffer, MapMode::Read, .., |_| {});

        self.value_buffers.push((dest_buffer, name, is_f32));
    }

    fn begin_time_span(&mut self, encoder: &mut impl WriteTimestamp, name: Cow<'static, str>) {
        let begin_instant = Instant::now();
        let begin_timestamp_index = self.write_timestamp(encoder, false);

        let span = self.open_span(None, name);
        span.begin_instant = Some(begin_instant);
        span.begin_timestamp_index = begin_timestamp_index;
    }

    fn end_time_span(&mut self, encoder: &mut impl WriteTimestamp) {
        let end_timestamp_index = self.write_timestamp(encoder, false);

        let span = self.close_span();
        span.end_timestamp_index = end_timestamp_index;
        span.end_instant = Some(Instant::now());
    }

    fn begin_pass<P: Pass>(&mut self, pass: &mut P, name: Cow<'static, str>) {
        let begin_instant = Instant::now();

        let begin_timestamp_index = self.write_timestamp(pass, true);
        let pipeline_statistics_index = self.write_pipeline_statistics(pass);

        let span = self.open_span(Some(P::KIND), name);
        span.begin_instant = Some(begin_instant);
        span.begin_timestamp_index = begin_timestamp_index;
        span.pipeline_statistics_index = pipeline_statistics_index;
    }

    fn end_pass(&mut self, pass: &mut impl Pass) {
        let end_timestamp_index = self.write_timestamp(pass, true);

        let span = self.close_span();
        span.end_timestamp_index = end_timestamp_index;

        if span.pipeline_statistics_index.is_some() {
            pass.end_pipeline_statistics_query();
        }

        span.end_instant = Some(Instant::now());
    }

    fn resolve(&mut self, encoder: &mut CommandEncoder) {
        let Some(resolve_buffer) = &self.resolve_buffer else {
            return;
        };

        match &self.timestamps_query_set {
            Some(set) if self.num_timestamps > 0 => {
                encoder.resolve_query_set(set, 0..self.num_timestamps, resolve_buffer, 0);
            }
            _ => {}
        }

        match &self.pipeline_statistics_query_set {
            Some(set) if self.num_pipeline_statistics > 0 => {
                encoder.resolve_query_set(
                    set,
                    0..self.num_pipeline_statistics,
                    resolve_buffer,
                    self.pipeline_statistics_buffer_offset,
                );
            }
            _ => {}
        }

        let Some(read_buffer) = &self.read_buffer else {
            return;
        };

        encoder.copy_buffer_to_buffer(resolve_buffer, 0, read_buffer, 0, self.buffer_size);
    }

    fn diagnostic_path(&self, range: &Range<usize>, field: &str) -> DiagnosticPath {
        DiagnosticPath::from_components(
            core::iter::once("render")
                .chain(self.path_components[range.clone()].iter().map(|v| &**v))
                .chain(core::iter::once(field)),
        )
    }

    fn finish(&mut self, callback: impl FnOnce(RenderDiagnostics) + Send + Sync + 'static) {
        let Some(read_buffer) = &self.read_buffer else {
            // we still have cpu timings, so let's use them

            let mut diagnostics = Vec::new();

            for span in &self.closed_spans {
                if let (Some(begin), Some(end)) = (span.begin_instant, span.end_instant) {
                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "elapsed_cpu"),
                        suffix: "ms",
                        value: (end - begin).as_secs_f64() * 1000.0,
                    });
                }
            }

            for (buffer, diagnostic_path, is_f32) in self.value_buffers.drain(..) {
                let buffer = buffer.get_mapped_range(..).unwrap();
                diagnostics.push(RenderDiagnostic {
                    path: DiagnosticPath::from_components(
                        core::iter::once("render")
                            .chain(core::iter::once(diagnostic_path.as_ref())),
                    ),
                    suffix: "",
                    value: if is_f32 {
                        f32::from_le_bytes((*buffer).try_into().unwrap()) as f64
                    } else {
                        u32::from_le_bytes((*buffer).try_into().unwrap()) as f64
                    },
                });
            }

            callback(RenderDiagnostics {
                diagnostics,
                gpu: GpuFrameTiming { frame_tag: self.frame_tag, elapsed_ms: None, timed_passes: 0, missed_passes: self.missed_passes },
            });
            return;
        };

        self.callback = Some(Box::new(callback));

        let is_mapped = self.is_mapped.clone();
        let map_failed = self.map_failed.clone();
        read_buffer.slice(..).map_async(MapMode::Read, move |res| {
            if let Err(e) = res {
                bevy_log::warn!("Failed to download render statistics buffer: {e}");
                map_failed.store(true, Ordering::Release);
                return;
            }

            is_mapped.store(true, Ordering::Release);
        });
    }

    // returns true if the frame is considered finished, false otherwise
    fn run_mapped_callback(&mut self, timestamp_period_ns: f32) -> bool {
        let Some(read_buffer) = &self.read_buffer else {
            return true;
        };
        if self.map_failed.swap(false, Ordering::AcqRel) {
            if let Some(callback) = self.callback.take() {
                callback(RenderDiagnostics {
                    diagnostics: Vec::new(),
                    gpu: GpuFrameTiming { frame_tag: self.frame_tag, missed_passes: self.missed_passes, ..Default::default() },
                });
            }
            return true;
        }
        if !self.is_mapped.load(Ordering::Acquire) {
            // need to wait more
            return false;
        }
        let Some(callback) = self.callback.take() else {
            return true;
        };

        let data = read_buffer.slice(..).get_mapped_range().unwrap();

        let timestamps = data[..(self.num_timestamps * 8) as usize]
            .as_chunks()
            .0
            .iter()
            .map(|&v| u64::from_le_bytes(v))
            .collect::<Vec<u64>>();

        let start = self.pipeline_statistics_buffer_offset as usize;
        let len = (self.num_pipeline_statistics as usize) * 40;
        let pipeline_statistics = data[start..start + len]
            .as_chunks()
            .0
            .iter()
            .map(|&v| u64::from_le_bytes(v))
            .collect::<Vec<u64>>();

        let mut diagnostics = Vec::new();

        for span in &self.closed_spans {
            if let (Some(begin), Some(end)) = (span.begin_instant, span.end_instant) {
                diagnostics.push(RenderDiagnostic {
                    path: self.diagnostic_path(&span.path_range, "elapsed_cpu"),
                    suffix: "ms",
                    value: (end - begin).as_secs_f64() * 1000.0,
                });
            }

            if let (Some(begin), Some(end)) = (span.begin_timestamp_index, span.end_timestamp_index)
            {
                let begin = timestamps[begin as usize] as f64;
                let end = timestamps[end as usize] as f64;
                let value = (end - begin) * (timestamp_period_ns as f64) / 1e6;

                #[cfg(feature = "tracing-tracy")]
                {
                    // Calling span_alloc() and end_zone() here instead of in open_span() and close_span() means that tracy does not know where each GPU command was recorded on the CPU timeline.
                    // Unfortunately we must do it this way, because tracy does not play nicely with multithreaded command recording. The start/end pairs would get all mixed up.
                    // The GPU spans themselves are still accurate though, and it's probably safe to assume that each GPU span in frame N belongs to the corresponding CPU render node span from frame N-1.
                    if let Some(tracy_gpu_context) = &self.tracy_gpu_context {
                        let name = &self.path_components[span.path_range.clone()].join("/");
                        let mut tracy_gpu_span =
                            tracy_gpu_context.span_alloc(name, "", "", 0).unwrap();
                        tracy_gpu_span.end_zone();
                        tracy_gpu_span.upload_timestamp_start(begin as i64);
                        tracy_gpu_span.upload_timestamp_end(end as i64);
                    }
                }

                diagnostics.push(RenderDiagnostic {
                    path: self.diagnostic_path(&span.path_range, "elapsed_gpu"),
                    suffix: "ms",
                    value,
                });
            }

            if let Some(index) = span.pipeline_statistics_index {
                let index = (index as usize) * 5;

                if span.pass_kind == Some(PassKind::Render) {
                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "vertex_shader_invocations"),
                        suffix: "",
                        value: pipeline_statistics[index] as f64,
                    });

                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "clipper_invocations"),
                        suffix: "",
                        value: pipeline_statistics[index + 1] as f64,
                    });

                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "clipper_primitives_out"),
                        suffix: "",
                        value: pipeline_statistics[index + 2] as f64,
                    });

                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "fragment_shader_invocations"),
                        suffix: "",
                        value: pipeline_statistics[index + 3] as f64,
                    });
                }

                if span.pass_kind == Some(PassKind::Compute) {
                    diagnostics.push(RenderDiagnostic {
                        path: self.diagnostic_path(&span.path_range, "compute_shader_invocations"),
                        suffix: "",
                        value: pipeline_statistics[index + 4] as f64,
                    });
                }
            }
        }

        for (buffer, diagnostic_path, is_f32) in self.value_buffers.drain(..) {
            let buffer = buffer.get_mapped_range(..).unwrap();
            diagnostics.push(RenderDiagnostic {
                path: DiagnosticPath::from_components(
                    core::iter::once("render").chain(core::iter::once(diagnostic_path.as_ref())),
                ),
                suffix: "",
                value: if is_f32 {
                    f32::from_le_bytes((*buffer).try_into().unwrap()) as f64
                } else {
                    u32::from_le_bytes((*buffer).try_into().unwrap()) as f64
                },
            });
        }

        callback(RenderDiagnostics {
            diagnostics,
            gpu: GpuFrameTiming {
                frame_tag: self.frame_tag,
                elapsed_ms: pass_total_ms(&timestamps, &self.pass_queries, timestamp_period_ns),
                timed_passes: self.pass_queries.len() as u32,
                missed_passes: self.missed_passes,
            },
        });

        drop(data);
        read_buffer.unmap();
        self.is_mapped.store(false, Ordering::Release);

        true
    }
}

/// Resource which stores render diagnostics of the most recent frame.
#[derive(Debug, Default, Clone, Resource)]
pub struct RenderDiagnostics {
    diagnostics: Vec<RenderDiagnostic>,
    pub(crate) gpu: GpuFrameTiming,
}

/// GPU execution time of disjoint recorder-instrumented render/compute passes.
/// Excludes copies, idle time, nested diagnostic spans and uninstrumented passes.
#[derive(Debug, Default, Clone)]
pub struct GpuFrameTiming {
    pub frame_tag: Option<u64>,
    pub elapsed_ms: Option<f64>,
    pub timed_passes: u32,
    pub missed_passes: u32,
}

fn allocate_pass_queries(supported: bool, used: &mut u32) -> Option<(u32, u32)> {
    if !supported || *used > MAX_TIMESTAMP_QUERIES - 2 { return None; }
    let begin = *used;
    *used += 2;
    Some((begin, begin + 1))
}

fn pass_total_ms(timestamps: &[u64], pairs: &[(u32, u32)], period: f32) -> Option<f64> {
    if pairs.is_empty() { return None; }
    let mut ticks = 0u64;
    for &(begin, end) in pairs {
        ticks = ticks.checked_add(timestamps.get(end as usize)?.checked_sub(*timestamps.get(begin as usize)?)?)?;
    }
    Some(ticks as f64 * period as f64 / 1e6)
}

/// A render diagnostic which has been recorded, but not yet stored in [`DiagnosticsStore`].
#[derive(Debug, Clone, Resource)]
pub struct RenderDiagnostic {
    pub path: DiagnosticPath,
    pub suffix: &'static str,
    pub value: f64,
}

/// Stores render diagnostics before they can be synced with the main app.
///
/// This mutex is locked twice per frame:
///  1. in `PreUpdate`, during [`sync_diagnostics`],
///  2. after rendering has finished and statistics have been downloaded from GPU.
#[derive(Debug, Default, Clone, Resource)]
pub struct RenderDiagnosticsMutex(pub(crate) Arc<Mutex<Option<RenderDiagnostics>>>);

/// Updates render diagnostics measurements.
pub fn sync_diagnostics(mutex: Res<RenderDiagnosticsMutex>, mut store: ResMut<DiagnosticsStore>) {
    let Some(diagnostics) = mutex.0.lock().ok().and_then(|mut v| v.take()) else {
        return;
    };

    let time = Instant::now();

    for diagnostic in &diagnostics.diagnostics {
        if store.get(&diagnostic.path).is_none() {
            store.add(Diagnostic::new(diagnostic.path.clone()).with_suffix(diagnostic.suffix));
        }

        store
            .get_mut(&diagnostic.path)
            .unwrap()
            .add_measurement(DiagnosticMeasurement {
                time,
                value: diagnostic.value,
            });
    }
}

pub trait WriteTimestamp {
    fn write_timestamp(&mut self, query_set: &QuerySet, index: u32);
}

impl WriteTimestamp for CommandEncoder {
    fn write_timestamp(&mut self, query_set: &QuerySet, index: u32) {
        if cfg!(target_os = "macos") {
            // When using tracy (and thus this function), rendering was flickering on macOS Tahoe.
            // See: https://github.com/bevyengine/bevy/issues/22257
            // The issue seems to be triggered when `write_timestamp` is called very close to frame
            // presentation.
            return;
        }
        CommandEncoder::write_timestamp(self, query_set, index);
    }
}

impl WriteTimestamp for RenderPass<'_> {
    fn write_timestamp(&mut self, query_set: &QuerySet, index: u32) {
        RenderPass::write_timestamp(self, query_set, index);
    }
}

impl WriteTimestamp for ComputePass<'_> {
    fn write_timestamp(&mut self, query_set: &QuerySet, index: u32) {
        ComputePass::write_timestamp(self, query_set, index);
    }
}

pub trait WritePipelineStatistics {
    fn begin_pipeline_statistics_query(&mut self, query_set: &QuerySet, index: u32);

    fn end_pipeline_statistics_query(&mut self);
}

impl WritePipelineStatistics for RenderPass<'_> {
    fn begin_pipeline_statistics_query(&mut self, query_set: &QuerySet, index: u32) {
        RenderPass::begin_pipeline_statistics_query(self, query_set, index);
    }

    fn end_pipeline_statistics_query(&mut self) {
        RenderPass::end_pipeline_statistics_query(self);
    }
}

impl WritePipelineStatistics for ComputePass<'_> {
    fn begin_pipeline_statistics_query(&mut self, query_set: &QuerySet, index: u32) {
        ComputePass::begin_pipeline_statistics_query(self, query_set, index);
    }

    fn end_pipeline_statistics_query(&mut self) {
        ComputePass::end_pipeline_statistics_query(self);
    }
}

pub trait Pass: WritePipelineStatistics + WriteTimestamp {
    const KIND: PassKind;
}

impl Pass for RenderPass<'_> {
    const KIND: PassKind = PassKind::Render;
}

impl Pass for ComputePass<'_> {
    const KIND: PassKind = PassKind::Compute;
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
pub enum PassKind {
    Render,
    Compute,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pass_queries_require_only_base_feature_and_reserve_atomic_pairs() {
        let mut used = 0;
        assert_eq!(allocate_pass_queries(false, &mut used), None);
        assert_eq!(used, 0);
        assert_eq!(allocate_pass_queries(true, &mut used), Some((0, 1)));
        used = MAX_TIMESTAMP_QUERIES - 1;
        assert_eq!(allocate_pass_queries(true, &mut used), None);
        assert_eq!(used, MAX_TIMESTAMP_QUERIES - 1);
        used -= 1;
        assert_eq!(allocate_pass_queries(true, &mut used), Some((MAX_TIMESTAMP_QUERIES - 2, MAX_TIMESTAMP_QUERIES - 1)));
        assert_eq!(allocate_pass_queries(true, &mut used), None);
    }

    #[test]
    fn pass_total_ignores_nested_spans_and_rejects_invalid_readback() {
        // Entries 2/3 represent an enclosing native span, not a pass.
        let timestamps = [10, 20, 0, 100, 30, 50];
        assert_eq!(pass_total_ms(&timestamps, &[(0, 1), (4, 5)], 1000.0), Some(0.03));
        assert_eq!(pass_total_ms(&timestamps, &[], 1.0), None);
        assert_eq!(pass_total_ms(&timestamps, &[(1, 0)], 1.0), None);
        assert_eq!(pass_total_ms(&timestamps, &[(0, 6)], 1.0), None);
    }

    #[test]
    fn base_timestamp_feature_plans_render_and_compute_boundaries() {
        let (device, queue) = crate::test_utils::create_dummy_device_with_features(Features::TIMESTAMP_QUERY);
        let info = RenderAdapterInfo(wgpu::AdapterInfo::new(wgpu::DeviceType::Cpu, wgpu::Backend::Noop));
        let mut recorder = DiagnosticsRecorder::new(&info, &device, &queue);
        recorder.begin_frame();
        recorder.set_frame_tag(Some(42));
        let mut encoder = device.create_command_encoder(&Default::default());
        drop(recorder.begin_compute_pass(&mut encoder, &Default::default()));
        drop(recorder.begin_render_pass(&mut encoder, &Default::default()));
        let frame = recorder.current_frame_lock();
        assert!(!frame.supports_timestamps_inside_encoders);
        assert!(!frame.supports_timestamps_inside_passes);
        assert_eq!(frame.pass_queries, [(0, 1), (2, 3)]);
        assert_eq!(frame.frame_tag, Some(42));
        drop(frame);
        recorder.resolve(&mut encoder);
        queue.submit([encoder.finish()]);
    }

    #[test]
    fn failed_readback_completes_with_original_tag_and_can_be_recycled() {
        let (device, _) = crate::test_utils::create_dummy_device_with_features(Features::TIMESTAMP_QUERY);
        let mut frame = FrameData::new(&device, Features::TIMESTAMP_QUERY,
            #[cfg(feature = "tracing-tracy")] None);
        frame.frame_tag = Some(7);
        frame.callback = Some(Box::new(|result| {
            assert_eq!(result.gpu.frame_tag, Some(7));
            assert!(result.gpu.elapsed_ms.is_none());
        }));
        assert!(!frame.run_mapped_callback(1.0));
        frame.map_failed.store(true, Ordering::Release);
        assert!(frame.run_mapped_callback(1.0));
        assert!(frame.callback.is_none());
        frame.begin();
        assert_eq!(frame.frame_tag, None);
    }

    #[test]
    fn unsupported_device_can_encode_both_pass_kinds_without_query_features() {
        let (device, queue) = crate::test_utils::create_dummy_device();
        let info = RenderAdapterInfo(wgpu::AdapterInfo::new(wgpu::DeviceType::Cpu, wgpu::Backend::Noop));
        let mut recorder = DiagnosticsRecorder::new(&info, &device, &queue);
        recorder.begin_frame();
        let mut encoder = device.create_command_encoder(&Default::default());
        drop(recorder.begin_compute_pass(&mut encoder, &Default::default()));
        drop(recorder.begin_render_pass(&mut encoder, &Default::default()));
        assert_eq!(recorder.current_frame_lock().num_timestamps, 0);
        recorder.resolve(&mut encoder);
        queue.submit([encoder.finish()]);
        recorder.finish_frame(&device, |result| assert!(result.gpu.elapsed_ms.is_none()));
    }
}
