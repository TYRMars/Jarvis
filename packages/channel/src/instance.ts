// Channel-instance value type + env-template resolver.
//
// Ported from crates/harness-channel/src/instance.rs. A `ChannelInstance` is
// one user-configured connection to a messaging platform — e.g. "the
// prod-alerts WeCom group robot". One deployment typically carries several
// instances, each pinning a `kind` (transport flavour) and an opaque `config`
// blob shaped by that kind.
//
// Credentials in `config` may be literal strings or use the `${env:VAR_NAME}`
// template syntax. The Rust resolver reads `std::env` at send-time; this port
// must NOT read `process.env`, so {@link resolveEnvTemplates} takes an explicit
// lookup function (the composition root supplies one backed by env). Keeping
// the lookup injected also makes the resolver pure + trivially testable.
import type { JsonValue } from "@jarvis/core";

/**
 * User-driven enabled/disabled/unconfigured state. Distinct from "did the last
 * send succeed". `"unconfigured"` is set by handlers when required fields are
 * missing. Serde shape: `#[serde(rename_all = "snake_case")]`, default
 * `"unconfigured"` on a fresh instance (see {@link newChannelInstance}).
 */
export type ChannelInstanceStatus = "enabled" | "disabled" | "unconfigured";

const CHANNEL_INSTANCE_STATUSES: readonly ChannelInstanceStatus[] = [
  "enabled",
  "disabled",
  "unconfigured",
];

/** Parse a wire string. `undefined` for unrecognised values. */
export function channelInstanceStatusFromWire(s: string): ChannelInstanceStatus | undefined {
  return (CHANNEL_INSTANCE_STATUSES as readonly string[]).includes(s)
    ? (s as ChannelInstanceStatus)
    : undefined;
}

/**
 * One configured channel — e.g. a WeCom group robot, a WeChat MP callback
 * target, a Feishu bot. Instances are user-named (`display_name`) because a
 * deployment may host several of the same `kind`.
 *
 * `config` is an opaque JSON object so each kind owns its own schema without
 * baking variant-specific fields into the shared surface. It may embed
 * `${env:NAME}` template strings — resolved at send-time, never at store-time.
 */
export interface ChannelInstance {
  /** Stable UUID. Frontend keys list rows by this. */
  id: string;
  /** Discriminator: `"wecom_webhook"` / `"wechat_mp"` / `"feishu_bot"` / … */
  kind: string;
  /** User-set human-readable name (e.g. "prod-alerts"). */
  display_name: string;
  status: ChannelInstanceStatus;
  /**
   * Kind-specific config payload. Rust uses `serde_json::Value` annotated
   * `Record<string, unknown>` for codegen; here it's a {@link JsonValue}
   * object in practice (the resolver recurses generically regardless).
   */
  config: JsonValue;
  /** RFC-3339 timestamp set on insert. */
  created_at: string;
  /** RFC-3339 timestamp bumped on every upsert. */
  updated_at: string;
}

/**
 * Build a fresh instance with a UUID id and now-stamped timestamps. Status
 * defaults to `"unconfigured"` so the caller has to opt into "go live" by
 * toggling it after validation (mirrors `ChannelInstance::new`).
 */
export function newChannelInstance(
  kind: string,
  displayName: string,
  config: JsonValue,
): ChannelInstance {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind,
    display_name: displayName,
    status: "unconfigured",
    config,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Bump `updated_at` to "now". Stores never mutate timestamps on the caller's
 * behalf — same convention as {@link touchChannelBinding}. Mirrors
 * `ChannelInstance::touch`.
 */
export function touchChannelInstance(instance: ChannelInstance): void {
  instance.updated_at = new Date().toISOString();
}

/**
 * Lookup of an env var name → its value (or `undefined` when unset). The
 * composition root supplies one backed by `process.env`; library code stays
 * env-free. Mirrors the role of `std::env::var` in the Rust resolver.
 */
export type EnvLookup = (name: string) => string | undefined;

/**
 * Resolve `${env:VAR_NAME}` template strings in `value` against `lookup`.
 * Recurses into arrays + objects; numbers / booleans / null pass through.
 * Used by kind-specific senders right before the outbound HTTP call.
 *
 * Vars that aren't set are left as the literal `${env:…}` placeholder so debug
 * logs don't silently elide misconfigurations — the channel sender treats any
 * remaining placeholder as a fatal "config incomplete" error. Mirrors
 * `resolve_env_templates`.
 */
export function resolveEnvTemplates(value: JsonValue, lookup: EnvLookup): JsonValue {
  if (typeof value === "string") {
    return resolveEnvTemplateString(value, lookup);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveEnvTemplates(v, lookup));
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveEnvTemplates(v, lookup);
    }
    return out;
  }
  // numbers / booleans / null pass through.
  return value;
}

/**
 * Substitute every `${env:VAR}` occurrence in `s`. Unset vars are left as the
 * literal `${env:…}` placeholder verbatim. Mirrors `resolve_env_template_string`.
 */
function resolveEnvTemplateString(s: string, lookup: EnvLookup): string {
  const MARKER = "${env:";
  // Cheap path: short-circuit when no template markers present.
  if (!s.includes(MARKER)) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(MARKER, i)) {
      const varStart = i + MARKER.length;
      const relEnd = s.indexOf("}", varStart);
      if (relEnd !== -1) {
        const varName = s.slice(varStart, relEnd);
        const resolved = lookup(varName);
        if (resolved !== undefined) {
          out += resolved;
        } else {
          // Leave the placeholder verbatim — the sender will refuse to
          // dispatch and surface the missing var.
          out += s.slice(i, relEnd + 1);
        }
        i = relEnd + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}
