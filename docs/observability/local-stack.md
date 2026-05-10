# Local OTel stack

Phase 1 of [otel-native-eval-harness.zh-CN.md](../proposals/otel-native-eval-harness.zh-CN.md): wire `tracing` + OTLP so a chat request shows up as a complete trace tree in Jaeger.

## Quick start

```bash
# 1. start collector + jaeger (localhost:4317 / localhost:16686)
docker compose -f infra/otel/docker-compose.yml up -d

# 2. run jarvis (OTLP exporter is on by default)
JARVIS_OTEL_ENDPOINT=http://127.0.0.1:4317 \
OPENAI_API_KEY=sk-... \
cargo run -p jarvis

# 3. fire a request (web UI at http://127.0.0.1:7001 or curl)
curl -N -X POST http://127.0.0.1:7001/v1/chat/completions/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# 4. open Jaeger
open http://127.0.0.1:16686

# 5. tear down
docker compose -f infra/otel/docker-compose.yml down
```

## Expected trace shape

A single chat request produces:

```text
http.request POST /v1/chat/completions/stream
  jarvis.agent.run                         (model, max_iterations, finish_reason)
    jarvis.agent.iteration                 (iteration=1)
      gen_ai.chat                          (provider, model, stream, finish_reason)
      gen_ai.tool.call                     (tool.name, args.bytes, success)
    jarvis.agent.iteration                 (iteration=2)
      gen_ai.chat
```

WebSocket turns swap the root for `ws.turn` (per-turn, not the socket lifetime).

SubAgent calls produce a `jarvis.subagent.run` span between the parent `gen_ai.tool.call` and its inner `gen_ai.chat` / `gen_ai.tool.call` children.

## Env vars

| Var | Default | Notes |
| --- | --- | --- |
| `JARVIS_OTEL_ENABLED` | enabled | OTLP exporter is on by default. Set `0` or `false` to disable it. |
| `JARVIS_OTEL_ENDPOINT` | `http://127.0.0.1:4317` | OTLP collector endpoint. |
| `JARVIS_OTEL_PROTOCOL` | `grpc` | `grpc` (default) or `http` / `http/protobuf`. |
| `JARVIS_OTEL_SERVICE_NAME` | `jarvis` | OTel `service.name` resource attribute. |
| `JARVIS_OTEL_ENV` | `local` | OTel `deployment.environment.name`. |
| `JARVIS_OTEL_SAMPLE_RATIO` | `1.0` | Head sampling ratio in `[0.0, 1.0]`. |

## Failure mode

If OTLP is enabled but the collector is unreachable, exporter batch failures land in stderr at WARN; the agent loop is unaffected. Spans buffered in the BatchSpanProcessor get dropped when the buffer fills. Set `JARVIS_OTEL_ENABLED=0` to run with the stderr fmt logger only.

## Switching to Tempo / Phoenix / Langfuse

The collector at `infra/otel/collector.yaml` ships with `otlp/jaeger` + `debug` exporters. Drop in a different exporter (e.g. `otlphttp` to Tempo, or vendor SDKs) without touching Jarvis itself — the binary only speaks OTLP.
