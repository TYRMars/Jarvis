/**
 * TypeScript client SDK for the Jarvis agent runtime HTTP API.
 *
 * Namespaces mirror the product design: `chat` (completions +
 * conversations), `work` (projects + requirements kanban), `memory`
 * (long-term memory rows). The wire surface this client targets is the
 * curated document served at `GET /v1/openapi.json`.
 *
 * Zero runtime dependencies — uses the platform `fetch` (Node >= 18,
 * browsers, Deno, Bun). Pass a custom `fetch` for older runtimes.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [extra: string]: unknown;
}

export interface ChatCompletionsRequest {
  messages: Message[];
  model?: string;
  /** Explicit provider name; wins over a `provider/model` form on `model`. */
  provider?: string;
}

export interface ChatCompletionsResponse {
  message: Message;
  iterations: number;
  history: Message[];
}

/** One streamed agent event (`AgentEvent` on the wire, tagged by `type`). */
export interface AgentEvent {
  type: string;
  [extra: string]: unknown;
}

export interface VersionInfo {
  name: string;
  version: string;
}

export class JarvisApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Jarvis API error: HTTP ${status}`);
    this.name = "JarvisApiError";
    this.status = status;
    this.body = body;
  }
}

export interface JarvisClientOptions {
  /** Server origin, e.g. `http://127.0.0.1:7001`. Default: same origin (""). */
  baseUrl?: string;
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Extra headers attached to every request (e.g. auth). */
  headers?: Record<string, string>;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export class JarvisClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: JarvisClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
  }

  // ---- meta -----------------------------------------------------------

  health(signal?: AbortSignal): Promise<unknown> {
    return this.request("/health", { signal });
  }

  version(signal?: AbortSignal): Promise<VersionInfo> {
    return this.request("/v1/version", { signal });
  }

  serverInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/v1/server/info", { signal });
  }

  openapi(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/v1/openapi.json", { signal });
  }

  // ---- chat -----------------------------------------------------------

  readonly chat = {
    /** Blocking agent run over a message list. */
    complete: (
      req: ChatCompletionsRequest,
      signal?: AbortSignal,
    ): Promise<ChatCompletionsResponse> =>
      this.request("/v1/chat/completions", { method: "POST", body: req, signal }),

    /**
     * Streaming agent run. Yields one `AgentEvent` per SSE `data:` frame
     * until the server closes the stream (after `done` / `error`).
     */
    stream: (
      req: ChatCompletionsRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> =>
      this.sse("/v1/chat/completions/stream", req, signal),
  };

  readonly conversations = {
    create: (
      body: { system?: string; id?: string; project?: string } = {},
      signal?: AbortSignal,
    ): Promise<{ id: string }> =>
      this.request("/v1/conversations", { method: "POST", body, signal }),

    list: (limit?: number, signal?: AbortSignal): Promise<unknown> =>
      this.request("/v1/conversations", { query: { limit }, signal }),

    get: (id: string, signal?: AbortSignal): Promise<unknown> =>
      this.request(`/v1/conversations/${encodeURIComponent(id)}`, { signal }),

    delete: (id: string, signal?: AbortSignal): Promise<unknown> =>
      this.request(`/v1/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal,
      }),

    /** Append a user message, run the agent, persist + return the result. */
    postMessage: (
      id: string,
      body: { content: string; model?: string; provider?: string },
      signal?: AbortSignal,
    ): Promise<{ id: string; message: Message; iterations: number; history: Message[] }> =>
      this.request(`/v1/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body,
        signal,
      }),

    /** Streaming variant of `postMessage` (SSE `AgentEvent` frames). */
    streamMessage: (
      id: string,
      body: { content: string; model?: string; provider?: string },
      signal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> =>
      this.sse(
        `/v1/conversations/${encodeURIComponent(id)}/messages/stream`,
        body,
        signal,
      ),
  };

  // ---- work (projects + requirements kanban) ---------------------------

  readonly work = {
    projects: {
      list: (signal?: AbortSignal): Promise<unknown> =>
        this.request("/v1/projects", { signal }),

      create: (
        body: { name: string } & Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<unknown> =>
        this.request("/v1/projects", { method: "POST", body, signal }),

      get: (idOrSlug: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/projects/${encodeURIComponent(idOrSlug)}`, { signal }),
    },

    requirements: {
      list: (
        projectId: string,
        triageState?: "approved" | "proposed_by_agent" | "proposed_by_scan" | "proposed",
        signal?: AbortSignal,
      ): Promise<unknown> =>
        this.request(
          `/v1/projects/${encodeURIComponent(projectId)}/requirements`,
          { query: { triage_state: triageState }, signal },
        ),

      create: (
        projectId: string,
        body: { title: string } & Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<unknown> =>
        this.request(
          `/v1/projects/${encodeURIComponent(projectId)}/requirements`,
          { method: "POST", body, signal },
        ),

      get: (id: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}`, { signal }),

      update: (
        id: string,
        patch: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: patch,
          signal,
        }),

      delete: (id: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}`, {
          method: "DELETE",
          signal,
        }),

      approve: (id: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}/approve`, {
          method: "POST",
          signal,
        }),

      reject: (id: string, reason: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}/reject`, {
          method: "POST",
          body: { reason },
          signal,
        }),

      runs: (id: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}/runs`, { signal }),

      startRun: (id: string, signal?: AbortSignal): Promise<unknown> =>
        this.request(`/v1/requirements/${encodeURIComponent(id)}/runs`, {
          method: "POST",
          signal,
        }),
    },
  };

  // ---- memory ----------------------------------------------------------

  readonly memory = {
    list: (
      query: { scope?: "user" | "project" | "workspace"; limit?: number } = {},
      signal?: AbortSignal,
    ): Promise<unknown> => this.request("/v1/memories", { query, signal }),

    create: (item: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> =>
      this.request("/v1/memories", { method: "POST", body: item, signal }),

    patch: (
      id: string,
      patch: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> =>
      this.request(`/v1/memories/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
        signal,
      }),

    delete: (id: string, signal?: AbortSignal): Promise<{ deleted: boolean }> =>
      this.request(`/v1/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal,
      }),
  };

  // ---- transport -------------------------------------------------------

  private url(path: string, query?: RequestOptions["query"]): string {
    let url = this.baseUrl + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const resp = await this.fetchImpl(this.url(path, opts.query), {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...this.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body (e.g. plain-text health) — return as-is
    }
    if (!resp.ok) {
      throw new JarvisApiError(resp.status, parsed);
    }
    return parsed as T;
  }

  /** POST `body`, parse the response as an SSE stream of JSON frames. */
  private async *sse(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const resp = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }
      throw new JarvisApiError(resp.status, parsed);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame's payload
        // is the concatenation of its `data:` lines.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          try {
            yield JSON.parse(data) as AgentEvent;
          } catch {
            // skip malformed frames rather than aborting the stream
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export default JarvisClient;
