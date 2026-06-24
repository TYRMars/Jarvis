import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Tool } from "@jarvis/core";

import {
  HTTP_DEFAULT_MAX_BYTES,
  HttpFetchTool,
  isPrivateIp,
  validateFetchUrl,
  type FetchImpl,
  type FetchResponse,
} from "./http.ts";

/** Build a fake FetchResponse over a body string/bytes + header map. */
function fakeResponse(opts: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): FetchResponse {
  const headers = opts.headers ?? {};
  const bodyBytes =
    typeof opts.body === "string"
      ? new TextEncoder().encode(opts.body)
      : (opts.body ?? new Uint8Array());
  return {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: {
      forEach(cb) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    async arrayBuffer() {
      const out = new ArrayBuffer(bodyBytes.byteLength);
      new Uint8Array(out).set(bodyBytes);
      return out;
    },
  };
}

/** A fetch stub that records the call and returns a canned response. */
function stubFetch(
  resp: FetchResponse,
): { fetchImpl: FetchImpl; calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return resp;
  };
  return { fetchImpl, calls };
}

test("requires a url argument", async () => {
  const tool = new HttpFetchTool({ fetchImpl: stubFetch(fakeResponse({})).fetchImpl });
  await assert.rejects(() => tool.invoke({}), /missing `url` argument/);
  await assert.rejects(() => tool.invoke({ url: 42 }), /missing `url` argument/);
});

test("exposes the expected tool surface", () => {
  const tool: Tool = new HttpFetchTool({ fetchImpl: stubFetch(fakeResponse({})).fetchImpl });
  assert.equal(tool.name, "http.fetch");
  assert.equal(tool.category, "network");
  assert.equal(tool.cacheable, true);
  assert.equal(tool.requiresApproval, undefined); // defaults false
  const params = tool.parameters as { type: string; required: string[]; properties: object };
  assert.equal(params.type, "object");
  assert.deepEqual(params.required, ["url"]);
});

test("GET: formats status, headers, and body", async () => {
  const { fetchImpl, calls } = stubFetch(
    fakeResponse({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain", "x-test": "yes" },
      body: "hello world",
    }),
  );
  const tool = new HttpFetchTool({ fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });

  assert.equal(
    out,
    "HTTP 200 OK\ncontent-type: text/plain\nx-test: yes\n\nhello world",
  );
  // GET is the default; no body sent.
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(calls[0]?.url, "http://example.test/");
});

test("status line falls back to the code when no reason phrase", async () => {
  const { fetchImpl } = stubFetch(fakeResponse({ status: 599, statusText: "", body: "x" }));
  const tool = new HttpFetchTool({ fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });
  assert.ok(out.startsWith("HTTP 599\n"));
});

test("method is uppercased and only GET/POST allowed", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl });

  await tool.invoke({ url: "http://example.test/", method: "post", body: "payload" });
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, "payload");

  await assert.rejects(
    () => tool.invoke({ url: "http://example.test/", method: "DELETE" }),
    /invalid method: DELETE/,
  );
});

test("body is only attached for POST", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl });
  await tool.invoke({ url: "http://example.test/", method: "GET", body: "ignored" });
  assert.equal(calls[0]?.init?.body, undefined);
});

test("headers must be strings", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl });

  await tool.invoke({
    url: "http://example.test/",
    headers: { Authorization: "Bearer t", "X-A": "1" },
  });
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer t", "X-A": "1" });

  await assert.rejects(
    () => tool.invoke({ url: "http://example.test/", headers: { "X-Bad": 5 } }),
    /header `X-Bad` must be a string/,
  );
});

test("body is truncated at maxBytes on a byte boundary with a marker", async () => {
  const maxBytes = 8;
  const { fetchImpl } = stubFetch(fakeResponse({ body: "0123456789" }));
  const tool = new HttpFetchTool({ maxBytes, fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });

  // header block is empty here, so: "HTTP 200 OK\n\n" + body + marker
  assert.equal(out, "HTTP 200 OK\n\n01234567\n\n[... truncated at 8 bytes ...]");
});

test("truncation counts bytes, not characters (multi-byte safe)", async () => {
  // "é" is 2 bytes in UTF-8. A 3-byte cap slices mid-character; lossy decode
  // yields a replacement char rather than throwing.
  const maxBytes = 3;
  const { fetchImpl } = stubFetch(fakeResponse({ body: "éé" })); // 4 bytes total
  const tool = new HttpFetchTool({ maxBytes, fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });
  assert.ok(out.startsWith("HTTP 200 OK\n\n"));
  assert.ok(out.endsWith("[... truncated at 3 bytes ...]"));
  // The first "é" (2 bytes) survives, the third byte is a dangling lead byte → replacement.
  assert.ok(out.includes("é"));
});

test("no truncation marker when body fits exactly", async () => {
  const { fetchImpl } = stubFetch(fakeResponse({ body: "1234" }));
  const tool = new HttpFetchTool({ maxBytes: 4, fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });
  assert.equal(out.includes("truncated"), false);
  assert.equal(out, "HTTP 200 OK\n\n1234");
});

test("default maxBytes is 256 KiB", async () => {
  assert.equal(HTTP_DEFAULT_MAX_BYTES, 262144);
  const big = "a".repeat(HTTP_DEFAULT_MAX_BYTES + 100);
  const { fetchImpl } = stubFetch(fakeResponse({ body: big }));
  const tool = new HttpFetchTool({ fetchImpl }); // no maxBytes override
  const out = await tool.invoke({ url: "http://example.test/" });
  assert.ok(out.endsWith(`[... truncated at ${HTTP_DEFAULT_MAX_BYTES} bytes ...]`));
});

// ---------------------------------------------------------------------------
// SSRF guard (blockPrivateHosts, on by default)
// ---------------------------------------------------------------------------

test("SSRF guard: blocks loopback / private / link-local / metadata by default", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl }); // guard on by default
  for (const url of [
    "http://localhost/",
    "http://localhost:7001/admin",
    "http://api.localhost/",
    "http://127.0.0.1/",
    "http://127.0.0.5/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // AWS/GCP metadata
    "http://100.64.0.1/", // CGNAT
    "http://[::1]/",
    "http://[fd00::1]/", // unique-local
    "http://[fe80::1]/", // link-local
    "http://metadata.google.internal/",
  ]) {
    await assert.rejects(
      () => tool.invoke({ url }),
      /SSRF guard/,
      `expected ${url} to be blocked`,
    );
  }
  // Nothing reached the network.
  assert.equal(calls.length, 0);
});

test("SSRF guard #200 bypass 1: IPv4-mapped IPv6 (::ffff:*) is blocked", () => {
  // Node's URL normalizes [::ffff:127.0.0.1] → ::ffff:7f00:1 (no dots), which a
  // dotted-decimal regex misses — decode the embedded IPv4 and re-check it.
  assert.throws(() => validateFetchUrl("http://[::ffff:127.0.0.1]/", true), /SSRF guard/);
  assert.throws(() => validateFetchUrl("http://[::ffff:169.254.169.254]/", true), /SSRF guard/);
  assert.throws(() => validateFetchUrl("http://[::ffff:10.0.0.1]/", true), /SSRF guard/);
  // A public IPv4-mapped address is still allowed.
  assert.doesNotThrow(() => validateFetchUrl("http://[::ffff:8.8.8.8]/", true));
});

test("SSRF guard #200 bypass 2: trailing-dot localhost. is blocked", () => {
  // `localhost.` keeps the trailing dot in hostname but resolves to 127.0.0.1.
  assert.throws(() => validateFetchUrl("http://localhost./", true), /SSRF guard/);
  assert.throws(() => validateFetchUrl("http://api.localhost./", true), /SSRF guard/);
  assert.throws(() => validateFetchUrl("http://127.0.0.1./", true), /SSRF guard/);
});

test("SSRF guard #207: numeric IPv4 notation resolves to a private range", () => {
  // Node's WHATWG `URL` already canonicalizes these to dotted-quad before the
  // guard runs, so they're blocked end-to-end today …
  for (const url of [
    "http://2130706433/", // bare decimal → 127.0.0.1
    "http://0177.0.0.1/", // octal octet → 127.0.0.1
    "http://0x7f.0.0.1/", // hex octet → 127.0.0.1
    "http://0x7f000001/", // whole-host hex → 127.0.0.1
    "http://017700000001/", // whole-host octal → 127.0.0.1
    "http://127.1/", // 2-part shorthand → 127.0.0.1
    "http://3232235521/", // bare decimal → 192.168.0.1
  ]) {
    assert.throws(() => validateFetchUrl(url, true), /SSRF guard/, `expected ${url} blocked`);
  }

  // … and `isPrivateIp` is now sound on the same notation as a standalone
  // primitive, independent of any URL canonicalization by the caller (#207).
  for (const host of [
    "2130706433",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "0x7f000001",
    "017700000001",
    "127.1",
    "0xa000001", // 10.0.0.1 private
    "0xa9fea9fe", // 169.254.169.254 metadata
    "3232235521", // 192.168.0.1
  ]) {
    assert.equal(isPrivateIp(host), true, `expected ${host} private`);
  }

  // Public numeric forms are normalized but stay allowed (no over-block).
  assert.equal(isPrivateIp("134744072"), false); // 8.8.8.8
  assert.equal(isPrivateIp("0x08080808"), false); // 8.8.8.8
  assert.doesNotThrow(() => validateFetchUrl("http://134744072/", true));

  // Genuine hostnames (incl. hex-looking labels) are not mistaken for numbers.
  assert.equal(isPrivateIp("example.com"), false);
  assert.equal(isPrivateIp("cafe.example"), false);
  assert.equal(isPrivateIp("0x7f.0.0.1.evil.example"), false);
});

test("SSRF guard: allows public hosts and rejects non-http(s) schemes", () => {
  assert.doesNotThrow(() => validateFetchUrl("https://example.com/", true));
  assert.doesNotThrow(() => validateFetchUrl("http://8.8.8.8/", true));
  assert.throws(() => validateFetchUrl("file:///etc/passwd", true), /unsupported URL scheme/);
  assert.throws(() => validateFetchUrl("ftp://example.com/", true), /unsupported URL scheme/);
  assert.throws(() => validateFetchUrl("gopher://example.com/", false), /unsupported URL scheme/);
});

test("SSRF guard: blockPrivateHosts=false reaches loopback (opt-out)", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl, blockPrivateHosts: false });
  await tool.invoke({ url: "http://localhost:7001/" });
  assert.equal(calls[0]?.url, "http://localhost:7001/");
});

test("integration: hits a real local server via global fetch", async () => {
  const server = createServer((req, res) => {
    let received = "";
    req.on("data", (c) => (received += c));
    req.on("end", () => {
      res.writeHead(201, "Created", { "content-type": "text/plain", "x-echo": received || "none" });
      res.end(`method=${req.method} auth=${req.headers["authorization"] ?? ""}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // 127.0.0.1 is a loopback host the SSRF guard blocks by default, so this
    // integration test opts out of the guard (mirrors JARVIS_HTTP_ALLOW_PRIVATE).
    const tool = new HttpFetchTool({ blockPrivateHosts: false }); // uses global fetch
    const out = await tool.invoke({
      url: `http://127.0.0.1:${port}/`,
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: "hi",
    });

    assert.ok(out.startsWith("HTTP 201 Created\n"));
    assert.ok(out.includes("x-echo: hi"));
    assert.ok(out.includes("method=POST auth=Bearer secret"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
