// SQLite backend tests. Runs the IDENTICAL shared contracts the JSON/memory
// backends use (imported from each store's `*.test.ts`) against the
// `Sqlite*` backends, plus `sqlite::memory:` round-trips and the connect /
// connectAll sqlite arms. better-sqlite3 needs no runtime flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newConversation, userMessage, type Conversation } from "@jarvis/core";
import { newProject, newRequirement } from "@jarvis/project";
import { newWorkflowDefinition, newWorkflowRun } from "@jarvis/workflow";

import { connect, connectAll } from "./connect.ts";
import { StoreError } from "./types.ts";
import {
  SqliteActivityStore,
  SqliteCommentStore,
  SqliteConversationStore,
  SqliteDocStore,
  SqliteLabelStore,
  SqliteProjectMemoryStore,
  SqliteProjectStore,
  SqliteRequirementRunStore,
  SqliteRequirementStore,
  SqliteWorkflowStore,
  resolveSqlitePath,
} from "./sqlite.ts";

// Import the exported contract suites — the same ones json-file / memory run.
import { contractTests as conversationContract } from "./store.test.ts";
import { contract as projectContract } from "./project-store.test.ts";
import { contract as requirementContract } from "./requirement-store.test.ts";
import { contract as runContract } from "./requirement-run-store.test.ts";
import { contract as activityContract } from "./activity-store.test.ts";
import { contract as commentContract } from "./comment-store.test.ts";
import { contract as labelContract } from "./label-store.test.ts";
import { contractTests as docContract } from "./doc-store.test.ts";
import { contractTests as projectMemoryContract } from "./project-memory-store.test.ts";
import { contractTests as workflowContract } from "./workflow-store.test.ts";

// Each contract's `make(dir)` gets a per-test temp dir; we open an on-disk
// SQLite DB inside it so the suites run against a durable file (not just
// `:memory:`), exercising the same path connectAll uses.
const dbUrl = (dir: string): string => `sqlite:${path.join(dir, "store.db")}`;

// ---------- shared contracts against the SQLite backends ----------

conversationContract("sqlite", (dir) => Promise.resolve(SqliteConversationStore.open(dbUrl(dir))));
projectContract("sqlite", (dir) => Promise.resolve(SqliteProjectStore.open(dbUrl(dir))));
requirementContract("sqlite", (dir) => Promise.resolve(SqliteRequirementStore.open(dbUrl(dir))));
runContract("sqlite", (dir) => Promise.resolve(SqliteRequirementRunStore.open(dbUrl(dir))));
activityContract("sqlite", (dir) => Promise.resolve(SqliteActivityStore.open(dbUrl(dir))));
commentContract("sqlite", (dir) => Promise.resolve(SqliteCommentStore.open(dbUrl(dir))));
labelContract("sqlite", (dir) => Promise.resolve(SqliteLabelStore.open(dbUrl(dir))));
docContract("sqlite", (dir) => Promise.resolve(SqliteDocStore.open(dbUrl(dir))));
projectMemoryContract("sqlite", (dir) => Promise.resolve(SqliteProjectMemoryStore.open(dbUrl(dir))));
workflowContract("sqlite", (dir) => Promise.resolve(SqliteWorkflowStore.open(dbUrl(dir))));

// ---------- sqlite::memory: round-trips (no temp dir needed) ----------

function convo(content: string): Conversation {
  const c = newConversation();
  c.messages.push(userMessage(content));
  return c;
}

test("resolveSqlitePath maps the URL forms", () => {
  assert.equal(resolveSqlitePath("sqlite::memory:"), ":memory:");
  assert.equal(resolveSqlitePath("sqlite://:memory:"), ":memory:");
  assert.equal(resolveSqlitePath("sqlite:/tmp/x.db"), "/tmp/x.db");
  assert.equal(resolveSqlitePath("sqlite:///tmp/x.db"), "/tmp/x.db");
  assert.equal(resolveSqlitePath("sqlite:rel.db"), "rel.db");
});

test("sqlite::memory: conversation round-trips in one shared handle", async () => {
  const store = SqliteConversationStore.open("sqlite::memory:");
  await store.saveEnvelope("c1", convo("hi"), { project_id: "p-1", lifecycle: "archived" });
  const env = await store.loadEnvelope("c1");
  assert.equal(env?.[0].messages.length, 1);
  assert.equal(env?.[1].project_id, "p-1");
  assert.equal(env?.[1].lifecycle, "archived");
  const rows = await store.list(10);
  assert.equal(rows[0]?.message_count, 1);
  assert.equal(await store.delete("c1"), true);
  assert.equal(await store.delete("c1"), false);
});

test("sqlite::memory: internal __memory__ id with ':' round-trips", async () => {
  const store = SqliteConversationStore.open("sqlite::memory:");
  const id = "__memory__.summary:abcdef0123456789";
  await store.save(id, convo("summary"));
  assert.equal((await store.load(id))?.messages.length, 1);
  assert.ok((await store.list(10)).some((r) => r.id === id));
});

test("sqlite::memory: every store in connectAll shares ONE database", async () => {
  // The whole point of one shared handle: an in-memory bundle must see its own
  // writes across stores. A separate handle per store would lose them.
  const bundle = await connectAll("sqlite::memory:");
  const p = newProject("alpha", "instructions");
  p.slug = "alpha"; // newProject leaves slug "" — callers set it (deriveSlug etc.)
  await bundle.projects.save(p);
  const req = newRequirement(p.id, "do a thing");
  await bundle.requirements.upsert(req);
  const def = newWorkflowDefinition("ship");
  await bundle.workflows.upsert(def);

  assert.equal((await bundle.projects.load(p.id))?.slug, "alpha");
  assert.equal((await bundle.requirements.get(req.id))?.title, "do a thing");
  assert.equal((await bundle.workflows.get(def.id))?.name, "ship");
  // Cross-store independence: deleting the requirement leaves the project.
  assert.equal(await bundle.requirements.delete(req.id), true);
  assert.equal((await bundle.projects.load(p.id))?.id, p.id);
});

// ---------- connect / connectAll sqlite arms (durable file) ----------

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-sqlite-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("connect: sqlite:<path> opens a SqliteConversationStore that persists across reopen", async () => {
  await withTempDir(async (dir) => {
    const url = dbUrl(dir);
    const first = await connect(url);
    await first.save("c1", convo("via connect"));
    // Reopen the SAME file in a fresh handle — durable on disk.
    const reopened = await connect(url);
    assert.equal((await reopened.load("c1"))?.messages.length, 1);
  });
});

test("connectAll: sqlite:<path> yields the full StoreBundle on one file", async () => {
  await withTempDir(async (dir) => {
    const url = dbUrl(dir);
    const bundle = await connectAll(url);

    const p = newProject("beta", "instructions");
    p.slug = "beta";
    await bundle.projects.save(p);
    const run = newWorkflowRun("wf-1", "req-1");
    await bundle.workflows.upsertRun(run);

    // Reopen and confirm both families survived to disk.
    const reopened = await connectAll(url);
    assert.equal((await reopened.projects.findBySlug("beta"))?.id, p.id);
    assert.equal((await reopened.workflows.getRun(run.id))?.workflow_id, "wf-1");
    assert.equal((await reopened.workflows.listRuns("wf-1", "req-1")).length, 1);
  });
});

test("connect: unknown + still-unsupported SQL schemes throw StoreError", async () => {
  await assert.rejects(() => connect("postgres://localhost/db"), StoreError);
  await assert.rejects(() => connect("mysql://localhost/db"), StoreError);
  await assert.rejects(() => connect("redis://localhost"), StoreError);
  await assert.rejects(() => connectAll("postgres://localhost/db"), StoreError);
});
