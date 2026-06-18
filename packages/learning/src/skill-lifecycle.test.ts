import { test } from "node:test";
import assert from "node:assert/strict";

import {
  newSkillLifecycle,
  pinnedSkillLifecycle,
  skillCreatorMayMutate,
  skillLifecycleCuratorArchivable,
  skillStateAsWire,
} from "./skill-lifecycle.ts";

test("new lifecycle starts active + unpinned, timestamps deferred to store", () => {
  const lc = newSkillLifecycle("rust-debugger", "user", "agent");
  assert.equal(lc.state, "active");
  assert.equal(lc.pinned, false);
  assert.equal(lc.archived_at, undefined);
  assert.equal(lc.created_at, "", "store stamps timestamps");
  assert.equal(lc.updated_at, "");
});

test("curator_archivable only for unpinned agent rows", () => {
  const agent = newSkillLifecycle("a", "workspace", "agent");
  assert.equal(skillLifecycleCuratorArchivable(agent), true);

  const pinned = pinnedSkillLifecycle(newSkillLifecycle("a", "workspace", "agent"));
  assert.equal(skillLifecycleCuratorArchivable(pinned), false, "pinned rows are protected");

  const bundled = newSkillLifecycle("b", "bundled", "bundled");
  assert.equal(skillLifecycleCuratorArchivable(bundled), false, "bundled never auto-archived");

  const user = newSkillLifecycle("u", "user", "user");
  assert.equal(skillLifecycleCuratorArchivable(user), false, "user-authored never auto-archived");

  const archived = newSkillLifecycle("c", "workspace", "agent");
  archived.state = "archived";
  assert.equal(skillLifecycleCuratorArchivable(archived), false, "already archived");
});

test("skill_state wire strings", () => {
  assert.equal(skillStateAsWire("active"), "active");
  assert.equal(skillStateAsWire("stale"), "stale");
  assert.equal(skillStateAsWire("archived"), "archived");
});

test("skill_creator curator gate", () => {
  assert.equal(skillCreatorMayMutate("agent"), true);
  assert.equal(skillCreatorMayMutate("user"), false);
  assert.equal(skillCreatorMayMutate("bundled"), false);
  assert.equal(skillCreatorMayMutate("plugin"), false);
});
