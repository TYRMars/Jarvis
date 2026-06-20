import { test } from "node:test";
import assert from "node:assert/strict";

import { isNavigationAllowed, originOf } from "./navigation.ts";

const ORIGIN = "http://127.0.0.1:7001";

test("file:// navigation is always allowed (bundled SPA fallback)", () => {
  assert.equal(isNavigationAllowed("file:///app/out/index.html", null), true);
  assert.equal(isNavigationAllowed("file:///app/out/index.html", ORIGIN), true);
});

test("navigation to the pinned server origin is allowed", () => {
  assert.equal(isNavigationAllowed(`${ORIGIN}/settings`, ORIGIN), true);
  assert.equal(isNavigationAllowed(`${ORIGIN}/v1/chat/ws`, ORIGIN), true);
});

test("navigation to a different origin is refused", () => {
  assert.equal(isNavigationAllowed("https://evil.example.com", ORIGIN), false);
  // Same host, different port is a different origin.
  assert.equal(isNavigationAllowed("http://127.0.0.1:9999", ORIGIN), false);
  // Same host/port, different scheme is a different origin.
  assert.equal(isNavigationAllowed("https://127.0.0.1:7001", ORIGIN), false);
});

test("nothing but file:// is allowed before an origin is pinned", () => {
  assert.equal(isNavigationAllowed(ORIGIN, null), false);
  assert.equal(isNavigationAllowed("https://evil.example.com", null), false);
});

test("unparseable / non-web targets are refused", () => {
  assert.equal(isNavigationAllowed("not a url", ORIGIN), false);
  assert.equal(isNavigationAllowed("about:blank", ORIGIN), false);
  assert.equal(isNavigationAllowed("javascript:alert(1)", ORIGIN), false);
});

test("a restart to a new port re-pins the allowed origin", () => {
  const next = "http://127.0.0.1:7042";
  // Old origin no longer matches; new one does.
  assert.equal(isNavigationAllowed(`${ORIGIN}/`, next), false);
  assert.equal(isNavigationAllowed(`${next}/`, next), true);
});

test("originOf strips path/query, returns null on garbage", () => {
  assert.equal(originOf("http://127.0.0.1:7001/health?x=1"), ORIGIN);
  assert.equal(originOf("nonsense"), null);
});
