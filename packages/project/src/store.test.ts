import { test } from "node:test";
import assert from "node:assert/strict";
import { newDocDraft, newDocProject, type DocEvent } from "./doc.ts";
import { newProject, type Project } from "./project.ts";
import {
  docStoreLatestDraft,
  type DocStore,
  type EventListener,
  type ProjectStore,
  type Unsubscribe,
} from "./store.ts";
import {
  newRequirement,
  requirementDeletedEvent,
  requirementUpsertedEvent,
  type Requirement,
  type RequirementEvent,
} from "./requirement.ts";
import { type RequirementStore } from "./store.ts";

// A minimal in-memory ProjectStore proves the interface is implementable in
// TS exactly as specified (no abstract base required for the no-event stores).
class MemProjectStore implements ProjectStore {
  private rows = new Map<string, Project>();

  async save(project: Project): Promise<void> {
    this.rows.set(project.id, { ...project });
  }
  async load(id: string): Promise<Project | undefined> {
    return this.rows.get(id);
  }
  async findBySlug(slug: string): Promise<Project | undefined> {
    for (const p of this.rows.values()) if (p.slug === slug) return p;
    return undefined;
  }
  async list(includeArchived: boolean, limit: number): Promise<Project[]> {
    return [...this.rows.values()]
      .filter((p) => includeArchived || !p.archived)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, limit);
  }
  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
  async archive(id: string): Promise<boolean> {
    const p = this.rows.get(id);
    if (!p) return false;
    p.archived = true;
    return true;
  }
}

test("ProjectStore is implementable; save/load/find/list/archive/delete behave", async () => {
  const store = new MemProjectStore();
  const p = newProject("Alpha", "x");
  p.slug = "alpha";
  await store.save(p);
  assert.deepEqual(await store.load(p.id), p);
  assert.deepEqual(await store.findBySlug("alpha"), p);
  assert.equal((await store.list(false, 10)).length, 1);
  assert.equal(await store.archive(p.id), true);
  assert.equal((await store.list(false, 10)).length, 0, "archived hidden by default");
  assert.equal((await store.list(true, 10)).length, 1);
  assert.equal(await store.delete(p.id), true);
  assert.equal(await store.delete(p.id), false, "second delete is a no-op");
});

// EventSource model: subscribe returns an unsubscribe; broadcast fans out.
class MemRequirementStore implements RequirementStore {
  private rows = new Map<string, Requirement>();
  private listeners = new Set<EventListener<RequirementEvent>>();

  subscribe(listener: EventListener<RequirementEvent>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private fanout(ev: RequirementEvent): void {
    for (const l of this.listeners) l(ev);
  }
  async list(projectId: string): Promise<Requirement[]> {
    return [...this.rows.values()].filter((r) => r.project_id === projectId);
  }
  async get(id: string): Promise<Requirement | undefined> {
    return this.rows.get(id);
  }
  async upsert(item: Requirement): Promise<void> {
    this.rows.set(item.id, { ...item });
    // Mirror Rust: the broadcast carries the serde-serialised (wire) row, so
    // skip fields (assignee_id / acceptance_policy) and a default triage_state
    // never reach listeners.
    this.fanout(requirementUpsertedEvent(item));
  }
  async delete(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    this.rows.delete(id);
    this.fanout(requirementDeletedEvent(row.project_id, id));
    return true;
  }
}

test("RequirementStore EventSource: subscribe receives upsert/delete; unsubscribe stops", async () => {
  const store = new MemRequirementStore();
  const seen: RequirementEvent[] = [];
  const off = store.subscribe((ev) => seen.push(ev));
  const r = newRequirement("p1", "x");
  r.assignee_id = "someone";
  await store.upsert(r);
  await store.delete(r.id);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, "upserted");
  assert.equal(seen[1].type, "deleted");
  // The fanned-out upserted frame must match Rust's serde output: no
  // skip fields, no default triage_state.
  const upsertedJson = JSON.stringify(seen[0]);
  assert.ok(!upsertedJson.includes("assignee_id"), "skip field leaked into broadcast");
  assert.ok(!upsertedJson.includes("acceptance_policy"), "skip field leaked into broadcast");
  assert.ok(!upsertedJson.includes("triage_state"), "default triage_state leaked into broadcast");
  off();
  await store.upsert(newRequirement("p1", "y"));
  assert.equal(seen.length, 2, "unsubscribed listener stops receiving");
});

test("docStoreLatestDraft picks the head of listDrafts", async () => {
  const proj = newDocProject("/r", "doc");
  const d1 = newDocDraft(proj.id, "first");
  const d2 = newDocDraft(proj.id, "second");
  const store: Pick<DocStore, "listDrafts"> = {
    // newest-first ordering is the store's contract; head is "latest".
    async listDrafts() {
      return [d2, d1];
    },
  };
  assert.deepEqual(await docStoreLatestDraft(store, proj.id), d2);

  const empty: Pick<DocStore, "listDrafts"> = {
    async listDrafts() {
      return [];
    },
  };
  assert.equal(await docStoreLatestDraft(empty, proj.id), undefined);
});

test("DocEvent type is consumable by a store fanout signature", () => {
  // Compile-time: a DocStore listener takes a DocEvent. This just exercises
  // the type at runtime to keep the test meaningful.
  const events: DocEvent[] = [{ type: "project_deleted", workspace: "/r", id: "x" }];
  assert.equal(events[0].type, "project_deleted");
});
