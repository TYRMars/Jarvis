import { test } from "node:test";
import assert from "node:assert/strict";

import { decideWindowOpen } from "./window-open.ts";

test("http(s) URLs are denied in-app but routed to the OS browser", () => {
  for (const url of [
    "https://accounts.example.com/oauth/authorize?client_id=x",
    "http://127.0.0.1:7001/v1/channels/1/oauth/start",
    "HTTPS://Example.com/Path", // scheme match is case-insensitive
  ]) {
    const d = decideWindowOpen(url);
    assert.equal(d.action, "deny", `${url} must deny the in-app window`);
    assert.equal(d.openExternal, url, `${url} must be handed to the OS browser`);
  }
});

test("non-http schemes are denied with no external hand-off", () => {
  for (const url of [
    "about:blank",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "myapp://deep/link",
    "", // Electron reports "" for some programmatic opens
  ]) {
    const d = decideWindowOpen(url);
    assert.equal(d.action, "deny", `${url} must deny the in-app window`);
    assert.equal(d.openExternal, undefined, `${url} must NOT be opened externally`);
  }
});

test("a bare-scheme http string without // is not treated as a web URL", () => {
  // Guards against handing odd `https:` values to the browser — we require `//`.
  const d = decideWindowOpen("https:notaurl");
  assert.equal(d.action, "deny");
  assert.equal(d.openExternal, undefined);
});
