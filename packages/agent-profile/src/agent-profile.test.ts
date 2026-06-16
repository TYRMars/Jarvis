import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentProfileEventId,
  newProfile,
  touchProfile,
  type AgentProfile,
  type AgentProfileEvent,
} from "./agent-profile.ts";

test("newProfile mints a UUID and equal timestamps", () => {
  const p = newProfile("Alice", "openai", "gpt-4o-mini");
  assert.equal(p.id.length, 36);
  assert.equal(p.name, "Alice");
  assert.equal(p.provider, "openai");
  assert.equal(p.model, "gpt-4o-mini");
  assert.equal(p.avatar, undefined);
  assert.equal(p.system_prompt, undefined);
  assert.equal(p.default_workspace, undefined);
  assert.equal(p.allowed_tools, undefined);
  assert.equal(p.created_at, p.updated_at);
});

test("newProfile trims the name", () => {
  const p = newProfile("  Bob  ", "anthropic", "claude-3-5-sonnet-latest");
  assert.equal(p.name, "Bob");
});

test("touchProfile bumps updated_at only", async () => {
  const p = newProfile("Alice", "openai", "gpt-4o-mini");
  const created = p.created_at;
  await new Promise((r) => setTimeout(r, 2));
  touchProfile(p);
  assert.equal(p.created_at, created);
  assert.notEqual(p.updated_at, created);
});

test("JSON round-trip skips default optional fields", () => {
  const p = newProfile("Alice", "openai", "gpt-4o-mini");
  const json = JSON.stringify(p);
  // None / empty optional fields are absent on the wire (skip_serializing_if).
  assert.ok(!json.includes("avatar"));
  assert.ok(!json.includes("system_prompt"));
  assert.ok(!json.includes("default_workspace"));
  assert.ok(!json.includes("allowed_tools"));
  const back = JSON.parse(json) as AgentProfile;
  assert.deepEqual(back, p);
});

test("populated optional fields survive the round-trip", () => {
  const p: AgentProfile = {
    ...newProfile("Alice", "codex", "gpt-5.4-mini"),
    avatar: "🦊",
    system_prompt: "Be concise.",
    default_workspace: "/work/alice",
    allowed_tools: ["fs.read", "code.grep"],
  };
  const back = JSON.parse(JSON.stringify(p)) as AgentProfile;
  assert.deepEqual(back, p);
});

test("upserted event flattens the profile under type:upserted", () => {
  const p = newProfile("Alice", "openai", "gpt-4o-mini");
  const ev: AgentProfileEvent = { type: "upserted", ...p };
  const json = JSON.stringify(ev);
  assert.ok(json.includes('"type":"upserted"'));
  const back = JSON.parse(json) as AgentProfileEvent;
  assert.equal(back.type, "upserted");
  assert.equal(agentProfileEventId(back), p.id);
});

test("deleted event carries just the id", () => {
  const ev: AgentProfileEvent = { type: "deleted", id: "p-7" };
  const json = JSON.stringify(ev);
  assert.ok(json.includes('"type":"deleted"'));
  const back = JSON.parse(json) as AgentProfileEvent;
  assert.equal(back.type, "deleted");
  assert.equal(agentProfileEventId(back), "p-7");
});
