// OpenTelemetry SDK bootstrap — composition-root only.
//
// The library packages (@jarvis/core's agent loop) emit `jarvis.agent.run` +
// `gen_ai.tool.call` spans through `@opentelemetry/api`, which is a no-op until a
// TracerProvider is registered. This file is the SOLE place that registers one,
// reading process.env (allowed here, like the rest of jarvis-app). It is OFF
// unless explicitly enabled, so default runs pay nothing.
//
// Enable via either:
//   JARVIS_OTEL_ENABLED=1                 → OTLP/HTTP exporter (honours the
//                                           standard OTEL_EXPORTER_OTLP_* vars)
//   OTEL_EXPORTER_OTLP_ENDPOINT=<url>     → same, implicitly enables
//   JARVIS_OTEL_CONSOLE=1                 → print spans to stderr (verify/debug;
//                                           no collector needed)
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/** Handle returned by {@link startOtel}; call `shutdown()` to flush + stop. */
export interface OtelHandle {
  shutdown(): Promise<void>;
}

type Env = Record<string, string | undefined>;

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}

/** Whether tracing should be wired for `env`. Pure — safe to unit-test without
 * registering a global provider. */
export function otelEnabled(env: Env): boolean {
  return (
    truthy(env.JARVIS_OTEL_ENABLED) ||
    truthy(env.JARVIS_OTEL_CONSOLE) ||
    (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim() !== ""
  );
}

/**
 * Start the OTel Node SDK when enabled, registering the global TracerProvider so
 * the agent-loop spans become live. Returns a shutdown handle, or `undefined`
 * when tracing is disabled (the common case). Console mode uses a
 * SimpleSpanProcessor (immediate stderr output) for easy verification; the OTLP
 * path batches.
 */
export function startOtel(env: Env = process.env): OtelHandle | undefined {
  if (!otelEnabled(env)) return undefined;

  const useConsole = truthy(env.JARVIS_OTEL_CONSOLE);
  const processor: SpanProcessor = useConsole
    ? new SimpleSpanProcessor(new ConsoleSpanExporter())
    : new BatchSpanProcessor(new OTLPTraceExporter());

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? "jarvis",
      [ATTR_SERVICE_VERSION]: env.JARVIS_VERSION ?? "0.0.0",
    }),
    spanProcessors: [processor],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
