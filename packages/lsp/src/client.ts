// A minimal LSP client. Spawns one language server over stdio, speaks
// JSON-RPC with hand-rolled `Content-Length` framing (no `vscode-jsonrpc`
// dependency), and collects PUSH diagnostics (`textDocument/publishDiagnostics`)
// — the path TypeScript / Pyright / gopls / rust-analyzer all use on open.
//
// Deliberately omits opencode's pull-diagnostics, workspace-diagnostics, and
// dynamic-registration machinery (the heavy, fragile parts). The one timing
// nuance kept is a SETTLE window: servers often push an empty array first and
// the populated array a moment later (tsserver sends syntactic then semantic),
// so `openAndDiagnose` resolves `settleMs` after the LAST push, not the first.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import type { Diagnostic, PublishDiagnosticsParams } from "./protocol.ts";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface LspClientOptions {
  command: string;
  args: string[];
  /** Workspace root URI (`file://…`). */
  rootUri: string;
  /** Spawn cwd (the workspace root path). */
  cwd: string;
  /** Hard cap waiting for an `initialize` reply. Default 5000ms. */
  initializeTimeoutMs?: number;
}

export class LspClient {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  /** uri → latest pushed diagnostics. */
  readonly #diagnostics = new Map<string, Diagnostic[]>();
  /** uri → settle callbacks fired on each publish. */
  readonly #waiters = new Map<string, Set<() => void>>();
  /** uri → last document version we sent (didOpen=1, then didChange++). */
  readonly #opened = new Map<string, number>();
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(opts: LspClientOptions) {
    this.#child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    // Servers log to stderr; drain it so the pipe never blocks the child.
    this.#child.stderr.on("data", () => {});
    this.#child.on("error", (err) => this.#handleClose(err));
    this.#child.on("exit", () => this.#handleClose(new Error("language server exited")));
    this.#ready = this.#initialize(opts.rootUri, opts.initializeTimeoutMs ?? 5000);
    // Surface nothing if no one awaits readiness before disposing.
    this.#ready.catch(() => {});
  }

  async #initialize(rootUri: string, timeoutMs: number): Promise<void> {
    await this.#request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      timeoutMs,
    );
    this.#notify("initialized", {});
  }

  /**
   * Open (or re-sync) `absPath` and resolve with the diagnostics the server
   * pushes for it, `settleMs` after the last push or at `timeoutMs`. Best-effort:
   * a server that never pushes resolves `[]` at the hard timeout.
   */
  async openAndDiagnose(
    absPath: string,
    languageId: string,
    text: string,
    opts: { timeoutMs?: number; settleMs?: number } = {},
  ): Promise<Diagnostic[]> {
    await this.#ready;
    const uri = pathToFileURL(absPath).toString();
    const prev = this.#opened.get(uri);
    if (prev === undefined) {
      this.#opened.set(uri, 1);
      this.#notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else {
      const version = prev + 1;
      this.#opened.set(uri, version);
      // Drop the previous version's cached diagnostics BEFORE re-syncing. LSP
      // `publishDiagnostics` does not echo a version, so we cannot tell a stale
      // push from a fresh one; clearing here makes `#waitForDiagnostics`'
      // already-landed guard a no-op on re-edit, so the settle window resolves
      // against the publish for THIS change rather than the pre-edit array. See
      // #203 (edit→verify loop reporting stale diagnostics).
      this.#diagnostics.delete(uri);
      this.#notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return this.#waitForDiagnostics(uri, opts.timeoutMs ?? 5000, opts.settleMs ?? 400);
  }

  #waitForDiagnostics(uri: string, timeoutMs: number, settleMs: number): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      let settle: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(hard);
        if (settle) clearTimeout(settle);
        this.#removeWaiter(uri, onPush);
        resolve(this.#diagnostics.get(uri) ?? []);
      };
      const onPush = (): void => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(finish, settleMs);
      };
      const hard = setTimeout(finish, timeoutMs);
      this.#addWaiter(uri, onPush);
      // A push may have already landed (race between didChange and the await).
      if (this.#diagnostics.has(uri)) onPush();
    });
  }

  async dispose(): Promise<void> {
    if (this.#closed) {
      this.#child.kill();
      return;
    }
    try {
      await this.#request("shutdown", null, 1000);
    } catch {
      // ignore — we're killing it anyway
    }
    this.#notify("exit", null);
    this.#child.kill();
    this.#closed = true;
  }

  // ---- waiters ----

  #addWaiter(uri: string, cb: () => void): void {
    const set = this.#waiters.get(uri) ?? new Set();
    set.add(cb);
    this.#waiters.set(uri, set);
  }

  #removeWaiter(uri: string, cb: () => void): void {
    const set = this.#waiters.get(uri);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this.#waiters.delete(uri);
  }

  // ---- framing / dispatch ----

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header block — drop it and resync.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1] as string, 10);
      const start = headerEnd + 4;
      if (this.#buffer.length < start + length) return; // body not all here yet
      const body = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(body) as RpcMessage;
      } catch {
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: RpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
      if (!pending) return;
      this.#pending.delete(msg.id as number);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    // Notification from the server.
    if (msg.id === undefined && msg.method) {
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as PublishDiagnosticsParams;
        this.#diagnostics.set(params.uri, params.diagnostics ?? []);
        const set = this.#waiters.get(params.uri);
        if (set) for (const cb of [...set]) cb();
      }
      return;
    }
    // Server→client request: answer so the server doesn't stall. We support no
    // capabilities, so empty/null replies are correct.
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "workspace/configuration") {
        const items = (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        this.#respond(msg.id, items.map(() => ({})));
      } else {
        this.#respond(msg.id, null);
      }
    }
  }

  #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("language server closed"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (this.#pending.delete(id)) reject(new Error(`lsp ${method} timed out`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #respond(id: number | string, result: unknown): void {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  #send(msg: RpcMessage): void {
    if (this.#closed || !this.#child.stdin.writable) return;
    const payload = Buffer.from(JSON.stringify(msg), "utf8");
    this.#child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.#child.stdin.write(payload);
  }

  #handleClose(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(err);
    this.#pending.clear();
    // Release any in-flight waiters with whatever diagnostics we have.
    for (const set of this.#waiters.values()) for (const cb of [...set]) cb();
  }
}
