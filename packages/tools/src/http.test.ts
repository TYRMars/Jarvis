import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Tool } from "@jarvis/core";

import {
  HTTP_DEFAULT_MAX_BYTES,
  HttpFetchTool,
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

// ---- SSRF guard (blockPrivateHosts, on by default) -------------------------

/** A fetch stub that returns canned responses in sequence and records calls. */
function sequenceFetch(
  responses: FetchResponse[],
): { fetchImpl: FetchImpl; calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
  let i = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return resp;
  };
  return { fetchImpl, calls };
}

const BLOCKED_HOSTS = [
  "http://127.0.0.1/",
  "http://127.255.255.254/",
  "http://localhost/",
  "http://localhost./", // trailing-dot FQDN (#200)
  "http://sub.localhost/",
  "http://169.254.169.254/latest/meta-data/", // cloud metadata
  "http://10.0.0.1/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://0.0.0.0/",
  "http://100.64.0.1/", // CGNAT
  "http://2130706433/", // decimal 127.0.0.1 (#207)
  "http://0177.0.0.1/", // octal (#207)
  "http://0x7f000001/", // hex (#207)
  "http://0x7f.0.0.1/", // mixed hex (#207)
  "http://[::1]/", // IPv6 loopback
  "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 (#200)
  "http://[::ffff:169.254.169.254]/", // mapped metadata (#200)
  "http://[fc00::1]/", // unique-local
  "http://[fe80::1]/", // link-local
];

for (const url of BLOCKED_HOSTS) {
  test(`SSRF guard blocks ${url}`, async () => {
    const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "secret" }));
    const tool = new HttpFetchTool({ fetchImpl }); // guard on by default
    await assert.rejects(() => tool.invoke({ url }), /private\/internal host|invalid URL/);
    assert.equal(calls.length, 0, "must not have issued any request");
  });
}

test("SSRF guard allows public hosts", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl });
  await tool.invoke({ url: "http://example.com/" });
  await tool.invoke({ url: "http://8.8.8.8/" });
  assert.equal(calls.length, 2);
});

test("SSRF guard rejects non-http(s) schemes", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "x" }));
  const tool = new HttpFetchTool({ fetchImpl });
  await assert.rejects(
    () => tool.invoke({ url: "file:///etc/passwd" }),
    /unsupported URL scheme/,
  );
  assert.equal(calls.length, 0);
});

test("blockPrivateHosts:false disables the guard", async () => {
  const { fetchImpl, calls } = stubFetch(fakeResponse({ body: "ok" }));
  const tool = new HttpFetchTool({ fetchImpl, blockPrivateHosts: false });
  await tool.invoke({ url: "http://127.0.0.1/" });
  assert.equal(calls.length, 1);
});

test("redirects are followed manually and re-validated (the #206 fix)", async () => {
  // A public host 302s to the metadata endpoint — the second hop must be blocked
  // and the internal response never fetched.
  const { fetchImpl, calls } = sequenceFetch([
    fakeResponse({
      status: 302,
      statusText: "Found",
      headers: { location: "http://169.254.169.254/latest/meta-data/iam/" },
    }),
    fakeResponse({ body: "IAM-CREDS" }), // must never be reached
  ]);
  const tool = new HttpFetchTool({ fetchImpl });
  await assert.rejects(
    () => tool.invoke({ url: "http://evil.example/redir" }),
    /private\/internal host/,
  );
  assert.equal(calls.length, 1, "must stop at the redirect, not fetch the metadata host");
  assert.equal(calls[0]?.init?.redirect, "manual");
});

test("redirect to a public host is followed", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    fakeResponse({ status: 301, statusText: "Moved", headers: { location: "http://b.example/" } }),
    fakeResponse({ status: 200, statusText: "OK", body: "landed" }),
  ]);
  const tool = new HttpFetchTool({ fetchImpl });
  const out = await tool.invoke({ url: "http://a.example/" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.url, "http://b.example/");
  assert.ok(out.includes("landed"));
});

test("relative redirect Location resolves against the current URL", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    fakeResponse({ status: 302, statusText: "Found", headers: { location: "/next" } }),
    fakeResponse({ status: 200, statusText: "OK", body: "ok" }),
  ]);
  const tool = new HttpFetchTool({ fetchImpl });
  await tool.invoke({ url: "http://a.example/start" });
  assert.equal(calls[1]?.url, "http://a.example/next");
});

test("POST downgrades to GET without a body on a 302 redirect", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    fakeResponse({ status: 302, statusText: "Found", headers: { location: "http://b.example/" } }),
    fakeResponse({ status: 200, statusText: "OK", body: "ok" }),
  ]);
  const tool = new HttpFetchTool({ fetchImpl });
  await tool.invoke({ url: "http://a.example/", method: "POST", body: "payload" });
  assert.equal(calls[1]?.init?.method, "GET");
  assert.equal(calls[1]?.init?.body, undefined);
});

test("too many redirects is rejected", async () => {
  const loop = fakeResponse({
    status: 302,
    statusText: "Found",
    headers: { location: "http://a.example/loop" },
  });
  const { fetchImpl } = sequenceFetch([loop]);
  const tool = new HttpFetchTool({ fetchImpl });
  await assert.rejects(() => tool.invoke({ url: "http://a.example/" }), /too many redirects/);
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
    // Loopback is fetched on purpose here — opt out of the SSRF guard.
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
