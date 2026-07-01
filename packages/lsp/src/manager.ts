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
  /**
   * After a server fails to come up (never `initialize`d, or the child died on
   * startup) its cache slot is evicted; this is how long to wait before the next
   * `report()` is allowed to re-spawn it, so a persistently-broken server can't
   * trigger a respawn storm. Default 2000ms.
   */
  respawnBackoffMs?: number;
}

export class LspManager {
  readonly #root: string;
  readonly #registry: LanguageRegistry;
  readonly #timeoutMs: number;
  readonly #settleMs: number;
  readonly #respawnBackoffMs: number;
  /** serverKey → client (a promise so concurrent files share one spawn). */
  readonly #clients = new Map<string, Promise<LspClient | null>>();
  /** serverKey → epoch ms of the last failed bring-up (respawn backoff gate). */
  readonly #failedAt = new Map<string, number>();

  constructor(opts: LspManagerOptions) {
    this.#root = opts.root;
    this.#registry = opts.registry ?? new DefaultLanguageRegistry(opts.search ?? {});
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#settleMs = opts.settleMs ?? 400;
    this.#respawnBackoffMs = opts.respawnBackoffMs ?? 2000;
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

  async #getClient(serverKey: string, command: string, args: string[]): Promise<LspClient | null> {
    let entry = this.#clients.get(serverKey);
    if (!entry) {
      // Respawn backoff: skip a server that just failed to come up so a broken
      // binary can't be re-spawned on every edit.
      const failedAt = this.#failedAt.get(serverKey);
      if (failedAt !== undefined && this.#now() - failedAt < this.#respawnBackoffMs) {
        return null;
      }
      entry = Promise.resolve().then<LspClient | null>(() => {
        try {
          return new LspClient({
            command,
            args,
            rootUri: pathToFileURL(this.#root).toString(),
            cwd: this.#root,
            initializeTimeoutMs: this.#timeoutMs,
          });
        } catch {
          return null;
        }
      });
      this.#clients.set(serverKey, entry);
    }

    const client = await entry;
    // A dead client — synchronous spawn throw (null), a child that exited, or an
    // `initialize` that never completed — must be evicted so a later report()
    // re-spawns instead of `await`ing a rejected `#ready` forever (#285). The
    // slot is only removed if it's still the one we resolved, so a concurrent
    // respawn isn't clobbered.
    if (!client || client.closed || !(await client.ready())) {
      if (this.#clients.get(serverKey) === entry) this.#clients.delete(serverKey);
      this.#failedAt.set(serverKey, this.#now());
      if (client) void client.dispose().catch(() => {});
      return null;
    }
    // Healthy: clear any prior failure stamp.
    this.#failedAt.delete(serverKey);
    return client;
  }

  /** Wall clock, isolated so it reads clearly and is trivial to reason about. */
  #now(): number {
    return Date.now();
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
