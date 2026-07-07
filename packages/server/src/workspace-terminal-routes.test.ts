import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { Agent, ToolRegistry, defaultAgentConfig, type LlmProvider } from "@jarvis/core";
import { serve } from "./server.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

/** A provider that is never actually called by the terminal routes. */
const idleProvider: LlmProvider = {
  complete: () =>
    Promise.resolve({
      message: { role: "assistant", content: "" },
      finish_reason: "stop",
      response_id: null,
    }),
  async *completeStream() {
    yield {
      type: "finish",
      message: { role: "assistant", content: "" },
      finish_reason: "stop",
      response_id: null,
    };
  },
};

function makeState(workspaceRoot?: string): AppState {
  const tools = new ToolRegistry();
  return {
    workspaceRoot,
    createAgent: () => new Agent(idleProvider, { ...defaultAgentConfig("test-model"), tools }),
  };
}

/** Spin a real server on an ephemeral port. */
async function startServer(state: AppState): Promise<{ port: number; close: () => Promise<void> }> {
  const app = await serve({ host: "127.0.0.1", port: 0 }, state);
  const { port } = app.server.address() as { port: number };
  return { port, close: () => app.close() };
}

/** Generous poll-until-true with a deadline (PTY output is async). */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition not met before timeout");
}

interface TermClient {
  ws: WebSocket;
  output: () => string;
  send(obj: unknown): void;
  close(): void;
}

/** Open a terminal WS and accumulate decoded output frames. */
async function openTerminal(port: number, query = ""): Promise<TermClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/workspace/terminal/ws${query}`);
  await once(ws, "open");
  let buf = "";
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    buf += isBinary ? data.toString("binary") : data.toString("utf8");
  });
  return {
    ws,
    output: () => buf,
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  };
}

// ---------- GET /v1/workspace/terminal (probe) ----------

test("GET /v1/workspace/terminal reports availability + shell when root set", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/workspace/terminal`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { available: boolean; shell: string };
    assert.equal(body.available, true);
    assert.equal(typeof body.shell, "string");
    assert.ok(body.shell.length > 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /v1/workspace/terminal reports unavailable with no root", async () => {
  const { port, close } = await startServer(makeState(undefined));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/workspace/terminal`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { available: boolean };
    assert.equal(body.available, false);
  } finally {
    await close();
  }
});

// ---------- WS PTY: streams output ----------

test("WS terminal streams shell output for an input command", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const client = await openTerminal(port);
  try {
    client.send({ t: "input", data: "echo jarvis-pty-marker\n" });
    await waitFor(() => client.output().includes("jarvis-pty-marker"));
    assert.ok(client.output().includes("jarvis-pty-marker"));
  } finally {
    client.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- WS PTY: resize is accepted ----------

test("WS terminal accepts a resize frame and keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const client = await openTerminal(port);
  try {
    client.send({ t: "resize", cols: 120, rows: 40 });
    // After a resize, the shell must still be alive and echo new input.
    client.send({ t: "input", data: "echo after-resize-ok\n" });
    await waitFor(() => client.output().includes("after-resize-ok"));
    assert.ok(client.output().includes("after-resize-ok"));
  } finally {
    client.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS terminal survives out-of-bounds / fractional resize frames (clamped, not crashed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const client = await openTerminal(port);
  try {
    // Absurdly large and fractional geometries — the clamp must reject/truncate
    // these rather than forwarding them to pty.resize (the query-path guard's
    // bounds must apply to the WS frame path too).
    client.send({ t: "resize", cols: 1e12, rows: 1e12 });
    client.send({ t: "resize", cols: 80.5, rows: 24.5 });
    client.send({ t: "resize", cols: 0, rows: 0 });
    // The shell must still be alive and echo new input.
    client.send({ t: "input", data: "echo still-alive-ok\n" });
    await waitFor(() => client.output().includes("still-alive-ok"));
    assert.ok(client.output().includes("still-alive-ok"));
  } finally {
    client.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- WS PTY: closing the socket kills the pty ----------

test("WS terminal: exiting the shell closes the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const client = await openTerminal(port);
  try {
    const closed = once(client.ws, "close");
    // `exit` ends the child; the server tears down -> socket closes.
    client.send({ t: "input", data: "exit\n" });
    const [code] = (await Promise.race([
      closed,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("socket did not close")), 5000)),
    ])) as [number];
    assert.equal(typeof code, "number");
  } finally {
    client.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS terminal: closing the socket terminates the child (no leak)", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const client = await openTerminal(port);
  try {
    // Print the shell's own PID over the stream so we can adversarially verify
    // the OS process is *actually* reaped on socket close — not merely that the
    // close handler ran. A teardown that forgot `pty.kill()` would still close
    // the socket but leave this process alive, which the liveness poll catches.
    client.send({ t: "input", data: "echo SHELLPID=$$\n" });
    await waitFor(() => /SHELLPID=(\d+)/.test(client.output()));
    const match = client.output().match(/SHELLPID=(\d+)/);
    assert.ok(match, "shell PID marker not seen in output");
    const shellPid = Number.parseInt(match[1]!, 10);
    assert.ok(Number.isInteger(shellPid) && shellPid > 0, "bad shell PID");

    // The process must be alive while the socket is open.
    assert.doesNotThrow(() => process.kill(shellPid, 0), "shell should be alive pre-close");

    // Close the socket; server-side teardown must kill the pty. First confirm
    // the close completes (the kill path doesn't throw / hang)...
    const closed = once(client.ws, "close");
    client.close();
    await Promise.race([
      closed,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("close hung")), 5000)),
    ]);

    // ...then confirm the OS process is gone (signal-0 throws ESRCH). Poll with
    // a deadline: reaping after kill() is async (the kernel delivers SIGHUP and
    // the parent must reap), so we wait for the process to disappear, not assume
    // it's instant.
    await waitFor(() => {
      try {
        process.kill(shellPid, 0);
        return false; // still alive
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH"; // reaped
      }
    });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- sandbox rejection ----------

test("WS terminal rejects an out-of-root absolute `root` override", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  // A `root` that does not resolve to a directory -> 400 -> close 1008.
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/v1/workspace/terminal/ws?root=${encodeURIComponent("/no/such/jarvis/root")}`,
  );
  try {
    const [code] = (await Promise.race([
      once(ws, "close"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no close")), 5000)),
    ])) as [number];
    assert.equal(code, 1008);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS terminal rejects a relative `cwd` that escapes the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-term-"));
  const { port, close } = await startServer(makeState(root));
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/v1/workspace/terminal/ws?cwd=${encodeURIComponent("../escape")}`,
  );
  try {
    const [code] = (await Promise.race([
      once(ws, "close"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no close")), 5000)),
    ])) as [number];
    assert.equal(code, 1008);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS terminal 503-closes when no workspace root is configured", async () => {
  const { port, close } = await startServer(makeState(undefined));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/workspace/terminal/ws`);
  try {
    const [code] = (await Promise.race([
      once(ws, "close"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no close")), 5000)),
    ])) as [number];
    assert.equal(code, 1011);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
  }
});
