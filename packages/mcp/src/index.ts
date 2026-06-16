// @jarvis/mcp — MCP bridge (client + server). Public surface.
//
// Client side: connect to an external MCP server over stdio, list its tools,
// and adapt each into a harness `Tool` (renamed `<prefix>.<name>`).
// Server side: expose a local `ToolRegistry` to external MCP clients over stdio
// (what the `--mcp-serve` subcommand calls).
export {
  McpClient,
  RemoteTool,
  McpError,
  connectAllMcp,
  mcpClientConfig,
  stdioTransport,
  type McpClientConfig,
  type McpClientHandle,
  type McpTransport,
} from "./client.ts";
export { McpServer, serveRegistryStdio } from "./server.ts";
