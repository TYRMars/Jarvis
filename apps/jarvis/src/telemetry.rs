//! Tracing subscriber + optional OTLP exporter init.
//!
//! Reads `JARVIS_OTEL_*` env vars at process start. OTLP export is
//! **opt-in** via `JARVIS_OTEL_ENABLED=1` / `true`. Default off —
//! the previous "default on, default endpoint 127.0.0.1:4317" mode
//! flooded logs with `BatchSpanProcessor.Flush.ExportError tcp
//! connect error` lines on every local dev box that didn't happen
//! to be running an OTLP collector. Operators who want telemetry
//! know to set the env var; everyone else stays quiet.
//!
//! When enabled, the subscriber gains a `tracing-opentelemetry`
//! layer backed by OTLP (gRPC default, `http/protobuf` opt-in). The
//! returned [`TelemetryGuard`] flushes the exporter on drop. Hold
//! it for the full process lifetime — dropping it early stops trace
//! export.

use harness_server::TelemetryStatus;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::trace::{Sampler, TracerProvider};
use opentelemetry_sdk::Resource;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Held for the lifetime of the process. `Drop` triggers a best-effort
/// shutdown of the OTel tracer provider so spans currently buffered in
/// the BatchSpanProcessor get flushed before exit.
pub struct TelemetryGuard {
    provider: Option<TracerProvider>,
    pub status: TelemetryStatus,
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

/// Initialise the global tracing subscriber.
///
/// Always installs an `EnvFilter` + stderr fmt layer (matching the
/// pre-OTel behaviour). When `JARVIS_OTEL_ENABLED` is set, also
/// installs a `tracing-opentelemetry` layer backed by an OTLP
/// exporter — the resulting `TracerProvider` is held by the returned
/// guard so it can be flushed on shutdown.
///
/// `default_filter` is used as the `EnvFilter` directive when
/// `RUST_LOG` is unset. If OTLP export is enabled, the directive is
/// upgraded to `info` so spans actually fire — otherwise the exporter
/// would have nothing to send.
pub fn init() -> TelemetryGuard {
    init_with_default_filter("info")
}

pub fn init_with_default_filter(default_filter: &str) -> TelemetryGuard {
    // Opt-in. The pre-2026-05 default of `true` produced ERROR log
    // spam on every local dev box (BatchSpanProcessor retrying its
    // tcp connect to 127.0.0.1:4317 every few seconds). Operators
    // who want telemetry set the env var; everyone else gets a
    // clean log.
    let enabled = env_flag_default("JARVIS_OTEL_ENABLED", false);
    // When OTel is on but `RUST_LOG` is unset, lift the baseline to
    // `info` so the instrumented spans actually reach the layer
    // pipeline. Otherwise the exporter would have nothing to send.
    let baseline = if std::env::var("RUST_LOG").is_err() && enabled {
        "info"
    } else {
        default_filter
    };
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(baseline));

    let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    let endpoint = std::env::var("JARVIS_OTEL_ENDPOINT")
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let protocol = std::env::var("JARVIS_OTEL_PROTOCOL").unwrap_or_else(|_| "grpc".to_string());
    let service_name =
        std::env::var("JARVIS_OTEL_SERVICE_NAME").unwrap_or_else(|_| "jarvis".to_string());
    let service_env =
        std::env::var("JARVIS_OTEL_ENV").unwrap_or_else(|_| "local".to_string());
    let sample_ratio: f64 = std::env::var("JARVIS_OTEL_SAMPLE_RATIO")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);

    if !enabled {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return TelemetryGuard {
            provider: None,
            status: TelemetryStatus {
                enabled: false,
                endpoint: None,
                protocol: None,
                service_name,
                service_env,
                sample_ratio,
            },
        };
    }

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
                protocol = %protocol,
                "OTLP exporter build failed; continuing with fmt logger only"
            );
            return TelemetryGuard {
                provider: None,
                status: TelemetryStatus {
                    enabled: false,
                    endpoint: Some(endpoint),
                    protocol: Some(protocol),
                    service_name,
                    service_env,
                    sample_ratio,
                },
            };
        }
    };

    let tracer = provider.tracer("jarvis");
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
        service_env = %service_env,
        sample_ratio,
        "OTLP tracing exporter installed"
    );

    TelemetryGuard {
        provider: Some(provider),
        status: TelemetryStatus {
            enabled: true,
            endpoint: Some(endpoint),
            protocol: Some(protocol),
            service_name,
            service_env,
            sample_ratio,
        },
    }
}
