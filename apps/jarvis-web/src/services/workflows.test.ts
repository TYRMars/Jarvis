// Unit tests for the workflows service: the definition cache + the REST
// wrappers' request shape (fetch is mocked; the Rust route tests cover
// the server behaviour). Mirrors the lightweight style of other service
// tests in this directory.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createWorkflow,
  deleteWorkflow,
  loadWorkflows,
  newAgentStep,
  runWorkflow,
  stepKindLabel,
  subscribeWorkflows,
  workflowsSnapshot,
  type WorkflowDefinition,
} from "./workflows";

function def(over: Partial<WorkflowDefinition> & { id: string }): WorkflowDefinition {
  return {
    project_id: null,
    name: over.id,
    description: null,
    steps: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  // Reset the module cache via a load of an empty list.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ items: [] }))),
  );
  await loadWorkflows();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workflows cache", () => {
  it("loadWorkflows populates the snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              def({ id: "a", updated_at: "2026-02-01T00:00:00Z" }),
              def({ id: "b", updated_at: "2026-03-01T00:00:00Z" }),
            ],
          }),
        ),
      ),
    );
    const list = await loadWorkflows();
    // newest-updated first
    expect(list.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("createWorkflow adds to the cache and notifies", async () => {
    let hits = 0;
    const unsub = subscribeWorkflows(() => {
      hits += 1;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(def({ id: "new" }), 201))),
    );
    const created = await createWorkflow({ name: "new", steps: [newAgentStep()] });
    expect(created.id).toBe("new");
    expect(workflowsSnapshot().some((d) => d.id === "new")).toBe(true);
    expect(hits).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it("deleteWorkflow removes from the cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(def({ id: "gone" }), 201))),
    );
    await createWorkflow({ name: "gone", steps: [newAgentStep()] });
    expect(workflowsSnapshot().some((d) => d.id === "gone")).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    await deleteWorkflow("gone");
    expect(workflowsSnapshot().some((d) => d.id === "gone")).toBe(false);
  });

  it("runWorkflow posts requirement_id and returns the run", async () => {
    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        seen.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
        return Promise.resolve(
          jsonResponse(
            { id: "run-1", workflow_id: "wf", requirement_id: "req-1", status: "running", step_results: [], started_at: "x", finished_at: null, error: null },
            202,
          ),
        );
      }),
    );
    const run = await runWorkflow("wf", "req-1");
    expect(run.id).toBe("run-1");
    expect(run.requirement_id).toBe("req-1");
    expect(seen[0].url).toContain("/v1/workflows/wf/run");
    expect((seen[0].body as { requirement_id?: string }).requirement_id).toBe("req-1");
  });
});

describe("workflow step helpers", () => {
  it("newAgentStep produces a blank agent step", () => {
    const s = newAgentStep("Research");
    expect(s.name).toBe("Research");
    expect(s.kind.type).toBe("agent");
  });

  it("stepKindLabel maps discriminators", () => {
    expect(stepKindLabel("agent")).toBe("Agent");
    expect(stepKindLabel("parallel")).toBe("Parallel");
  });
});
