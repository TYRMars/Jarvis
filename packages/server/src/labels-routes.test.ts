import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { makeMemoryStores } from "@jarvis/store";
import { registerLabelsRoutes } from "./labels-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

function makeState(opts: { labels?: boolean } = {}): AppState {
  const stores = makeMemoryStores();
  return {
    createAgent: agentUnused,
    labels: opts.labels === false ? undefined : stores.labels,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerLabelsRoutes(app, state);
  await app.ready();
  return app;
}

test("labels routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ labels: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/projects/p1/labels" })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/projects/p1/labels",
        payload: { name: "bug", colour: "#ff0000" },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/labels/l1", payload: { name: "x" } })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/labels/l1" })).statusCode, 503);
  await app.close();
});

test("POST creates a label, lists it, canonicalises colour + trims description", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({
    method: "POST",
    url: "/v1/projects/p1/labels",
    payload: { name: "  Bug  ", colour: "#FF0000", description: "  needs a fix  " },
  });
  assert.equal(created.statusCode, 201);
  const l = created.json();
  assert.equal(l.name, "Bug"); // trimmed
  assert.equal(l.colour, "#ff0000"); // lowercased
  assert.equal(l.description, "needs a fix"); // trimmed
  assert.equal(l.project_id, "p1");

  const list = await app.inject({ method: "GET", url: "/v1/projects/p1/labels" });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.project_id, "p1");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, l.id);
  await app.close();
});

test("POST validation: bad name → 400, bad colour → 400, over-cap description → 400", async () => {
  const app = await buildApp(makeState());
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/projects/p1/labels",
        payload: { name: "   ", colour: "#ff0000" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/projects/p1/labels",
        payload: { name: "ok", colour: "red" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/projects/p1/labels",
        payload: { name: "ok", colour: "#ff0000", description: "d".repeat(257) },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

test("POST a duplicate name in the same project → 409 Conflict", async () => {
  const app = await buildApp(makeState());
  await app.inject({
    method: "POST",
    url: "/v1/projects/p1/labels",
    payload: { name: "bug", colour: "#ff0000" },
  });
  const dup = await app.inject({
    method: "POST",
    url: "/v1/projects/p1/labels",
    payload: { name: "BUG", colour: "#00ff00" }, // case-insensitive clash
  });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /already exists/);
  await app.close();
});

test("PATCH renames / recolours / clears description; touch bumps updated_at", async () => {
  const app = await buildApp(makeState());
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/projects/p1/labels",
      payload: { name: "bug", colour: "#ff0000", description: "old" },
    })
  ).json();

  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/labels/${created.id}`,
    payload: { name: "defect", colour: "#00FF00", description: "" },
  });
  assert.equal(patched.statusCode, 200);
  const l = patched.json();
  assert.equal(l.name, "defect");
  assert.equal(l.colour, "#00ff00");
  assert.ok(!("description" in l)); // "" clears it
  assert.ok(l.updated_at >= created.updated_at);
  await app.close();
});

test("PATCH on a missing label → 404", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "PATCH", url: "/v1/labels/nope", payload: { name: "x" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("PATCH rename to a clashing name → 409", async () => {
  const app = await buildApp(makeState());
  await app.inject({
    method: "POST",
    url: "/v1/projects/p1/labels",
    payload: { name: "bug", colour: "#ff0000" },
  });
  const second = (
    await app.inject({
      method: "POST",
      url: "/v1/projects/p1/labels",
      payload: { name: "feature", colour: "#00ff00" },
    })
  ).json();
  const clash = await app.inject({
    method: "PATCH",
    url: `/v1/labels/${second.id}`,
    payload: { name: "bug" },
  });
  assert.equal(clash.statusCode, 409);
  await app.close();
});

test("DELETE removes a label, returns the ids, 404 when absent", async () => {
  const app = await buildApp(makeState());
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/projects/p1/labels",
      payload: { name: "bug", colour: "#ff0000" },
    })
  ).json();

  const del = await app.inject({ method: "DELETE", url: `/v1/labels/${created.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true, label_id: created.id, project_id: "p1" });

  const list = await app.inject({ method: "GET", url: "/v1/projects/p1/labels" });
  assert.equal(list.json().items.length, 0);

  const again = await app.inject({ method: "DELETE", url: `/v1/labels/${created.id}` });
  assert.equal(again.statusCode, 404);
  await app.close();
});
