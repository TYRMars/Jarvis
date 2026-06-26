// A minimal MCP stdio server fixture for integration tests: advertises a single
// `echo` tool and serves it over stdio. Used by client.test.ts to exercise the
// real spawn → handshake → registerInto path (e.g. connectAllMcp rollback).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stdio-echo-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes the input",
      inputSchema: { type: "object", properties: { msg: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo ${JSON.stringify(req.params.arguments ?? {})}` }],
}));

await server.connect(new StdioServerTransport());
