import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChannelHuman,
  expiredResponse,
  hitlActive,
  requestHuman,
  withHitl,
  type HitlRequest,
  type HitlResponse,
  type PendingHitl,
} from "./hitl.ts";

function req(id: string): HitlRequest {
  return { id, transport: "text", kind: "input", title: "Q?" };
}

test("requestHuman: no sink resolves an expired response", async () => {
  assert.equal(hitlActive(), false);
  const r = await requestHuman(req("h1"));
  assert.equal(r.request_id, "h1");
  assert.equal(r.status, "expired");
});

test("withHitl: installs the sink that requestHuman routes to", async () => {
  const seen: string[] = [];
  const sink = async (r: HitlRequest): Promise<HitlResponse> => {
    seen.push(r.id);
    return { request_id: r.id, status: "submitted", payload: "blue" };
  };
  const out = await withHitl(sink, async () => {
    assert.equal(hitlActive(), true);
    return requestHuman(req("h2"));
  });
  assert.deepEqual(seen, ["h2"]);
  assert.equal(out.status, "submitted");
  assert.equal(out.payload, "blue");
  // Scope is restored after withHitl returns.
  assert.equal(hitlActive(), false);
});

test("ChannelHuman: fans a PendingHitl out and resolves on respond", async () => {
  let captured: PendingHitl | undefined;
  const human = new ChannelHuman((p) => {
    captured = p;
  });
  const p = human.request(req("h3"));
  assert.ok(captured, "send callback received the pending request");
  assert.equal(captured!.request.id, "h3");
  captured!.respond({ request_id: "h3", status: "approved", payload: true });
  const r = await p;
  assert.equal(r.status, "approved");
  assert.equal(r.payload, true);
});

test("ChannelHuman: a second respond is ignored (settle-once)", async () => {
  let captured: PendingHitl | undefined;
  const human = new ChannelHuman((p) => {
    captured = p;
  });
  const p = human.request(req("h4"));
  captured!.respond({ request_id: "h4", status: "submitted", payload: "first" });
  captured!.respond({ request_id: "h4", status: "cancelled" });
  const r = await p;
  assert.equal(r.payload, "first");
});

test("ChannelHuman: a throwing send rejects the request", async () => {
  const human = new ChannelHuman(() => {
    throw new Error("socket closed");
  });
  await assert.rejects(() => human.request(req("h5")), /socket closed/);
});

test("expiredResponse: shape", () => {
  const r = expiredResponse("h6");
  assert.deepEqual(r, { request_id: "h6", status: "expired", reason: "no HITL transport available" });
});
