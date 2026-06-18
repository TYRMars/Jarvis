import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { makeMemoryStores, MemoryConversationStore } from "@jarvis/store";
import { newProject, setProjectSlug } from "@jarvis/project";
import { registerProjectsRoutes } from "./projects-routes.ts";
import type { AppState } from "./state.ts";

// ---------- harness ----------

function baseState(): AppState {
  return {
    createAgent: () => {
      throw new Error("agent not used in these route tests");
    },
  };
}

/** State with an in-memory ProjectStore + ConversationStore wired in. */
function stateWithProjects(): AppState {
  const stores = makeMemoryStores();
  return { ...baseState(), projects: stores.projects, store: stores.conversations };
}

async function appWith(state: AppState): Promise<FastifyInstance> {
  const app = Fastify();
  registerProjectsRoutes(app, state);
  await app.ready();
  return app;
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-proj-"));
}

// ---------- 503 when unconfigured ----------

test("projects routes 503 when no store is configured", async () => {
  const app = await appWith(baseState());
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/projects" })).statusCode, 503);
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "X", instructions: "y" } }))
        .statusCode,
      503,
    );
    assert.equal((await app.inject({ method: "GET", url: "/v1/projects/abc" })).statusCode, 503);
    assert.equal((await app.inject({ method: "DELETE", url: "/v1/projects/abc" })).statusCode, 503);
    assert.equal((await app.inject({ method: "PUT", url: "/v1/projects/abc", payload: {} })).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/v1/projects/abc/restore" })).statusCode, 503);
  } finally {
    await app.close();
  }
});

// ---------- create / get / list round-trip ----------

test("create / get-by-slug / list round-trip", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Customer Support", instructions: "Be terse and helpful." },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    const id = body.id as string;
    assert.equal(body.slug, "customer-support");
    // Default automation is omitted on the wire.
    assert.equal(body.automation, undefined);

    // get by slug
    const got = await app.inject({ method: "GET", url: "/v1/projects/customer-support" });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().id, id);

    // get by id
    const gotById = await app.inject({ method: "GET", url: `/v1/projects/${id}` });
    assert.equal(gotById.json().slug, "customer-support");

    // list — conversation_count is 0 (store present, no bound convos)
    const list = await app.inject({ method: "GET", url: "/v1/projects" });
    assert.equal(list.statusCode, 200);
    const rows = list.json() as { id: string; conversation_count?: number }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.conversation_count, 0);
  } finally {
    await app.close();
  }
});

test("create rejects blank name / instructions", async () => {
  const app = await appWith(stateWithProjects());
  try {
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "  ", instructions: "x" } }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "X", instructions: " " } }))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

// ---------- slug resolution ----------

test("caller-supplied slug collision is 409", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const first = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "A", instructions: "x", slug: "dup" },
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "B", instructions: "y", slug: "dup" },
    });
    assert.equal(second.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("derived slug disambiguates with a -N suffix", async () => {
  const app = await appWith(stateWithProjects());
  try {
    await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Writing Project", instructions: "x" } });
    const second = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Writing Project", instructions: "y" },
    });
    assert.equal(second.json().slug, "writing-project-2");
  } finally {
    await app.close();
  }
});

test("create rejects a malformed caller slug", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Bad", instructions: "x", slug: "Bad Slug!" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

// ---------- update ----------

test("update applies only the supplied fields", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Old", instructions: "old" },
    });
    const id = created.json().id as string;

    const updated = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}`,
      payload: { instructions: "new body" },
    });
    assert.equal(updated.statusCode, 200);
    const body = updated.json();
    assert.equal(body.instructions, "new body");
    assert.equal(body.name, "Old"); // untouched
  } finally {
    await app.close();
  }
});

test("update 404s for an unknown project", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const res = await app.inject({ method: "PUT", url: "/v1/projects/nope", payload: { name: "X" } });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("update rejects a slug already owned by another project", async () => {
  const app = await appWith(stateWithProjects());
  try {
    await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "A", instructions: "x", slug: "taken" } });
    const b = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "B", instructions: "y" } });
    const idB = b.json().id as string;
    const res = await app.inject({ method: "PUT", url: `/v1/projects/${idB}`, payload: { slug: "taken" } });
    assert.equal(res.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("update sets and clears custom columns", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Cols", instructions: "x" } });
    const id = created.json().id as string;

    const set = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}`,
      payload: {
        columns: [
          { id: "triage", label: "Triage", kind: "backlog" },
          { id: "doing", label: "Doing", kind: "in_progress" },
          { id: "blocked", label: "Blocked" },
        ],
      },
    });
    assert.equal(set.statusCode, 200);
    const cols = set.json().columns as { id: string; kind?: string }[];
    assert.equal(cols.length, 3);
    assert.equal(cols[2]?.id, "blocked");
    assert.equal(cols[2]?.kind, undefined);

    // Empty array reverts to defaults — `columns` is omitted from the wire.
    const cleared = await app.inject({ method: "PUT", url: `/v1/projects/${id}`, payload: { columns: [] } });
    assert.equal(cleared.json().columns, undefined);
  } finally {
    await app.close();
  }
});

test("update rejects invalid columns (dupes / charset / blank / kind)", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Bad", instructions: "x" } });
    const id = created.json().id as string;
    const url = `/v1/projects/${id}`;

    const dup = await app.inject({
      method: "PUT",
      url,
      payload: { columns: [{ id: "x", label: "X" }, { id: "x", label: "Y" }] },
    });
    assert.equal(dup.statusCode, 400);

    const charset = await app.inject({ method: "PUT", url, payload: { columns: [{ id: "Bad Id", label: "Y" }] } });
    assert.equal(charset.statusCode, 400);

    const blank = await app.inject({ method: "PUT", url, payload: { columns: [{ id: "ok", label: "   " }] } });
    assert.equal(blank.statusCode, 400);

    const kind = await app.inject({
      method: "PUT",
      url,
      payload: { columns: [{ id: "ok", label: "Y", kind: "magic" }] },
    });
    assert.equal(kind.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("update can unarchive via archived:false", async () => {
  const state = stateWithProjects();
  const p = newProject("Z", "x");
  setProjectSlug(p, "z");
  p.archived = true;
  await state.projects!.save(p);
  const app = await appWith(state);
  try {
    const res = await app.inject({ method: "PUT", url: `/v1/projects/${p.id}`, payload: { archived: false } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().archived, false);
  } finally {
    await app.close();
  }
});

// ---------- delete (soft default) + restore ----------

test("delete defaults to soft (archive); restore brings it back", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Z", instructions: "x" } });
    const id = created.json().id as string;

    const del = await app.inject({ method: "DELETE", url: `/v1/projects/${id}` });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { archived: true, id });

    // Default list excludes archived rows.
    const list = await app.inject({ method: "GET", url: "/v1/projects" });
    assert.equal((list.json() as unknown[]).length, 0);

    // include_archived surfaces it again.
    const listAll = await app.inject({ method: "GET", url: "/v1/projects?include_archived=true" });
    assert.equal((listAll.json() as unknown[]).length, 1);

    // Restore.
    const restored = await app.inject({ method: "POST", url: `/v1/projects/${id}/restore` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().archived, false);
  } finally {
    await app.close();
  }
});

test("delete 404s for an unknown project", async () => {
  const app = await appWith(stateWithProjects());
  try {
    assert.equal((await app.inject({ method: "DELETE", url: "/v1/projects/nope" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

// ---------- hard delete ----------

test("hard delete removes a project with no bound conversations", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Doomed", instructions: "x" } });
    const id = created.json().id as string;

    const del = await app.inject({ method: "DELETE", url: `/v1/projects/${id}?hard=true` });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { deleted: true, id });

    assert.equal((await app.inject({ method: "GET", url: `/v1/projects/${id}` })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("hard delete refuses (409) when conversations are bound", async () => {
  const stores = makeMemoryStores();
  const convStore = stores.conversations as MemoryConversationStore;
  const state: AppState = { ...baseState(), projects: stores.projects, store: convStore };

  const p = newProject("X", "x");
  setProjectSlug(p, "x");
  await state.projects!.save(p);
  await convStore.saveEnvelope("convA", { messages: [] }, { project_id: p.id, lifecycle: "active" });

  const app = await appWith(state);
  try {
    const res = await app.inject({ method: "DELETE", url: `/v1/projects/${p.id}?hard=true` });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json().bound_conversations, ["convA"]);
  } finally {
    await app.close();
  }
});

// ---------- workspace canonicalisation ----------

test("create canonicalises + dedupes workspaces", async () => {
  const dir = await tmpDir();
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Multi",
        instructions: "x",
        workspaces: [{ path: dir, name: "Primary" }, { path: dir }],
      },
    });
    assert.equal(created.statusCode, 201);
    const ws = created.json().workspaces as { path: string; name?: string }[];
    assert.equal(ws.length, 1, "duplicate path should be deduped");
    assert.equal(ws[0]?.name, "Primary");
  } finally {
    await app.close();
  }
});

test("create 400s for an unreachable workspace path", async () => {
  const app = await appWith(stateWithProjects());
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Bad", instructions: "x", workspaces: [{ path: "/this/should/not/exist/abc123" }] },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("update can replace and then clear workspaces, leaving them untouched on omit", async () => {
  const dir = await tmpDir();
  const app = await appWith(stateWithProjects());
  try {
    const created = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "P", instructions: "x" } });
    const id = created.json().id as string;

    const set = await app.inject({ method: "PUT", url: `/v1/projects/${id}`, payload: { workspaces: [{ path: dir }] } });
    assert.equal((set.json().workspaces as unknown[]).length, 1);

    const clear = await app.inject({ method: "PUT", url: `/v1/projects/${id}`, payload: { workspaces: [] } });
    assert.equal((clear.json().workspaces as unknown[]).length, 0);

    // Re-set, then a patch that omits workspaces must leave them in place.
    await app.inject({ method: "PUT", url: `/v1/projects/${id}`, payload: { workspaces: [{ path: dir }] } });
    const renamed = await app.inject({ method: "PUT", url: `/v1/projects/${id}`, payload: { name: "Renamed" } });
    assert.equal((renamed.json().workspaces as unknown[]).length, 1);
    assert.equal(renamed.json().name, "Renamed");
  } finally {
    await app.close();
  }
});
