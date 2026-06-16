import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentEventRequirementId,
  editComment,
  newComment,
  replyComment,
  type Comment,
  type CommentEvent,
} from "./comment.ts";

test("newComment mints a uuid and matching timestamps, no parent", () => {
  const c = newComment("req-1", { type: "human" }, "hello");
  assert.equal(c.id.length, 36);
  assert.equal(c.requirement_id, "req-1");
  assert.equal(c.body, "hello");
  assert.equal(c.parent_id, undefined);
  assert.equal(c.created_at, c.updated_at);
});

test("replyComment records the parent id", () => {
  const c = replyComment("req-1", { type: "human" }, "+1", "top-id");
  assert.equal(c.parent_id, "top-id");
});

test("editComment changes body + bumps updated_at, immutable created_at", () => {
  const c = newComment("req-1", { type: "human" }, "v1");
  c.created_at = "2020-01-01T00:00:00.000Z";
  c.updated_at = "2020-01-01T00:00:00.000Z";
  assert.equal(editComment(c, "v2"), true);
  assert.equal(c.body, "v2");
  assert.notEqual(c.updated_at, "2020-01-01T00:00:00.000Z");
  assert.equal(c.created_at, "2020-01-01T00:00:00.000Z");
});

test("editComment skips a no-op body change", () => {
  const c = newComment("req-1", { type: "human" }, "same");
  const stamp = c.updated_at;
  assert.equal(editComment(c, "same"), false);
  assert.equal(c.updated_at, stamp);
});

test("wire shape: parent_id omitted when absent; round-trips", () => {
  const c = newComment("req-1", { type: "human" }, "no parent");
  const json = JSON.stringify(c);
  assert.ok(!json.includes("parent_id"));
  const back = JSON.parse(json) as Comment;
  assert.deepEqual(back, c);
});

test("agent-authored comment round-trips", () => {
  const c = newComment("req-1", { type: "agent", profile_id: "alice-bot" }, "hi from a bot");
  const back = JSON.parse(JSON.stringify(c)) as Comment;
  assert.deepEqual(back, c);
});

test("CommentEvent variants + requirement-id helper", () => {
  const c = newComment("req-9", { type: "human" }, "x");
  const posted: CommentEvent = { type: "posted", ...c };
  assert.ok(JSON.stringify(posted).includes('"type":"posted"'));
  assert.equal(commentEventRequirementId(posted), "req-9");
  const deleted: CommentEvent = { type: "deleted", requirement_id: "req-9", comment_id: c.id };
  assert.equal(commentEventRequirementId(deleted), "req-9");
});
