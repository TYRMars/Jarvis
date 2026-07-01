// LspManager — the diagnostics entry point the composition root wires into the
// edit tools. Lazily spawns one server per language (reused across files),
// opens each written file, waits for diagnostics, and returns the combined
// errors-only `<diagnostics>` block. Every failure path degrades to `""` so a
// flaky/absent server never breaks an edit.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { relative } from "node:path";
import { LspClient } from "./client.ts";
import { report } from "./diagnostic.ts";
import { DefaultLanguageRegistry, type LanguageRegistry, type SearchEnv } from "./registry.ts";

export interface LspManagerOptions {
  /** Workspace root: server cwd + the `<diagnostics file>` label is relative to it. */
  root: string;
  /** Override the language registry (tests point an extension at a mock server). */
  registry?: LanguageRegistry;
  /**
   * Executable search environment for the default registry's PATH probe (the
   * composition root supplies `process.env.PATH`). Ignored when `registry` is
   * given. Absent → the default registry finds no servers.
   */
  search?: SearchEnv;
  /** Hard cap per file waiting for diagnostics. Default 5000ms. */
  timeoutMs?: number;
  /** Quiet window after the last push before resolving. Default 400ms. */
  settleMs?: number;
  /** Hard cap waiting for a spawned server's `initialize`. Default 5000ms. */
  initializeTimeoutMs?: number;
  /**
   * After a server fails to become ready (early exit / `initialize` timeout),
   * wait this long before spawning it again — throttles respawn storms when a
   * server is persistently broken. Default 30000ms.
   */
  respawnBackoffMs?: number;
}

export class LspManager {
  readonly #root: string;
  readonly #registry: LanguageRegistry;
  readonly #timeoutMs: number;
  readonly #settleMs: number;
  readonly #initializeTimeoutMs: number;
  readonly #respawnBackoffMs: number;
  /** serverKey → client (a promise so concurrent files share one spawn). */
  readonly #clients = new Map<string, Promise<LspClient | null>>();
  /** serverKey → earliest epoch-ms we may respawn after a failed client. */
  readonly #respawnAfter = new Map<string, number>();

  constructor(opts: LspManagerOptions) {
    this.#root = opts.root;
    this.#registry = opts.registry ?? new DefaultLanguageRegistry(opts.search ?? {});
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#settleMs = opts.settleMs ?? 400;
    this.#initializeTimeoutMs = opts.initializeTimeoutMs ?? 5000;
    this.#respawnBackoffMs = opts.respawnBackoffMs ?? 30_000;
  }

  /**
   * Diagnose each written file and return the concatenated errors-only blocks
   * (one per file with errors), or `""` when there's nothing to report.
   */
  async report(absPaths: string[]): Promise<string> {
    const blocks: string[] = [];
    for (const abs of absPaths) {
      try {
        const block = await this.#reportOne(abs);
        if (block) blocks.push(block);
      } catch {
        // best-effort: a diagnostics failure must never break the edit
      }
    }
    return blocks.join("\n");
  }

  async #reportOne(abs: string): Promise<string> {
    const spec = this.#registry.resolve(abs);
    if (!spec) return "";
    const client = await this.#getClient(spec.serverKey, spec.command, spec.args);
    if (!client) return "";
    const text = await readFile(abs, "utf8");
    const diagnostics = await client.openAndDiagnose(abs, spec.languageId, text, {
      timeoutMs: this.#timeoutMs,
      settleMs: this.#settleMs,
    });
    const label = relative(this.#root, abs) || abs;
    return report(label, diagnostics);
  }

  #getClient(serverKey: string, command: string, args: string[]): Promise<LspClient | null> {
    const existing = this.#clients.get(serverKey);
    if (existing) {
      // A cached client whose handshake failed (or which has since died) is
      // useless — evict it (and set a respawn backoff) so a later edit re-spawns
      // instead of `await`ing a rejected `#ready` forever (#285).
      return existing.then((client) => {
        if (client && client.isDead) {
          if (this.#clients.get(serverKey) === existing) {
            this.#clients.delete(serverKey);
            this.#respawnAfter.set(serverKey, Date.now() + this.#respawnBackoffMs);
            void client.dispose().catch(() => {});
          }
          return null;
        }
        return client;
      });
    }
    // Within the backoff window after a failure, don't respawn yet.
    const after = this.#respawnAfter.get(serverKey);
    if (after !== undefined && Date.now() < after) return Promise.resolve(null);
    this.#respawnAfter.delete(serverKey);
    const created = Promise.resolve().then<LspClient | null>(() => {
      try {
        return new LspClient({
          command,
          args,
          rootUri: pathToFileURL(this.#root).toString(),
          cwd: this.#root,
          initializeTimeoutMs: this.#initializeTimeoutMs,
        });
      } catch {
        return null;
      }
    });
    this.#clients.set(serverKey, created);
    return created;
  }

  /** Shut every spawned server down. Call on process shutdown. */
  async dispose(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(
      clients.map(async (p) => {
        const client = await p.catch(() => null);
        if (client) await client.dispose();
      }),
    );
  }
}
