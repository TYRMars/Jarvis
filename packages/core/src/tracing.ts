// OpenTelemetry instrumentation seam for the agent loop.
//
// `@opentelemetry/api` is the standard library-instrumentation surface: until a
// composition root registers a TracerProvider (see packages/jarvis-app's OTel
// bootstrap), every span here is a no-op with zero overhead and no dependency on
// process.env — so core stays a leaf. When the SDK IS registered, the loop emits
// two span kinds (mirroring the Rust `tracing` spans named in the rewrite
// tasklist):
//
//   jarvis.agent.run   — one per Agent.run / Agent.runStream invocation; carries
//                        `jarvis.agent.model` + `jarvis.agent.iterations`.
//   gen_ai.tool.call   — one per tool invocation; carries `gen_ai.tool.name` +
//                        `gen_ai.tool.call.id`. Parented to the agent span.
//
// The blocking path nests tool spans via the ambient active context; the
// streaming path can't rely on ambient context across `yield`s, so it threads
// the agent span in explicitly as the parent.
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { errorText } from "./error.ts";

/** Instrumentation scope name for the agent-loop tracer. */
export const TRACER_NAME = "@jarvis/core";

/** Start the top-level `jarvis.agent.run` span. The caller owns its lifetime
 * and MUST call {@link endAgentSpan}. */
export function startAgentSpan(model: string): Span {
  return trace.getTracer(TRACER_NAME).startSpan("jarvis.agent.run", {
    attributes: { "jarvis.agent.model": model },
  });
}

/** End an agent span, recording the iteration count and an optional error. */
export function endAgentSpan(span: Span, info: { iterations?: number; error?: unknown }): void {
  if (info.iterations !== undefined) {
    span.setAttribute("jarvis.agent.iterations", info.iterations);
  }
  if (info.error !== undefined) {
    span.recordException(toError(info.error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorText(info.error) });
  }
  span.end();
}

/**
 * Run `fn` inside a `gen_ai.tool.call` child span. `parent`, when given, is set
 * as the span's parent context explicitly — the streaming loop passes its agent
 * span here because the ambient OTel context isn't preserved across generator
 * `yield`s. The span records (and re-throws) any exception so a throwing
 * `tool.invoke` is reflected, even though the caller later formats it as text.
 */
export function withToolSpan<T>(
  toolName: string,
  callId: string,
  fn: () => Promise<T>,
  parent?: Span,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const opts = { attributes: { "gen_ai.tool.name": toolName, "gen_ai.tool.call.id": callId } };
  const body = (span: Span): Promise<T> =>
    fn().then(
      (r) => {
        span.end();
        return r;
      },
      (e: unknown) => {
        span.recordException(toError(e));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorText(e) });
        span.end();
        throw e;
      },
    );
  if (parent) {
    const ctx = trace.setSpan(context.active(), parent);
    return tracer.startActiveSpan("gen_ai.tool.call", opts, ctx, body);
  }
  return tracer.startActiveSpan("gen_ai.tool.call", opts, body);
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(errorText(e));
}
