# jarvis-client

Python SDK for the Jarvis agent runtime HTTP API. Stdlib-only — zero
dependencies, Python ≥ 3.9.

The wire surface this client targets is the curated OpenAPI document the
server serves at `GET /v1/openapi.json`.

## Usage

```python
from jarvis_client import JarvisClient

jarvis = JarvisClient("http://127.0.0.1:7001")

# meta
print(jarvis.version())  # {"name": "jarvis", "version": "0.2.0"}

# chat — blocking
out = jarvis.chat.complete([{"role": "user", "content": "hello"}])
print(out["message"]["content"])

# chat — streaming (one AgentEvent dict per SSE frame)
for ev in jarvis.chat.stream([{"role": "user", "content": "hi"}]):
    if ev.get("type") == "delta":
        print(ev.get("content"), end="")

# persisted conversations
conv = jarvis.conversations.create(system="be terse")
jarvis.conversations.post_message(conv["id"], "what changed today?")

# work (projects + requirements kanban)
jarvis.work.projects.create("demo")
jarvis.work.requirements.create("demo", "ship the SDK")

# long-term memory
jarvis.memory.list(scope="user", limit=50)
```

Non-2xx replies raise `JarvisApiError` with `.status` and `.body`.
Endpoints backed by an unconfigured store reply `503`.
