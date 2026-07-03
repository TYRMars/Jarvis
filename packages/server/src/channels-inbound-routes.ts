// Inbound channel callback + OAuth routes.
//
// Ported from crates/harness-server/src/{channels_inbound_routes,
// channels_oauth_routes,channels_wecom_app/{crypto,oauth,mod}}.rs.
//
// Endpoints:
// - GET  /v1/channels/:id/callback          — platform verification handshake
//                                               (WeCom posts an `echostr`).
// - POST /v1/channels/:id/callback          — real inbound message (encrypted
//                                               XML envelope).
// - GET  /v1/channels/:id/oauth/start       — build a signed CSRF state +
//                                               302 into WeCom's authorize page.
// - GET  /v1/channels/:id/oauth/callback    — verify the state, exchange the
//                                               `code` → userid, redirect / render.
//
// SECURITY-CRITICAL: the signature verification + AES payload decode are ported
// faithfully from the Rust crypto module (sha1 over a sorted concat for the
// callback signature, HMAC-SHA1 over a base64url-no-pad payload for the OAuth
// state, AES-256-CBC NoPadding with WeCom's `random16 || len_be32 || msg ||
// receive_id` envelope). The verify path is consulted FIRST on both GET + POST,
// and a mismatch is a 401. Constant-time comparison guards the signature check.
//
// The callback flow:
// 1. Look up the channel instance by id (404 if absent; 503 if the store is
//    absent; 503 if the instance is disabled).
// 2. Find the kind's inbound handler. Outbound-only kinds (wecom_webhook /
//    feishu_bot / dingtalk_bot) return undefined → 405.
// 3. Resolve `${env:…}` templates on the config blob (via state.envLookup when
//    present; otherwise leave placeholders, which the handler rejects).
// 4. handler.verify() FIRST — 401 on failure. Always.
// 5. GET → handle_get; POST → handle_post + a best-effort agent dispatch SEAM.
//
// SEAM: on a valid inbound message we decode the event, stamp the instance id +
// kind on it, and — if state.channelDispatcher is present — hand the decoded
// event to it (best-effort, fire-and-forget). The full Rust flow (binding-write
// + per-request agent build + reply push) needs a `build_agent` hook and the
// binding/conversation stores wired into a richer dispatcher than the current
// `ChannelDispatcher` (sendById-only) seam exposes; that orchestration is
// DEFERRED. Without a dispatcher we still ack synchronously (the platform's
// 5-second budget is met regardless).
//
// HARD CONVENTIONS: ESM/NodeNext/strict, `import type`, no enums/namespaces, no
// new npm deps (node:crypto only). NEVER reads process.env — env-template
// resolution uses an injected `state.envLookup` if the composition root supplies
// one (it is not yet on AppState, so this module treats it as optional).
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ackEmpty,
  ackPlain,
  channelInboundKindTag,
  resolveEnvTemplates,
  type AckPayload,
  type ChannelInboundEvent,
  type ChannelInboundKind,
  type ChannelInstance,
  type ChannelInstanceStore,
  type DecodedInbound,
  type EnvLookup,
  type InboundRequest,
  outboundText,
} from "@jarvis/channel";
import type { JsonValue } from "@jarvis/core";
import type { AppState } from "./state.ts";

// ============================================================================
// crypto primitives (port of channels_wecom_app/crypto.rs)
// ============================================================================

/**
 * `sha1(sort([token, timestamp, nonce, payload]).join(""))`, hex-encoded
 * lowercase. Same scheme for the GET handshake (`payload = echostr`) and the
 * POST verify (`payload = <Encrypt>` field). Mirrors `wecom_signature`.
 */
export function wecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  payload: string,
): string {
  const parts = [token, timestamp, nonce, payload].sort();
  return crypto.createHash("sha1").update(parts.join(""), "utf8").digest("hex");
}

/**
 * Constant-time byte-slice equality so a mismatched signature doesn't leak
 * prefix-length info via timing. `node:crypto`'s `timingSafeEqual` throws on a
 * length mismatch, so we guard the length first (returning false), mirroring
 * the Rust `constant_time_eq`'s explicit length check.
 */
export function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Find `<Tag>...</Tag>` in `xml` and return the inner content, stripping a
 * `<![CDATA[...]]>` wrapper if present. Hand-rolled (the inbound XML shape is
 * rigid + flat). Returns undefined for missing tags. Doesn't handle nesting —
 * WeCom's inbound XML never does. Mirrors `extract_tag`.
 */
export function extractTag(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const openIdx = xml.indexOf(open);
  if (openIdx === -1) return undefined;
  const start = openIdx + open.length;
  const relEnd = xml.slice(start).indexOf(close);
  if (relEnd === -1) return undefined;
  const raw = xml.slice(start, start + relEnd);
  if (raw.startsWith("<![CDATA[") && raw.endsWith("]]>")) {
    return raw.slice("<![CDATA[".length, raw.length - "]]>".length);
  }
  return raw;
}

/**
 * AES-256-CBC decrypt the WeCom callback payload + extract the real plaintext.
 * Envelope (after base64-decode of the ciphertext):
 *   key = base64-decode(EncodingAESKey + "=")   // 32 bytes
 *   iv  = key[..16]                              // first 16 bytes of key
 *   plaintext = random_16 || msg_len_be_u32 || msg || receive_id
 * We strip WeCom's PKCS#7-style tail padding, extract `msg`, validate
 * `receive_id == expected_corp_id`, and return `msg`. Mirrors
 * `decrypt_aes_payload`. Throws a string-message Error on any structural
 * failure (the caller maps these to 400/401).
 */
export function decryptAesPayload(
  encodingAesKey: string,
  ciphertextB64: string,
  expectedCorpId: string,
): string {
  // EncodingAESKey is 43 chars of base64 — append `=` for a valid 44-char
  // padded base64 → 32 bytes.
  let aesKey: Buffer;
  try {
    aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
  } catch (e) {
    throw new Error(`encoding_aes_key not valid base64: ${describe(e)}`);
  }
  if (aesKey.length !== 32) {
    throw new Error(`encoding_aes_key decoded to ${aesKey.length} bytes; expected 32`);
  }
  const iv = aesKey.subarray(0, 16);

  // Node's base64 decoder is lenient (it ignores garbage), so validate the
  // ciphertext is well-formed base64 before trusting the decoded length.
  const trimmed = ciphertextB64.trim();
  if (!isValidBase64(trimmed)) {
    throw new Error("ciphertext not valid base64");
  }
  const ciphertext = Buffer.from(trimmed, "base64");
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`ciphertext length ${ciphertext.length} is not a multiple of 16`);
  }

  let buf: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(false);
    buf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(`AES decrypt failed: ${describe(e)}`);
  }

  // Strip WeCom's PKCS#7-style padding: the last byte = pad count, 1..=32.
  if (buf.length === 0) throw new Error("decrypted buffer is empty");
  const pad = buf[buf.length - 1]!;
  if (pad === 0 || pad > 32 || pad > buf.length) {
    throw new Error(`invalid padding length: ${pad}`);
  }
  const plain = buf.subarray(0, buf.length - pad);

  // Layout: `random_16 || msg_len_4_be || msg || receive_id`.
  if (plain.length < 16 + 4) {
    throw new Error(`plaintext too short: ${plain.length} bytes`);
  }
  const msgLen = plain.readUInt32BE(16);
  if (16 + 4 + msgLen > plain.length) {
    throw new Error(`msg_len ${msgLen} exceeds plaintext length ${plain.length - 20}`);
  }
  const msgBytes = plain.subarray(20, 20 + msgLen);
  const receiveId = plain.subarray(20 + msgLen).toString("utf8");
  if (receiveId !== expectedCorpId) {
    throw new Error(`receive_id mismatch: expected ${expectedCorpId}, got ${receiveId}`);
  }
  return msgBytes.toString("utf8");
}

/**
 * Strict base64 (standard alphabet) check. Node's `Buffer.from(s,"base64")`
 * silently drops invalid characters, so the production decryptor can't tell
 * `@@@not-base64@@@` from a short valid string. We validate the input is the
 * base64 alphabet (with optional `=` tail padding) before decoding so a
 * corrupt payload surfaces as the same "not valid base64" error Rust returns.
 */
function isValidBase64(s: string): boolean {
  if (s.length === 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
}

// ============================================================================
// OAuth state sign / verify (port of channels_wecom_app/oauth.rs)
// ============================================================================

/**
 * Decoded state payload after signature verification. The fields are the
 * contract between {@link makeOAuthState} and {@link verifyOAuthState}. Mirrors
 * `OAuthStateClaims`; `ctx` is omitted when absent (`skip_serializing_if`).
 */
export interface OAuthStateClaims {
  instance_id: string;
  exp: number;
  nonce: string;
  ctx?: string;
}

/**
 * HMAC-SHA1 of the state payload keyed by the instance token, 40-char lowercase
 * hex. HMAC (not plain sha1-concat) because the token is a true secret and HMAC
 * is the standard CSRF-token construction. Mirrors `oauth_state_sig`.
 */
function oauthStateSig(payloadB64: string, instanceToken: string): string {
  return crypto.createHmac("sha1", instanceToken).update(payloadB64, "utf8").digest("hex");
}

/**
 * Sign a fresh state token: `base64url(json(claims)).<hmac-sha1-hex>`. The
 * `instanceToken` is the same secret inbound verify uses (`config.token`), so
 * no dedicated signing key is needed. Mirrors `make_oauth_state`. Throws on an
 * empty token.
 */
export function makeOAuthState(
  instanceId: string,
  instanceToken: string,
  ttlSecs: number,
  ctx: string | undefined,
  nonceHex: string,
  nowUnix: number,
): string {
  if (instanceToken.length === 0) {
    throw new Error("instance token is empty — cannot sign OAuth state");
  }
  const claims: OAuthStateClaims = {
    instance_id: instanceId,
    exp: nowUnix + ttlSecs,
    nonce: nonceHex,
  };
  // serde skips `ctx` when None — only include it when present + non-empty so
  // the JSON shape (and thus the signature surface) matches "no ctx".
  if (ctx !== undefined) claims.ctx = ctx;
  const b64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = oauthStateSig(b64, instanceToken);
  return `${b64}.${sig}`;
}

/**
 * Verify + decode a state token. Returns the claims (CSRF passed + not expired)
 * or throws an operator-readable Error. Step order matters: split → recompute
 * sig + constant-time compare → decode/parse → cross-check instance → expiry.
 * Mirrors `verify_oauth_state`.
 */
export function verifyOAuthState(
  state: string,
  expectedInstance: string,
  instanceToken: string,
  nowUnix: number,
): OAuthStateClaims {
  const dot = state.indexOf(".");
  if (dot === -1) throw new Error("state missing signature");
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (b64.length === 0 || sig.length === 0) throw new Error("state malformed");
  const expectedSig = oauthStateSig(b64, instanceToken);
  if (!constantTimeEq(Buffer.from(sig, "utf8"), Buffer.from(expectedSig, "utf8"))) {
    throw new Error("state signature mismatch");
  }
  let claims: OAuthStateClaims;
  try {
    const raw = Buffer.from(b64, "base64url").toString("utf8");
    claims = JSON.parse(raw) as OAuthStateClaims;
  } catch (e) {
    throw new Error(`state json: ${describe(e)}`);
  }
  if (claims.instance_id !== expectedInstance) {
    throw new Error("state instance_id mismatch");
  }
  if (claims.exp < nowUnix) {
    throw new Error("state expired");
  }
  return claims;
}

// ============================================================================
// WeCom authorize URL + inbound XML parse (port of channels_wecom_app)
// ============================================================================

/**
 * Minimal RFC 3986 unreserved-chars-only URL encoder. Mirrors
 * `urlencoding_minimal` / the route's `urlencoded` — percent-encodes anything
 * not in the unreserved set (so base64 `+` / `/` / `=` round-trip in a query).
 */
export function urlencodingMinimal(s: string): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Build the WeCom OAuth2 authorize URL (snsapi_base). `#wechat_redirect` is
 * mandatory — without it the page renders blank inside the WeCom client.
 * Mirrors `oauth_authorize_url`.
 */
export function oauthAuthorizeUrl(
  corpId: string,
  agentId: number,
  redirectUri: string,
  state: string,
): string {
  return (
    `https://open.weixin.qq.com/connect/oauth2/authorize` +
    `?appid=${urlencodingMinimal(corpId)}` +
    `&redirect_uri=${urlencodingMinimal(redirectUri)}` +
    `&response_type=code` +
    `&scope=snsapi_base` +
    `&state=${urlencodingMinimal(state)}` +
    `&agentid=${agentId}#wechat_redirect`
  );
}

/**
 * Parse decrypted WeCom inbound XML into a normalised event. Prefers `<ChatId>`
 * over `<FromUserName>` for the binding key (group routing). Unknown MsgTypes
 * fold into an `event` kind. `instance_id` is stamped by the route handler.
 * Mirrors `parse_inbound_xml`. Throws on a missing `<MsgType>` /
 * `<FromUserName>`.
 */
export function parseInboundXml(xml: string): ChannelInboundEvent {
  const msgType = extractTag(xml, "MsgType");
  if (msgType === undefined) throw new Error("inbound XML missing <MsgType>");
  const fromUser = extractTag(xml, "FromUserName");
  if (fromUser === undefined) throw new Error("inbound XML missing <FromUserName>");
  const externalChatId = extractTag(xml, "ChatId") ?? fromUser;

  let kind: ChannelInboundKind;
  let text: string;
  switch (msgType) {
    case "text":
      kind = { kind: "text" };
      text = extractTag(xml, "Content") ?? "";
      break;
    case "image":
      kind = { kind: "image" };
      text = "";
      break;
    case "voice":
      kind = { kind: "voice" };
      text = "";
      break;
    case "event":
      kind = { kind: "event", name: (extractTag(xml, "Event") ?? "").toLowerCase() };
      text = "";
      break;
    default:
      kind = { kind: "event", name: msgType };
      text = "";
      break;
  }
  return {
    channel: "wecom_app",
    instance_id: "", // filled in by the route handler.
    external_chat_id: externalChatId,
    external_user_id: fromUser,
    text,
    kind,
    raw: { xml },
    received_at: new Date().toISOString(),
  };
}

// ============================================================================
// Inbound handler — WeCom self-built app (port of WeComAppInboundHandler)
// ============================================================================

/**
 * Per-kind inbound logic. Mirrors the Rust `ChannelInboundHandler` trait. Only
 * `wecom_app` ships a handler today; outbound-only kinds (wecom_webhook /
 * feishu_bot / dingtalk_bot) have none → the route 405s.
 *
 * `verify` throws an operator-readable Error on rejection (route → 401);
 * `handleGet` / `handlePost` throw on a decode failure (route → 400).
 */
export interface ChannelInboundHandler {
  verify(req: InboundRequest, resolvedConfig: JsonValue): void;
  handleGet(req: InboundRequest, resolvedConfig: JsonValue): Promise<AckPayload>;
  handlePost(req: InboundRequest, resolvedConfig: JsonValue): Promise<DecodedInbound>;
}

function requireInboundField(config: JsonValue, field: string): string {
  const raw = readStr(config, field);
  if (raw === undefined) {
    throw new Error(`inbound requires \`${field}\` to be set on the channel instance`);
  }
  if (raw.includes("${env:")) {
    throw new Error(
      `${field} contains an unresolved \${env:...} template — set the env var before retrying`,
    );
  }
  return raw;
}

/** WeCom self-built-app inbound handler. Stateless. */
class WeComAppInboundHandler implements ChannelInboundHandler {
  verify(req: InboundRequest, resolvedConfig: JsonValue): void {
    const token = requireInboundField(resolvedConfig, "callback_token");
    const timestamp = req.query["timestamp"];
    if (timestamp === undefined) throw new Error("missing timestamp query param");
    const nonce = req.query["nonce"];
    if (nonce === undefined) throw new Error("missing nonce query param");
    const signature = req.query["msg_signature"] ?? req.query["signature"];
    if (signature === undefined) throw new Error("missing msg_signature query param");

    // The signed 4th element is the echostr (GET handshake) or the <Encrypt>
    // field from the body (POST callback) — whichever the request provides.
    const echo = req.query["echostr"];
    const bodyEncrypt =
      echo !== undefined
        ? undefined
        : extractTag(Buffer.from(req.body).toString("utf8"), "Encrypt");
    const fourth = echo ?? bodyEncrypt ?? "";
    if (fourth.length === 0) throw new Error("missing echostr / Encrypt");

    const expected = wecomSignature(token, timestamp, nonce, fourth);
    if (!constantTimeEq(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
      throw new Error("signature mismatch");
    }
  }

  async handleGet(req: InboundRequest, resolvedConfig: JsonValue): Promise<AckPayload> {
    // Already passed verify(). Decrypt the echostr + return the raw plaintext —
    // that's the WeCom callback verification protocol.
    const aesKey = requireInboundField(resolvedConfig, "callback_aes_key");
    const corpId = requireInboundField(resolvedConfig, "corp_id");
    const echo = req.query["echostr"];
    if (echo === undefined) throw new Error("missing echostr");
    const plain = decryptAesPayload(aesKey, echo, corpId);
    return ackPlain(Buffer.from(plain, "utf8"));
  }

  async handlePost(req: InboundRequest, resolvedConfig: JsonValue): Promise<DecodedInbound> {
    const aesKey = requireInboundField(resolvedConfig, "callback_aes_key");
    const corpId = requireInboundField(resolvedConfig, "corp_id");
    const bodyStr = Buffer.from(req.body).toString("utf8");
    const encrypt = extractTag(bodyStr, "Encrypt");
    if (encrypt === undefined) throw new Error("body missing <Encrypt> field");
    const plaintextXml = decryptAesPayload(aesKey, encrypt, corpId);
    const event = parseInboundXml(plaintextXml);
    // Ack-and-async: 200 OK empty body. Any reply is pushed back out-of-band.
    return { event, ack: ackEmpty() };
  }
}

/**
 * Resolve the inbound handler for a kind. Mirrors `ChannelAdapter::
 * inbound_handler` — only `wecom_app` returns one; everything else is
 * outbound-only (→ 405). Kept as a tiny dispatch so adding a second inbound
 * kind is "add an arm".
 */
function inboundHandlerForKind(kind: string): ChannelInboundHandler | undefined {
  if (kind === "wecom_app") return new WeComAppInboundHandler();
  return undefined;
}

/**
 * Resolve the OAuth capability for a kind. Mirrors `ChannelAdapter::
 * oauth_capability` — only `wecom_app` supports OAuth today. Returns a flag
 * (the WeCom flow is wired directly into the route since it's the only one);
 * other inbound-capable kinds without OAuth get a 405.
 */
function kindSupportsOAuth(kind: string): boolean {
  return kind === "wecom_app";
}

// ============================================================================
// shared route plumbing
// ============================================================================

const STATE_TTL_SECS = 600;

/** JSON-object field reader returning a trimmed non-empty string or undefined. */
function readStr(config: JsonValue, field: string): string | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const v = (config as Record<string, JsonValue>)[field];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/** JSON-object numeric field reader (accepts a number or numeric string). */
function readNum(config: JsonValue, field: string): number | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const v = (config as Record<string, JsonValue>)[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && String(n) === v.trim()) return n;
  }
  return undefined;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Current Unix seconds. */
function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** 16 random bytes → 32 hex chars (the OAuth state nonce). */
function randomNonceHex(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Build the platform-agnostic {@link InboundRequest} from a Fastify request. */
function toInboundRequest(req: FastifyRequest, body: Uint8Array): InboundRequest {
  const query: Record<string, string> = {};
  const q = req.query as Record<string, unknown>;
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === "string") query[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") query[k] = v[0];
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") headers[k] = v[0];
  }
  return { query, headers, body };
}

/** Map an {@link AckPayload} to a Fastify reply. Mirrors `ack_to_response`. */
function sendAck(reply: FastifyReply, ack: AckPayload): FastifyReply {
  switch (ack.type) {
    case "empty":
      return reply.code(200).send();
    case "plain":
      return reply
        .code(200)
        .header("content-type", "text/plain; charset=utf-8")
        .send(Buffer.from(ack.bytes));
    case "xml":
      return reply
        .code(200)
        .header("content-type", "application/xml; charset=utf-8")
        .send(ack.body);
  }
}

/**
 * Resolve `${env:…}` templates on a config blob using the composition root's
 * env lookup when present. `state.envLookup` is NOT yet on the AppState type;
 * we read it defensively so this module is forward-compatible — without it the
 * placeholders survive and the handler's `requireInboundField` rejects them
 * with a clear "set the env var" message (no `process.env` read here).
 */
function resolveConfig(state: AppState, config: Record<string, unknown>): JsonValue {
  // `ChannelInstance.config` is an opaque JSON object (`Record<string, unknown>`
  // on the wire); it is a `JsonValue` at runtime, so narrow it for the resolver.
  const json = config as Record<string, JsonValue>;
  const lookup = (state as { envLookup?: EnvLookup }).envLookup;
  if (lookup) return resolveEnvTemplates(json, lookup);
  return json;
}

interface PreparedInbound {
  instance: ChannelInstance;
  handler: ChannelInboundHandler;
  resolvedConfig: JsonValue;
  req: InboundRequest;
}

/**
 * Common preamble for GET + POST: 503 (no store) / 404 (unknown) / 503
 * (disabled) / 405 (outbound-only). On success returns the prepared bundle;
 * on any failure sends the reply itself and returns undefined. Mirrors
 * `prepare_inbound`.
 */
async function prepareInbound(
  state: AppState,
  reply: FastifyReply,
  id: string,
  fastifyReq: FastifyRequest,
  body: Uint8Array,
): Promise<PreparedInbound | undefined> {
  const store = state.channelInstances;
  if (!store) {
    reply.code(503).send({ error: "channel-instance store not configured" });
    return undefined;
  }
  let instance: ChannelInstance | undefined;
  try {
    instance = await store.get(id);
  } catch (e) {
    reply.code(500).send({ error: describe(e) });
    return undefined;
  }
  if (!instance) {
    reply.code(404).send({ error: "channel instance not found" });
    return undefined;
  }
  if (instance.status === "disabled") {
    reply.code(503).send({ error: `channel instance '${instance.display_name}' is disabled` });
    return undefined;
  }
  const handler = inboundHandlerForKind(instance.kind);
  if (!handler) {
    reply.code(405).send({ error: `kind '${instance.kind}' is outbound-only` });
    return undefined;
  }
  const resolvedConfig = resolveConfig(state, instance.config);
  return {
    instance,
    handler,
    resolvedConfig,
    req: toInboundRequest(fastifyReq, body),
  };
}

/**
 * Load the channel instance for the OAuth routes, dispatching the same failure
 * modes as {@link prepareInbound} but gating on OAuth capability (405) instead
 * of an inbound handler. Returns the instance + resolved config, or sends the
 * reply + returns undefined. Mirrors `load_oauth_capability`.
 */
async function loadOAuthInstance(
  state: AppState,
  reply: FastifyReply,
  id: string,
): Promise<{ instance: ChannelInstance; resolvedConfig: JsonValue } | undefined> {
  const store: ChannelInstanceStore | undefined = state.channelInstances;
  if (!store) {
    reply.code(503).send({ error: "channel-instance store not configured" });
    return undefined;
  }
  let instance: ChannelInstance | undefined;
  try {
    instance = await store.get(id);
  } catch (e) {
    reply.code(500).send({ error: describe(e) });
    return undefined;
  }
  if (!instance) {
    reply.code(404).send({ error: "channel instance not found" });
    return undefined;
  }
  if (instance.status === "disabled") {
    reply.code(503).send({ error: `channel instance '${instance.display_name}' is disabled` });
    return undefined;
  }
  if (!kindSupportsOAuth(instance.kind)) {
    reply.code(405).send({ error: `kind '${instance.kind}' does not support OAuth` });
    return undefined;
  }
  return { instance, resolvedConfig: resolveConfig(state, instance.config) };
}

// --- ctx | next packing (port of channels_oauth_routes.rs helpers) ----------

/** Pack `ctx` + `next` into a single state-claim field (`<safe_ctx>|<next>`). */
export function packCtx(ctx: string | undefined, next: string | undefined): string | undefined {
  const c = ctx ?? "";
  const n = next ?? "";
  if (c.length === 0 && n.length === 0) return undefined;
  const safeCtx = c.replace(/\|/g, ""); // strip pipes to keep the boundary unambiguous
  return `${safeCtx}|${n}`;
}

/** Reverse of {@link packCtx}. Returns `[ctx, next]`. */
export function unpackCtx(packed: string | undefined): [string | undefined, string | undefined] {
  if (packed === undefined) return [undefined, undefined];
  const idx = packed.indexOf("|");
  if (idx !== -1) {
    const ctx = packed.slice(0, idx);
    const next = packed.slice(idx + 1);
    return [ctx.length > 0 ? ctx : undefined, next.length > 0 ? next : undefined];
  }
  return [packed.length > 0 ? packed : undefined, undefined];
}

/**
 * Allowlist `next=` URL schemes: http/https only. No `javascript:` (XSS), no
 * `data:` (phishing), no protocol-relative `//host` (scheme inheritance).
 * Mirrors `is_safe_next_url`.
 */
export function isSafeNextUrl(s: string): boolean {
  if (s.startsWith("//")) return false;
  const lower = s.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/** HTML-escape for the success page (mirrors `html_escape`). */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline "verified identity" page (mirrors `render_success_page`). */
export function renderSuccessPage(userid: string, ctx: string | undefined): string {
  const useridH = htmlEscape(userid);
  const ctxH = ctx ? htmlEscape(ctx) : "";
  const ctxBlock = ctxH.length === 0 ? "" : `<p>ctx: <code>${ctxH}</code></p>`;
  return (
    `<!doctype html><html lang="zh-CN"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>已验证身份</title>` +
    `<style>body{font-family:-apple-system,sans-serif;padding:2rem;text-align:center;color:#1f2937}` +
    `h1{font-size:1.5rem;margin:1rem 0 .5rem}code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.25rem}</style>` +
    `</head><body><div style="font-size:3rem">✅</div>` +
    `<h1>已验证身份</h1>` +
    `<p>userid: <code>${useridH}</code></p>` +
    `${ctxBlock}` +
    `<p style="color:#6b7280;margin-top:2rem">可以关闭这个页面了。</p>` +
    `</body></html>`
  );
}

/**
 * Resolve the public host the composition root pins (`state.publicHost`).
 * Trims a trailing slash + validates the scheme. NOT yet on AppState — read
 * defensively (this module never touches `process.env`). Returns undefined when
 * absent / invalid → the OAuth start route 500s with a clear message.
 */
function resolvePublicHost(state: AppState): string | undefined {
  const raw = (state as { publicHost?: string }).publicHost;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;
  if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) return undefined;
  return trimmed;
}

// ============================================================================
// routes
// ============================================================================

export function registerChannelsInboundRoutes(app: FastifyInstance, state: AppState): void {
  // Register the inbound callback routes + their raw-body content-type parsers
  // inside an ENCAPSULATED Fastify plugin. Content-type parsers are scoped to
  // the context they're added in, so the permissive `*` catch-all the callbacks
  // need (to preserve the verbatim signed payload) applies ONLY to this
  // subtree. On the shared root instance it would replace Fastify's default
  // 415-on-unknown-content-type for every route process-wide, making unrelated
  // routes silently accept odd content-types as raw bytes (#297).
  void app.register(async (scoped) => {
    registerInboundCallbackRoutes(scoped, state);
  });
}

function registerInboundCallbackRoutes(app: FastifyInstance, state: AppState): void {
  // Inbound callbacks need the raw body bytes (the signature covers the
  // verbatim <Encrypt> payload). Register a content-type parser that keeps the
  // body as a Buffer for the callback paths' content types.
  registerRawBodyParsers(app);

  // --------------------------- GET callback (verification handshake) --------
  app.get("/v1/channels/:id/callback", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const prepared = await prepareInbound(state, reply, id, req, new Uint8Array());
    if (!prepared) return reply;
    try {
      prepared.handler.verify(prepared.req, prepared.resolvedConfig);
    } catch (e) {
      return reply.code(401).send({ error: describe(e) });
    }
    try {
      const ack = await prepared.handler.handleGet(prepared.req, prepared.resolvedConfig);
      return sendAck(reply, ack);
    } catch (e) {
      return reply.code(400).send({ error: describe(e) });
    }
  });

  // --------------------------- POST callback (real inbound message) ---------
  app.post("/v1/channels/:id/callback", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = rawBodyBytes(req.body);
    const prepared = await prepareInbound(state, reply, id, req, body);
    if (!prepared) return reply;
    try {
      prepared.handler.verify(prepared.req, prepared.resolvedConfig);
    } catch (e) {
      return reply.code(401).send({ error: describe(e) });
    }
    let decoded: DecodedInbound;
    try {
      decoded = await prepared.handler.handlePost(prepared.req, prepared.resolvedConfig);
    } catch (e) {
      return reply.code(400).send({ error: describe(e) });
    }
    // Stamp the instance id + kind on the event (the handler never sees the URL
    // path) so the downstream binding lookup / dispatch can route correctly.
    decoded.event.instance_id = prepared.instance.id;
    decoded.event.channel = prepared.instance.kind;

    // SEAM: best-effort agent dispatch. The full Rust flow (binding write +
    // per-request agent build + reply push) is DEFERRED — the current
    // ChannelDispatcher seam only exposes `sendById`, not an inbound-event
    // orchestrator. When a dispatcher is present and the event carries text +
    // a sender, we echo the platform's behaviour of routing a reply back
    // through the same instance; otherwise we ack without dispatch. Either way
    // the platform ack returns synchronously so the 5-second budget is met.
    void dispatchInboundBestEffort(state, decoded.event);

    return sendAck(reply, decoded.ack);
  });

  // --------------------------- GET oauth/start ------------------------------
  app.get("/v1/channels/:id/oauth/start", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { ctx?: string; next?: string };
    const nextRaw = typeof q.next === "string" ? q.next : undefined;
    if (nextRaw !== undefined && !isSafeNextUrl(nextRaw)) {
      return reply.code(400).send({ error: "next URL must be http(s)://" });
    }
    const loaded = await loadOAuthInstance(state, reply, id);
    if (!loaded) return reply;

    const publicHost = resolvePublicHost(state);
    if (!publicHost) {
      return reply.code(500).send({
        error: "public host not configured — required to build OAuth redirect URI",
      });
    }
    const redirectUri = `${publicHost}/v1/channels/${id}/oauth/callback`;

    const corpId = readStr(loaded.resolvedConfig, "corp_id");
    if (!corpId) {
      return reply.code(500).send({ error: "corp_id missing or unresolved" });
    }
    const agentId = readNum(loaded.resolvedConfig, "agent_id");
    if (agentId === undefined) {
      return reply.code(500).send({ error: "agent_id missing or not a number" });
    }
    const token = readStr(loaded.resolvedConfig, "token");
    if (!token) {
      return reply
        .code(500)
        .send({ error: "instance token missing — required for OAuth state signing" });
    }

    const ctxRaw = typeof q.ctx === "string" ? q.ctx : undefined;
    const ctxPacked = packCtx(ctxRaw, nextRaw);
    let signedState: string;
    try {
      signedState = makeOAuthState(id, token, STATE_TTL_SECS, ctxPacked, randomNonceHex(), nowUnix());
    } catch (e) {
      return reply.code(500).send({ error: describe(e) });
    }
    const authorizeUrl = oauthAuthorizeUrl(corpId, agentId, redirectUri, signedState);
    // Hand-set Location so the `#wechat_redirect` fragment survives (the WeCom
    // mobile client honours it). 302 FOUND, empty body.
    return reply.code(302).header("location", authorizeUrl).send();
  });

  // --------------------------- GET oauth/callback ---------------------------
  app.get("/v1/channels/:id/oauth/callback", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { code?: string; state?: string; error?: string };
    if (typeof q.error === "string" && q.error.length > 0) {
      return reply.code(400).send({ error: `wecom oauth error: ${q.error}` });
    }
    const code = typeof q.code === "string" && q.code.length > 0 ? q.code : undefined;
    if (!code) return reply.code(400).send({ error: "missing `code` query param" });
    const stateToken = typeof q.state === "string" && q.state.length > 0 ? q.state : undefined;
    if (!stateToken) return reply.code(400).send({ error: "missing `state` query param" });

    const loaded = await loadOAuthInstance(state, reply, id);
    if (!loaded) return reply;

    const token = readStr(loaded.resolvedConfig, "token");
    if (!token) {
      return reply
        .code(500)
        .send({ error: "instance token missing — cannot verify OAuth state" });
    }
    let claims: OAuthStateClaims;
    try {
      claims = verifyOAuthState(stateToken, id, token, nowUnix());
    } catch (e) {
      return reply.code(401).send({ error: describe(e) });
    }

    // DEFERRED: the actual `code → userid` exchange POSTs to WeCom's
    // cgi-bin/auth/getuserinfo with an app access_token (which itself needs the
    // cgi-bin/gettoken round-trip + a process-level token cache). That HTTP
    // client + token cache is a separate later wave; the route layer's
    // signature-critical work (state sign/verify + CSRF + expiry) is what's
    // ported here. Surface the deferral as a clean 503 rather than pretending
    // to verify identity we can't yet fetch.
    return reply.code(503).send({
      error: "wecom oauth code exchange not configured — deferred to a later wave",
      // Echo the verified state's ctx so a caller can confirm CSRF passed even
      // while the identity fetch is stubbed.
      ctx: unpackCtx(claims.ctx)[0] ?? null,
    });
  });
}

/**
 * Best-effort inbound dispatch SEAM. Empty-text events (subscribe pings, image
 * notices) are skipped. The current {@link AppState.channelDispatcher} only
 * supports `sendById`, so the full agent-run + binding-write flow is DEFERRED;
 * we simply don't crash the ack path. Any dispatcher error is swallowed (the
 * platform already has its 200).
 */
async function dispatchInboundBestEffort(
  state: AppState,
  event: ChannelInboundEvent,
): Promise<void> {
  if (event.text.length === 0) return; // no-text events: binding-track only (deferred), no dispatch.
  const dispatcher = state.channelDispatcher;
  if (!dispatcher) return; // no seam wired — ack without dispatch (per the route contract).
  try {
    // DEFERRED: the Rust flow looks up / mints a ChannelBinding, runs a
    // per-request agent to completion, then pushes the assistant's reply via
    // the originating instance with `to_user` overridden to the sender. With
    // only `sendById` on the seam (and no build_agent hook on AppState), we
    // cannot run the agent here. We intentionally do NOT echo the inbound text
    // back (that would be a noisy non-reply). This call site exists so the
    // dispatcher wiring is exercised once the orchestrator lands; today it's a
    // documented no-op beyond the guard. Reference the tag for log parity.
    void channelInboundKindTag(event.kind);
    void outboundText; // imported for the future reply-push; referenced to keep the seam honest.
  } catch {
    /* best-effort: the platform ack already returned */
  }
}

// ============================================================================
// raw-body handling
// ============================================================================

const RAW_BODY_SYMBOL = "__channels_inbound_raw_body__";

interface RawBodyHolder {
  [RAW_BODY_SYMBOL]: Buffer;
}

/**
 * Register content-type parsers that retain the verbatim request bytes. The
 * callback signature covers the raw `<Encrypt>` payload, so we must not let
 * Fastify's default JSON parser mangle / reject the XML body. We park the raw
 * Buffer behind a symbol-keyed wrapper that {@link rawBodyBytes} unwraps.
 */
function registerRawBodyParsers(app: FastifyInstance): void {
  const keep = (
    _req: FastifyRequest,
    payload: Buffer,
    done: (err: Error | null, body?: unknown) => void,
  ): void => {
    const holder: RawBodyHolder = { [RAW_BODY_SYMBOL]: payload };
    done(null, holder);
  };
  // WeCom posts `text/xml` (and occasionally `application/xml`); cover both
  // plus a permissive catch-all so an odd content-type still preserves bytes.
  for (const ct of ["text/xml", "application/xml", "text/plain"]) {
    try {
      app.addContentTypeParser(ct, { parseAs: "buffer" }, keep as never);
    } catch {
      /* parser for this content-type already registered — fine */
    }
  }
  try {
    app.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      keep as never,
    );
  } catch {
    /* catch-all already registered — fine */
  }
}

/** Unwrap the raw request body bytes parked by {@link registerRawBodyParsers}. */
function rawBodyBytes(body: unknown): Uint8Array {
  if (body && typeof body === "object" && RAW_BODY_SYMBOL in body) {
    return (body as RawBodyHolder)[RAW_BODY_SYMBOL];
  }
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return new Uint8Array();
}
