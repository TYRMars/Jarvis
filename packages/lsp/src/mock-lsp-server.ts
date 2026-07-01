// A tiny LSP server used only by the tests — speaks the same `Content-Length`
// framing as a real server so the client/manager are exercised end-to-end over
// a real child process (no mocking of internals).
//
// Behaviour: replies to `initialize`, then on every `didOpen` / `didChange`
// pushes an EMPTY diagnostics array immediately and, if the document text
// contains the marker `@@ERROR@@ <msg>`, a populated array ~30ms later. That
// "empty then populated" sequence mirrors tsserver and exercises the client's
// settle window (it must resolve with the later, populated push).
//
// Run as: `node --experimental-strip-types mock-lsp-server.ts` (the path is
// passed by the test through a custom LanguageRegistry).
//
// Fault injection (for the manager's dead-client eviction tests): pass
// `--mode-file=<path>` and the server reads that file at startup —
//   "hang" → accept the connection but never answer `initialize` (readiness
//            times out); "exit" → exit(1) immediately; anything else → normal.
// The file is re-read on every (re)spawn, so a test can flip a server from
// broken to healthy between `report()` calls.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

/** Startup fault mode, read once from `--mode-file` (default: healthy). */
function startupMode(): "hang" | "exit" | "ok" {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--mode-file="));
  if (!arg) return "ok";
  try {
    const mode = readFileSync(arg.slice("--mode-file=".length), "utf8").trim();
    return mode === "hang" || mode === "exit" ? mode : "ok";
  } catch {
    return "ok";
  }
}

const MODE = startupMode();
if (MODE === "exit") process.exit(1);

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
}

function send(msg: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function publish(uri: string, errorMessage: string | null): void {
  send({
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: [] },
  });
  if (errorMessage !== null) {
    setTimeout(() => {
      send({
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              source: "mock",
              message: errorMessage,
            },
          ],
        },
      });
    }, 30);
  }
}

function docFromParams(params: unknown): { uri: string; text: string } | null {
  const td = (params as { textDocument?: { uri?: string; text?: string } } | undefined)?.textDocument;
  if (!td?.uri) return null;
  if (typeof td.text === "string") return { uri: td.uri, text: td.text };
  const changes = (params as { contentChanges?: { text?: string }[] } | undefined)?.contentChanges;
  const text = changes?.[changes.length - 1]?.text;
  return { uri: td.uri, text: typeof text === "string" ? text : "" };
}

function handle(msg: RpcMessage): void {
  switch (msg.method) {
    case "initialize":
      // "hang" mode: swallow the handshake so the client's readiness times out.
      if (MODE === "hang") return;
      send({ id: msg.id, result: { capabilities: {} } });
      return;
    case "shutdown":
      send({ id: msg.id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    case "textDocument/didOpen":
    case "textDocument/didChange": {
      const doc = docFromParams(msg.params);
      if (!doc) return;
      const match = /@@ERROR@@\s*([^\n]*)/.exec(doc.text);
      publish(doc.uri, match ? `mock error: ${(match[1] ?? "").trim()}` : null);
      return;
    }
    default:
      // Notifications we ignore (initialized, …) and any server-unknown method.
      return;
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1] as string, 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body) as RpcMessage);
    } catch {
      // ignore malformed input
    }
  }
});
