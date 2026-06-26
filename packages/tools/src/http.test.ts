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

test("response headers are bounded by maxBytes with a truncation marker", async () => {
  // Many small headers whose combined size blows past the cap. Each line is
  // "h<NN>: <40 bytes>\n" ≈ 50 bytes; 40 of them ≈ 2 KiB > the 200-byte cap.
  const headers: Record<string, string> = {};
  for (let i = 0; i < 40; i++) headers[`h${String(i).padStart(2, "0")}`] = "v".repeat(40);
  const { fetchImpl } = stubFetch(fakeResponse({ headers, body: "ok" }));
  const tool = new HttpFetchTool({ maxBytes: 200, fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });

  // The emitted header block (everything between the status line and the blank
  // line that precedes the body) must stay within the cap, plus the marker.
  assert.ok(out.includes("[... response headers truncated at 200 bytes ...]"));
  const headerBlock = out.split("\n\n")[0]!.split("\n").slice(1).join("\n");
  const markerBytes = new TextEncoder().encode(
    "[... response headers truncated at 200 bytes ...]\n",
  ).length;
  assert.ok(
    new TextEncoder().encode(headerBlock).length <= 200 + markerBytes,
    "header block must be bounded by the byte cap",
  );
  // Body still present and untruncated.
  assert.ok(out.endsWith("\n\nok"));
});

test("small header blocks are emitted verbatim with no marker", async () => {
  const { fetchImpl } = stubFetch(
    fakeResponse({ headers: { "x-a": "1", "x-b": "2" }, body: "ok" }),
  );
  const tool = new HttpFetchTool({ maxBytes: 200, fetchImpl });
  const out = await tool.invoke({ url: "http://example.test/" });
  assert.equal(out, "HTTP 200 OK\nx-a: 1\nx-b: 2\n\nok");
  assert.equal(out.includes("truncated"), false);
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
    const tool = new HttpFetchTool({}); // uses global fetch
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
