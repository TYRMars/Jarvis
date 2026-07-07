// Tests for the project-connector REST surface. Ported from the `tests` module
// in crates/harness-server/src/connectors_routes.rs, plus the 503 / 404 / map_error
// coverage the prompt calls for. Network-free: a scripted MockConnector serves a
// fixed issue list, records pushes, and can report a moved remote `updated_at`.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  ConnectorError,
  MemoryConnectorAccountStore,
  MemoryProjectBindingStore,
  MemoryRequirementBindingStore,
  type ConnectorAuth,
  type ProjectBinding,
  type ProjectConnector,
  type PullResult,
  type PushResult,
  type RemoteIssue,
  type RemoteIssueState,
  type RemoteProject,
  type RequirementPush,
} from "@jarvis/connectors";
import { MemoryActivityStore, MemoryProjectStore, MemoryRequirementStore } from "@jarvis/store";
import { registerConnectorsRoutes } from "./connectors-routes.ts";
import type { AppState, ConnectorSecretResolver } from "./state.ts";

// ---------------------------------------------------------------------
// Scripted connector
// ---------------------------------------------------------------------

class MockConnector implements ProjectConnector {
  readonly id = "mock";
  readonly displayName = "Mock Tracker";
  issues: RemoteIssue[];
  readonly pushes: Array<[string, RequirementPush]> = [];
  /** What `fetchIssue` reports as the remote's updated_at (overrides the issue's). */
  remoteUpdatedAt: string | undefined = undefined;
  /** When set, every call rejects with this error (auth/not_found probes). */
  failWith: ConnectorError | undefined = undefined;

  constructor(issues: RemoteIssue[]) {
    this.issues = issues;
  }

  listRemoteProjects(_auth: ConnectorAuth): Promise<RemoteProject[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve([{ id: "acme/demo", name: "demo" }]);
  }

  pullRequirements(_auth: ConnectorAuth, _binding: ProjectBinding): Promise<PullResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ issues: structuredClone(this.issues), cursor: null });
  }

  fetchIssue(
    _auth: ConnectorAuth,
    _binding: ProjectBinding,
    remoteTaskId: string,
  ): Promise<RemoteIssue> {
    if (this.failWith) return Promise.reject(this.failWith);
    const issue = this.issues.find((i) => i.id === remoteTaskId);
    if (!issue) return Promise.reject(ConnectorError.notFound("no such issue"));
    const copy = structuredClone(issue);
    if (this.remoteUpdatedAt !== undefined) copy.updated_at = this.remoteUpdatedAt;
    return Promise.resolve(copy);
  }

  pushRequirement(
    _auth: ConnectorAuth,
    _binding: ProjectBinding,
    remoteTaskId: string,
    change: RequirementPush,
  ): Promise<PushResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.pushes.push([remoteTaskId, structuredClone(change)]);
    return Promise.resolve({ remoteUpdatedAt: "2026-06-10T12:00:00Z" });
  }
}

function issue(id: string, title: string, state: RemoteIssueState): RemoteIssue {
  return {
    id,
    title,
    body: `body of ${title}`,
    state,
    url: `https://example.test/${id}`,
    labels: [],
    updated_at: "2026-06-09T00:00:00Z",
  };
}

// ---------------------------------------------------------------------
// AppState fixtures
// ---------------------------------------------------------------------

const noAgent = (): never => {
  throw new Error("agent not used in these route tests");
};

interface StateBits {
  mock?: MockConnector;
  /** Include the three connector stores (default true). */
  connectorStores?: boolean;
  /** Include the project + requirement + activity stores (default true). */
  domainStores?: boolean;
  /** Include the secret resolver (default true). */
  secrets?: boolean;
  /** Override the secret resolver (default resolves MOCK_TOKEN → "secret"). */
  resolver?: ConnectorSecretResolver;
}

interface BuiltState {
  state: AppState;
  requirements?: MemoryRequirementStore;
  activities?: MemoryActivityStore;
  rbStore?: MemoryRequirementBindingStore;
}

function makeState(bits: StateBits = {}): BuiltState {
  const connectorStores = bits.connectorStores ?? true;
  const domainStores = bits.domainStores ?? true;
  const secrets = bits.secrets ?? true;

  const requirements = domainStores ? new MemoryRequirementStore() : undefined;
  const activities = domainStores ? new MemoryActivityStore() : undefined;
  const rbStore = connectorStores ? new MemoryRequirementBindingStore() : undefined;

  const resolver: ConnectorSecretResolver =
    bits.resolver ??
    ((ref) => Promise.resolve(ref === "MOCK_TOKEN" ? "secret" : undefined));

  const state: AppState = {
    createAgent: noAgent,
    projects: domainStores ? new MemoryProjectStore() : undefined,
    requirements,
    activities,
    connectors: bits.mock ? [bits.mock] : [],
    connectorAccounts: connectorStores ? new MemoryConnectorAccountStore() : undefined,
    connectorProjectBindings: connectorStores ? new MemoryProjectBindingStore() : undefined,
    connectorRequirementBindings: rbStore,
    connectorSecrets: secrets ? resolver : undefined,
  };
  return { state, requirements, activities, rbStore };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerConnectorsRoutes(app, state);
  await app.ready();
  return app;
}

/** Create one account through the REST surface; return its id. */
async function setupAccount(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/accounts",
    payload: { display_name: "test", auth_ref: "MOCK_TOKEN" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { account: { id: string } }).account.id;
}

// ---------------------------------------------------------------------
// list connectors + 503s
// ---------------------------------------------------------------------

test("GET /v1/connectors lists registered kinds (no store needed)", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({ method: "GET", url: "/v1/connectors" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { items: [{ id: "mock", display_name: "Mock Tracker" }] });
  await app.close();
});

test("connector store-backed routes 503 when the connector stores are absent", async () => {
  const { state } = makeState({ mock: new MockConnector([]), connectorStores: false });
  const app = await buildApp(state);
  for (const r of [
    { method: "GET" as const, url: "/v1/connectors/accounts" },
    { method: "POST" as const, url: "/v1/connectors/mock/accounts", payload: { display_name: "x", auth_ref: "MOCK_TOKEN" } },
    { method: "DELETE" as const, url: "/v1/connectors/accounts/a1" },
    { method: "GET" as const, url: "/v1/connectors/mock/projects?account_id=a1" },
    { method: "POST" as const, url: "/v1/connectors/mock/import", payload: { account_id: "a1", remote_project_id: "acme/demo" } },
    { method: "GET" as const, url: "/v1/project-bindings" },
    { method: "POST" as const, url: "/v1/project-bindings/b1/sync" },
    { method: "POST" as const, url: "/v1/requirement-bindings/rb1/push", payload: { action: "close" } },
  ]) {
    const res = await app.inject(r);
    assert.equal(res.statusCode, 503, `${r.method} ${r.url} → ${res.body}`);
  }
  await app.close();
});

test("import 503s when project/requirement stores are absent (connector stores present)", async () => {
  const { state } = makeState({ mock: new MockConnector([]), domainStores: false });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  assert.equal(res.statusCode, 503, res.body);
  assert.match((res.json() as { error: string }).error, /project\/requirement/);
  await app.close();
});

// ---------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------

test("create account on an unknown connector → 404", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({
    method: "POST",
    url: "/v1/connectors/nope/accounts",
    payload: { display_name: "x", auth_ref: "MOCK_TOKEN" },
  });
  assert.equal(res.statusCode, 404, res.body);
  await app.close();
});

test("create account rejects a token-shaped auth_ref → 400", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/accounts",
    payload: {
      display_name: "x",
      auth_ref:
        "ghp_AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789x",
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  await app.close();
});

test("create account + list + delete round-trip", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);

  const listed = await app.inject({ method: "GET", url: "/v1/connectors/accounts" });
  assert.equal(listed.statusCode, 200);
  const items = (listed.json() as { items: Array<{ id: string }> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, accountId);

  const del = await app.inject({ method: "DELETE", url: `/v1/connectors/accounts/${accountId}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  const delAgain = await app.inject({ method: "DELETE", url: `/v1/connectors/accounts/${accountId}` });
  assert.deepEqual(delAgain.json(), { deleted: false });
  await app.close();
});

// ---------------------------------------------------------------------
// remote projects + secret resolution
// ---------------------------------------------------------------------

test("list remote projects: unknown account → 404", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({
    method: "GET",
    url: "/v1/connectors/mock/projects?account_id=ghost",
  });
  assert.equal(res.statusCode, 404, res.body);
  await app.close();
});

test("list remote projects: unresolvable secret → 400", async () => {
  const { state } = makeState({
    mock: new MockConnector([]),
    resolver: () => Promise.resolve(undefined),
  });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);
  const res = await app.inject({
    method: "GET",
    url: `/v1/connectors/mock/projects?account_id=${accountId}`,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match((res.json() as { error: string }).error, /not resolvable/);
  await app.close();
});

test("list remote projects: no secret resolver wired → 503", async () => {
  const { state } = makeState({ mock: new MockConnector([]), secrets: false });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);
  const res = await app.inject({
    method: "GET",
    url: `/v1/connectors/mock/projects?account_id=${accountId}`,
  });
  assert.equal(res.statusCode, 503, res.body);
  await app.close();
});

test("list remote projects: happy path", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);
  const res = await app.inject({
    method: "GET",
    url: `/v1/connectors/mock/projects?account_id=${accountId}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { items: [{ id: "acme/demo", name: "demo" }] });
  await app.close();
});

test("connector auth failure on remote-projects → 502 (map_error)", async () => {
  const mock = new MockConnector([]);
  mock.failWith = ConnectorError.auth("bad token");
  const { state } = makeState({ mock });
  const app = await buildApp(state);
  const accountId = await setupAccount(app);
  const res = await app.inject({
    method: "GET",
    url: `/v1/connectors/mock/projects?account_id=${accountId}`,
  });
  assert.equal(res.statusCode, 502, res.body);
  await app.close();
});

// ---------------------------------------------------------------------
// import
// ---------------------------------------------------------------------

test("import creates a project, requirements, and bindings; Closed → done", async () => {
  const mock = new MockConnector([
    issue("1", "open thing", "open"),
    issue("2", "closed thing", "closed"),
  ]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);

  const res = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const j = res.json() as {
    summary: { created: number; updated: number; unchanged: number };
    binding: { id: string };
    project_id: string;
  };
  assert.equal(j.summary.created, 2);
  const bindingId = j.binding.id;
  const projectId = j.project_id;

  const rows = await built.requirements!.list(projectId);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.title === "open thing")?.status, "backlog");
  assert.equal(rows.find((r) => r.title === "closed thing")?.status, "done");

  const bindings = await built.rbStore!.listForProjectBinding(bindingId);
  assert.equal(bindings.length, 2);
  assert.ok(bindings.every((b) => b.remote_updated_at !== undefined));

  // Each import leaves a connector_sync Activity row.
  for (const r of rows) {
    const acts = await built.activities!.listForRequirement(r.id);
    assert.ok(acts.some((a) => a.kind === "connector_sync"));
  }
  await app.close();
});

test("second import of the same remote → 409; sync is idempotent and never clobbers local status", async () => {
  const mock = new MockConnector([issue("1", "first title", "open")]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);

  const first = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  assert.equal(first.statusCode, 201, first.body);
  const fj = first.json() as { binding: { id: string }; project_id: string };
  const bindingId = fj.binding.id;
  const projectId = fj.project_id;

  // Re-import of the same remote is refused.
  const second = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  assert.equal(second.statusCode, 409, second.body);

  // Local-only status change survives a re-sync; a remote retitle lands.
  const rowsBefore = await built.requirements!.list(projectId);
  const row = rowsBefore[0]!;
  row.status = "in_progress";
  await built.requirements!.upsert(row);
  mock.issues[0]!.title = "renamed title";

  const synced = await app.inject({
    method: "POST",
    url: `/v1/project-bindings/${bindingId}/sync`,
    payload: {},
  });
  assert.equal(synced.statusCode, 200, synced.body);
  const sj = synced.json() as { summary: { created: number; updated: number } };
  assert.equal(sj.summary.created, 0);
  assert.equal(sj.summary.updated, 1);

  const rows = await built.requirements!.list(projectId);
  assert.equal(rows.length, 1, "sync must not duplicate rows");
  assert.equal(rows[0]?.title, "renamed title");
  assert.equal(rows[0]?.status, "in_progress", "pull must never clobber local status");
  await app.close();
});

test("sync of an unknown binding → 404", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({ method: "POST", url: "/v1/project-bindings/ghost/sync" });
  assert.equal(res.statusCode, 404, res.body);
  await app.close();
});

test("list project bindings filtered by project_id", async () => {
  const mock = new MockConnector([issue("1", "x", "open")]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);
  const imported = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  const projectId = (imported.json() as { project_id: string }).project_id;

  const all = await app.inject({ method: "GET", url: "/v1/project-bindings" });
  assert.equal((all.json() as { items: unknown[] }).items.length, 1);

  const filtered = await app.inject({
    method: "GET",
    url: `/v1/project-bindings?project_id=${projectId}`,
  });
  assert.equal((filtered.json() as { items: unknown[] }).items.length, 1);

  const none = await app.inject({
    method: "GET",
    url: "/v1/project-bindings?project_id=other",
  });
  assert.equal((none.json() as { items: unknown[] }).items.length, 0);
  await app.close();
});

// ---------------------------------------------------------------------
// push (write-back) + conflict/force gate
// ---------------------------------------------------------------------

test("push: empty body → 400; conflict gate → 409; force overrides + stamps binding + audit row", async () => {
  const mock = new MockConnector([issue("1", "thing", "open")]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);

  const imported = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  const bindingId = (imported.json() as { binding: { id: string } }).binding.id;
  const rb = (await built.rbStore!.listForProjectBinding(bindingId))[0]!;

  // Empty push is a 400.
  const empty = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: {},
  });
  assert.equal(empty.statusCode, 400, empty.body);

  // Remote moved since the import → 409 without force.
  mock.remoteUpdatedAt = "2026-06-09T09:00:00Z";
  const conflict = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: { action: "close", comment: "done by jarvis" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(mock.pushes.length, 0, "no push on conflict");

  // force=true overrides.
  const forced = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: { action: "close", comment: "done by jarvis", force: true },
  });
  assert.equal(forced.statusCode, 200, forced.body);
  assert.equal(mock.pushes.length, 1);
  assert.equal(mock.pushes[0]?.[0], "1");
  assert.equal(mock.pushes[0]?.[1].action, "close");

  const saved = await built.rbStore!.get(rb.id);
  assert.ok(saved?.last_pushed_at !== undefined);
  assert.equal(
    saved?.remote_updated_at,
    "2026-06-10T12:00:00Z",
    "push result becomes the new conflict baseline",
  );

  const acts = await built.activities!.listForRequirement(rb.requirement_id);
  assert.ok(acts.some((a) => a.kind === "connector_sync"), "push must leave an audit row");
  await app.close();
});

test("push: undefined conflict baseline fails closed → 409 (no blind overwrite)", async () => {
  // A remote issue whose payload omits `updated_at` (GHES / edge variant) →
  // the binding's `remote_updated_at` baseline is undefined. The push must
  // fail closed with a 409, never a blind overwrite.
  const bare = issue("1", "thing", "open");
  delete bare.updated_at;
  const mock = new MockConnector([bare]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);

  const imported = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  const bindingId = (imported.json() as { binding: { id: string } }).binding.id;
  const rb = (await built.rbStore!.listForProjectBinding(bindingId))[0]!;
  assert.equal(rb.remote_updated_at, undefined, "baseline is undefined for this fixture");

  // fetchIssue still returns no updated_at → cannot prove safety → 409.
  const blind = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: { action: "close", comment: "done by jarvis" },
  });
  assert.equal(blind.statusCode, 409, blind.body);
  assert.equal(mock.pushes.length, 0, "must not push when safety is unprovable");

  // force=true still overrides the closed gate.
  const forced = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: { action: "close", comment: "done by jarvis", force: true },
  });
  assert.equal(forced.statusCode, 200, forced.body);
  assert.equal(mock.pushes.length, 1, "force overrides the fail-closed gate");
  await app.close();
});

test("push: unknown requirement binding → 404", async () => {
  const { state } = makeState({ mock: new MockConnector([]) });
  const app = await buildApp(state);
  const res = await app.inject({
    method: "POST",
    url: "/v1/requirement-bindings/ghost/push",
    payload: { action: "close" },
  });
  assert.equal(res.statusCode, 404, res.body);
  await app.close();
});

test("push with only a comment (no action) is accepted", async () => {
  const mock = new MockConnector([issue("1", "thing", "open")]);
  const built = makeState({ mock });
  const app = await buildApp(built.state);
  const accountId = await setupAccount(app);
  const imported = await app.inject({
    method: "POST",
    url: "/v1/connectors/mock/import",
    payload: { account_id: accountId, remote_project_id: "acme/demo" },
  });
  const bindingId = (imported.json() as { binding: { id: string } }).binding.id;
  const rb = (await built.rbStore!.listForProjectBinding(bindingId))[0]!;

  const res = await app.inject({
    method: "POST",
    url: `/v1/requirement-bindings/${rb.id}/push`,
    payload: { comment: "just a note" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(mock.pushes.length, 1);
  assert.equal(mock.pushes[0]?.[1].action, undefined);
  assert.equal(mock.pushes[0]?.[1].comment, "just a note");
  await app.close();
});
