// @jarvis/connectors — project-connector layer.
//
// Import / sync / push project items to external trackers (GitHub Issues).
// Ported from the harness-connectors Rust crate + the connector binding stores
// in harness-store. A LIBRARY: connector value types, the platform-neutral
// ProjectConnector interface, the GitHub client (injectable fetch), and the
// three ConnectorStore backends (Memory + JSON-file). HTTP routes that map
// remote issues -> Requirements live in @jarvis/server (a later batch).

// ---------- value types + interfaces (types.ts) ----------
export {
  ConnectorError,
  type ConnectorErrorKind,
  type ConnectorAccount,
  type ConnectorAuth,
  type RemoteProject,
  type ProjectBinding,
  type RequirementBinding,
  type RemoteIssue,
  type RemoteIssueState,
  type PullResult,
  type PushAction,
  type RequirementPush,
  type PushResult,
  type ProjectConnector,
  type ConnectorAccountStore,
  type ProjectBindingStore,
  type RequirementBindingStore,
  newConnectorAccount,
  newProjectBinding,
  touchProjectBinding,
  newRequirementBinding,
  touchRequirementBinding,
} from "./types.ts";

// ---------- GitHub client (github.ts) ----------
export {
  GitHubConnector,
  type GitHubConnectorOptions,
  type FetchLike,
  parseIssue,
  splitRepo,
  validateIssueNumber,
} from "./github.ts";

// ---------- store backends (stores.ts) ----------
export {
  MemoryConnectorAccountStore,
  MemoryProjectBindingStore,
  MemoryRequirementBindingStore,
  JsonFileConnectorAccountStore,
  JsonFileProjectBindingStore,
  JsonFileRequirementBindingStore,
} from "./stores.ts";
