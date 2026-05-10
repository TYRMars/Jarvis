import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSubAgentRuns } from "./subagentRuns";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchSubAgentRuns", () => {
  it("treats a missing route as an unavailable optional feature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    await expect(fetchSubAgentRuns()).rejects.toThrow(
      "subagent runs registry not configured",
    );
  });

  it("returns recorded runs from the registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          items: [
            {
              id: "run-1",
              name: "codex",
              status: "running",
              started_at: 1,
              updated_at: 2,
              duration_ms: 1000,
              tool_call_count: 0,
            },
          ],
        }),
      ),
    );

    await expect(fetchSubAgentRuns()).resolves.toMatchObject([
      { id: "run-1", name: "codex", status: "running" },
    ]);
  });
});
