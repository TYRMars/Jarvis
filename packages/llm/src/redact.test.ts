import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets, safeBody, redactedMarker } from "./redact.ts";

test("scrubSecrets: redacts JSON credential fields, keeps structure", () => {
  const out = scrubSecrets('{"access_token":"sk-abc123","model":"gpt-4o"}');
  assert.doesNotMatch(out, /sk-abc123/);
  assert.match(out, /"access_token":"<redacted>"/);
  // Non-secret fields survive.
  assert.match(out, /"model":"gpt-4o"/);
});

test("scrubSecrets: redacts form-encoded and several key names", () => {
  const out = scrubSecrets("refresh_token=rt-secret&client_secret=cs-secret&grant_type=refresh_token");
  assert.doesNotMatch(out, /rt-secret/);
  assert.doesNotMatch(out, /cs-secret/);
  assert.match(out, /refresh_token=<redacted>/);
  assert.match(out, /client_secret=<redacted>/);
  // grant_type is not a secret key — preserved.
  assert.match(out, /grant_type=refresh_token/);
});

test("safeBody: passes short scrubbed bodies through", () => {
  assert.equal(safeBody("plain error"), "plain error");
});

test("safeBody: truncates oversized bodies with a marker", () => {
  const big = "x".repeat(1000);
  const out = safeBody(big, 100);
  assert.equal(out.length < big.length, true);
  assert.match(out, /\[truncated 900 chars\]/);
});

test("safeBody: scrubs secrets even when short", () => {
  const out = safeBody('{"api_key":"secret-value"}');
  assert.doesNotMatch(out, /secret-value/);
});

test("redactedMarker: exposes only a byte count", () => {
  assert.equal(redactedMarker("any-secret-body"), "<redacted 15 bytes>");
  assert.doesNotMatch(redactedMarker("token=leak"), /leak/);
});
