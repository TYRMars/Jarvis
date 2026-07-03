import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import {
  MemoryChannelInstanceStore,
  newChannelInstance,
  type ChannelInstance,
} from "@jarvis/channel";
import {
  registerChannelsInboundRoutes,
  wecomSignature,
  constantTimeEq,
  extractTag,
  decryptAesPayload,
  parseInboundXml,
  makeOAuthState,
  verifyOAuthState,
  oauthAuthorizeUrl,
  urlencodingMinimal,
  packCtx,
  unpackCtx,
  isSafeNextUrl,
  renderSuccessPage,
} from "./channels-inbound-routes.ts";
import type { AppState } from "./state.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** Mirror of the Rust `synth_encrypt` test helper: wrap `msg` in WeCom's
 *  `random16 || len_be32 || msg || receive_id`, PKCS#7-pad to a 32-byte
 *  multiple, AES-256-CBC encrypt with iv = key[..16], base64-encode. */
function synthEncrypt(msg: string, corpId: string, key: Buffer): string {
  const iv = key.subarray(0, 16);
  const msgBuf = Buffer.from(msg, "utf8");
  const corpBuf = Buffer.from(corpId, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length);
  let payload = Buffer.concat([Buffer.alloc(16), lenBuf, msgBuf, corpBuf]);
  const padLen = 32 - (payload.length % 32);
  payload = Buffer.concat([payload, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
}

/** EncodingAESKey = first 43 chars of base64(key) (production appends `=`). */
function synthAesKeyB64(key: Buffer): string {
  return key.toString("base64").slice(0, 43);
}

function makeState(opts: { store?: MemoryChannelInstanceStore | false; publicHost?: string } = {}): AppState {
  const state: AppState & { publicHost?: string } = {
    createAgent: agentUnused,
    channelInstances:
      opts.store === false ? undefined : (opts.store ?? new MemoryChannelInstanceStore()),
  };
  if (opts.publicHost !== undefined) state.publicHost = opts.publicHost;
  return state;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerChannelsInboundRoutes(app, state);
  await app.ready();
  return app;
}

/** Enabled wecom_app instance with the given config, persisted into `store`. */
async function seedWeComApp(
  store: MemoryChannelInstanceStore,
  config: Record<string, unknown>,
): Promise<ChannelInstance> {
  const inst = newChannelInstance("wecom_app", "test-row", config as never);
  inst.status = "enabled";
  await store.upsert(inst);
  return inst;
}

// ===========================================================================
// UNIT — wecom_signature
// ===========================================================================

test("wecom_signature is 40 lowercase hex chars and order-independent (sorted)", () => {
  const s1 = wecomSignature("ABC", "1", "N", "PL");
  assert.equal(s1.length, 40);
  assert.ok(/^[0-9a-f]{40}$/.test(s1));
  // changing an input changes the digest
  assert.notEqual(s1, wecomSignature("ABC", "2", "N", "PL"));
  // reordering identical inputs yields the same signature (sort makes order irrelevant)
  assert.equal(wecomSignature("PL", "ABC", "1", "N"), s1);
});

test("constantTimeEq: equal/diff/length-mismatch/empty", () => {
  assert.equal(constantTimeEq(Buffer.from("abc"), Buffer.from("abc")), true);
  assert.equal(constantTimeEq(Buffer.from("abc"), Buffer.from("abd")), false);
  assert.equal(constantTimeEq(Buffer.from("abc"), Buffer.from("abcd")), false); // must not throw
  assert.equal(constantTimeEq(Buffer.from(""), Buffer.from("")), true);
});

// ===========================================================================
// UNIT — extract_tag
// ===========================================================================

test("extractTag handles plain + CDATA, undefined for missing", () => {
  const xml = "<root><A>plain</A><B><![CDATA[in cdata]]></B></root>";
  assert.equal(extractTag(xml, "A"), "plain");
  assert.equal(extractTag(xml, "B"), "in cdata");
  assert.equal(extractTag(xml, "Missing"), undefined);
});

// ===========================================================================
// UNIT — AES decrypt round-trip (port of crypto.rs::tests)
// ===========================================================================

test("decryptAesPayload round-trips msg + validates corp_id", () => {
  const key = Buffer.alloc(32, 7);
  const cipher = synthEncrypt("hello world", "ww-good-corp", key);
  const plain = decryptAesPayload(synthAesKeyB64(key), cipher, "ww-good-corp");
  assert.equal(plain, "hello world");
});

test("decryptAesPayload rejects a wrong corp_id (receive_id mismatch)", () => {
  const key = Buffer.alloc(32, 7);
  const cipher = synthEncrypt("hi", "ww-actual", key);
  assert.throws(
    () => decryptAesPayload(synthAesKeyB64(key), cipher, "ww-different"),
    /receive_id mismatch/,
  );
});

test("decryptAesPayload rejects invalid base64 ciphertext", () => {
  const key = Buffer.alloc(32, 11);
  assert.throws(
    () => decryptAesPayload(synthAesKeyB64(key), "@@@not-base64@@@", "ww"),
    /ciphertext not valid base64/,
  );
});

test("decryptAesPayload rejects a short AES key", () => {
  // 30 base64 chars decode to ~22 bytes, not 32.
  assert.throws(
    () => decryptAesPayload("a".repeat(30), "AAAA", "ww"),
    /expected 32|not valid base64/,
  );
});

test("decryptAesPayload rejects a tampered ciphertext (decrypt/padding/length failure)", () => {
  const key = Buffer.alloc(32, 7);
  const cipher = Buffer.from(synthEncrypt("hello world", "ww-corp", key), "base64");
  // Flip a byte in the middle block — CBC propagates corruption to the tail,
  // breaking the padding / receive_id. Must throw, never silently accept.
  cipher[20] = cipher[20]! ^ 0xff;
  assert.throws(() =>
    decryptAesPayload(synthAesKeyB64(key), cipher.toString("base64"), "ww-corp"),
  );
});

// ===========================================================================
// UNIT — inbound XML parse (port of mod.rs::tests)
// ===========================================================================

test("parseInboundXml: text message, ChatId wins over FromUserName", () => {
  const xml =
    "<xml><FromUserName><![CDATA[user42]]></FromUserName>" +
    "<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好 jarvis]]></Content>" +
    "<ChatId><![CDATA[group-abc]]></ChatId></xml>";
  const evt = parseInboundXml(xml);
  assert.equal(evt.channel, "wecom_app");
  assert.equal(evt.text, "你好 jarvis");
  assert.deepEqual(evt.kind, { kind: "text" });
  assert.equal(evt.external_chat_id, "group-abc");
  assert.equal(evt.external_user_id, "user42");
});

test("parseInboundXml: falls back to FromUserName when no ChatId", () => {
  const xml = "<xml><FromUserName>user-alone</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>";
  assert.equal(parseInboundXml(xml).external_chat_id, "user-alone");
});

test("parseInboundXml: image/voice/event/unknown kinds", () => {
  assert.deepEqual(
    parseInboundXml("<xml><FromUserName>u</FromUserName><MsgType>image</MsgType></xml>").kind,
    { kind: "image" },
  );
  assert.deepEqual(
    parseInboundXml("<xml><FromUserName>u</FromUserName><MsgType>voice</MsgType></xml>").kind,
    { kind: "voice" },
  );
  assert.deepEqual(
    parseInboundXml(
      "<xml><FromUserName>u</FromUserName><MsgType>event</MsgType><Event>Subscribe</Event></xml>",
    ).kind,
    { kind: "event", name: "subscribe" }, // lowercased
  );
  assert.deepEqual(
    parseInboundXml("<xml><FromUserName>u</FromUserName><MsgType>location</MsgType></xml>").kind,
    { kind: "event", name: "location" },
  );
});

test("parseInboundXml: missing MsgType / FromUserName throws", () => {
  assert.throws(() => parseInboundXml("<xml><FromUserName>u</FromUserName></xml>"), /MsgType/);
  assert.throws(() => parseInboundXml("<xml><MsgType>text</MsgType></xml>"), /FromUserName/);
});

// ===========================================================================
// UNIT — OAuth state sign / verify (port of oauth.rs::tests)
// ===========================================================================

test("OAuth state round-trips claims (instance/exp/nonce/ctx)", () => {
  const state = makeOAuthState("inst-1", "token-secret", 600, "session=abc", "deadbeefcafebabe", 1_700_000_000);
  const claims = verifyOAuthState(state, "inst-1", "token-secret", 1_700_000_100);
  assert.equal(claims.instance_id, "inst-1");
  assert.equal(claims.exp, 1_700_000_600);
  assert.equal(claims.nonce, "deadbeefcafebabe");
  assert.equal(claims.ctx, "session=abc");
});

test("OAuth state rejects a tampered payload (signature mismatch)", () => {
  const state = makeOAuthState("inst-1", "token-secret", 600, undefined, "nonce123", 1_700_000_000);
  const dot = state.indexOf(".");
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const last = payload[payload.length - 1]!;
  const badPayload = payload.slice(0, -1) + (last === "A" ? "B" : "A");
  assert.throws(
    () => verifyOAuthState(`${badPayload}.${sig}`, "inst-1", "token-secret", 1_700_000_100),
    /signature/,
  );
});

test("OAuth state rejects a tampered signature", () => {
  const state = makeOAuthState("inst-1", "token-secret", 600, undefined, "n", 1_700_000_000);
  const payload = state.slice(0, state.indexOf("."));
  assert.throws(
    () => verifyOAuthState(`${payload}.${"0".repeat(40)}`, "inst-1", "token-secret", 1_700_000_100),
    /signature/,
  );
});

test("OAuth state rejects wrong instance / expired / malformed / empty token", () => {
  const stA = makeOAuthState("inst-A", "tok", 600, undefined, "n", 1_700_000_000);
  assert.throws(() => verifyOAuthState(stA, "inst-B", "tok", 1_700_000_100), /instance_id/);

  const stExp = makeOAuthState("inst-1", "tok", 60, undefined, "n", 1_700_000_000);
  assert.throws(() => verifyOAuthState(stExp, "inst-1", "tok", 1_700_000_070), /expired/);

  assert.throws(() => verifyOAuthState("aGVsbG8", "inst-1", "tok", 1), /missing signature/);
  assert.throws(() => verifyOAuthState("aGVsbG8.", "inst-1", "tok", 1), /malformed/);
  assert.throws(() => makeOAuthState("inst-1", "", 600, undefined, "n", 1), /token/);
});

test("OAuth state sig differs per token (CSRF gate is real)", () => {
  // Two different tokens over the same instance produce distinct signatures.
  const s1 = makeOAuthState("inst-1", "token-A", 600, undefined, "n", 1_700_000_000);
  const s2 = makeOAuthState("inst-1", "token-B", 600, undefined, "n", 1_700_000_000);
  assert.notEqual(s1.slice(s1.indexOf(".")), s2.slice(s2.indexOf(".")));
  // A state signed with token-A must NOT verify under token-B.
  assert.throws(() => verifyOAuthState(s1, "inst-1", "token-B", 1_700_000_100), /signature/);
});

// ===========================================================================
// UNIT — authorize URL + URL encoder + ctx pack/unpack + next safety + page
// ===========================================================================

test("oauthAuthorizeUrl has all required params + #wechat_redirect, no whitespace", () => {
  const url = oauthAuthorizeUrl(
    "ww-corp",
    1_000_002,
    "https://abc.example/v1/channels/xyz/oauth/callback",
    "state-token-abc",
  );
  assert.ok(url.includes("appid=ww-corp"));
  assert.ok(url.includes("redirect_uri=https%3A%2F%2Fabc.example%2Fv1%2Fchannels%2Fxyz%2Foauth%2Fcallback"));
  assert.ok(url.includes("response_type=code"));
  assert.ok(url.includes("scope=snsapi_base"));
  assert.ok(url.includes("state=state-token-abc"));
  assert.ok(url.includes("agentid=1000002"));
  assert.ok(url.endsWith("#wechat_redirect"));
  assert.ok(!url.includes(" "));
  assert.ok(!url.includes("\n"));
});

test("urlencodingMinimal escapes reserved, preserves unreserved", () => {
  assert.equal(urlencodingMinimal("a+b/c=d"), "a%2Bb%2Fc%3Dd");
  assert.equal(urlencodingMinimal("hello world"), "hello%20world");
  assert.equal(urlencodingMinimal("abc_DEF.123-~"), "abc_DEF.123-~");
});

test("packCtx/unpackCtx round-trip + pipe-strip + empty", () => {
  assert.deepEqual(unpackCtx(packCtx("session=abc", undefined)), ["session=abc", undefined]);
  assert.deepEqual(unpackCtx(packCtx(undefined, "https://x.example/cb")), [undefined, "https://x.example/cb"]);
  assert.deepEqual(unpackCtx(packCtx("s=42", "https://x.example")), ["s=42", "https://x.example"]);
  // pipe in ctx is stripped so it can't shift the boundary
  assert.deepEqual(unpackCtx(packCtx("bad|injected=evil.com", undefined)), ["badinjected=evil.com", undefined]);
  assert.equal(packCtx(undefined, undefined), undefined);
  assert.equal(packCtx("", ""), undefined);
});

test("isSafeNextUrl blocks dangerous schemes", () => {
  assert.equal(isSafeNextUrl("https://x.example/cb"), true);
  assert.equal(isSafeNextUrl("http://x.example/cb"), true);
  assert.equal(isSafeNextUrl("javascript:alert(1)"), false);
  assert.equal(isSafeNextUrl("data:text/html,<script>"), false);
  assert.equal(isSafeNextUrl("//evil.example/cb"), false);
  assert.equal(isSafeNextUrl("file:///etc/passwd"), false);
  assert.equal(isSafeNextUrl(""), false);
});

test("renderSuccessPage escapes userid + conditionally renders ctx", () => {
  const escaped = renderSuccessPage("<script>", undefined);
  assert.ok(escaped.includes("&lt;script&gt;"));
  assert.ok(!escaped.includes("<script>"));
  assert.ok(!renderSuccessPage("ZhangSan", undefined).includes("ctx:"));
  assert.ok(renderSuccessPage("ZhangSan", "session=abc").includes("ctx:"));
});

// ===========================================================================
// ROUTE — 503 when no store
// ===========================================================================

test("all callback + oauth routes 503 when no channel-instance store", async () => {
  const app = await buildApp(makeState({ store: false, publicHost: "https://h.example" }));
  for (const r of [
    { method: "GET" as const, url: "/v1/channels/x/callback" },
    { method: "POST" as const, url: "/v1/channels/x/callback", payload: "<xml/>" },
    { method: "GET" as const, url: "/v1/channels/x/oauth/start" },
    { method: "GET" as const, url: "/v1/channels/x/oauth/callback?code=c&state=s" },
  ]) {
    const res = await app.inject(r);
    assert.equal(res.statusCode, 503, `${r.method} ${r.url}`);
  }
  await app.close();
});

// ===========================================================================
// ROUTE — 404 unknown instance
// ===========================================================================

test("callback + oauth 404 for an unknown instance id", async () => {
  const app = await buildApp(makeState({ publicHost: "https://h.example" }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/channels/ghost/callback" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/channels/ghost/oauth/start" })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/channels/ghost/oauth/callback?code=c&state=s" })).statusCode,
    404,
  );
  await app.close();
});

// ===========================================================================
// ROUTE — 503 disabled instance
// ===========================================================================

test("callback 503s a disabled instance", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", callback_token: "T", callback_aes_key: "k" });
  inst.status = "disabled";
  await store.upsert(inst);
  const app = await buildApp(makeState({ store }));
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/callback` });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /disabled/);
  await app.close();
});

// ===========================================================================
// ROUTE — 405 outbound-only kind
// ===========================================================================

test("callback 405s an outbound-only kind (wecom_webhook has no inbound handler)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = newChannelInstance("wecom_webhook", "alerts", { webhook_url: "https://x" } as never);
  inst.status = "enabled";
  await store.upsert(inst);
  const app = await buildApp(makeState({ store }));
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/callback` });
  assert.equal(res.statusCode, 405);
  assert.match(res.json().error, /outbound-only/);
  await app.close();
});

test("oauth 405s a kind without OAuth (feishu_bot)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = newChannelInstance("feishu_bot", "lark", { webhook_url: "https://x" } as never);
  inst.status = "enabled";
  await store.upsert(inst);
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/oauth/start` });
  assert.equal(res.statusCode, 405);
  assert.match(res.json().error, /does not support OAuth/);
  await app.close();
});

// ===========================================================================
// ROUTE — GET callback verification handshake (valid + tampered signature)
// ===========================================================================

test("GET callback: valid signature decrypts echostr + returns the plaintext verbatim", async () => {
  const key = Buffer.alloc(32, 5);
  const aesKeyB64 = synthAesKeyB64(key);
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-corp",
    callback_token: "TOK",
    callback_aes_key: aesKeyB64,
  });
  const app = await buildApp(makeState({ store }));

  const echostr = synthEncrypt("verify-plaintext-123", "ww-corp", key);
  const timestamp = "100";
  const nonce = "rand";
  const sig = wecomSignature("TOK", timestamp, nonce, echostr);
  const url =
    `/v1/channels/${inst.id}/callback?msg_signature=${encodeURIComponent(sig)}` +
    `&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "verify-plaintext-123");
  await app.close();
});

test("GET callback: TAMPERED signature → 401, never decrypts", async () => {
  const key = Buffer.alloc(32, 5);
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-corp",
    callback_token: "TOK",
    callback_aes_key: synthAesKeyB64(key),
  });
  const app = await buildApp(makeState({ store }));

  const echostr = synthEncrypt("secret", "ww-corp", key);
  const url =
    `/v1/channels/${inst.id}/callback?msg_signature=${"0".repeat(40)}` +
    `&timestamp=100&nonce=rand&echostr=${encodeURIComponent(echostr)}`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /signature mismatch/);
  await app.close();
});

test("GET callback: missing query params → 401 (verify runs first)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww",
    callback_token: "TOK",
    callback_aes_key: "k",
  });
  const app = await buildApp(makeState({ store }));
  // no timestamp/nonce/signature
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/callback` });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("GET callback: 401 when callback_token is unset on the instance", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww" }); // no callback_token
  const app = await buildApp(makeState({ store }));
  const res = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/callback?msg_signature=x&timestamp=1&nonce=n&echostr=e`,
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /callback_token/);
  await app.close();
});

// ===========================================================================
// ROUTE — POST callback (valid round-trip + tampered + ack)
// ===========================================================================

test("POST callback: valid signature decrypts the <Encrypt> body + acks 200 empty", async () => {
  const key = Buffer.alloc(32, 3);
  const aesKeyB64 = synthAesKeyB64(key);
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-test",
    callback_token: "T",
    callback_aes_key: aesKeyB64,
  });
  const app = await buildApp(makeState({ store }));

  const innerXml = "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>";
  const encrypt = synthEncrypt(innerXml, "ww-test", key);
  const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  const timestamp = "100";
  const nonce = "rand";
  const sig = wecomSignature("T", timestamp, nonce, encrypt);

  const res = await app.inject({
    method: "POST",
    url: `/v1/channels/${inst.id}/callback?msg_signature=${sig}&timestamp=${timestamp}&nonce=${nonce}`,
    headers: { "content-type": "text/xml" },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, ""); // ack-and-async: empty body
  await app.close();
});

test("raw-body `*` parser is scoped to inbound routes, not the root app (#297)", async () => {
  // The permissive catch-all content-type parser the callbacks need must NOT
  // leak onto the shared root instance, where it would replace Fastify's
  // default 415-on-unknown-content-type for every route process-wide.
  const app = Fastify();
  registerChannelsInboundRoutes(app, makeState({ store: new MemoryChannelInstanceStore() }));
  // A sibling route on the ROOT app that reads its body like a normal handler.
  app.post("/probe", async (req) => ({ bodyType: typeof req.body }));
  await app.ready();

  // An unknown content-type on the root route must be rejected with 415, not
  // silently parsed into a raw-buffer holder object.
  const res = await app.inject({
    method: "POST",
    url: "/probe",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("abc"),
  });
  assert.equal(res.statusCode, 415, `root route should 415 on unknown content-type; got ${res.statusCode}`);
  await app.close();
});

test("POST callback: TAMPERED signature → 401, body never decrypted/dispatched", async () => {
  const key = Buffer.alloc(32, 3);
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-test",
    callback_token: "T",
    callback_aes_key: synthAesKeyB64(key),
  });
  // A dispatcher that records calls — it must NOT be invoked on a 401.
  let dispatched = 0;
  const state = makeState({ store });
  state.channelDispatcher = {
    sendById: async () => {
      dispatched += 1;
      return { outcome: "sent" };
    },
  };
  const app = await buildApp(state);

  const encrypt = synthEncrypt(
    "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>",
    "ww-test",
    key,
  );
  const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  const res = await app.inject({
    method: "POST",
    url: `/v1/channels/${inst.id}/callback?msg_signature=${"f".repeat(40)}&timestamp=100&nonce=rand`,
    headers: { "content-type": "text/xml" },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(dispatched, 0, "dispatcher must not run on a signature failure");
  await app.close();
});

test("POST callback: valid signature but wrong corp_id in payload → 400 (decode failure)", async () => {
  const key = Buffer.alloc(32, 3);
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-configured",
    callback_token: "T",
    callback_aes_key: synthAesKeyB64(key),
  });
  const app = await buildApp(makeState({ store }));

  // Ciphertext's embedded receive_id is "ww-evil", not the configured corp_id.
  const encrypt = synthEncrypt(
    "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>",
    "ww-evil",
    key,
  );
  const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  const sig = wecomSignature("T", "100", "rand", encrypt);
  const res = await app.inject({
    method: "POST",
    url: `/v1/channels/${inst.id}/callback?msg_signature=${sig}&timestamp=100&nonce=rand`,
    headers: { "content-type": "text/xml" },
    payload: body,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /receive_id mismatch/);
  await app.close();
});

// ===========================================================================
// ROUTE — OAuth start
// ===========================================================================

test("oauth/start 302s into the WeCom authorize URL with a signed state", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, {
    corp_id: "ww-corp",
    agent_id: 1_000_002,
    token: "csrf-secret",
  });
  const app = await buildApp(makeState({ store, publicHost: "https://h.example/" }));
  const res = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/oauth/start?ctx=session%3Dabc&next=https%3A%2F%2Fapp.example%2Fdone`,
  });
  assert.equal(res.statusCode, 302);
  const loc = res.headers["location"];
  assert.ok(typeof loc === "string");
  assert.ok(loc.startsWith("https://open.weixin.qq.com/connect/oauth2/authorize?"));
  assert.ok(loc.includes("appid=ww-corp"));
  assert.ok(loc.includes("agentid=1000002"));
  assert.ok(loc.endsWith("#wechat_redirect"));
  // The redirect_uri is built from the trailing-slash-trimmed public host.
  assert.ok(
    loc.includes("redirect_uri=" + urlencodingMinimal(`https://h.example/v1/channels/${inst.id}/oauth/callback`)),
  );
  // A `state=` param is present and is a signed token (has a `.` separator
  // once url-decoded).
  const stateMatch = /state=([^&]+)/.exec(loc);
  assert.ok(stateMatch);
  assert.ok(decodeURIComponent(stateMatch![1]!).includes("."));
  await app.close();
});

test("oauth/start 400s an unsafe next URL", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1, token: "t" });
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));
  const res = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/oauth/start?next=javascript%3Aalert(1)`,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /next URL/);
  await app.close();
});

test("oauth/start 500s when no public host is configured", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1, token: "t" });
  const app = await buildApp(makeState({ store })); // no publicHost
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/oauth/start` });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /public host/);
  await app.close();
});

test("oauth/start 500s when the instance token is unset (cannot sign state)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1 }); // no token
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));
  const res = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/oauth/start` });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /token/);
  await app.close();
});

// ===========================================================================
// ROUTE — OAuth callback
// ===========================================================================

test("oauth/callback 400s a missing code / state and surfaces an oauth error param", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1, token: "t" });
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));

  assert.equal(
    (await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/oauth/callback?state=s` })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: `/v1/channels/${inst.id}/oauth/callback?code=c` })).statusCode,
    400,
  );
  const errRes = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/oauth/callback?error=access_denied`,
  });
  assert.equal(errRes.statusCode, 400);
  assert.match(errRes.json().error, /access_denied/);
  await app.close();
});

test("oauth/callback 401s a state that fails CSRF verification (wrong token / tampered)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1, token: "real-secret" });
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));
  // State signed with a DIFFERENT token → signature mismatch.
  const forged = makeOAuthState(inst.id, "attacker-secret", 600, undefined, "n", Math.floor(Date.now() / 1000));
  const res = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/oauth/callback?code=valid-code&state=${encodeURIComponent(forged)}`,
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /signature/);
  await app.close();
});

test("oauth/callback: valid state passes CSRF then 503s on the deferred code exchange (echoes ctx)", async () => {
  const store = new MemoryChannelInstanceStore();
  const inst = await seedWeComApp(store, { corp_id: "ww", agent_id: 1, token: "csrf-secret" });
  const app = await buildApp(makeState({ store, publicHost: "https://h.example" }));
  const packed = packCtx("session=abc", undefined);
  const goodState = makeOAuthState(inst.id, "csrf-secret", 600, packed, "n", Math.floor(Date.now() / 1000));
  const res = await app.inject({
    method: "GET",
    url: `/v1/channels/${inst.id}/oauth/callback?code=valid-code&state=${encodeURIComponent(goodState)}`,
  });
  assert.equal(res.statusCode, 503);
  const json = res.json();
  assert.match(json.error, /code exchange not configured/);
  assert.equal(json.ctx, "session=abc"); // proves the verified ctx round-tripped
  await app.close();
});
