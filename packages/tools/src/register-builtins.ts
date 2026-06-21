// register_builtins + BuiltinsConfig. Ported from
// crates/harness-tools/src/lib.rs.
//
// Registers the default toolset into a `ToolRegistry`. Read primitives
// (`echo`, `time.now`, `http.fetch`, `fs.read`, `fs.list`, `code.grep`,
// `fs.find`, `workspace.context`, `project.checks`, `triage.scan_candidates`,
// `plan.update`, `ask.text`, `exit_plan`) are always on. Write / exec
// primitives (`fs.write`, `fs.edit`, `fs.patch`, `shell.exec`) are gated
// behind their explicit enable flag — matching the Rust precedent exactly:
// anything that writes to disk or runs code stays opt-in + approval-gated.
//
// The store-backed tool families in the Rust (`project.*`, `memory.*`,
// `channel.send`, `codex.run`, `claude_code.run`, `roadmap.import`) are not
// part of the Node `@jarvis/tools` surface yet, so their config knobs are
// intentionally absent. The `requirement.*`, `doc.*`, `learning.memory.*`, and
// `todo.*` families ARE ported: each registers conditionally when its backing
// store(s) are supplied (mirrors the Rust "registered when their stores are
// present").
import type { ToolRegistry } from "@jarvis/core";
import type { MemoryStore as LearningMemoryStore } from "@jarvis/learning";
import type { ActivityStore, DocStore, ProjectStore, RequirementStore } from "@jarvis/project";
import type { TodoStore } from "@jarvis/todo";

import { AskTextTool } from "./ask.ts";
import { ProjectChecksTool } from "./checks.ts";
import { EchoTool } from "./echo.ts";
import { EnterPlanModeTool } from "./enter-plan-mode.ts";
import { ExitPlanTool } from "./exit-plan.ts";
import { FsEditTool, FsListTool, FsReadTool, FsWriteTool } from "./fs.ts";
import { FsFindTool } from "./fs-find.ts";
import { GitDiffTool, GitLogTool, GitShowTool, GitStatusTool } from "./git.ts";
import { CodeGrepTool } from "./grep.ts";
import { HttpFetchTool, HTTP_DEFAULT_MAX_BYTES } from "./http.ts";
import { FsPatchTool } from "./patch.ts";
import { registerDocTools } from "./doc-tools.ts";
import { registerLearningMemoryTools } from "./learning-memory-tools.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { PlanUpdateTool } from "./plan-update.ts";
import { registerRequirementTools } from "./requirement-tools.ts";
import { ShellExecTool, SHELL_DEFAULT_TIMEOUT_MS } from "./shell.ts";
import { TimeNowTool } from "./time.ts";
import { registerTodoTools } from "./todo-tools.ts";
import { TriageScanTool } from "./triage-scan.ts";
import { WorkspaceContextTool } from "./workspace.ts";

/** Default `fs.read` byte cap: 256 KiB, matching the Rust `fs_max_bytes`. */
export const FS_DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Configuration for the default set of built-in tools. Mirrors the Rust
 * `BuiltinsConfig`; every field is optional and falls back to the same
 * defaults as the Rust `Default` impl. The composition root (never a library
 * crate) supplies the values.
 */
export interface BuiltinsConfig {
  /**
   * Root directory for all `fs.*` tools and the `shell.exec` cwd. Relative
   * tool arguments are resolved against this directory; `..` / absolute paths
   * are rejected. Defaults to `"."`.
   */
  fsRoot?: string;
  /**
   * Cap on response body size (in bytes) for `http.fetch`. Responses larger
   * than this are truncated with a trailing marker. Defaults to 256 KiB.
   */
  httpMaxBytes?: number;
  /**
   * Allow `http.fetch` to reach loopback / private / link-local / metadata
   * hosts. Defaults to `false` (SSRF guard on). The composition root sets this
   * from `JARVIS_HTTP_ALLOW_PRIVATE` when the operator wants the agent to hit
   * `localhost` dev servers (P8.6).
   */
  httpAllowPrivateHosts?: boolean;
  /**
   * Cap on file size (in bytes) for `fs.read`. Files larger than this are
   * truncated with a trailing marker so a single `fs.read` can't blow the
   * LLM context window. Defaults to 256 KiB.
   */
  fsMaxBytes?: number;
  /**
   * Whether to register `fs.write`. Defaults to `false` because writes are a
   * destructive primitive.
   */
  enableFsWrite?: boolean;
  /**
   * Whether to register `fs.edit`. Defaults to `false` because it mutates
   * files. `fs.edit` is the preferred primitive for editing existing files —
   * it requires the model to identify a unique snippet, limiting accidental
   * damage compared to `fs.write`.
   */
  enableFsEdit?: boolean;
  /**
   * Whether to register `fs.patch`. Defaults to `false` because it mutates
   * files. `fs.patch` applies a unified diff (multi-hunk, multi-file)
   * atomically — preferred over `fs.edit` when the change spans more than one
   * location. Always approval-gated.
   */
  enableFsPatch?: boolean;
  /**
   * Whether to register `shell.exec`. Defaults to `false` — arbitrary command
   * execution against the host is the most dangerous primitive in the toolbox.
   */
  enableShellExec?: boolean;
  /**
   * Default timeout (ms) for `shell.exec` invocations that don't supply one.
   * The model can still pass a smaller value per call. Defaults to 30000.
   */
  shellDefaultTimeoutMs?: number;
  /**
   * Whether to register the read-only `git.*` tools (`git.status`, `git.diff`,
   * `git.log`, `git.show`). Defaults to `true` — they are read-only and shell
   * out to the host's `git` binary, which is virtually always present. If
   * `git` isn't on `PATH`, the tools error at invoke time rather than failing
   * registration; flip this to `false` to skip them entirely.
   */
  enableGitRead?: boolean;
  /**
   * Whether to register `enter_plan_mode`. Off by default — leaving this off
   * keeps Plan-Mode entry strictly operator-driven. Coding deployments
   * typically want it on so the model can volunteer a plan-first round.
   */
  enableEnterPlanMode?: boolean;
  /**
   * Per-project Requirement store. The `requirement.*` tool family is
   * registered only when BOTH `requirements` AND `activities` are present —
   * a half-enabled set (mutations land but the audit row goes nowhere) is
   * strictly worse than off. Mirrors the Rust "registered when their stores
   * are present" rule.
   */
  requirements?: RequirementStore;
  /**
   * Append-only audit-timeline store. Required alongside `requirements` to
   * enable the `requirement.*` tools.
   */
  activities?: ActivityStore;
  /**
   * Project store. Accepted for parity with the Rust signature / future use;
   * the status-mutation tools don't read it today, so it is optional even
   * when the `requirement.*` family is enabled.
   */
  projects?: ProjectStore;
  /**
   * DocProject + append-only Markdown draft store. The `doc.*` tool family
   * (`doc.{list,search,get,upsert,create,update,delete}` + `doc.draft.{get,
   * save}`) is registered only when this store is present. The four mutators
   * plus `doc.draft.save` are approval-gated. Mirrors the Rust "registered
   * when their stores are present" rule.
   */
  docs?: DocStore;
  /**
   * Row-based long-term Memory store (from `@jarvis/learning`). The
   * `learning.memory.*` tool family (`list` / `add` / `update` / `delete`) is
   * registered only when this store is present; `learning.memory.delete` is
   * approval-gated. Distinct from the workspace `memory.*` markdown surface
   * (not yet ported).
   */
  learningMemory?: LearningMemoryStore;
  /**
   * Workspace root for the agent's `memory.*` markdown-memory family
   * (`memory.{list,read,write,delete}` + the include-directive tools). When
   * supplied — or, when omitted, falling back to `fsRoot` — the family is
   * registered with this directory as the workspace scope
   * (`<root>/.jarvis/memory/`). The mutating tools (`write` / `delete` /
   * `include_add` / `include_remove` / `include_refresh`) are approval-gated;
   * `list` / `read` / `include_list` are read-only. Distinct from the row-based
   * `learning.memory.*` surface (`learningMemory`).
   */
  memoryWorkspaceRoot?: string;
  /**
   * Optional user-scope root for the `memory.*` family (parent of
   * `.jarvis/memory/`, usually the operator's home directory). When present,
   * `scope: "user"` writes land here and the combined `memory.list` shows the
   * user section; when absent, user scope is disabled — user-scope writes error
   * cleanly. Has no effect unless a workspace root (`memoryWorkspaceRoot` or
   * `fsRoot`) is available.
   */
  memoryUserRoot?: string;
  /**
   * Persistent workspace TODO board store (from `@jarvis/todo`). The `todo.*`
   * tool family (`list` / `add` / `update` / `delete`) is registered only when
   * this store is present. All four are ungated (`read`-category) — matching
   * the Rust, where `todo.delete`'s mass-delete protection lives in the input
   * schema, not an approval gate. The tools resolve a default workspace from
   * `fsRoot` when a call omits an explicit `workspace` override.
   */
  todos?: TodoStore;
}

/**
 * Register the full default toolset into `registry`. Individual tools can
 * still be registered one-by-one if you want finer control. Follows the Rust
 * `register_builtins` ordering and gating exactly.
 */
export function registerBuiltins(registry: ToolRegistry, config: BuiltinsConfig = {}): void {
  const root = config.fsRoot ?? ".";
  const httpMaxBytes = config.httpMaxBytes ?? HTTP_DEFAULT_MAX_BYTES;
  const fsMaxBytes = config.fsMaxBytes ?? FS_DEFAULT_MAX_BYTES;
  const enableGitRead = config.enableGitRead ?? true;

  // Always-on, read-only group.
  registry.register(new EchoTool());
  registry.register(new TimeNowTool());
  registry.register(
    new HttpFetchTool({
      maxBytes: httpMaxBytes,
      blockPrivateHosts: !(config.httpAllowPrivateHosts ?? false),
    }),
  );
  registry.register(new FsReadTool({ root, maxBytes: fsMaxBytes }));
  registry.register(new FsListTool({ root }));
  registry.register(new CodeGrepTool({ root }));
  registry.register(new FsFindTool({ root }));
  registry.register(new WorkspaceContextTool({ root }));
  registry.register(new ProjectChecksTool({ root }));
  registry.register(new TriageScanTool({ root }));
  registry.register(new PlanUpdateTool());
  registry.register(new AskTextTool());
  // `exit_plan` is the terminal tool the agent calls in Plan Mode to hand a
  // draft plan back to the user. Harmless outside Plan Mode, so always-on
  // keeps the Plan-Mode tool filter simple.
  registry.register(new ExitPlanTool());

  if (config.enableEnterPlanMode ?? false) {
    registry.register(new EnterPlanModeTool());
  }

  // Write / exec primitives: opt-in + approval-gated.
  if (config.enableFsWrite ?? false) {
    registry.register(new FsWriteTool({ root }));
  }
  if (config.enableFsEdit ?? false) {
    registry.register(new FsEditTool({ root }));
  }
  if (config.enableFsPatch ?? false) {
    registry.register(new FsPatchTool({ root }));
  }
  if (enableGitRead) {
    registry.register(new GitStatusTool({ root }));
    registry.register(new GitDiffTool({ root }));
    registry.register(new GitLogTool({ root }));
    registry.register(new GitShowTool({ root }));
  }
  if (config.enableShellExec ?? false) {
    registry.register(
      new ShellExecTool({
        root,
        timeoutMs: config.shellDefaultTimeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS,
      }),
    );
  }

  // Store-backed `requirement.*` family: conditional registration — both
  // stores must be present (mirrors the Rust "registered when their stores
  // are present"). A half-enabled set (mutations land but the audit row goes
  // nowhere) is strictly worse than off.
  if (config.requirements !== undefined && config.activities !== undefined) {
    registerRequirementTools(registry, {
      requirements: config.requirements,
      activities: config.activities,
      projects: config.projects,
    });
  }

  // Store-backed `doc.*` family: registered when the `DocStore` is present.
  // The four mutators (`upsert`/`create`/`update`/`delete`) and `draft.save`
  // are approval-gated; the read tools are not.
  if (config.docs !== undefined) {
    registerDocTools(registry, { docs: config.docs, fsRoot: root });
  }

  // Store-backed `learning.memory.*` family: registered when the row-based
  // `MemoryStore` is present. `learning.memory.delete` is approval-gated.
  if (config.learningMemory !== undefined) {
    registerLearningMemoryTools(registry, { memory: config.learningMemory });
  }

  // Agent `memory.*` markdown-memory family: filesystem-based, no store. Needs
  // only a workspace root. Registered when an explicit memory workspace root is
  // configured (`memoryWorkspaceRoot`), or when an explicit `fsRoot` is — the
  // memory tree lives under that root's `.jarvis/memory/`. We deliberately
  // DON'T register on the bare `"."` default so a config that supplies neither
  // root never silently exposes a memory tree in the process CWD. The user
  // scope is enabled only when `memoryUserRoot` is present.
  const memoryWorkspaceRoot = config.memoryWorkspaceRoot ?? config.fsRoot;
  if (memoryWorkspaceRoot !== undefined) {
    registerMemoryTools(
      registry,
      config.memoryUserRoot !== undefined
        ? { workspaceRoot: memoryWorkspaceRoot, userRoot: config.memoryUserRoot }
        : { workspaceRoot: memoryWorkspaceRoot },
    );
  }

  // Store-backed `todo.*` family: registered when the `TodoStore` is present.
  // All four are ungated (`read`-category) — `todo.delete`'s mass-delete
  // protection lives in the input schema, not an approval gate (matches Rust).
  // The default workspace falls back to `fsRoot` (`root`) when a call omits an
  // explicit `workspace` override.
  if (config.todos !== undefined) {
    registerTodoTools(registry, { todos: config.todos, workspace: root });
  }
}
