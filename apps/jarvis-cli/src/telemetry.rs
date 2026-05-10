//! Tracing subscriber + optional OTLP exporter init for `jarvis-cli`.
//!
//! Mirrors `apps/jarvis/src/telemetry.rs` so both binaries pick up the
//! same `JARVIS_OTEL_*` env surface. Kept as a copy (not a shared
//! crate) per the Phase 1 plan — ~140 lines is cheaper than a new
//! crate boundary.
//!
//! The CLI defaults its `EnvFilter` baseline to `warn` (vs the
//! server's `info`) so streamed assistant text on stdout stays
//! pipe-clean. OTLP export is enabled by default and can be disabled
//! with `JARVIS_OTEL_ENABLED=0` / `false`; when enabled, the baseline
//! is bumped to `info` automatically so the exporter has spans to
//! send.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::trace::{Sampler, TracerProvider};
use opentelemetry_sdk::Resource;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

pub struct TelemetryGuard {
    provider: Option<TracerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            let _ = provider.shutdown();
        }
    }
}

fn env_flag_default(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"),
        Err(_) => default,
    }
}

pub fn init() -> TelemetryGuard {
    let enabled = env_flag_default("JARVIS_OTEL_ENABLED", true);
    let baseline = if std::env::var("RUST_LOG").is_err() && enabled {
        "info"
    } else {
        "warn"
    };
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(baseline));
    let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    if !enabled {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return TelemetryGuard { provider: None };
    }

    let endpoint = std::env::var("JARVIS_OTEL_ENDPOINT")
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let protocol = std::env::var("JARVIS_OTEL_PROTOCOL").unwrap_or_else(|_| "grpc".to_string());
    let service_name =
        std::env::var("JARVIS_OTEL_SERVICE_NAME").unwrap_or_else(|_| "jarvis-cli".to_string());
    let service_env =
        std::env::var("JARVIS_OTEL_ENV").unwrap_or_else(|_| "local".to_string());
    let sample_ratio: f64 = std::env::var("JARVIS_OTEL_SAMPLE_RATIO")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);

    let resource = Resource::new(vec![
        KeyValue::new("service.name", service_name.clone()),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        KeyValue::new("deployment.environment.name", service_env.clone()),
    ]);

    let provider_result = if protocol.eq_ignore_ascii_case("http")
        || protocol.eq_ignore_ascii_case("http/protobuf")
    {
        opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(&endpoint)
            .with_protocol(Protocol::HttpBinary)
            .build()
            .map(|exporter| {
                TracerProvider::builder()
                    .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
                    .with_resource(resource.clone())
                    .with_sampler(Sampler::TraceIdRatioBased(sample_ratio.clamp(0.0, 1.0)))
                    .build()
            })
    } else {
        opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(&endpoint)
            .build()
            .map(|exporter| {
                TracerProvider::builder()
                    .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
                    .with_resource(resource.clone())
                    .with_sampler(Sampler::TraceIdRatioBased(sample_ratio.clamp(0.0, 1.0)))
                    .build()
            })
    };

    let provider = match provider_result {
        Ok(p) => p,
        Err(err) => {
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .init();
            tracing::warn!(
                error = %err,
                endpoint = %endpoint,
                "OTLP exporter build failed; continuing with fmt logger only"
            );
            return TelemetryGuard { provider: None };
        }
    };

    let tracer = provider.tracer("jarvis-cli");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    opentelemetry::global::set_tracer_provider(provider.clone());

    tracing::info!(
        endpoint = %endpoint,
        protocol = %protocol,
        service_name = %service_name,
        sample_ratio,
        "OTLP tracing exporter installed"
    );

    TelemetryGuard {
        provider: Some(provider),
    }
}
