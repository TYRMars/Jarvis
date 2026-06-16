// connect(url) → ConversationStore, picking the backend by URL scheme.
// Ported from harness-store/src/lib.rs (the conversation subset). P2 supports
// `json:` / `json://` only; SQL schemes (sqlite/postgres/mysql) land in P6.
//
// `connectAll(url)` extends this to the whole domain-store family: for the
// `json:` scheme it opens the conversation store PLUS every domain store under
// one base dir (each namespacing its own subdir off the base — see the per-
// store `open(base)` impls), returning a typed `StoreBundle`. SQL schemes still
// throw (deferred to P6). `makeMemoryStores()` returns an all-in-memory bundle
// for tests + the server's no-DB fallback.
import { JsonFileConversationStore } from "./json-file.ts";
import { MemoryConversationStore } from "./memory.ts";
import { StoreError, type ConversationStore } from "./types.ts";
import { JsonFileProjectStore, MemoryProjectStore } from "./project-store.ts";
import { JsonFileRequirementStore, MemoryRequirementStore } from "./requirement-store.ts";
import { JsonFileRequirementRunStore, MemoryRequirementRunStore } from "./requirement-run-store.ts";
import { JsonFileActivityStore, MemoryActivityStore } from "./activity-store.ts";
import { JsonFileCommentStore, MemoryCommentStore } from "./comment-store.ts";
import { JsonFileLabelStore, MemoryLabelStore } from "./label-store.ts";
import { JsonFileDocStore, MemoryDocStore } from "./doc-store.ts";
import { JsonFileProjectMemoryStore, MemoryProjectMemoryStore } from "./project-memory-store.ts";
import { JsonFileWorkflowStore, MemoryWorkflowStore } from "./workflow-store.ts";
import type {
  ActivityStore,
  CommentStore,
  DocStore,
  LabelStore,
  ProjectMemoryStore,
  ProjectStore,
  RequirementRunStore,
  RequirementStore,
} from "@jarvis/project";
import type { WorkflowStore } from "@jarvis/workflow";

/**
 * The full set of persistence backends the server wires up. Every store family
 * shares one base directory (JSON backend) or one process (memory backend);
 * each store namespaces its own rows so they never collide.
 */
export interface StoreBundle {
  conversations: ConversationStore;
  projects: ProjectStore;
  requirements: RequirementStore;
  requirementRuns: RequirementRunStore;
  activities: ActivityStore;
  comments: CommentStore;
  labels: LabelStore;
  docs: DocStore;
  projectMemory: ProjectMemoryStore;
  workflows: WorkflowStore;
}

/** Open the conversation store for `url`. Throws StoreError on an unknown scheme. */
export async function connect(url: string): Promise<ConversationStore> {
  const scheme = url.split(":", 1)[0] ?? "";
  switch (scheme) {
    case "json":
      return JsonFileConversationStore.open(jsonPath(url));
    case "sqlite":
    case "postgres":
    case "postgresql":
    case "mysql":
    case "mariadb":
      throw new StoreError(`store scheme not yet supported in the Node port: ${scheme} (lands in P6)`);
    default:
      throw new StoreError(`unsupported store URL scheme: ${scheme}`);
  }
}

/**
 * Open the conversation store PLUS every domain store for `url`, returning a
 * typed {@link StoreBundle}. For the `json:` scheme each store is opened off the
 * SAME base dir, namespacing its own subdir (`conversations` flat under the
 * base, `projects/`, `requirements/`, `requirement_runs/`, `activities/`,
 * `comments/`, `labels/`, `docs/`, `project-memories/`, `workflows/` +
 * `workflow_runs/`). SQL schemes throw (deferred to P6).
 */
export async function connectAll(url: string): Promise<StoreBundle> {
  const scheme = url.split(":", 1)[0] ?? "";
  switch (scheme) {
    case "json": {
      const base = jsonPath(url);
      // Opened in parallel — each ensures its own subdir off the shared base.
      const [
        conversations,
        projects,
        requirements,
        requirementRuns,
        activities,
        comments,
        labels,
        docs,
        projectMemory,
        workflows,
      ] = await Promise.all([
        JsonFileConversationStore.open(base),
        JsonFileProjectStore.open(base),
        JsonFileRequirementStore.open(base),
        JsonFileRequirementRunStore.open(base),
        JsonFileActivityStore.open(base),
        JsonFileCommentStore.open(base),
        JsonFileLabelStore.open(base),
        JsonFileDocStore.open(base),
        JsonFileProjectMemoryStore.open(base),
        JsonFileWorkflowStore.open(base),
      ]);
      return {
        conversations,
        projects,
        requirements,
        requirementRuns,
        activities,
        comments,
        labels,
        docs,
        projectMemory,
        workflows,
      };
    }
    case "sqlite":
    case "postgres":
    case "postgresql":
    case "mysql":
    case "mariadb":
      throw new StoreError(`store scheme not yet supported in the Node port: ${scheme} (lands in P6)`);
    default:
      throw new StoreError(`unsupported store URL scheme: ${scheme}`);
  }
}

/**
 * An all-in-memory {@link StoreBundle} — backs tests and the server's no-DB
 * fallback. Memory backends are not `connect()`-selectable (no durable URL
 * scheme maps to them), so this is the only way to get them as a bundle.
 */
export function makeMemoryStores(): StoreBundle {
  return {
    conversations: new MemoryConversationStore(),
    projects: new MemoryProjectStore(),
    requirements: new MemoryRequirementStore(),
    requirementRuns: new MemoryRequirementRunStore(),
    activities: new MemoryActivityStore(),
    comments: new MemoryCommentStore(),
    labels: new MemoryLabelStore(),
    docs: new MemoryDocStore(),
    projectMemory: new MemoryProjectMemoryStore(),
    workflows: new MemoryWorkflowStore(),
  };
}

/** Accept both `json://path` and `json:path`; the rest is the directory. */
function jsonPath(url: string): string {
  let p: string;
  if (url.startsWith("json://")) p = url.slice("json://".length);
  else if (url.startsWith("json:")) p = url.slice("json:".length);
  else p = "";
  if (p === "") {
    throw new StoreError(
      "json: requires a directory path (e.g. `json:///Users/me/.local/share/jarvis/conversations`)",
    );
  }
  return p;
}
