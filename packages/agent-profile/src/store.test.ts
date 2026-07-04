import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newProfile, type AgentProfile, type AgentProfileEvent } from "./agent-profile.ts";
import type { AgentProfileStore } from "./store.ts";
import { JsonFileAgentProfileStore } from "./json-store.ts";
import { MemoryAgentProfileStore } from "./memory-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-agent-profile-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `name` is what `list` sorts by; build profiles with explicit names.
function profile(name: string): AgentProfile {
  return newProfile(name, "openai", "gpt-4o-mini");
}

function contract(name: string, make: (dir: string) => Promise<AgentProfileStore>): void {
  test(`${name}: upsert then get round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = profile("Alice");
      await store.upsert(p);
      const got = await store.get(p.id);
      assert.deepEqual(got, p);
    });
  });

  test(`${name}: get of an unknown id is undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.equal(await store.get("nope"), undefined);
    });
  });

  test(`${name}: list is empty on a fresh store`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.deepEqual(await store.list(), []);
    });
  });

  test(`${name}: list is sorted by name ascending`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(profile("Charlie"));
      await store.upsert(profile("Alice"));
      await store.upsert(profile("Bob"));
      const names = (await store.list()).map((p) => p.name);
      assert.deepEqual(names, ["Alice", "Bob", "Charlie"]);
    });
  });

  test(`${name}: upsert overwrites by id`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = profile("Alice");
      await store.upsert(p);
      const updated = { ...p, model: "gpt-4o", avatar: "🦊" };
      await store.upsert(updated);
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.deepEqual(list[0], updated);
    });
  });

  test(`${name}: delete removes and is idempotent`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = profile("Alice");
      await store.upsert(p);
      assert.equal(await store.delete(p.id), true);
      assert.equal(await store.get(p.id), undefined);
      // already absent → false, no throw.
      assert.equal(await store.delete(p.id), false);
    });
  });

  test(`${name}: subscribe sees upserted then deleted`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const events: AgentProfileEvent[] = [];
      const unsubscribe = store.subscribe((e) => events.push(e));
      const p = profile("Alice");
      await store.upsert(p);
      await store.delete(p.id);
      unsubscribe();
      assert.equal(events.length, 2);
      const [up, del] = events;
      assert.equal(up?.type, "upserted");
      assert.equal(up && "id" in up ? up.id : undefined, p.id);
      assert.equal(up && "name" in up ? up.name : undefined, "Alice");
      assert.equal(del?.type, "deleted");
      assert.equal(del?.id, p.id);
    });
  });

  test(`${name}: no-op delete does not emit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const events: AgentProfileEvent[] = [];
      store.subscribe((e) => events.push(e));
      assert.equal(await store.delete("ghost"), false);
      assert.deepEqual(events, []);
    });
  });

  test(`${name}: unsubscribe stops delivery and is idempotent`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const events: AgentProfileEvent[] = [];
      const unsubscribe = store.subscribe((e) => events.push(e));
      unsubscribe();
      unsubscribe(); // idempotent
      await store.upsert(profile("Alice"));
      assert.deepEqual(events, []);
    });
  });

  test(`${name}: a throwing listener neither rejects the mutation nor blocks other listeners`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: AgentProfileEvent[] = [];
      // First-registered listener throws; a later one must still be delivered,
      // and the committed upsert/delete must not reject back to the caller.
      store.subscribe(() => {
        throw new Error("boom");
      });
      store.subscribe((e) => seen.push(e));

      const warnings: unknown[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        const p = profile("Alice");
        await store.upsert(p); // must resolve despite the throwing listener
        assert.equal(await store.delete(p.id), true);
      } finally {
        console.warn = origWarn;
      }

      assert.deepEqual(
        seen.map((e) => e.type),
        ["upserted", "deleted"],
        "the non-throwing listener must still receive both events",
      );
      assert.ok(warnings.length >= 2, "each throwing invocation is logged and swallowed");
    });
  });

  test(`${name}: get returns an independent copy (no aliasing into the store)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = profile("Alice");
      await store.upsert(p);
      const got = await store.get(p.id);
      assert.ok(got);
      got.name = "Mutated";
      const again = await store.get(p.id);
      assert.equal(again?.name, "Alice");
    });
  });
}

contract("memory", () => Promise.resolve(new MemoryAgentProfileStore()));
contract("json-file", (dir) => JsonFileAgentProfileStore.open(dir));

// JSON-file-specific: durability + on-disk layout + graceful corruption.
test("json-file: persists across reopen under agent_profiles/", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileAgentProfileStore.open(dir);
    const p = profile("Alice");
    await store.upsert(p);

    const files = await readdir(path.join(dir, "agent_profiles"));
    assert.deepEqual(files, [`${p.id}.json`]); // UUID is filename-safe, no encoding

    const reopened = await JsonFileAgentProfileStore.open(dir);
    assert.deepEqual(await reopened.get(p.id), p);
    assert.deepEqual(await reopened.list(), [p]);
  });
});

test("json-file: percent-encodes filename for unsafe ids", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileAgentProfileStore.open(dir);
    const p = { ...profile("Weird"), id: "a:b/c" };
    await store.upsert(p);
    const files = await readdir(path.join(dir, "agent_profiles"));
    assert.equal(files.length, 1);
    assert.ok(!files[0]?.includes(":"));
    assert.ok(!files[0]?.includes("/"));
    assert.deepEqual(await store.get("a:b/c"), p);
  });
});
