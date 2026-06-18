// Project connectors — value types, the platform-neutral connector
// interface, and the three store traits. Ported from
// crates/harness-connectors/src/lib.rs.
//
// Design boundaries (from the proposal):
// - The local store stays the source of truth for execution, audit and auto
//   mode; the external platform is a requirement *source* and a status-sync
//   *target*.
// - `ConnectorAccount.auth_ref` names a secret (e.g. an env var); raw tokens
//   are never persisted. Library code never reads process.env — the
//   composition root resolves `auth_ref` -> token and passes a
//   {@link ConnectorAuth} down.
// - v1 is explicit import / sync / push. No background sync, no remote deletes.
//
// First shipped connector: GitHub Issues ({@link GitHubConnector} in
// github.ts); the interface is platform-neutral so Asana / Linear / Jira slot
// in later.

/** RFC-3339 / ISO-8601 timestamp string in UTC. */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/**
 * Discriminated connector failure. Mirrors Rust's `ConnectorError` enum;
 * `kind` is the variant, `message` the rendered text. `Conflict` additionally
 * carries the remote `updated_at` the caller must re-pull past (or `force`).
 */
export type ConnectorErrorKind = "auth" | "not_found" | "conflict" | "other";

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  /** Set only for `kind === "conflict"`: the remote `updated_at` baseline. */
  readonly remoteUpdatedAt?: string;

  private constructor(kind: ConnectorErrorKind, message: string, remoteUpdatedAt?: string) {
    super(message);
    this.name = "ConnectorError";
    this.kind = kind;
    if (remoteUpdatedAt !== undefined) this.remoteUpdatedAt = remoteUpdatedAt;
  }

  /** Authentication / authorization failure against the remote API. */
  static auth(message: string): ConnectorError {
    return new ConnectorError("auth", `connector auth error: ${message}`);
  }

  /** Remote object (repo / project / issue) does not exist or is not visible. */
  static notFound(message: string): ConnectorError {
    return new ConnectorError("not_found", `remote not found: ${message}`);
  }

  /** The remote changed since we last synced; caller must re-pull or `force`. */
  static conflict(remoteUpdatedAt: string): ConnectorError {
    return new ConnectorError(
      "conflict",
      `remote conflict: remote updated at ${remoteUpdatedAt}`,
      remoteUpdatedAt,
    );
  }

  /** Transport / decode / unexpected-shape failures. */
  static other(message: string): ConnectorError {
    return new ConnectorError("other", `connector error: ${message}`);
  }
}

// ---------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------

/**
 * A configured account for one connector. `auth_ref` names a secret (v1: an
 * environment-variable name) — never the raw token.
 */
export interface ConnectorAccount {
  id: string;
  /** Connector id this account belongs to (`"github"`, …). */
  connector: string;
  display_name: string;
  /** Key into the secret resolver (v1: env-var name, e.g. `GITHUB_TOKEN`). */
  auth_ref: string;
  created_at: string;
  updated_at: string;
}

/** Construct a fresh {@link ConnectorAccount} (UUID id, now() timestamps). */
export function newConnectorAccount(
  connector: string,
  displayName: string,
  authRef: string,
): ConnectorAccount {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    connector,
    display_name: displayName,
    auth_ref: authRef,
    created_at: ts,
    updated_at: ts,
  };
}

/**
 * Resolved credential handed to connector calls. Built by the composition root
 * from {@link ConnectorAccount.auth_ref}; never stored.
 *
 * The Rust type custom-formats Debug to redact the token. In TS the
 * equivalent is to keep the value out of structured logs — callers must not
 * serialise a `ConnectorAuth` directly. JSON.stringify would expose `token`,
 * so this stays a plain shape passed only to connector methods.
 */
export interface ConnectorAuth {
  token: string;
}

/**
 * External project (GitHub repo, Asana project, …) as listed by
 * {@link ProjectConnector.listRemoteProjects}.
 */
export interface RemoteProject {
  /** Connector-scoped stable id (GitHub: `owner/repo`). */
  id: string;
  name: string;
  url?: string;
  description?: string;
}

/** Binding between a Jarvis Project row and one remote project. */
export interface ProjectBinding {
  id: string;
  connector: string;
  account_id: string;
  /** Jarvis `Project.id`. */
  project_id: string;
  /** Connector-scoped remote project id (GitHub: `owner/repo`). */
  remote_project_id: string;
  remote_url?: string;
  /** Opaque incremental-sync cursor (unused by v1 GitHub pull). */
  sync_cursor?: string;
  /**
   * Connector-specific mapping knobs; unknown remote fields live here rather
   * than widening the local schema. Mirrors Rust's `serde_json::Value` default
   * of `null`.
   */
  field_mapping: unknown;
  created_at: string;
  updated_at: string;
}

/** Construct a fresh {@link ProjectBinding} (UUID id, null field_mapping). */
export function newProjectBinding(
  connector: string,
  accountId: string,
  projectId: string,
  remoteProjectId: string,
): ProjectBinding {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    connector,
    account_id: accountId,
    project_id: projectId,
    remote_project_id: remoteProjectId,
    field_mapping: null,
    created_at: ts,
    updated_at: ts,
  };
}

/** Bump `updated_at` to now (mirrors Rust's `ProjectBinding::touch`). */
export function touchProjectBinding(binding: ProjectBinding): void {
  binding.updated_at = now();
}

/** Binding between a Jarvis Requirement row and one remote issue. */
export interface RequirementBinding {
  id: string;
  connector: string;
  project_binding_id: string;
  /** Jarvis `Requirement.id`. */
  requirement_id: string;
  /** Connector-scoped issue id (GitHub: the issue number as a string). */
  remote_task_id: string;
  remote_url?: string;
  /**
   * Remote `updated_at` as of the last pull/push — the conflict baseline for
   * pushes.
   */
  remote_updated_at?: string;
  last_pushed_at?: string;
  created_at: string;
  updated_at: string;
}

/** Construct a fresh {@link RequirementBinding} (UUID id, now() timestamps). */
export function newRequirementBinding(
  connector: string,
  projectBindingId: string,
  requirementId: string,
  remoteTaskId: string,
): RequirementBinding {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    connector,
    project_binding_id: projectBindingId,
    requirement_id: requirementId,
    remote_task_id: remoteTaskId,
    created_at: ts,
    updated_at: ts,
  };
}

/** Bump `updated_at` to now (mirrors Rust's `RequirementBinding::touch`). */
export function touchRequirementBinding(binding: RequirementBinding): void {
  binding.updated_at = now();
}

/** Open / closed state of a remote issue. Wire form snake_case. */
export type RemoteIssueState = "open" | "closed";

/**
 * Normalized remote issue, the lingua franca between connectors and the
 * server's import/sync logic.
 */
export interface RemoteIssue {
  /** Connector-scoped stable id (GitHub: issue number as a string). */
  id: string;
  title: string;
  body?: string;
  state: RemoteIssueState;
  url?: string;
  labels: string[];
  updated_at?: string;
}

/**
 * Result of one {@link ProjectConnector.pullRequirements} call. `cursor` is an
 * opaque value to persist on the binding for incremental pulls (v1 GitHub
 * always returns `null` — full pull, idempotent upsert).
 */
export interface PullResult {
  issues: RemoteIssue[];
  cursor: string | null;
}

/** Explicit write-back action against a remote issue. Wire form snake_case. */
export type PushAction = "close" | "reopen";

/**
 * Narrow, explicit write-back. v1 supports closing/reopening the remote issue
 * and posting one comment; both optional, both explicit (the server never
 * derives a push from local status changes).
 */
export interface RequirementPush {
  action?: PushAction;
  comment?: string;
}

/**
 * Result of one {@link ProjectConnector.pushRequirement} call. `remoteUpdatedAt`
 * is the remote `updated_at` after the push when the API reports it — it
 * becomes the new conflict baseline on the binding.
 */
export interface PushResult {
  remoteUpdatedAt: string | null;
}

// ---------------------------------------------------------------------
// Connector interface
// ---------------------------------------------------------------------

/**
 * Platform-neutral connector surface. The GitHub Issues connector is the first
 * impl; Asana / Linear / Jira slot in later. All methods reject with a
 * {@link ConnectorError} on failure.
 */
export interface ProjectConnector {
  /** Stable connector id (`"github"`); keys accounts and bindings. */
  readonly id: string;
  readonly displayName: string;

  /** List remote projects visible to the token (for the bind UI). */
  listRemoteProjects(auth: ConnectorAuth): Promise<RemoteProject[]>;

  /** Full pull of the remote project's issues, normalized. */
  pullRequirements(auth: ConnectorAuth, binding: ProjectBinding): Promise<PullResult>;

  /** Fetch one issue — the conflict-detection probe before a push. */
  fetchIssue(
    auth: ConnectorAuth,
    binding: ProjectBinding,
    remoteTaskId: string,
  ): Promise<RemoteIssue>;

  /** Apply a narrow write-back to one remote issue. */
  pushRequirement(
    auth: ConnectorAuth,
    binding: ProjectBinding,
    remoteTaskId: string,
    change: RequirementPush,
  ): Promise<PushResult>;
}

// ---------------------------------------------------------------------
// Store traits (backends live in stores.ts)
// ---------------------------------------------------------------------

export interface ConnectorAccountStore {
  upsert(account: ConnectorAccount): Promise<void>;
  get(id: string): Promise<ConnectorAccount | undefined>;
  list(): Promise<ConnectorAccount[]>;
  delete(id: string): Promise<boolean>;
}

export interface ProjectBindingStore {
  upsert(binding: ProjectBinding): Promise<void>;
  get(id: string): Promise<ProjectBinding | undefined>;
  /** `projectId = undefined` lists everything. */
  list(projectId?: string): Promise<ProjectBinding[]>;
  delete(id: string): Promise<boolean>;
}

export interface RequirementBindingStore {
  upsert(binding: RequirementBinding): Promise<void>;
  get(id: string): Promise<RequirementBinding | undefined>;
  listForProjectBinding(projectBindingId: string): Promise<RequirementBinding[]>;
  findByRemote(
    projectBindingId: string,
    remoteTaskId: string,
  ): Promise<RequirementBinding | undefined>;
  findByRequirement(requirementId: string): Promise<RequirementBinding | undefined>;
  delete(id: string): Promise<boolean>;
}
