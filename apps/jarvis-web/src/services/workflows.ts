// Service layer for declarative workflows.
//
// REST endpoints (crates/harness-server/src/workflow_routes.rs):
//   GET    /v1/workflows                 -> { items: WorkflowDefinition[] }
//   POST   /v1/workflows                 -> WorkflowDefinition (201)
//   GET    /v1/workflows/:id             -> WorkflowDefinition
//   PATCH  /v1/workflows/:id             -> WorkflowDefinition
//   DELETE /v1/workflows/:id             -> 204
//   POST   /v1/workflows/:id/run         -> WorkflowRun (202)
//   GET    /v1/workflows/:id/runs        -> { items: WorkflowRun[] }
//   GET    /v1/workflow-runs/:run_id     -> WorkflowRun
//
// Definitions are cached + subscribable (catalogue UI); runs are fetched
// on demand (server-of-record telemetry, like requirementRuns).

import type { WorkflowDefinition } from "../types/generated/WorkflowDefinition";
import type { WorkflowStep } from "../types/generated/WorkflowStep";
import type { WorkflowStepKind } from "../types/generated/WorkflowStepKind";
import type { WorkflowRun } from "../types/generated/WorkflowRun";
import type { WorkflowStepResult } from "../types/generated/WorkflowStepResult";
import type { WorkflowRunStatus } from "../types/generated/WorkflowRunStatus";
import type { JoinPolicy } from "../types/generated/JoinPolicy";
import { apiUrl } from "./api";

// Re-export generated types so components import them from the service,
// never from types/generated directly.
export type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowRun,
  WorkflowStepResult,
  WorkflowRunStatus,
  JoinPolicy,
};

// ---------- cache + subscribers ------------------------------------

const byId: Map<string, WorkflowDefinition> = new Map();
const subscribers = new Set<() => void>();
let loadedOnce = false;

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("workflows subscriber threw", e);
    }
  }
}

/** Subscribe to any workflow-cache change. Returns an unsubscribe fn. */
export function subscribeWorkflows(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Snapshot of cached definitions, newest-updated first. */
export function workflowsSnapshot(): WorkflowDefinition[] {
  const list = Array.from(byId.values());
  list.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return list;
}

export function workflowsLoaded(): boolean {
  return loadedOnce;
}

// ---------- REST ---------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

/** Fetch all workflow definitions and populate the cache. */
export async function loadWorkflows(): Promise<WorkflowDefinition[]> {
  const data = await request<{ items: WorkflowDefinition[] }>(
    "GET",
    "/v1/workflows",
  );
  byId.clear();
  for (const def of data.items ?? []) byId.set(def.id, def);
  loadedOnce = true;
  notify();
  return workflowsSnapshot();
}

export interface CreateWorkflowInput {
  name: string;
  description?: string | null;
  project_id?: string | null;
  steps: WorkflowStep[];
}

/** Create a definition. Server fills id + timestamps + any blank step ids. */
export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<WorkflowDefinition> {
  const def = await request<WorkflowDefinition>("POST", "/v1/workflows", input);
  byId.set(def.id, def);
  notify();
  return def;
}

export interface UpdateWorkflowInput {
  name?: string;
  /** `""` clears the description. */
  description?: string | null;
  /** `""` clears the project scope. */
  project_id?: string | null;
  steps?: WorkflowStep[];
}

export async function updateWorkflow(
  id: string,
  patch: UpdateWorkflowInput,
): Promise<WorkflowDefinition> {
  const def = await request<WorkflowDefinition>(
    "PATCH",
    `/v1/workflows/${encodeURIComponent(id)}`,
    patch,
  );
  byId.set(def.id, def);
  notify();
  return def;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await request<void>("DELETE", `/v1/workflows/${encodeURIComponent(id)}`);
  if (byId.delete(id)) notify();
}

/** Dispatch a run (optionally bound to a requirement). Returns the
 *  freshly-minted `Running` run; poll `listWorkflowRuns` for progress. */
export async function runWorkflow(
  id: string,
  requirementId?: string,
): Promise<WorkflowRun> {
  return request<WorkflowRun>(
    "POST",
    `/v1/workflows/${encodeURIComponent(id)}/run`,
    { requirement_id: requirementId ?? null },
  );
}

/** Run history for one definition (newest-first per the server). */
export async function listWorkflowRuns(id: string): Promise<WorkflowRun[]> {
  const data = await request<{ items: WorkflowRun[] }>(
    "GET",
    `/v1/workflows/${encodeURIComponent(id)}/runs`,
  );
  return data.items ?? [];
}

/** Fetch one run by id (for live status drill-down). */
export async function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(
    "GET",
    `/v1/workflow-runs/${encodeURIComponent(runId)}`,
  );
}

// ---------- step helpers (for the catalogue editor) ----------------

/** A blank Agent step (id minted server-side on save). */
export function newAgentStep(name = "Step"): WorkflowStep {
  return {
    id: "",
    name,
    kind: {
      type: "agent",
      prompt: "",
      subagent: null,
      model: null,
      output_key: null,
    },
  };
}

/** Human label for a step kind discriminator. */
export function stepKindLabel(kind: WorkflowStepKind["type"]): string {
  switch (kind) {
    case "agent":
      return "Agent";
    case "pipeline":
      return "Pipeline";
    case "phase":
      return "Phase";
    case "parallel":
      return "Parallel";
    default:
      return kind;
  }
}
