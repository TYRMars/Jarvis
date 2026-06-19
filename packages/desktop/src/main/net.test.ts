import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

import { pickPort, probeHealth } from "./net.ts";

test("pickPort returns a bindable ephemeral port", async () => {
  const port = await pickPort();
  assert.ok(port > 0 && port < 65536, `port out of range: ${port}`);
  // The port must be free immediately after picking — re-bind to prove it.
  await new Promise<void>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
  });
});

test("pickPort yields distinct ports across calls", async () => {
  const ports = await Promise.all([pickPort(), pickPort(), pickPort()]);
  assert.equal(new Set(ports).size, ports.length);
});

test("probeHealth is true for a 2xx /health", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  try {
    assert.equal(await probeHealth(`http://127.0.0.1:${port}`), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeHealth is false for non-2xx", async () => {
  const server = http.createServer((_req, res) => res.writeHead(500).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  try {
    assert.equal(await probeHealth(`http://127.0.0.1:${port}`), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeHealth is false (not throwing) for a dead origin", async () => {
  const port = await pickPort(); // free port, nothing listening
  assert.equal(await probeHealth(`http://127.0.0.1:${port}`, 200), false);
});
