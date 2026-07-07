// Web terminal: a PTY-backed shell exposed over WebSocket so the right-rail
// Terminal panel can drive a real interactive shell from the browser. Ported
// from crates/harness-server/src/workspace_terminal.rs.
//
// Each WS upgrade spins up its own child process (node-pty); the child is
// killed on socket close, and the socket is closed when the child exits.
//
// Wire protocol (small, text-or-binary per frame), matching the Rust module:
//
//   - Client -> server TEXT frames are JSON control messages:
//       {"t":"input","data":"…"}        forwarded to PTY stdin verbatim
//       {"t":"resize","cols":80,"rows":24}
//       {"t":"ping"}                    no-op
//   - Client -> server BINARY frames are forwarded to PTY stdin verbatim.
//   - Server -> client frames carry raw PTY stdout/stderr. node-pty hands us
//     already-UTF-8-decoded strings (the Rust layer ships raw bytes); ANSI /
//     control sequences are passed through untouched so xterm.js renders them
//     faithfully.
//
// Sandbox: the working directory is `?root=<abs>` (validated the same way the
// read-only workspace endpoints do — absolute, NUL/newline/CR-free, resolves to
// a directory) or `AppState.workspaceRoot` when absent. Unlike the Rust module,
// which also accepts a relative `cwd` under the root, we mirror the existing
// workspace-routes.ts sandbox: an override `root` must be absolute and resolve
// under nothing wider than itself; a relative `cwd` query is additionally
// resolved UNDER the resolved root and rejected on `..` / absolute escapes.
// `503` when no root resolves.
//
// Shell: the Rust picks `$SHELL` then `/bin/zsh` -> `/bin/bash` -> `/bin/sh`
// (cmd.exe on Windows). We never read process.env, so we use a hardcoded
// default — `bash` if present else `sh` on posix, `cmd.exe` on win32 — with an
// optional `AppState.terminalShell` override (the only knob the composition
// root may supply). node-pty sets `$TERM` in the child from the `name` option
// (we force `xterm-256color`); the rest of the child env is inherited by
// node-pty internally (we do not touch process.env).
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AppState } from "./state.ts";

/** Default initial PTY size when the query omits cols/rows (Rust 80x24). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// ---------------------------------------------------------------------------
// Shell selection (no process.env)
// ---------------------------------------------------------------------------

/**
 * Pick the shell to spawn. Mirrors the Rust fallback chain shape without
 * reading the environment: an explicit `AppState.terminalShell` override wins,
 * otherwise a hardcoded default — `/bin/bash` if it exists else `/bin/sh` on
 * posix, `cmd.exe` on Windows.
 */
function pickShell(state: AppState): string {
  if (state.terminalShell && state.terminalShell.trim() !== "") {
    return state.terminalShell;
  }
  if (process.platform === "win32") {
    return "cmd.exe";
  }
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

// ---------------------------------------------------------------------------
// Workspace-root resolution + sandbox (mirrors workspace-routes.ts)
// ---------------------------------------------------------------------------

type ResolveResult = { ok: true; root: string } | { ok: false };

function badRequest(reply: FastifyReply, msg: string): FastifyReply {
  return reply.code(400).send({ error: msg });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve the workspace root for one request. A `?root=<abs>` override wins over
 * `AppState.workspaceRoot`; it must be absolute, NUL/newline/CR-free, and
 * `realpath` to an existing directory (anything else -> 400, already sent). When
 * both the override and the pinned root are absent -> 503 (already sent). On
 * success returns the canonical root. Mirrors Rust `resolve_workspace`.
 */
async function resolveWorkspace(
  state: AppState,
  reply: FastifyReply,
  overrideRoot: string | undefined,
): Promise<ResolveResult> {
  if (overrideRoot !== undefined) {
    const trimmed = overrideRoot.trim();
    if (trimmed === "") {
      badRequest(reply, "`root` must not be empty");
      return { ok: false };
    }
    if (/[\0\n\r]/.test(trimmed)) {
      badRequest(reply, "`root` contains forbidden characters");
      return { ok: false };
    }
    if (!isAbsolute(trimmed)) {
      badRequest(reply, "`root` must be an absolute path");
      return { ok: false };
    }
    let canonical: string;
    try {
      canonical = await realpath(trimmed);
    } catch (e) {
      badRequest(reply, `\`root\` does not resolve: ${errMsg(e)}`);
      return { ok: false };
    }
    let isDir = false;
    try {
      isDir = (await stat(canonical)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      badRequest(reply, "`root` is not a directory");
      return { ok: false };
    }
    return { ok: true, root: canonical };
  }
  if (state.workspaceRoot) {
    return { ok: true, root: state.workspaceRoot };
  }
  reply.code(503).send({ error: "workspace root not configured" });
  return { ok: false };
}

/**
 * Reject path traversal / absolute paths the same way the `fs.*` tools do.
 * Empty input is allowed here (means "the root itself"). Mirrors the
 * `safeRelative` in workspace-routes.ts.
 */
function safeRelative(rel: string): { ok: true; value: string } | { ok: false; error: string } {
  if (rel.startsWith("/")) {
    return { ok: false, error: "`cwd` must be relative to the workspace root" };
  }
  if (/[\0\n]/.test(rel)) {
    return { ok: false, error: "`cwd` contains forbidden characters" };
  }
  for (const comp of rel.split(/[/\\]/)) {
    if (comp === "..") {
      return { ok: false, error: "`cwd` must not contain `..`" };
    }
  }
  if (isAbsolute(rel)) {
    return { ok: false, error: "absolute `cwd` components are not allowed" };
  }
  return { ok: true, value: rel };
}

/**
 * Clamp a numeric terminal dimension to a positive integer `<= 0xffff`;
 * undefined when out of range / non-finite. Shared by the query-param path and
 * the WS `resize` frame so both entry points enforce identical bounds.
 */
export function clampDim(n: unknown): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const t = Math.trunc(n);
  if (t <= 0 || t > 0xffff) return undefined;
  return t;
}

/** Parse a u16-ish dimension from a query string; undefined when absent/invalid. */
function parseDim(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return clampDim(Number.parseInt(raw, 10));
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/terminal — capability probe
// ---------------------------------------------------------------------------

/**
 * Capability probe. The Terminal panel hits this on mount so it can render a
 * clean "unavailable" state instead of failing the WS upgrade. `available` is
 * false only when no workspace root resolves; actual PTY spawn errors surface
 * through the open WS as a closing frame. Mirrors Rust `status`.
 */
function handleStatus(state: AppState, reply: FastifyReply): FastifyReply {
  return reply.send({
    available: state.workspaceRoot != null,
    shell: pickShell(state),
  });
}

// ---------------------------------------------------------------------------
// WS /v1/workspace/terminal/ws — the PTY session
// ---------------------------------------------------------------------------

/** Client -> server JSON control frame (text frames only). */
interface ClientFrame {
  t?: string;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/**
 * Drive one PTY session over an open socket. Spawns the shell with cwd pinned
 * to `cwd`, wires PTY output -> socket and socket input -> PTY, handles resize
 * frames, and tears the child down on socket close / PTY exit. Mirrors Rust
 * `run_terminal`.
 */
function runTerminal(socket: WebSocket, shell: string, cwd: string, cols: number, rows: number): void {
  let pty: IPty;
  try {
    pty = spawn(shell, [], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
    });
  } catch (e) {
    // Surface the spawn failure as a close frame (the panel renders it as a
    // session error) rather than leaving a half-open socket.
    try {
      socket.close(1011, `spawn shell: ${errMsg(e)}`.slice(0, 120));
    } catch {
      /* socket already gone */
    }
    return;
  }

  let closed = false;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  // ---- PTY -> WS (output frames) ----
  pty.onData((chunk: string) => {
    if (closed) return;
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(chunk);
      } catch {
        teardown();
      }
    }
  });

  pty.onExit(() => {
    teardown();
  });

  // ---- WS -> PTY (input / resize / ping) ----
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      // Binary frame: forwarded to PTY stdin verbatim (Rust WsMessage::Binary).
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      try {
        pty.write(buf);
      } catch {
        teardown();
      }
      return;
    }
    // Text frame: a JSON control message.
    const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString();
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      // Bad frame — the Rust handler logs and ignores it.
      return;
    }
    switch (frame.t) {
      case "input": {
        if (typeof frame.data === "string") {
          try {
            pty.write(frame.data);
          } catch {
            teardown();
          }
        }
        return;
      }
      case "resize": {
        // Clamp/truncate to the same bounds as the `?cols=/?rows=` query path
        // so the frame path can't bypass the hardened dimension guard.
        const c = clampDim(frame.cols);
        const r = clampDim(frame.rows);
        if (c !== undefined && r !== undefined) {
          try {
            pty.resize(c, r);
          } catch {
            /* resize on a dead pty — ignore */
          }
        }
        return;
      }
      case "ping":
        return;
      default:
        // Unknown control frame — ignore (Rust treats it as a parse miss).
        return;
    }
  });

  socket.on("close", teardown);
  socket.on("error", teardown);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the workspace terminal routes:
 *   - GET /v1/workspace/terminal      capability probe ({available, shell})
 *   - GET /v1/workspace/terminal/ws   PTY-over-WebSocket session
 *
 * Both resolve a workspace root (`?root=<abs>` override or the pinned
 * `AppState.workspaceRoot`); the WS upgrade 503s / 400s before opening the PTY
 * when the root can't be resolved or a relative `?cwd=` escapes the sandbox.
 */
export function registerWorkspaceTerminalRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/workspace/terminal", (_req, reply) => handleStatus(state, reply));

  app.get(
    "/v1/workspace/terminal/ws",
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      void handleTerminalWs(socket, req, state);
    },
  );
}

/**
 * Validate + resolve the request, then hand the open socket to `runTerminal`.
 * Validation failures close the socket with a status reason (the upgrade has
 * already completed by the time the handler runs, so we can't 400/503 over
 * HTTP — we signal the client through the close frame instead).
 */
async function handleTerminalWs(socket: WebSocket, req: FastifyRequest, state: AppState): Promise<void> {
  const q = req.query as { root?: string; cwd?: string; cols?: string; rows?: string };

  // Reuse the HTTP resolver shape by faking a reply sink that records the
  // status/message, then translate a failure into a WS close.
  let failure: { code: number; msg: string } | undefined;
  const replyStub = {
    code(c: number) {
      this._code = c;
      return this;
    },
    send(body: { error?: string }) {
      failure = { code: this._code ?? 500, msg: body.error ?? "error" };
      return this;
    },
    _code: undefined as number | undefined,
  };
  const resolved = await resolveWorkspace(state, replyStub as unknown as FastifyReply, q.root);
  if (!resolved.ok) {
    closeWith(socket, failure?.code ?? 503, failure?.msg ?? "workspace root not configured");
    return;
  }
  let cwd = resolved.root;
  if (q.cwd !== undefined && q.cwd !== "") {
    const safe = safeRelative(q.cwd);
    if (!safe.ok) {
      closeWith(socket, 400, safe.error);
      return;
    }
    cwd = join(resolved.root, safe.value);
    // Confirm the resolved cwd still exists as a directory under the root.
    try {
      if (!(await stat(cwd)).isDirectory()) {
        closeWith(socket, 400, "`cwd` is not a directory");
        return;
      }
    } catch {
      closeWith(socket, 400, "`cwd` does not resolve");
      return;
    }
  }

  const cols = parseDim(q.cols) ?? DEFAULT_COLS;
  const rows = parseDim(q.rows) ?? DEFAULT_ROWS;
  runTerminal(socket, pickShell(state), cwd, cols, rows);
}

/**
 * Close the socket with an application close code + reason. 1008 (policy
 * violation) for client errors, 1011 (internal error) for 503/server, so the
 * panel can distinguish "your request was bad" from "the server can't serve a
 * terminal here". The reason carries the human message (capped to the WS
 * 123-byte reason limit).
 */
function closeWith(socket: WebSocket, httpStatus: number, msg: string): void {
  const code = httpStatus >= 500 ? 1011 : 1008;
  try {
    socket.close(code, msg.slice(0, 120));
  } catch {
    /* socket already gone */
  }
}
