import { test } from "node:test";
import assert from "node:assert/strict";
import { splitHost } from "./provider.ts";
import { isIpv4, getLocalIpv4s } from "./ip.ts";
import { DuckDnsProvider } from "./providers/duckdns.ts";
import { DynDns2Provider } from "./providers/dyndns2.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { DdnsRuntime } from "./runtime.ts";

/** Stub globalThis.fetch with a handler; returns a restore fn. */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => { status?: number; ok?: boolean; body: string },
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url, init);
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => r.body,
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("splitHost: two-label apex, subdomain, and override", () => {
  assert.deepEqual(splitHost("home.example.com"), { rr: "home", apex: "example.com" });
  assert.deepEqual(splitHost("example.com"), { rr: "@", apex: "example.com" });
  assert.deepEqual(splitHost("a.b.example.com"), { rr: "a.b", apex: "example.com" });
  // Override resolves multi-label public suffixes the naive split can't.
  assert.deepEqual(splitHost("home.example.co.uk", "example.co.uk"), {
    rr: "home",
    apex: "example.co.uk",
  });
});

test("isIpv4 + getLocalIpv4s", () => {
  assert.ok(isIpv4("192.168.1.20"));
  assert.ok(!isIpv4("999.1.1.1"));
  assert.ok(!isIpv4("not-an-ip"));
  assert.ok(Array.isArray(getLocalIpv4s()));
});

test("duckdns: OK response → success, derives subdomain", async () => {
  let seenUrl = "";
  const restore = stubFetch((url) => {
    seenUrl = url;
    return { body: "OK" };
  });
  try {
    const res = await new DuckDnsProvider().update({
      hostname: "myhome.duckdns.org",
      ip: "1.2.3.4",
      recordType: "A",
      credentials: { token: "tok" },
    });
    assert.equal(res.ok, true);
    assert.match(seenUrl, /domains=myhome&/);
    assert.match(seenUrl, /token=tok/);
    assert.match(seenUrl, /ip=1.2.3.4/);
  } finally {
    restore();
  }
});

test("duckdns: KO response → failure", async () => {
  const restore = stubFetch(() => ({ body: "KO" }));
  try {
    const res = await new DuckDnsProvider().update({
      hostname: "x.duckdns.org",
      ip: "1.2.3.4",
      recordType: "A",
      credentials: { token: "bad" },
    });
    assert.equal(res.ok, false);
  } finally {
    restore();
  }
});

test("dyndns2: good / nochg / badauth + Basic auth header", async () => {
  const calls: { auth?: string }[] = [];
  let body = "good 1.2.3.4";
  const restore = stubFetch((_url, init) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    calls.push(auth ? { auth } : {});
    return { body };
  });
  try {
    const p = new DynDns2Provider();
    const creds = { username: "u", password: "p" };
    const good = await p.update({ hostname: "h.example.com", ip: "1.2.3.4", recordType: "A", credentials: creds });
    assert.equal(good.ok, true);
    assert.equal(good.unchanged ?? false, false);
    // Basic auth = base64("u:p")
    assert.equal(calls[0]?.auth, `Basic ${Buffer.from("u:p").toString("base64")}`);

    body = "nochg 1.2.3.4";
    const nochg = await p.update({ hostname: "h.example.com", ip: "1.2.3.4", recordType: "A", credentials: creds });
    assert.equal(nochg.ok, true);
    assert.equal(nochg.unchanged, true);

    body = "badauth";
    const bad = await p.update({ hostname: "h.example.com", ip: "1.2.3.4", recordType: "A", credentials: creds });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /authentication failed/);
  } finally {
    restore();
  }
});

test("dyndns2: missing credentials throws", async () => {
  await assert.rejects(
    () => new DynDns2Provider().update({ hostname: "h", ip: "1.2.3.4", recordType: "A", credentials: {} }),
    /missing credential/,
  );
});

test("cloudflare: resolves zone, updates existing record only when changed", async () => {
  const restore = stubFetch((url, init) => {
    if (url.includes("/zones?name=")) {
      return { body: JSON.stringify({ success: true, errors: [], result: [{ id: "ZONE1", name: "example.com" }] }) };
    }
    if (url.includes("/dns_records?")) {
      return {
        body: JSON.stringify({
          success: true,
          errors: [],
          result: [{ id: "REC1", name: "home.example.com", type: "A", content: "9.9.9.9" }],
        }),
      };
    }
    if (init?.method === "PUT") {
      return { body: JSON.stringify({ success: true, errors: [], result: { id: "REC1", name: "home.example.com", type: "A", content: "1.2.3.4" } }) };
    }
    return { body: JSON.stringify({ success: false, errors: [{ code: 0, message: "unexpected" }] }) };
  });
  try {
    const res = await new CloudflareProvider().update({
      hostname: "home.example.com",
      ip: "1.2.3.4",
      recordType: "A",
      credentials: { api_token: "tok" },
    });
    assert.equal(res.ok, true);
    assert.match(res.message, /updated/);
  } finally {
    restore();
  }
});

test("DdnsRuntime: update cycle drives provider + status, scrubs secrets", async () => {
  const restore = stubFetch(() => ({ body: "OK" })); // duckdns OK
  try {
    const rt = await DdnsRuntime.create({
      seed: {
        provider: "duckdns",
        hostname: "myhome.duckdns.org",
        port: 7001,
        credentials: { token: "supersecret" },
        upnp_enabled: false,
      },
      deps: {
        getPublicIp: async () => "203.0.113.7",
        probeReachable: async () => true,
        now: () => "2026-06-22T00:00:00Z",
      },
    });
    assert.equal(rt.isConfigured(), true);
    const status = await rt.updateNow();
    assert.equal(status.configured, true);
    assert.equal(status.public_ip, "203.0.113.7");
    assert.equal(status.last_result?.ok, true);
    assert.equal(status.last_update, "2026-06-22T00:00:00Z");
    assert.equal(status.reachable, true);

    // The scrubbed view never leaks the token value.
    const view = rt.configView();
    assert.deepEqual(view?.credential_keys, ["token"]);
    assert.equal(JSON.stringify(view).includes("supersecret"), false);
    assert.equal(rt.externalOrigin(), "http://myhome.duckdns.org:7001");
  } finally {
    restore();
  }
});

test("DdnsRuntime: unconfigured → status reports not configured, no throw", async () => {
  const rt = await DdnsRuntime.create({});
  assert.equal(rt.isConfigured(), false);
  const status = rt.status();
  assert.equal(status.configured, false);
  assert.equal(status.enabled, true);
  assert.ok(Array.isArray(status.lan_addrs));
});
