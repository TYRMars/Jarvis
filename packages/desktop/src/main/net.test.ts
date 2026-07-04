import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

import { bindWithRetry, isAddrInUse, pickPort, probeHealth } from "./net.ts";

/** A synthetic Node listen error with the given code. */
function listenError(code: string): Error {
  return Object.assign(new Error(`listen ${code}: address already in use`), { code });
}

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

// ---------- bindWithRetry (issue #318: pickPort→serve TOCTOU) ----------

test("isAddrInUse recognises EADDRINUSE by code and by message", () => {
  assert.equal(isAddrInUse(listenError("EADDRINUSE")), true);
  assert.equal(isAddrInUse(new Error("bind EADDRINUSE 127.0.0.1:7001")), true);
  assert.equal(isAddrInUse(listenError("EACCES")), false);
  assert.equal(isAddrInUse(new Error("some other failure")), false);
  assert.equal(isAddrInUse(null), false);
  assert.equal(isAddrInUse(undefined), false);
});

test("bindWithRetry succeeds on the first port when it is free", async () => {
  let calls = 0;
  const { handle, port } = await bindWithRetry(
    5000,
    (p) => {
      calls++;
      return Promise.resolve(`handle:${p}`);
    },
    { pick: () => Promise.reject(new Error("should not pick")) },
  );
  assert.equal(calls, 1);
  assert.equal(port, 5000);
  assert.equal(handle, "handle:5000");
});

test("bindWithRetry retries on a fresh port after EADDRINUSE", async () => {
  const retries: Array<[number, number, number]> = [];
  let attempt = 0;
  const { handle, port } = await bindWithRetry(
    5000,
    (p) => {
      attempt++;
      // First choice is taken; the freshly-picked 6000 binds cleanly.
      if (p === 5000) return Promise.reject(listenError("EADDRINUSE"));
      return Promise.resolve(`handle:${p}`);
    },
    {
      pick: () => Promise.resolve(6000),
      onRetry: (taken, next, n) => retries.push([taken, next, n]),
    },
  );
  assert.equal(attempt, 2, "one failed bind + one success");
  assert.equal(port, 6000);
  assert.equal(handle, "handle:6000");
  assert.deepEqual(retries, [[5000, 6000, 1]]);
});

test("bindWithRetry gives up after maxAttempts, surfacing the last EADDRINUSE", async () => {
  let attempt = 0;
  let picks = 0;
  await assert.rejects(
    bindWithRetry(
      5000,
      () => {
        attempt++;
        return Promise.reject(listenError("EADDRINUSE"));
      },
      { maxAttempts: 3, pick: () => Promise.resolve(6000 + picks++) },
    ),
    (e: unknown) => isAddrInUse(e),
  );
  assert.equal(attempt, 3, "bound exactly maxAttempts times");
  assert.equal(picks, 2, "picked a fresh port between attempts, not after the last");
});

test("bindWithRetry does not retry a non-EADDRINUSE error", async () => {
  let attempt = 0;
  await assert.rejects(
    bindWithRetry(
      5000,
      () => {
        attempt++;
        return Promise.reject(listenError("EACCES"));
      },
      { pick: () => Promise.reject(new Error("should not pick")) },
    ),
    /EACCES/,
  );
  assert.equal(attempt, 1, "EACCES surfaces immediately, no retry");
});
