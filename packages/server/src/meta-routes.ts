// Operator/meta routes. Ported from harness-server (routes.rs get_server_info /
// probe_provider, openapi.rs version):
//   GET  /v1/server/info          — runtime config snapshot (no secrets)
//   GET  /v1/version              — { name: "jarvis", version }
//   POST /v1/providers/:name/probe — provider connectivity ping
//
// server/info merges the static, config-derived `state.serverInfo` snapshot
// with the LIVE tool list (registry, incl. muted), mcp prefixes, and provider
// catalog so a runtime mute / mcp add is reflected on the next fetch.
import type { FastifyInstance } from "fastify";
import { errorText, userMessage, type ToolSpec } from "@jarvis/core";
import type { AppState } from "./state.ts";

interface ProbeBody {
  model?: string;
  test_tools?: boolean;
}

export function registerMetaRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/server/info", async (_req, reply) => {
    const info = state.serverInfo ?? {};
    const tools = state.tools ? state.tools.allNames().sort() : [];
    const mcpServers = state.mcpManager ? state.mcpManager.list().map((s) => s.prefix) : [];
    const providers = state.providerCatalog?.providers ?? [];
    return reply.send({
      ...info,
      tools,
      tool_count: tools.length,
      mcp_servers: mcpServers,
      providers,
    });
  });

  app.get("/v1/version", async (_req, reply) => {
    return reply.send({ name: "jarvis", version: state.serverInfo?.version ?? "0.0.0" });
  });

  // Probe the configured provider with a minimal completion. Capability fields
  // are nullable — reported as `null` (unknown) unless actually exercised. The
  // outcome is always a 200 with the result in the body (never an HTTP error),
  // matching the web `ProbeResult` contract.
  app.post("/v1/providers/:name/probe", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!state.provider) return reply.code(503).send({ error: "no provider configured" });
    const body = (req.body ?? {}) as ProbeBody;
    const entry = state.providerCatalog?.providers.find((p) => p.name === name);
    const model = body.model ?? entry?.default_model ?? "";
    const start = Date.now();
    const result: {
      name: string;
      model: string;
      auth_ok: boolean;
      default_model_ok: boolean;
      supports_tool_calls: boolean | null;
      supports_streaming: boolean | null;
      latency_ms: number;
      error: string | null;
    } = {
      name,
      model,
      auth_ok: false,
      default_model_ok: false,
      // Every provider in tree streams.
      supports_streaming: true,
      supports_tool_calls: null,
      latency_ms: 0,
      error: null,
    };

    try {
      await state.provider.complete({
        model,
        messages: [userMessage("ping")],
        max_tokens: 1,
        temperature: 0,
      });
      result.auth_ok = true;
      result.default_model_ok = true;
    } catch (e) {
      // A failed ping leaves auth_ok/default_model_ok false; the message tells
      // the operator whether it's a bad key, a bad model, or a transport error.
      result.error = errorText(e);
      result.latency_ms = Date.now() - start;
      return reply.send(result);
    }

    if (body.test_tools) {
      const noop: ToolSpec = { name: "noop", description: "probe", parameters: { type: "object" } };
      try {
        await state.provider.complete({
          model,
          messages: [userMessage("ping")],
          max_tokens: 1,
          temperature: 0,
          tools: [noop],
        });
        result.supports_tool_calls = true;
      } catch {
        result.supports_tool_calls = false;
      }
    }

    result.latency_ms = Date.now() - start;
    return reply.send(result);
  });
}
