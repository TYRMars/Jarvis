import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type ChannelInboundKind,
  ackEmpty,
  ackPlain,
  ackXml,
  channelInboundKindTag,
  newInboundRequest,
} from "./inbound.ts";

test("channelInboundKindTag formats fieldless + event kinds", () => {
  assert.equal(channelInboundKindTag({ kind: "text" }), "text");
  assert.equal(channelInboundKindTag({ kind: "image" }), "image");
  assert.equal(channelInboundKindTag({ kind: "voice" }), "voice");
  assert.equal(channelInboundKindTag({ kind: "event", name: "subscribe" }), "event:subscribe");
});

test("ChannelInboundKind serialises to the serde tag/content wire form", () => {
  const text: ChannelInboundKind = { kind: "text" };
  assert.deepEqual(JSON.parse(JSON.stringify(text)), { kind: "text" });
  const ev: ChannelInboundKind = { kind: "event", name: "member_join" };
  assert.deepEqual(JSON.parse(JSON.stringify(ev)), { kind: "event", name: "member_join" });
});

test("newInboundRequest is an empty envelope", () => {
  const req = newInboundRequest();
  assert.deepEqual(req.query, {});
  assert.deepEqual(req.headers, {});
  assert.equal(req.body.length, 0);
  assert.ok(req.body instanceof Uint8Array);
});

test("AckPayload constructors carry the discriminant + payload", () => {
  assert.deepEqual(ackEmpty(), { type: "empty" });

  const bytes = new Uint8Array([1, 2, 3]);
  const plain = ackPlain(bytes);
  assert.equal(plain.type, "plain");
  assert.equal(plain.type === "plain" && plain.bytes, bytes);

  const xml = ackXml("<xml/>");
  assert.equal(xml.type, "xml");
  assert.equal(xml.type === "xml" && xml.body, "<xml/>");
});
