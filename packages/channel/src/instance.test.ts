import { test } from "node:test";
import assert from "node:assert/strict";

import type { JsonValue } from "@jarvis/core";
import {
  type EnvLookup,
  channelInstanceStatusFromWire,
  newChannelInstance,
  resolveEnvTemplates,
  touchChannelInstance,
} from "./instance.ts";

/** Build an EnvLookup from a plain map (the composition root supplies a real one). */
function envFrom(map: Record<string, string>): EnvLookup {
  return (name) => (name in map ? map[name] : undefined);
}

test("channelInstanceStatusFromWire round-trips, rejects unknown", () => {
  assert.equal(channelInstanceStatusFromWire("enabled"), "enabled");
  assert.equal(channelInstanceStatusFromWire("disabled"), "disabled");
  assert.equal(channelInstanceStatusFromWire("unconfigured"), "unconfigured");
  assert.equal(channelInstanceStatusFromWire("nope"), undefined);
});

test("newChannelInstance defaults to unconfigured, fresh id, equal timestamps", () => {
  const inst = newChannelInstance("wecom_webhook", "test", {});
  assert.equal(inst.status, "unconfigured");
  assert.equal(inst.kind, "wecom_webhook");
  assert.equal(inst.display_name, "test");
  assert.notEqual(inst.id, "");
  assert.equal(inst.created_at, inst.updated_at);
});

test("touchChannelInstance bumps updated_at, leaves created_at", () => {
  const inst = newChannelInstance("feishu_bot", "n", {});
  inst.created_at = "2020-01-01T00:00:00.000Z";
  inst.updated_at = "2020-01-01T00:00:00.000Z";
  touchChannelInstance(inst);
  assert.equal(inst.created_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(inst.updated_at, "2020-01-01T00:00:00.000Z");
});

test("resolveEnvTemplates substitutes string values, leaves literals", () => {
  const lookup = envFrom({ JARVIS_TEST_WECOM: "secret-key-abc" });
  const input: JsonValue = {
    webhook_url: "https://qyapi.weixin.qq.com/x?key=${env:JARVIS_TEST_WECOM}",
    literal: "no template here",
  };
  const out = resolveEnvTemplates(input, lookup) as Record<string, string>;
  assert.equal(out["webhook_url"], "https://qyapi.weixin.qq.com/x?key=secret-key-abc");
  assert.equal(out["literal"], "no template here");
});

test("resolveEnvTemplates leaves an unknown var as the verbatim placeholder", () => {
  const out = resolveEnvTemplates("${env:JARVIS_TEST_MISSING}", envFrom({}));
  // Unchanged — caller is expected to treat as misconfigured.
  assert.equal(out, "${env:JARVIS_TEST_MISSING}");
});

test("resolveEnvTemplates recurses into nested objects + arrays", () => {
  const lookup = envFrom({ JARVIS_TEST_NEST: "Z" });
  const input: JsonValue = {
    outer: [{ inner: "x-${env:JARVIS_TEST_NEST}-y" }, "${env:JARVIS_TEST_NEST}"],
  };
  const out = resolveEnvTemplates(input, lookup) as { outer: [{ inner: string }, string] };
  assert.equal(out.outer[0].inner, "x-Z-y");
  assert.equal(out.outer[1], "Z");
});

test("resolveEnvTemplates leaves numbers / booleans / null untouched", () => {
  const input: JsonValue = { n: 7, b: true, z: null, nested: [1, false] };
  const out = resolveEnvTemplates(input, envFrom({}));
  assert.deepEqual(out, input);
});

test("resolveEnvTemplates handles multiple markers in one string", () => {
  const lookup = envFrom({ A: "1", B: "2" });
  assert.equal(resolveEnvTemplates("${env:A}-mid-${env:B}", lookup), "1-mid-2");
});

test("resolveEnvTemplates short-circuits strings with no marker", () => {
  assert.equal(resolveEnvTemplates("plain ${notenv} text", envFrom({})), "plain ${notenv} text");
});
