// Parallel sub-agent batch tool. Exposed to the main agent as
// `subagent.batch`. Accepts a list of `{subagent, task, context?}` pairs and
// runs them concurrently against the shared SubAgentRegistry, capped by a
// process-wide semaphore. Combines results per a configurable `join` strategy
// (summarize / race / all_required / best_effort). Ported from
// harness-subagents/src/batch.rs.
//
// Each child runs under its own `withSubagent` scope forwarding into the outer
// sink, so the transport renders one timeline per child run id. A failing
// child does not crash the whole batch — the join strategy makes the policy
// explicit. Children are invoked without a `subagent.*` tool in their own
// registry (anti-recursion).
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import {
  activeSender,
  activeWorkspaceOr,
  withSubagent,
  type SubAgent,
  type SubAgentInput,
  type SubAgentRegistry,
  type SubAgentSink,
} from "./subagent.ts";

/** Default per-batch concurrency cap. Mirrors the spec's "并发上限默认 3". */
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * How to combine multiple sub-agent results. Serialises as snake_case so the
 * JSON payload reads as the spec wrote it. (Rust enum -> string-literal union.)
 */
export type JoinStrategy = "summarize" | "race" | "all_required" | "best_effort";

interface BatchTaskInput {
  subagent: string;
  task: string;
  context?: JsonValue;
}

interface BatchInvocation {
  tasks: BatchTaskInput[];
  join: JoinStrategy;
  max_concurrency?: number;
}

type BatchChildOutcome =
  | { status: "ok"; message: string }
  | { status: "error"; error: string }
  // `race` join: a child that completed successfully but was not the first to
  // finish. It genuinely ran its full inner loop (and any side effects — e.g. a
  // write-capable subagent's file edits — persisted), so we keep its message and
  // report it honestly as `superseded` rather than falsely claiming it was
  // `cancelled`. There is no true cancellation here: all children run to
  // completion (the SubAgent contract has no abort channel).
  | { status: "superseded"; message: string };

interface BatchChildResult {
  subagent: string;
  task: string;
  duration_ms: number;
  outcome: BatchChildOutcome;
}

/** `subagent.batch` — runs N sub-agent tasks concurrently. */
export class SubAgentBatchTool implements Tool {
  readonly name = "subagent.batch";
  readonly category: ToolCategory = "write";
  readonly #registry: SubAgentRegistry;
  readonly #defaultRoot: string;
  readonly #maxConcurrency: number;

  constructor(registry: SubAgentRegistry, defaultRoot: string, maxConcurrency: number) {
    this.#registry = registry;
    this.#defaultRoot = defaultRoot;
    this.#maxConcurrency = Math.max(1, maxConcurrency);
  }

  get description(): string {
    return (
      "Run multiple sub-agent tasks in parallel and combine results. " +
      "`tasks` is an array of `{subagent, task, context?}`; `join` picks " +
      "summarize | race | all_required | best_effort (default summarize). " +
      "Use this when several independent reads / reviews / drafts can " +
      "run at once instead of sequentially in tool calls."
    );
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["subagent", "task"],
            properties: {
              subagent: {
                type: "string",
                description: "Registry name of the sub-agent to invoke (e.g. 'doc_reader').",
              },
              task: { type: "string", description: "Free-form natural-language task for the child." },
              context: { description: "Optional structured context forwarded as SubAgentInput.context." },
            },
          },
        },
        join: {
          type: "string",
          enum: ["summarize", "race", "all_required", "best_effort"],
          description: "How to combine child results. Defaults to 'summarize'.",
        },
        max_concurrency: {
          type: "integer",
          minimum: 1,
          description: "Per-call concurrency cap (clamped to the host's limit).",
        },
      },
    };
  }

  // The wrapper is gated even when children are read-only — fanning out to an
  // unbounded list has process-impact (concurrent LLM calls = $$).
  get requiresApproval(): boolean {
    return true;
  }

  async invoke(args: JsonValue): Promise<string> {
    const invocation = parseInvocation(args);
    if (invocation.tasks.length === 0) {
      throw new Error("subagent.batch requires at least one task");
    }

    const cap =
      invocation.max_concurrency === undefined
        ? this.#maxConcurrency
        : clamp(invocation.max_concurrency, 1, this.#maxConcurrency);

    const workspaceRoot = activeWorkspaceOr(this.#defaultRoot);
    const join = invocation.join;

    // Resolve every sub-agent up front so a typo'd name fails fast before
    // anything is spawned.
    const resolved: Array<[BatchTaskInput, SubAgent]> = invocation.tasks.map((t) => {
      const sub = this.#registry.get(t.subagent);
      if (sub === undefined) throw new Error(`subagent.batch: unknown subagent \`${t.subagent}\``);
      return [t, sub];
    });

    // Forward children's frames into the outer transport's sink (cloned). If
    // no outer sink is installed (unit tests) children's frames drop silently.
    const outerSink = activeSender();

    const sem = new Semaphore(cap);
    const tasks = resolved.map(([input, sub], idx) =>
      runChildRecord(sem, outerSink, sub, {
        task: input.task,
        workspace_root: workspaceRoot,
        ...(input.context !== undefined ? { context: input.context } : {}),
        caller_chain: [`batch:${idx}`],
      }),
    );

    const raw = join === "race" ? await collectRace(tasks) : await Promise.all(tasks);

    if (join === "all_required") {
      const failure = raw.find((r) => r.outcome.status === "error");
      if (failure) {
        const errText = failure.outcome.status === "error" ? failure.outcome.error : "unknown";
        throw new Error(`subagent.batch (all_required): \`${failure.subagent}\` failed: ${errText}`);
      }
    }

    return formatSummary(join, raw);
  }
}

/** Run one child, timing it and capturing its outcome (never throws). */
async function runChildRecord(
  sem: Semaphore,
  outerSink: SubAgentSink | undefined,
  sub: SubAgent,
  input: SubAgentInput,
): Promise<BatchChildResult> {
  const started = Date.now();
  const release = await sem.acquire();
  let outcome: BatchChildOutcome;
  try {
    const message = await runChild(outerSink, sub, input);
    outcome = { status: "ok", message };
  } catch (e) {
    outcome = { status: "error", error: stringifyError(e) };
  } finally {
    release();
  }
  return {
    subagent: sub.name,
    task: input.task,
    duration_ms: Date.now() - started,
    outcome,
  };
}

/**
 * Invoke the child under its own withSubagent scope (forwarding into the outer
 * sink). With no outer sink (unit tests), frames drop silently.
 */
function runChild(outerSink: SubAgentSink | undefined, sub: SubAgent, input: SubAgentInput): Promise<string> {
  if (outerSink) {
    return withSubagent(outerSink, async () => (await sub.invoke(input)).message);
  }
  return sub.invoke(input).then((out) => out.message);
}

/**
 * Race: the first successful child to *finish* wins; the others still run to
 * completion (there is no abort channel into a child agent, so their side
 * effects persist) and are reported as `superseded` — never as `cancelled`,
 * which would tell the orchestrator that real, already-committed work never
 * happened. The winner is chosen by genuine completion order, not array order:
 * each task is non-throwing (runChildRecord captures errors), so we record the
 * index of each as it settles. Output row order stays the input order for a
 * deterministic wire shape.
 */
async function collectRace(tasks: Array<Promise<BatchChildResult>>): Promise<BatchChildResult[]> {
  const finishOrder: number[] = [];
  const settled = await Promise.all(
    tasks.map((task, i) => task.then((res) => {
      finishOrder.push(i);
      return res;
    })),
  );

  // Winner = first child (in completion order) that succeeded.
  let winnerIdx = -1;
  for (const i of finishOrder) {
    if (settled[i].outcome.status === "ok") {
      winnerIdx = i;
      break;
    }
  }

  return settled.map((res, i) => {
    if (i !== winnerIdx && res.outcome.status === "ok") {
      return {
        subagent: res.subagent,
        task: res.task,
        duration_ms: res.duration_ms,
        outcome: { status: "superseded", message: res.outcome.message },
      };
    }
    return res;
  });
}

function formatSummary(strategy: JoinStrategy, results: readonly BatchChildResult[]): string {
  let out = `subagent.batch (${strategy}, ${results.length} task${results.length === 1 ? "" : "s"}):\n`;
  for (const r of results) {
    out += `- [${r.outcome.status}] ${r.subagent} (${r.duration_ms}ms)\n`;
    if (r.outcome.status === "ok") {
      out += indent(r.outcome.message);
    } else if (r.outcome.status === "superseded") {
      // Still ran to completion; its side effects (if any) persisted.
      out += indent("[superseded by race winner — this child still ran to completion]");
      out += indent(r.outcome.message);
    } else if (r.outcome.status === "error") {
      out += indent(`[warning] ${r.outcome.error}`);
    }
  }
  return out;
}

function indent(text: string): string {
  let out = "";
  for (const line of text.split("\n")) out += `    ${line}\n`;
  return out;
}

function parseInvocation(args: JsonValue): BatchInvocation {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("subagent.batch invalid args: expected an object");
  }
  const obj = args as Record<string, JsonValue>;
  const rawTasks = obj["tasks"];
  if (!Array.isArray(rawTasks)) {
    throw new Error("subagent.batch invalid args: `tasks` must be an array");
  }
  const tasks: BatchTaskInput[] = rawTasks.map((t) => {
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      throw new Error("subagent.batch invalid args: each task must be an object");
    }
    const to = t as Record<string, JsonValue>;
    const subagent = to["subagent"];
    const task = to["task"];
    if (typeof subagent !== "string" || typeof task !== "string") {
      throw new Error("subagent.batch invalid args: task needs string `subagent` + `task`");
    }
    const item: BatchTaskInput = { subagent, task };
    if (to["context"] !== undefined) item.context = to["context"];
    return item;
  });

  const join = parseJoin(obj["join"]);
  const result: BatchInvocation = { tasks, join };
  const maxc = obj["max_concurrency"];
  if (typeof maxc === "number") result.max_concurrency = maxc;
  return result;
}

function parseJoin(v: JsonValue | undefined): JoinStrategy {
  if (v === "race" || v === "all_required" || v === "best_effort") return v;
  return "summarize"; // default + any unrecognised value
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** A minimal counting semaphore — the Node stand-in for tokio's Semaphore. */
class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  /** Acquire a permit; resolves to a release function. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.#release();
        });
      };
      if (this.#available > 0) {
        this.#available--;
        grant();
      } else {
        this.#waiters.push(() => {
          this.#available--;
          grant();
        });
      }
    });
  }

  #release(): void {
    this.#available++;
    const next = this.#waiters.shift();
    if (next) next();
  }
}
